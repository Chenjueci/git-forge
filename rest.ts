// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments and pull
// requests (including squash/merge with three-way conflict detection), all backed by the git
// object store — a contents PUT is a real commit, a merge is a real commit on the base branch.

import { buildCommit, parseCommit, type Repo, type Store, type Issue, type Pull } from './store.ts';

export interface RestRequest {
  method: string;
  /** Decoded path segments after /api/v3 (empty for the root). */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body (undefined when absent or not an object/array). */
  body: Record<string, unknown> | undefined;
  /** The request's absolute base (http://host) for Link headers. */
  origin: string;
  /** The /api/v3 path with a leading slash, for building absolute URLs. */
  path: string;
}

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const reply = (status: number, body?: unknown, headers?: Record<string, string>): RestReply => ({ status, body, headers });
const notFound = (): RestReply => reply(404, { message: 'Not Found' });
const unprocessable = (message: string): RestReply => reply(422, { message });

// ---------------------------------------------------------------------------------------------
// views

export function userView(store: Store, login: string): Record<string, unknown> {
  return {
    login,
    id: store.viewerId,
    node_id: `U_${store.viewerId}`,
    type: 'User',
    name: login,
    email: `${login}@example.invalid`,
    site_admin: false,
    avatar_url: '',
    html_url: '',
  };
}

export function repoView(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin ?? 'viewer';
  let openIssues = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openIssues += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: userView(store, owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: store.isoFor(repo.seq),
    updated_at: store.isoFor(repo.seq),
    pushed_at: store.isoFor(repo.seq),
    html_url: '',
    clone_url: '',
    ssh_url: '',
    fork: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    size: 0,
    language: null,
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(0).toISOString().replace('.000Z', 'Z') };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString().replace('.000Z', 'Z'),
  };
}

export function commitView(store: Store, oid: string): Record<string, unknown> | null {
  const object = store.getObject(oid);
  if (object === undefined || object.type !== 'commit') return null;
  const view = parseCommit(object.data);
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: parseIdentity(view.author),
      committer: parseIdentity(view.committer),
      message: view.message.replace(/\n$/, ''),
      tree: { sha: view.tree, url: '' },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: view.parents.map((parent) => ({ sha: parent, url: '' })),
    html_url: '',
  };
}

function labelView(store: Store, repo: Repo, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (label === undefined) return null;
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: '',
  };
}

export function issueView(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin ?? 'viewer';
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelView(store, repo, name) ?? { name }),
    user: userView(store, owner),
    assignees: [],
    comments: issue.comments.length,
    created_at: store.isoFor(issue.seq),
    updated_at: store.isoFor(issue.seq),
    closed_at: issue.closedSeq !== null ? store.isoFor(issue.closedSeq) : null,
    html_url: '',
  };
}

function pullAsIssueView(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin ?? 'viewer';
  return {
    id: pull.id,
    node_id: `I_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    labels: [],
    user: userView(store, owner),
    assignees: [],
    comments: 0,
    created_at: store.isoFor(pull.seq),
    updated_at: store.isoFor(pull.seq),
    closed_at: pull.state === 'closed' ? store.isoFor(pull.mergedSeq ?? pull.seq) : null,
    pull_request: { url: '', html_url: '', diff_url: '', patch_url: '' },
    html_url: '',
  };
}

export function pullView(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.owner ?? store.viewerLogin ?? 'viewer';
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = store.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const repoJson = repoView(store, repo);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: userView(store, owner),
    labels: [],
    draft: pull.draft,
    head: {
      label: `${owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: userView(store, owner),
      repo: repoJson,
    },
    base: {
      label: `${owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: userView(store, owner),
      repo: repoJson,
    },
    merged: pull.merged,
    merged_at: pull.mergedSeq !== null ? store.isoFor(pull.mergedSeq) : null,
    merge_commit_sha: pull.mergeCommitSha,
    closed_at: pull.state === 'closed' ? store.isoFor(pull.mergedSeq ?? pull.seq) : null,
    created_at: store.isoFor(pull.seq),
    updated_at: store.isoFor(pull.seq),
    html_url: '',
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commentView(store: Store, repo: Repo, comment: { id: number; body: string; userLogin: string; seq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userView(store, comment.userLogin),
    created_at: store.isoFor(comment.seq),
    updated_at: store.isoFor(comment.seq),
    html_url: '',
  };
}

// ---------------------------------------------------------------------------------------------
// pagination

function paginate(request: RestRequest, items: unknown[]): RestReply {
  const perPageRaw = Number(request.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.trunc(perPageRaw)) : 30;
  const pageRaw = Number(request.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => `${request.origin}${request.path}?per_page=${perPage}&page=${p}`;
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
    links.push(`<${urlFor(1)}>; rel="first"`);
  }
  return reply(200, slice, links.length > 0 ? { link: links.join(', ') } : {});
}

// ---------------------------------------------------------------------------------------------
// tree diffs and commits

type FlatTree = Map<string, { mode: string; oid: string }>;

function flatOfCommit(store: Store, commitOid: string | null): FlatTree {
  if (commitOid === null) return new Map();
  const tree = store.commitTree(commitOid);
  return store.flattenTree(tree);
}

interface TreeChange {
  path: string;
  from: { mode: string; oid: string } | null;
  to: { mode: string; oid: string } | null;
}

function diffTrees(before: FlatTree, after: FlatTree): TreeChange[] {
  const changes: TreeChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of paths) {
    const from = before.get(path) ?? null;
    const to = after.get(path) ?? null;
    if (from?.oid === to?.oid && from?.mode === to?.mode) continue;
    if (from === null && to === null) continue;
    changes.push({ path, from, to });
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : 1));
}

function lineCount(text: string): number {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Make one commit on `branch` applying `changes` (path -> bytes, or null to delete). */
function commitChanges(
  store: Store,
  repo: Repo,
  branch: string,
  changes: ReadonlyMap<string, Buffer | null>,
  message: string,
): string {
  const tip = store.branchTip(repo, branch);
  const flat = flatOfCommit(store, tip);
  for (const [path, bytes] of changes) {
    if (bytes === null) flat.delete(path);
    else flat.set(path, { mode: '100644', oid: store.putObject('blob', bytes) });
  }
  const tree = store.buildTreeFromFlat(flat);
  const seq = store.nextSeq();
  const identity = store.identityFor(seq);
  const commit = buildCommit({
    tree,
    parents: tip !== null ? [tip] : [],
    author: identity,
    committer: identity,
    message,
  });
  const oid = store.putObject('commit', commit);
  repo.refs.set(`refs/heads/${branch}`, oid);
  return oid;
}

// ---------------------------------------------------------------------------------------------
// the router

export function handleRest(store: Store, request: RestRequest): RestReply {
  const seg = request.segments;
  const method = request.method;

  // The API root and service endpoints.
  if (seg.length === 0) {
    if (method !== 'GET') return notFound();
    return reply(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues',
      rate_limit_url: '/api/v3/rate_limit',
    });
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return reply(200, { verifiable_password_authentication: false, installed_version: '3.99.0', github_services_sha: 'forge' });
  }
  if (seg[0] === 'rate_limit' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return reply(200, {
      resources: { core: { limit: 5000, remaining: 4999, reset: 2_000_000_000, used: 1 } },
      rate: { limit: 5000, remaining: 4999, reset: 2_000_000_000, used: 1 },
    });
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    const login = store.viewerLogin ?? 'viewer';
    return reply(200, userView(store, login));
  }

  // Repository creation and the viewer's list.
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'POST') {
      const name = typeof request.body?.name === 'string' ? (request.body.name as string) : '';
      if (name === '') return unprocessable('Repository creation failed.');
      if (store.repos.has(name)) {
        return reply(422, {
          message: 'Repository creation failed.',
          errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
        });
      }
      const repo = store.createRepo(name, {
        isPrivate: request.body?.private !== false,
        description: typeof request.body?.description === 'string' ? (request.body.description as string) : '',
      });
      return reply(201, repoView(store, repo));
    }
    if (method === 'GET') {
      const repos = [...store.repos.values()]
        .filter((repo) => repo.owner === null || repo.owner === store.viewerLogin)
        .sort((a, b) => a.seq - b.seq)
        .map((repo) => repoView(store, repo));
      return paginate(request, repos);
    }
    return notFound();
  }

  if (seg[0] !== 'repos' || seg.length < 3) return notFound();
  const owner = seg[1] as string;
  const repoName = seg[2] as string;
  store.learnViewer(owner);
  const repo = store.resolveRepo(owner, repoName);
  if (repo === null) return notFound();
  const rest = seg.slice(3);
  const body = request.body ?? {};

  // The repository itself.
  if (rest.length === 0) {
    if (method === 'GET') return reply(200, repoView(store, repo));
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description as string;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private as boolean;
      if (typeof body.name === 'string' && (body.name as string) !== repo.name) {
        const next = body.name as string;
        if (!store.repos.has(next)) {
          store.repos.delete(repo.name);
          repo.name = next;
          store.repos.set(next, repo);
        }
      }
      if (typeof body.default_branch === 'string') repo.defaultBranch = body.default_branch as string;
      return reply(200, repoView(store, repo));
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.name);
      return reply(204);
    }
    return notFound();
  }

  // Branches.
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, oid]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: oid, url: '' },
        protected: false,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return paginate(request, branches);
  }
  if (rest[0] === 'branches' && rest.length === 2 && method === 'GET') {
    const branch = (rest[1] as string).replace(/~SLASH~/g, '/');
    const tip = store.branchTip(repo, branch);
    if (tip === null) return notFound();
    return reply(200, { name: branch, commit: commitView(store, tip), protected: false });
  }

  // Commits.
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const shaParam = request.query.get('sha');
    let tip: string | null;
    if (shaParam === null || shaParam === '') tip = store.branchTip(repo, repo.defaultBranch);
    else if (/^[0-9a-f]{40}$/i.test(shaParam)) tip = store.getObject(shaParam.toLowerCase())?.type === 'commit' ? shaParam.toLowerCase() : null;
    else tip = store.branchTip(repo, shaParam) ?? (repo.refs.get(`refs/tags/${shaParam}`) ?? null);
    if (tip === null) return reply(200, []);
    const commits = store
      .ancestorsOf(tip)
      .map((oid) => commitView(store, oid))
      .filter((view) => view !== null);
    return paginate(request, commits);
  }
  if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
    const view = commitView(store, (rest[1] as string).toLowerCase());
    return view === null ? notFound() : reply(200, view);
  }

  // Git refs over REST.
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'GET') {
      const refs = [...repo.refs.entries()].map(([ref, oid]) => ({
        ref,
        node_id: `REF_${ref}`,
        object: { sha: oid, type: store.getObject(oid)?.type ?? 'commit', url: '' },
      }));
      return reply(200, refs);
    }
    if (rest.length === 2 && method === 'POST') {
      const ref = typeof body.ref === 'string' ? (body.ref as string) : '';
      const sha = typeof body.sha === 'string' ? (body.sha as string).toLowerCase() : '';
      if (ref === '' || store.getObject(sha) === undefined) return unprocessable('Validation Failed');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      repo.refs.set(ref, sha);
      return reply(201, { ref, node_id: `REF_${ref}`, object: { sha, type: store.getObject(sha)?.type ?? 'commit', url: '' } });
    }
    if (rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      if (method === 'GET') {
        const oid = repo.refs.get(ref);
        if (oid === undefined) return notFound();
        return reply(200, { ref, node_id: `REF_${ref}`, object: { sha: oid, type: store.getObject(oid)?.type ?? 'commit', url: '' } });
      }
      if (method === 'DELETE') {
        if (!repo.refs.delete(ref)) return notFound();
        return reply(204);
      }
    }
    return notFound();
  }

  // Contents.
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).join('/');
    return handleContents(store, request, repo, filePath);
  }

  // Labels.
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      const labels = [...repo.labels.values()].sort((a, b) => a.seq - b.seq).map((label) => labelView(store, repo, label.name));
      return paginate(request, labels);
    }
    if (rest.length === 1 && method === 'POST') {
      const name = typeof body.name === 'string' ? (body.name as string) : '';
      if (name === '') return unprocessable('Validation Failed');
      if (repo.labels.has(name)) return unprocessable('Validation Failed');
      const label = {
        id: store.nextLabelId(),
        name,
        color: typeof body.color === 'string' ? (body.color as string).replace(/^#/, '') : 'ededed',
        description: typeof body.description === 'string' ? (body.description as string) : null,
        seq: store.nextSeq(),
      };
      repo.labels.set(name, label);
      return reply(201, labelView(store, repo, name));
    }
    if (rest.length === 2) {
      const name = decodeURIComponent(rest[1] as string);
      if (method === 'GET') {
        const view = labelView(store, repo, name);
        return view === null ? notFound() : reply(200, view);
      }
      if (method === 'DELETE') {
        if (!repo.labels.delete(name)) return notFound();
        return reply(204);
      }
    }
    return notFound();
  }

  // Issues and their comments.
  if (rest[0] === 'issues') {
    return handleIssues(store, request, repo, rest.slice(1));
  }

  // Pull requests.
  if (rest[0] === 'pulls') {
    return handlePulls(store, request, repo, rest.slice(1));
  }

  return notFound();
}

// ---------------------------------------------------------------------------------------------
// contents

function resolveRefTip(store: Store, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return store.branchTip(repo, repo.defaultBranch);
  const branch = store.branchTip(repo, ref);
  if (branch !== null) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) {
    let current = tag;
    for (let i = 0; i < 10; i += 1) {
      const object = store.getObject(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type !== 'tag') return null;
      const text = object.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match === null) return null;
      current = match[1] as string;
    }
    return null;
  }
  if (/^[0-9a-f]{40}$/i.test(ref) && store.getObject(ref.toLowerCase())?.type === 'commit') return ref.toLowerCase();
  return null;
}

function handleContents(store: Store, request: RestRequest, repo: Repo, filePath: string): RestReply {
  const method = request.method;
  const body = request.body ?? {};

  if (method === 'GET') {
    const tip = resolveRefTip(store, repo, request.query.get('ref'));
    if (tip === null) return notFound();
    const tree = store.commitTree(tip);
    if (tree === null) return notFound();
    if (filePath === '') return reply(200, dirListing(store, tree, ''));
    // Walk to the target.
    const segments = filePath.split('/');
    let currentTree: string | null = tree;
    for (let i = 0; i < segments.length - 1; i += 1) {
      currentTree = childTree(store, currentTree, segments[i] as string);
      if (currentTree === null) return notFound();
    }
    const leaf = segments[segments.length - 1] as string;
    const entry = treeEntry(store, currentTree, leaf);
    if (entry === null) return notFound();
    if (entry.mode === '40000' || entry.mode === '040000') {
      return reply(200, dirListing(store, entry.oid, filePath));
    }
    const blob = store.getObject(entry.oid);
    if (blob === undefined) return notFound();
    return reply(200, {
      name: leaf,
      path: filePath,
      sha: entry.oid,
      size: blob.data.length,
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      html_url: '',
      download_url: '',
    });
  }

  if (method === 'PUT') {
    const branch = typeof body.branch === 'string' ? (body.branch as string) : repo.defaultBranch;
    const message = typeof body.message === 'string' ? (body.message as string) : '';
    const contentB64 = typeof body.content === 'string' ? (body.content as string) : '';
    const bytes = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const tip = store.branchTip(repo, branch);
    const hasCommits = repo.refs.size > 0;
    if (tip === null && hasCommits && branch !== repo.defaultBranch) return notFound();
    if (tip === null && hasCommits && repo.refs.has(`refs/heads/${repo.defaultBranch}`)) return notFound();
    const flat = flatOfCommit(store, tip);
    const existing = flat.get(filePath);
    const providedSha = typeof body.sha === 'string' ? (body.sha as string).toLowerCase() : null;
    if (existing !== undefined && providedSha !== existing.oid) {
      return reply(409, { message: 'sha does not match' });
    }
    const commitSha = commitChanges(store, repo, branch, new Map([[filePath, bytes]]), message);
    const blobOid = store.putObject('blob', bytes);
    const commitObject = store.getObject(commitSha);
    const commitParsed = commitObject !== undefined ? parseCommit(commitObject.data) : null;
    return reply(existing !== undefined ? 200 : 201, {
      content: {
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        sha: blobOid,
        size: bytes.length,
        type: 'file',
        encoding: 'base64',
        html_url: '',
        download_url: '',
      },
      commit: {
        sha: commitSha,
        message: commitParsed?.message.replace(/\n$/, '') ?? message,
        tree: { sha: commitParsed?.tree ?? '' },
        parents: (commitParsed?.parents ?? []).map((parent) => ({ sha: parent })),
        html_url: '',
      },
    });
  }

  if (method === 'DELETE') {
    const branch = typeof body.branch === 'string' ? (body.branch as string) : repo.defaultBranch;
    const message = typeof body.message === 'string' ? (body.message as string) : '';
    const tip = store.branchTip(repo, branch);
    if (tip === null) return notFound();
    const flat = flatOfCommit(store, tip);
    const existing = flat.get(filePath);
    if (existing === undefined) return notFound();
    const providedSha = typeof body.sha === 'string' ? (body.sha as string).toLowerCase() : null;
    if (providedSha !== null && providedSha !== existing.oid) return reply(409, { message: 'sha does not match' });
    const commitSha = commitChanges(store, repo, branch, new Map([[filePath, null]]), message);
    return reply(200, { content: null, commit: { sha: commitSha } });
  }

  return notFound();
}

function treeEntry(store: Store, treeOid: string | null, name: string): { mode: string; oid: string } | null {
  if (treeOid === null) return null;
  const object = store.getObject(treeOid);
  if (object === undefined || object.type !== 'tree') return null;
  const data = object.data;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const entryName = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (entryName === name) return { mode, oid };
    offset = nul + 21;
  }
  return null;
}

function childTree(store: Store, treeOid: string | null, name: string): string | null {
  const entry = treeEntry(store, treeOid, name);
  if (entry === null || (entry.mode !== '40000' && entry.mode !== '040000')) return null;
  return entry.oid;
}

function dirListing(store: Store, treeOid: string, prefix: string): Record<string, unknown>[] {
  const object = store.getObject(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  const entries: Record<string, unknown>[] = [];
  const data = object.data;
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    const isDir = mode === '40000' || mode === '040000';
    const blob = isDir ? undefined : store.getObject(oid);
    entries.push({
      name,
      path: prefix === '' ? name : `${prefix}/${name}`,
      sha: oid,
      size: blob?.data.length ?? 0,
      type: isDir ? 'dir' : 'file',
      html_url: '',
      download_url: '',
    });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// issues

function handleIssues(store: Store, request: RestRequest, repo: Repo, rest: string[]): RestReply {
  const method = request.method;
  const body = request.body ?? {};

  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? (body.title as string) : '';
      const issueBody = typeof body.body === 'string' ? (body.body as string) : '';
      const labelNames = Array.isArray(body.labels) ? (body.labels as unknown[]).map((entry) => String(entry)) : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return unprocessable('Validation Failed');
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = {
        number,
        id: store.nextResourceId(),
        title,
        body: issueBody,
        state: 'open',
        labels: labelNames,
        comments: [],
        seq: store.nextSeq(),
        closedSeq: null,
      };
      repo.issues.set(number, issue);
      return reply(201, issueView(store, repo, issue));
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const direction = request.query.get('direction') ?? 'desc';
      const items: Array<{ seq: number; view: Record<string, unknown>; state: string }> = [];
      for (const issue of repo.issues.values()) {
        items.push({ seq: issue.seq, view: issueView(store, repo, issue), state: issue.state });
      }
      for (const pull of repo.pulls.values()) {
        items.push({ seq: pull.seq, view: pullAsIssueView(store, repo, pull), state: pull.state });
      }
      const filtered = items.filter((item) => state === 'all' || item.state === state);
      filtered.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return paginate(request, filtered.map((item) => item.view));
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const issue = repo.issues.get(number);

  if (rest.length === 1) {
    if (issue === undefined) {
      const pull = repo.pulls.get(number);
      if (pull !== undefined && method === 'GET') return reply(200, pullAsIssueView(store, repo, pull));
      return notFound();
    }
    if (method === 'GET') return reply(200, issueView(store, repo, issue));
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title as string;
      if (typeof body.body === 'string') issue.body = body.body as string;
      if (body.state === 'closed' || body.state === 'open') {
        issue.state = body.state as 'open' | 'closed';
        issue.closedSeq = issue.state === 'closed' ? store.nextSeq() : null;
      }
      if (Array.isArray(body.labels)) {
        const names = (body.labels as unknown[]).map((entry) => String(entry));
        for (const name of names) if (!repo.labels.has(name)) return unprocessable('Validation Failed');
        issue.labels = names;
      }
      return reply(200, issueView(store, repo, issue));
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return notFound();
    if (method === 'POST') {
      const commentBody = typeof body.body === 'string' ? (body.body as string) : '';
      const comment = {
        id: store.nextResourceId(),
        body: commentBody,
        userLogin: repo.owner ?? store.viewerLogin ?? 'viewer',
        seq: store.nextSeq(),
      };
      issue.comments.push(comment);
      return reply(201, commentView(store, repo, comment));
    }
    if (method === 'GET') {
      const comments = [...issue.comments].sort((a, b) => a.seq - b.seq).map((comment) => commentView(store, repo, comment));
      return paginate(request, comments);
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'labels') {
    if (issue === undefined) return notFound();
    if (method === 'POST') {
      const names = Array.isArray(body.labels)
        ? (body.labels as unknown[]).map((entry) => String(entry))
        : typeof body.name === 'string'
          ? [body.name as string]
          : [];
      for (const name of names) if (!repo.labels.has(name)) return unprocessable('Validation Failed');
      for (const name of names) if (!issue.labels.includes(name)) issue.labels.push(name);
      return reply(200, issue.labels.map((name) => labelView(store, repo, name) ?? { name }));
    }
    if (method === 'GET') {
      return reply(200, issue.labels.map((name) => labelView(store, repo, name) ?? { name }));
    }
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------------------------------------
// pull requests

/** Create a pull request record; shared by the REST, GraphQL and MCP surfaces. */
export function createPullRecord(
  store: Store,
  repo: Repo,
  fields: { title: string; body: string; head: string; base: string; draft?: boolean },
): Pull | 'invalid' | 'exists' {
  let head = fields.head;
  if (head.includes(':')) head = head.slice(head.indexOf(':') + 1);
  const headSha = store.branchTip(repo, head);
  const baseSha = store.branchTip(repo, fields.base);
  if (headSha === null || baseSha === null) return 'invalid';
  if (head === fields.base) return 'invalid';
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === fields.base) return 'exists';
  }
  const number = repo.nextNumber;
  repo.nextNumber += 1;
  const pull: Pull = {
    number,
    id: store.nextResourceId(),
    title: fields.title,
    body: fields.body,
    state: 'open',
    headRef: head,
    baseRef: fields.base,
    headSha,
    baseSha,
    merged: false,
    mergedSeq: null,
    mergeCommitSha: null,
    seq: store.nextSeq(),
    draft: fields.draft === true,
  };
  repo.pulls.set(number, pull);
  return pull;
}

/** Whether merging `pull` right now would conflict (three-way, against the merge base). */
export function pullConflicts(store: Store, repo: Repo, pull: Pull): boolean {
  const headTip = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = store.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const mb = store.mergeBase(headTip, baseTip);
  if (mb === null) return true;
  const headChanges = diffTrees(flatOfCommit(store, mb), flatOfCommit(store, headTip));
  const baseChanges = diffTrees(flatOfCommit(store, mb), flatOfCommit(store, baseTip));
  const baseChanged = new Map(baseChanges.map((change) => [change.path, change]));
  for (const change of headChanges) {
    const other = baseChanged.get(change.path);
    if (other !== undefined && other.to?.oid !== change.to?.oid) return true;
  }
  return false;
}

/** The changed paths of a pull request (merge-base tree vs head tree), sorted by path. */
export function pullChanges(store: Store, repo: Repo, pull: Pull): TreeChange[] {
  const headTip = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = store.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const mb = store.mergeBase(headTip, baseTip) ?? baseTip;
  return diffTrees(flatOfCommit(store, mb), flatOfCommit(store, headTip));
}

/**
 * Merge a pull request into its base branch (squash by default, a real merge commit for
 * method "merge"). Shared by REST, GraphQL and MCP. Returns the outcome.
 */
export function performMerge(
  store: Store,
  repo: Repo,
  pull: Pull,
  mergeMethod: string,
  commitTitle?: string,
): { outcome: 'merged'; sha: string } | { outcome: 'conflict' | 'not-mergeable' } {
  if (pull.merged || pull.state !== 'open') return { outcome: 'not-mergeable' };
  const headTip = store.branchTip(repo, pull.headRef);
  const baseTip = store.branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return { outcome: 'not-mergeable' };
  const mb = store.mergeBase(headTip, baseTip);
  if (mb === null) return { outcome: 'not-mergeable' };
  const headChanges = diffTrees(flatOfCommit(store, mb), flatOfCommit(store, headTip));
  const baseChanges = diffTrees(flatOfCommit(store, mb), flatOfCommit(store, baseTip));
  const baseChanged = new Map(baseChanges.map((change) => [change.path, change]));
  for (const change of headChanges) {
    const other = baseChanged.get(change.path);
    if (other !== undefined && other.to?.oid !== change.to?.oid) return { outcome: 'conflict' };
  }
  const flat = flatOfCommit(store, baseTip);
  for (const change of headChanges) {
    if (change.to === null) flat.delete(change.path);
    else flat.set(change.path, change.to);
  }
  const tree = store.buildTreeFromFlat(flat);
  const seq = store.nextSeq();
  const identity = store.identityFor(seq);
  const isMergeCommit = mergeMethod === 'merge';
  const message = isMergeCommit
    ? `Merge pull request #${pull.number} from ${pull.headRef}`
    : commitTitle !== undefined && commitTitle !== ''
      ? commitTitle
      : pull.title;
  const commit = buildCommit({
    tree,
    parents: isMergeCommit ? [baseTip, headTip] : [baseTip],
    author: identity,
    committer: identity,
    message,
  });
  const commitOid = store.putObject('commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSeq = seq;
  pull.mergeCommitSha = commitOid;
  return { outcome: 'merged', sha: commitOid };
}

function handlePulls(store: Store, request: RestRequest, repo: Repo, rest: string[]): RestReply {
  const method = request.method;
  const body = request.body ?? {};

  if (rest.length === 0) {
    if (method === 'POST') {
      const created = createPullRecord(store, repo, {
        title: typeof body.title === 'string' ? (body.title as string) : '',
        body: typeof body.body === 'string' ? (body.body as string) : '',
        head: typeof body.head === 'string' ? (body.head as string) : '',
        base: typeof body.base === 'string' ? (body.base as string) : '',
        draft: body.draft === true,
      });
      if (created === 'invalid') return unprocessable('Validation Failed');
      if (created === 'exists') return unprocessable('A pull request already exists for this branch.');
      return reply(201, pullView(store, repo, created));
    }
    if (method === 'GET') {
      const state = request.query.get('state') ?? 'open';
      const pulls = [...repo.pulls.values()]
        .filter((pull) => state === 'all' || pull.state === state)
        .sort((a, b) => b.seq - a.seq)
        .map((pull) => pullView(store, repo, pull));
      return paginate(request, pulls);
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return notFound();
  const pull = repo.pulls.get(number);
  if (pull === undefined) {
    // Merging or reading an unknown pull is a 404 with a message body.
    return notFound();
  }

  if (rest.length === 1) {
    if (method === 'GET') return reply(200, pullView(store, repo, pull));
    if (method === 'PATCH') {
      if (typeof body.title === 'string') pull.title = body.title as string;
      if (typeof body.body === 'string') pull.body = body.body as string;
      if (body.state === 'closed' || body.state === 'open') pull.state = body.state as 'open' | 'closed';
      return reply(200, pullView(store, repo, pull));
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    const changes = pullChanges(store, repo, pull);
    const files = changes.map((change) => {
      const beforeText = change.from !== null ? (store.getObject(change.from.oid)?.data.toString('utf8') ?? '') : '';
      const afterText = change.to !== null ? (store.getObject(change.to.oid)?.data.toString('utf8') ?? '') : '';
      const additions = change.to !== null ? lineCount(afterText) : 0;
      const deletions = change.from !== null ? lineCount(beforeText) : 0;
      const status = change.from === null ? 'added' : change.to === null ? 'removed' : 'modified';
      return {
        sha: change.to?.oid ?? change.from?.oid ?? '',
        filename: change.path,
        status,
        additions,
        deletions,
        changes: additions + deletions,
        blob_url: '',
        raw_url: '',
        contents_url: '',
      };
    });
    return paginate(request, files);
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (method === 'GET') {
      return pull.merged ? reply(204) : notFound();
    }
    if (method === 'PUT') {
      const mergeMethod = typeof body.merge_method === 'string' ? (body.merge_method as string) : 'merge';
      const commitTitle = typeof body.commit_title === 'string' ? (body.commit_title as string) : undefined;
      const result = performMerge(store, repo, pull, mergeMethod, commitTitle);
      if (result.outcome === 'conflict') return reply(405, { message: 'Merge conflict' });
      if (result.outcome === 'not-mergeable') return reply(405, { message: 'Pull Request is not mergeable' });
      return reply(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
    }
    return notFound();
  }

  return notFound();
}
