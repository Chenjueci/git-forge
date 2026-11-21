// The forge's in-memory store: git objects (content-addressed, shared across repos), repositories
// with refs, and the REST-level resources (labels, issues, pull requests) that sit on top of them.
// Everything is deterministic: ids and timestamps come from logical counters, never from a clock
// or a random source, so two identical request sequences produce identical state.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

/** sha1("<type> <size>\0" + data), the git object id. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

/** Serialise tree entries, sorted the way git sorts them (directories as if named "name/"). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build commit object bytes from fields; `author`/`committer` are full "Name <email> ts tz" lines. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object's bytes. */
export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
  }
  return view;
}

// ---------------------------------------------------------------------------------------------
// resources

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string | null;
  seq: number;
}

export interface IssueComment {
  id: number;
  body: string;
  userLogin: string;
  seq: number;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  closedSeq: number | null;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  /** Branch tips captured at creation, used when a branch later disappears. */
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  seq: number;
  draft: boolean;
}

export interface Repo {
  id: number;
  name: string;
  owner: string | null;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  seq: number;
}

/** The epoch every generated timestamp derives from: 2025-01-01T00:00:00Z plus a logical offset. */
export const EPOCH_BASE = 1_735_689_600;

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  viewerLogin: string | null = null;
  viewerId = 1000;
  private seq = 0;
  private repoIdCounter = 5000;
  private resourceIdCounter = 100_000;
  private labelIdCounter = 200_000;

  /** The next logical sequence number; every created thing takes one, in request order. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  nextRepoId(): number {
    this.repoIdCounter += 1;
    return this.repoIdCounter;
  }

  nextResourceId(): number {
    this.resourceIdCounter += 1;
    return this.resourceIdCounter;
  }

  nextLabelId(): number {
    this.labelIdCounter += 1;
    return this.labelIdCounter;
  }

  /** An ISO timestamp for a logical sequence number (deterministic, strictly increasing in seq). */
  isoFor(seq: number): string {
    return new Date((EPOCH_BASE + seq * 61) * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** An epoch-seconds timestamp for a logical sequence number. */
  epochFor(seq: number): number {
    return EPOCH_BASE + seq * 61;
  }

  /** The viewer's git identity line for commits the forge itself authors. */
  identityFor(seq: number): string {
    const login = this.viewerLogin ?? 'viewer';
    return `${login} <${login}@example.invalid> ${this.epochFor(seq)} +0000`;
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Record the viewer's login the first time an owner-bearing request names one. */
  learnViewer(owner: string): void {
    if (this.viewerLogin === null && owner !== '') this.viewerLogin = owner;
  }

  createRepo(name: string, options: { isPrivate: boolean; description: string }): Repo {
    const repo: Repo = {
      id: this.nextRepoId(),
      name,
      owner: this.viewerLogin,
      isPrivate: options.isPrivate,
      description: options.description,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.nextSeq(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  /**
   * Resolve a repository by an owner/name pair from a request path. Learns the viewer and binds an
   * unbound repository's owner from the first owner-bearing request that names it; a mismatched
   * owner (once anything is known) is a miss, which callers turn into a 404.
   */
  resolveRepo(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (repo.owner === null) {
      this.learnViewer(owner);
      repo.owner = this.viewerLogin ?? owner;
    }
    if (owner !== repo.owner) return null;
    return repo;
  }

  /** The tip commit of a branch ref, or null when the branch does not exist. */
  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Flatten a tree (recursively) into path -> {mode, oid}; `treeOid` may be null (empty tree). */
  flattenTree(treeOid: string | null, prefix = '', out = new Map<string, { mode: string; oid: string }>()): Map<string, { mode: string; oid: string }> {
    if (treeOid === null) return out;
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return out;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
    return out;
  }

  /** Rebuild nested trees from a flat path map; returns the root tree oid (the empty tree's when empty). */
  buildTreeFromFlat(flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
    interface Node {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, value] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i] as string;
        if (!node.dirs.has(segment)) node.dirs.set(segment, { files: new Map(), dirs: new Map() });
        node = node.dirs.get(segment) as Node;
      }
      node.files.set(segments[segments.length - 1] as string, value);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** The tree oid of a commit, or null when the commit is unknown. */
  commitTree(commitOid: string): string | null {
    const object = this.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  private ancestorCache = new Map<string, string[]>();
  private treeIdsCache = new Map<string, Set<string>>();
  private reachableCache = new Map<string, Set<string>>();

  /** All ancestors of `tip` (including itself), breadth-first from the tip. Memoised: objects are immutable. */
  ancestorsOf(tip: string): string[] {
    const cached = this.ancestorCache.get(tip);
    if (cached !== undefined) return cached;
    const order: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      order.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    this.ancestorCache.set(tip, order);
    return order;
  }

  /** The tree+blob object ids of one commit's tree (not its ancestors). Memoised. */
  commitTreeIds(commitOid: string): Set<string> {
    const cached = this.treeIdsCache.get(commitOid);
    if (cached !== undefined) return cached;
    const out = new Set<string>();
    const object = this.objects.get(commitOid);
    if (object !== undefined && object.type === 'commit') {
      const stack = [parseCommit(object.data).tree];
      while (stack.length > 0) {
        const oid = stack.pop() as string;
        if (out.has(oid)) continue;
        const entry = this.objects.get(oid);
        if (entry === undefined) continue;
        out.add(oid);
        if (entry.type === 'tree') {
          for (const child of parseTree(entry.data)) stack.push(child.oid);
        }
      }
    }
    this.treeIdsCache.set(commitOid, out);
    return out;
  }

  /** Reachable set from a single tip, memoised (see reachableFrom for the general form). */
  reachableSet(tip: string): Set<string> {
    const cached = this.reachableCache.get(tip);
    if (cached !== undefined) return cached;
    const out = this.reachableFrom([tip]);
    this.reachableCache.set(tip, out);
    return out;
  }

  /** Whether `ancestor` is `descendant` itself or one of its ancestors. */
  isAncestor(ancestor: string, descendant: string): boolean {
    return this.ancestorsOf(descendant).includes(ancestor);
  }

  /** A common ancestor of two commits (the first of a's ancestors that is also an ancestor of b). */
  mergeBase(a: string, b: string): string | null {
    const bAncestors = new Set(this.ancestorsOf(b));
    for (const candidate of this.ancestorsOf(a)) {
      if (bAncestors.has(candidate)) return candidate;
    }
    return null;
  }

  /** Every object reachable from the given tips (commits walk to trees and blobs; tags peel). */
  reachableFrom(tips: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const object = this.objects.get(oid);
      if (object === undefined) continue;
      out.add(oid);
      if (object.type === 'commit') {
        const view = parseCommit(object.data);
        stack.push(view.tree);
        for (const parent of view.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return out;
  }
}

/** The one store the whole server shares. */
export const store = new Store();
