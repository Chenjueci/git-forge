// MCP (streamable HTTP) at /mcp: JSON-RPC over POST, modern-era discovery
// (server/discover → 2026-07-28) plus the legacy initialize handshake, and six tools that read
// and write the same store the REST and GraphQL surfaces serve. Tool results carry the created
// or read object both as JSON text and as structuredContent, with the REST views' exact shape
// (ids, numbers, full_name) so cross-surface parity holds.

import type { Store, Repo } from './store.ts';
import { repoView, issueView, pullView, createPullRecord, performMerge } from './rest.ts';

export interface MCPRequest {
  method: string;
  rawBody: Buffer;
  sessionId: string | null;
  protocolVersion: string | null;
}

export interface MCPReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const MODERN_VERSION = '2026-07-28';
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// The tool list is a fixed constant: two tools/list calls must answer byte-identically.
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'One of open, closed, all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
] as const;

interface RpcError {
  code: number;
  message: string;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, error: RpcError): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error };
}

function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function resolveRepoArg(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = stringArg(args, 'owner');
  const repo = stringArg(args, 'repo');
  if (owner === '' || repo === '') return null;
  store.learnViewer(owner);
  return store.resolveRepo(owner, repo);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> | RpcError {
  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name');
      if (repoName === '') return toolError('name is required');
      if (store.repos.has(repoName)) return toolError(`repository ${repoName} already exists`);
      const repo = store.createRepo(repoName, {
        isPrivate: args.private !== false,
        description: stringArg(args, 'description'),
      });
      return toolOk(repoView(store, repo));
    }
    case 'get_repo': {
      const repo = resolveRepoArg(store, args);
      if (repo === null) return toolError('repository not found');
      return toolOk(repoView(store, repo));
    }
    case 'create_issue': {
      const owner = stringArg(args, 'owner');
      const repoName = stringArg(args, 'repo');
      const title = stringArg(args, 'title');
      if (owner === '' || repoName === '' || title === '') {
        return toolError('owner, repo and title are required');
      }
      const repo = resolveRepoArg(store, args);
      if (repo === null) return toolError('repository not found');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue = {
        number,
        id: store.nextResourceId(),
        title,
        body: stringArg(args, 'body'),
        state: 'open' as const,
        labels: [] as string[],
        comments: [],
        seq: store.nextSeq(),
        closedSeq: null,
      };
      repo.issues.set(number, issue);
      return toolOk(issueView(store, repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepoArg(store, args);
      if (repo === null) return toolError('repository not found');
      const state = stringArg(args, 'state') || 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.seq - b.seq)
        .map((issue) => issueView(store, repo, issue));
      return toolOk(issues);
    }
    case 'create_pull_request': {
      const repo = resolveRepoArg(store, args);
      if (repo === null) return toolError('repository not found');
      const created = createPullRecord(store, repo, {
        title: stringArg(args, 'title'),
        body: stringArg(args, 'body'),
        head: stringArg(args, 'head'),
        base: stringArg(args, 'base'),
      });
      if (created === 'invalid') return toolError('invalid head or base branch');
      if (created === 'exists') return toolError('a pull request already exists for this branch');
      return toolOk(pullView(store, repo, created));
    }
    case 'merge_pull_request': {
      const repo = resolveRepoArg(store, args);
      if (repo === null) return toolError('repository not found');
      const raw = args.pull_number;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolError('pull request not found');
      const result = performMerge(store, repo, pull, 'merge');
      if (result.outcome === 'conflict') return toolError('merge conflict');
      if (result.outcome === 'not-mergeable') return toolError('pull request is not mergeable');
      return toolOk(pullView(store, repo, pull));
    }
    default:
      return { code: -32602, message: `unknown tool: ${name}` };
  }
}

function handleRpc(store: Store, message: Record<string, unknown>): { status: number; body: unknown } | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? (message.method as string) : '';
  const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  if (method === 'server/discover') {
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: [MODERN_VERSION],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : '';
    const protocolVersion = LEGACY_VERSIONS.includes(requested) || requested === MODERN_VERSION ? requested : LEGACY_VERSIONS[0];
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      }),
    };
  }
  if (method.startsWith('notifications/')) {
    return isNotification ? null : { status: 200, body: rpcResult(id, {}) };
  }
  if (isNotification) return null;
  if (method === 'ping') return { status: 200, body: rpcResult(id, {}) };
  if (method === 'tools/list') {
    return { status: 200, body: rpcResult(id, { tools: TOOLS }) };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? (params.name as string) : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    if (!TOOLS.some((tool) => tool.name === name)) {
      return { status: 200, body: rpcError(id, { code: -32602, message: `unknown tool: ${name}` }) };
    }
    const result = callTool(store, name, args);
    if ('code' in result && 'message' in result && !('content' in result)) {
      return { status: 200, body: rpcError(id, result as RpcError) };
    }
    return { status: 200, body: rpcResult(id, result) };
  }
  return { status: 200, body: rpcError(id, { code: -32601, message: `method not found: ${method}` }) };
}

export function handleMCP(store: Store, request: MCPRequest): MCPReply {
  if (request.method === 'DELETE') return { status: 200, body: undefined };
  if (request.method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
  const text = request.rawBody.toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const idMatch = /"id"\s*:\s*(\d+|"[^"]*")/.exec(text);
    let id: unknown = null;
    if (idMatch !== null) {
      const raw = idMatch[1] as string;
      id = raw.startsWith('"') ? raw.slice(1, -1) : Number(raw);
    }
    return { status: 400, body: rpcError(id, { code: -32700, message: 'Parse error' }) };
  }
  if (Array.isArray(parsed)) {
    const responses: unknown[] = [];
    for (const entry of parsed) {
      if (typeof entry === 'object' && entry !== null) {
        const handled = handleRpc(store, entry as Record<string, unknown>);
        if (handled !== null) responses.push(handled.body);
      }
    }
    return { status: 200, body: responses };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 200, body: rpcError(null, { code: -32600, message: 'Invalid Request' }) };
  }
  const handled = handleRpc(store, parsed as Record<string, unknown>);
  if (handled === null) return { status: 202, body: undefined };
  return { status: handled.status, body: handled.body };
}
