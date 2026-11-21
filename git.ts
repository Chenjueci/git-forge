// Git smart HTTP: protocol v0 and v2 ref advertisement, v2 ls-refs and fetch (with shallow
// support), a basic v0 fetch, and v0 receive-pack with report-status. Packfiles are read and
// written in pure JS (node:zlib / node:crypto only); objects live in the shared store.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZERO_OID, hashObject, parseCommit, parseTag, type GitObject, type ObjType, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Parse every pkt-line in `bytes` from `offset`; returns the packets and the offset past the last one. */
export function parsePackets(bytes: Buffer, offset = 0): { packets: Packet[]; next: number } {
  const packets: Packet[] = [];
  let at = offset;
  while (at + 4 <= bytes.length) {
    const header = bytes.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > bytes.length) break;
    packets.push({ kind: 'data', payload: bytes.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, next: at };
}

// ---------------------------------------------------------------------------------------------
// packfiles

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile (no deltas) from full objects; trailer is the SHA-1 of everything before it. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta stream to base bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

interface PackEntry {
  offset: number;
  type: ObjType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile and resolve every object (OFS_DELTA / REF_DELTA included). `external` resolves
 * a thin pack's missing bases. Returns oid -> object.
 */
export function readPack(pack: Buffer, external?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let at = 12;
  for (let i = 0; i < count; i += 1) {
    const start = at;
    let byte = pack[at] as number;
    at += 1;
    const code = (byte >> 4) & 0x07;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at] as number;
      at += 1;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (code === 6) {
      let b = pack[at] as number;
      at += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[at] as number;
        at += 1;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      baseOffset = value;
    } else if (code === 7) {
      baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    }
    const inflated = inflateAt(pack, at);
    at = inflated.next;
    if (code === 6) entries.push({ offset: start, type: 'ofs-delta', data: inflated.data, baseOffset });
    else if (code === 7) entries.push({ offset: start, type: 'ref-delta', data: inflated.data, baseOid });
    else {
      const type = CODE_TYPE[code];
      if (type === undefined) throw new Error(`unknown pack object type ${code}`);
      entries.push({ offset: start, type, data: inflated.data });
    }
  }
  const byOffset = new Map<number, { oid: string; object: GitObject }>();
  const byOid = new Map<string, GitObject>();
  const resolveEntry = (entry: PackEntry): { oid: string; object: GitObject } => {
    const cached = byOffset.get(entry.offset);
    if (cached !== undefined) return cached;
    let object: GitObject;
    if (entry.type === 'ofs-delta') {
      const baseEntry = entries.find((candidate) => candidate.offset === entry.offset - (entry.baseOffset ?? 0));
      if (baseEntry === undefined) throw new Error('ofs-delta base missing');
      const base = resolveEntry(baseEntry);
      object = { type: base.object.type, data: applyDelta(base.object.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      let base = byOid.get(entry.baseOid ?? '');
      if (base === undefined && external !== undefined) base = external(entry.baseOid ?? '');
      if (base === undefined) throw new Error('ref-delta base missing');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    const resolved = { oid: hashObject(object.type, object.data), object };
    byOffset.set(entry.offset, resolved);
    byOid.set(resolved.oid, object);
    return resolved;
  };
  for (const entry of entries) resolveEntry(entry);
  return byOid;
}

// ---------------------------------------------------------------------------------------------
// helpers shared by the handlers

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendGitError(res: ServerResponse, status: number, message: string): void {
  const text = `${JSON.stringify({ message })}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Every ref of a repo, sorted by name, with HEAD first handled by callers. */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The commit a tag (possibly nested) ultimately points at, or null. */
export function peelToCommit(store: Store, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = store.getObject(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type !== 'tag') return null;
    current = parseTag(object.data).object;
  }
  return null;
}

const UPLOAD_CAPS_V2: readonly string[] = ['agent=forge/1.0', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k ofs-delta shallow object-format=sha1';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta object-format=sha1 agent=forge/1.0';

// ---------------------------------------------------------------------------------------------
// info/refs

export function handleInfoRefs(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo, service: string): void {
  const protocolHeader = req.headers['git-protocol'];
  const wantsV2 = service === 'git-upload-pack' && typeof protocolHeader === 'string' && protocolHeader.includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) {
    const parts: Buffer[] = [pktLine('version 2\n')];
    for (const capability of UPLOAD_CAPS_V2) parts.push(pktLine(`${capability}\n`));
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', Buffer.concat(parts));
    return;
  }
  const caps = service === 'git-upload-pack' ? `${UPLOAD_CAPS_V0} symref=HEAD:refs/heads/${repo.defaultBranch}` : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    // The first ref line carries the capability list after a NUL; HEAD goes first.
    parts.push(pktLine(`${headOid ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const object = store.getObject(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(store, ref.oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, `application/x-${service}-advertisement`, Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// ls-refs (protocol v2)

interface V2Request {
  command: string;
  args: string[];
}

function parseV2Request(body: Buffer): V2Request | null {
  const { packets } = parsePackets(body);
  const header: string[] = [];
  const args: string[] = [];
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      section = 1;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) header.push(line);
    else args.push(line);
  }
  const commandLine = header.find((line) => line.startsWith('command='));
  if (commandLine === undefined) return null;
  return { command: commandLine.slice('command='.length), args };
}

export function handleLsRefs(store: Store, res: ServerResponse, repo: Repo, args: readonly string[]): void {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      lines.push(symrefs ? `${headOid} HEAD symref-target:${headTarget}` : `${headOid} HEAD`);
    } else if (unborn) {
      lines.push(symrefs ? `unborn HEAD symref-target:${headTarget}` : 'unborn HEAD');
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel) {
      const object = store.getObject(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(store, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  const parts = lines.map((line) => pktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// fetch

interface FetchPlan {
  objects: GitObject[];
  shallowLines: string[];
  unshallowLines: string[];
  ackLines: string[];
}

/** Tree+blob closure of one commit (not its ancestors), memoised in the store. */
function treeClosure(store: Store, commitOid: string, into: Set<string>): void {
  for (const oid of store.commitTreeIds(commitOid)) into.add(oid);
}

function planFetch(store: Store, request: {
  wants: readonly string[];
  haves: readonly string[];
  shallow: readonly string[];
  depth: number | null;
}): FetchPlan {
  const shallowSet = new Set(request.shallow);
  const held = new Set<string>();
  for (const have of request.haves) {
    if (!store.getObject(have)) continue;
    if (shallowSet.has(have)) {
      held.add(have);
      treeClosure(store, have, held);
    } else {
      for (const oid of store.reachableSet(have)) held.add(oid);
    }
  }
  for (const boundary of request.shallow) {
    if (!store.getObject(boundary)) continue;
    held.add(boundary);
    treeClosure(store, boundary, held);
  }

  // Which commits to include. A want may be an annotated tag: the tag object travels too, and
  // its history is the commit it peels to.
  const included = new Set<string>();
  const extraObjects = new Set<string>();
  const startCommits: string[] = [];
  for (const want of request.wants) {
    const object = store.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      extraObjects.add(want);
      const peeled = peelToCommit(store, want);
      if (peeled !== null) startCommits.push(peeled);
    } else if (object.type === 'commit') {
      startCommits.push(want);
    }
  }
  const boundary = new Set<string>();
  if (request.depth !== null) {
    const depth = Math.max(1, request.depth);
    const queue: Array<{ oid: string; dist: number }> = startCommits.map((oid) => ({ oid, dist: 0 }));
    const seenDist = new Map<string, number>();
    while (queue.length > 0) {
      const { oid, dist } = queue.shift() as { oid: string; dist: number };
      if (seenDist.has(oid) && (seenDist.get(oid) as number) <= dist) continue;
      seenDist.set(oid, dist);
      const object = store.getObject(oid);
      if (object === undefined || object.type !== 'commit') continue;
      included.add(oid);
      const parents = parseCommit(object.data).parents;
      for (const parent of parents) {
        if (dist + 1 < depth) queue.push({ oid: parent, dist: dist + 1 });
      }
    }
    // Boundary = included commits with a parent that exists but is not included.
    for (const oid of included) {
      const object = store.getObject(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !included.has(parent) && store.getObject(parent) !== undefined)) boundary.add(oid);
    }
  } else {
    for (const start of startCommits) {
      for (const oid of store.ancestorsOf(start)) included.add(oid);
    }
  }

  const objectIds = new Set<string>();
  for (const oid of extraObjects) if (!held.has(oid)) objectIds.add(oid);
  for (const oid of included) {
    if (held.has(oid)) continue;
    objectIds.add(oid);
    const closure = new Set<string>();
    treeClosure(store, oid, closure);
    for (const treeOid of closure) if (!held.has(treeOid)) objectIds.add(treeOid);
  }

  const objects: GitObject[] = [];
  for (const oid of objectIds) {
    const object = store.getObject(oid);
    if (object !== undefined) objects.push(object);
  }

  const shallowLines: string[] = [];
  const unshallowLines: string[] = [];
  if (request.depth !== null) {
    for (const oid of boundary) shallowLines.push(oid);
    for (const old of request.shallow) {
      if (included.has(old) && !boundary.has(old)) unshallowLines.push(old);
    }
  }

  const ackLines: string[] = [];
  const common = request.haves.filter((have) => store.getObject(have) !== undefined);
  if (common.length > 0) {
    for (const have of common) ackLines.push(`ACK ${have}`);
    ackLines.push('ready');
  } else {
    ackLines.push('NAK');
  }
  return { objects, shallowLines, unshallowLines, ackLines };
}

/** Sideband-frame a pack: band-1 chunks as pkt-lines, then flush. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleFetchV2(store: Store, res: ServerResponse, repo: Repo, args: readonly string[]): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
  }
  const plan = planFetch(store, { wants, haves, shallow, depth });
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  for (const line of plan.ackLines) parts.push(pktLine(`${line}\n`));
  parts.push(PKT_FLUSH);
  if (plan.shallowLines.length > 0 || plan.unshallowLines.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** A minimal protocol-v0 fetch (want/have sections), for clients that never upgrade to v2. */
export function handleFetchV0(store: Store, res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets } = parsePackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
  }
  const plan = planFetch(store, { wants, haves, shallow, depth });
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  for (const oid of plan.shallowLines) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowLines) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = haves.filter((have) => store.getObject(have) !== undefined);
  if (common.length > 0) parts.push(pktLine(`ACK ${common[0]}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(sidebandPack(pack));
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** POST git-upload-pack dispatcher: v2 commands, or a v0 request body. */
export function handleUploadPack(store: Store, req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const protocolHeader = req.headers['git-protocol'];
  const isV2 = typeof protocolHeader === 'string' && protocolHeader.includes('version=2');
  if (isV2) {
    const parsed = parseV2Request(body);
    if (parsed === null) {
      sendGitError(res, 400, 'Bad Request');
      return;
    }
    if (parsed.command === 'ls-refs') {
      handleLsRefs(store, res, repo, parsed.args);
      return;
    }
    if (parsed.command === 'fetch') {
      handleFetchV2(store, res, repo, parsed.args);
      return;
    }
    sendGitError(res, 400, 'Bad Request');
    return;
  }
  // A malformed body (not pkt-lines at all) gets a plain 400; a well-formed v0 request is served.
  if (body.length > 0 && !/^[0-9a-fA-F]{4}$/.test(body.subarray(0, 4).toString('ascii'))) {
    sendGitError(res, 400, 'Bad Request');
    return;
  }
  handleFetchV0(store, res, repo, body);
}

// ---------------------------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, res: ServerResponse, repo: Repo, body: Buffer): void {
  const { packets, next } = parsePackets(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  let sawFlush = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sawFlush = true;
      break;
    }
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length === 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
  }
  if (!sawFlush && commands.length === 0) {
    sendGitError(res, 400, 'Bad Request');
    return;
  }
  // parsePackets stops at the first non-pkt-line bytes, which is exactly where the pack begins
  // (a pack starts with "PACK", never a hex length), so `next` is the pack's offset.
  const packBytes = body.subarray(next);
  let unpackOk = true;
  let unpackDetail = 'ok';
  const hasPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => store.getObject(oid));
      for (const [oid, object] of objects) {
        if (!store.objects.has(oid)) store.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
      unpackDetail = 'error packfile could not be unpacked';
    }
  } else if (hasPack) {
    // A command list that updates a ref always carries a pack (possibly an empty one).
    unpackOk = true;
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (current === ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'reference not found' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (store.getObject(command.newOid) === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (command.oldOid !== ZERO_OID) {
      const newObject = store.getObject(command.newOid);
      const oldObject = store.getObject(command.oldOid);
      if (newObject?.type === 'commit' && oldObject?.type === 'commit' && !store.isAncestor(command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const reportLines: string[] = [`unpack ${unpackDetail}`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}` : `ng ${result.ref} ${result.reason}`);
  }
  const reportParts = reportLines.map((line) => pktLine(`${line}\n`));
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  const wantsSideband = capabilities.split(' ').includes('side-band-64k');
  if (wantsSideband) {
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      const chunk = report.subarray(offset, Math.min(report.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(PKT_FLUSH);
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
  } else {
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', report);
  }
}
