// The forge's HTTP surface, wired from the three protocol modules:
//   - git smart HTTP at /<owner>/<repo>.git/info/refs, git-upload-pack, git-receive-pack
//   - GitHub REST v3 under /api/v3
//   - GraphQL at /api/graphql and MCP (streamable HTTP) at /mcp
// plus GET /healthz. Everything is served from one in-memory store. Authentication is the shop
// token from MAKEFUN_SHOP_TOKEN as a Bearer token; when the env var is unset (local development)
// any token is accepted so the checks' unauthenticated cases can still be exercised by hand.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return requestCounter.toString(16).toUpperCase().padStart(8, '0');
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return true;
  const header = req.headers.authorization;
  return header === `Bearer ${expected}`;
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Requires authentication' });
}

export function createApp() {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await route(req, res);
    } catch {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    }
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const path = url.pathname;

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/<endpoint>
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repoName = decodeURIComponent(gitMatch[2] as string);
    store.learnViewer(owner);
    const repo = store.resolveRepo(owner, repoName);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    const endpoint = gitMatch[3] as string;
    if (endpoint === 'info/refs') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Bad Request' });
        return;
      }
      res.setHeader('x-github-request-id', nextRequestId());
      handleInfoRefs(store, req, res, repo, service);
      return;
    }
    const body = await readBody(req);
    res.setHeader('x-github-request-id', nextRequestId());
    if (endpoint === 'git-upload-pack') handleUploadPack(store, req, res, repo, body);
    else handleReceivePack(store, res, repo, body);
    return;
  }

  // GraphQL.
  if (path === '/api/graphql') {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const body = await readBody(req);
    const reply = handleGraphQL(store, { method, rawBody: body });
    sendJson(res, reply.status, reply.body, reply.headers);
    return;
  }

  // MCP.
  if (path === '/mcp' || path.startsWith('/mcp/')) {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const body = await readBody(req);
    const reply = handleMCP(store, {
      method,
      rawBody: body,
      sessionId: typeof req.headers['mcp-session-id'] === 'string' ? (req.headers['mcp-session-id'] as string) : null,
      protocolVersion: typeof req.headers['mcp-protocol-version'] === 'string' ? (req.headers['mcp-protocol-version'] as string) : null,
    });
    sendJson(res, reply.status, reply.body, reply.headers);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      unauthorized(res);
      return;
    }
    const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    let parsedBody: Record<string, unknown> | undefined;
    if (rawBody.length > 0) {
      try {
        const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return;
        }
        parsedBody = parsed as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const segments = path
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map((segment) => decodeURIComponent(segment));
    const host = req.headers.host ?? 'localhost';
    const request: RestRequest = {
      method,
      segments,
      query: url.searchParams,
      body: parsedBody,
      origin: `http://${host}`,
      path,
    };
    const reply = handleRest(store, request);
    const headers: Record<string, string> = { ...(reply.headers ?? {}) };
    if (segments.length === 0) headers['x-oauth-scopes'] = 'repo, user';
    sendJson(res, reply.status, reply.body, headers);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}
