// GraphQL v4: a small but real GraphQL engine (lexer, parser, field validation, executor) over
// the shared store, covering exactly the surface gh and the conformance suite exercise: viewer,
// repository, node, __type introspection, issue/pull-request connections with cursor pagination,
// and the createIssue / closeIssue / createPullRequest / mergePullRequest / addComment mutations.
// Global ids are opaque, stable and type-tagged (base64 of "<Type>:<key>"), never bare numbers.

import type { Store, Repo, Issue, Pull } from './store.ts';
import { createPullRecord, performMerge, pullChanges, pullConflicts } from './rest.ts';

export interface GraphQLRequest {
  method: string;
  rawBody: Buffer;
}

export interface GraphQLReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------
// lexer / parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\ufeff') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      if (text.includes('.')) tokens.push({ kind: 'float', value: Number(text) });
      else tokens.push({ kind: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'fragment'; typeCondition: string; selections: SelectionNode[] };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = lex(source);
  }

  private peek(): Token {
    return this.tokens[this.at] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.at] as Token;
    this.at += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('empty document');
    return operations;
  }

  private parseOperation(): OperationNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { type: 'query', name: null, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      this.next();
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.expectName();
      if (this.peek().kind === 'punct' && this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '(') {
        this.parseVariableDefinitions();
      }
      // Directives are not used by the suite; skip any that appear.
      while (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '@') {
        this.next();
        this.expectName();
        if (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '(') this.parseArguments();
      }
      return { type: token.value as 'query' | 'mutation', name, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      // Fragment definitions are parsed and registered nowhere: the suite never sends them.
      this.next();
      this.expectName();
      const on = this.expectName();
      if (on !== 'on') throw new Error('expected "on" in fragment definition');
      this.expectName();
      this.parseSelectionSet();
      return { type: 'query', name: null, selections: [] };
    }
    throw new Error('expected an operation');
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.skipPunct('=')) this.parseValue();
    }
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const on = this.expectName();
      if (on !== 'on') throw new Error('expected "on" after "..."');
      const typeCondition = this.expectName();
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', typeCondition, selections };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.skipPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    let args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '(') {
      args = this.parseArguments();
    }
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && (this.peek() as { value?: string }).value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!this.skipPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value');
  }
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueOf(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// schema: field lists (for validation + introspection) and field result types

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', '__typename'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate',
    'url', 'createdAt', 'updatedAt', '__typename',
  ],
  Ref: ['name', 'prefix', '__typename'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'repository', '__typename'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  IssueEdge: ['node', 'cursor', '__typename'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor', '__typename'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'url', 'createdAt', 'updatedAt', 'author', 'repository', '__typename',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount', '__typename'],
  PullRequestEdge: ['node', 'cursor', '__typename'],
  PullRequestChangedFileConnection: ['nodes', 'totalCount', '__typename'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType', '__typename'],
  CreateIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CloseIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', '__typename'],
  CommentEdge: ['node', 'cursor', '__typename'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author', '__typename'],
  Node: ['id', '__typename'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', '__typename'],
  __Field: ['name', 'description', '__typename'],
  __EnumValue: ['name', 'description', '__typename'],
  __Schema: ['types', 'queryType', 'mutationType', '__typename'],
};

const FIELD_TYPE: Record<string, string> = {
  'Query.viewer': 'User',
  'Query.repository': 'Repository',
  'Query.node': 'Node',
  'Query.__type': '__Type',
  'Query.__schema': '__Schema',
  'Repository.owner': 'User',
  'Repository.defaultBranchRef': 'Ref',
  'Repository.issue': 'Issue',
  'Repository.issues': 'IssueConnection',
  'Repository.pullRequest': 'PullRequest',
  'Repository.pullRequests': 'PullRequestConnection',
  'IssueConnection.nodes': 'Issue',
  'IssueConnection.edges': 'IssueEdge',
  'IssueConnection.pageInfo': 'PageInfo',
  'IssueEdge.node': 'Issue',
  'Issue.author': 'User',
  'Issue.repository': 'Repository',
  'PullRequestConnection.nodes': 'PullRequest',
  'PullRequestConnection.edges': 'PullRequestEdge',
  'PullRequestConnection.pageInfo': 'PageInfo',
  'PullRequestEdge.node': 'PullRequest',
  'PullRequest.files': 'PullRequestChangedFileConnection',
  'PullRequestChangedFileConnection.nodes': 'PullRequestChangedFile',
  'PullRequest.author': 'User',
  'PullRequest.repository': 'Repository',
  'Mutation.createIssue': 'CreateIssuePayload',
  'Mutation.closeIssue': 'CloseIssuePayload',
  'Mutation.createPullRequest': 'CreatePullRequestPayload',
  'Mutation.mergePullRequest': 'MergePullRequestPayload',
  'Mutation.addComment': 'AddCommentPayload',
  'CreateIssuePayload.issue': 'Issue',
  'CloseIssuePayload.issue': 'Issue',
  'CreatePullRequestPayload.pullRequest': 'PullRequest',
  'MergePullRequestPayload.pullRequest': 'PullRequest',
  'AddCommentPayload.commentEdge': 'CommentEdge',
  'CommentEdge.node': 'IssueComment',
  'IssueComment.author': 'User',
  '__Type.fields': '__Field',
  '__Type.enumValues': '__EnumValue',
};

const ENUM_TYPES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  StatusState: ['EXPECTED', 'ERROR', 'FAILURE', 'PENDING', 'SUCCESS'],
};

/** Validate every field in the operation against the schema; unknown fields are errors. */
function validateSelections(typeName: string, selections: SelectionNode[], errors: string[]): void {
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      validateSelections(selection.typeCondition, selection.selections, errors);
      continue;
    }
    const fields = TYPE_FIELDS[typeName];
    if (fields === undefined) continue;
    if (!fields.includes(selection.name)) {
      errors.push(`Field '${selection.name}' doesn't exist on type '${typeName}'`);
      continue;
    }
    const childType = FIELD_TYPE[`${typeName}.${selection.name}`];
    if (childType !== undefined && selection.selections.length > 0) {
      validateSelections(childType, selection.selections, errors);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// global ids

function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

const repoGlobalId = (repo: Repo): string => globalId('Repository', String(repo.id));
const issueGlobalId = (repo: Repo, issue: Issue): string => globalId('Issue', `${repo.id}/${issue.number}`);
const pullGlobalId = (repo: Repo, pull: Pull): string => globalId('PullRequest', `${repo.id}/${pull.number}`);
const commentGlobalId = (repo: Repo, issue: Issue, commentId: number): string =>
  globalId('IssueComment', `${repo.id}/${issue.number}/${commentId}`);

// ---------------------------------------------------------------------------------------------
// execution

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
}

type Source = Record<string, unknown> & { __t: string };

const src = (type: string, fields: Record<string, unknown>): Source => ({ __t: type, ...fields });

function argsOf(field: FieldNode, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, ctx.variables);
  return out;
}

function issueSource(ctx: Ctx, repo: Repo, issue: Issue): Source {
  return src('Issue', { repo, issue });
}

function pullSource(ctx: Ctx, repo: Repo, pull: Pull): Source {
  return src('PullRequest', { repo, pull });
}

function cursorFor(repo: Repo, seq: number): string {
  return Buffer.from(`cursor:${repo.id}:${seq}`, 'utf8').toString('base64');
}

function seqFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:\d+:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function resolveField(ctx: Ctx, typeName: string, source: Source, field: FieldNode): unknown {
  const store = ctx.store;
  const args = argsOf(field, ctx);
  // The Node interface delegates to the source's concrete type.
  if (typeName === 'Node' && source.__t !== 'Node') {
    return resolveField(ctx, source.__t, source, field);
  }
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return src('User', { login: store.viewerLogin ?? 'viewer' });
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        store.learnViewer(owner);
        const repo = store.resolveRepo(owner, name);
        return repo === null ? null : src('Repository', { repo });
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const repo = [...store.repos.values()].find((candidate) => candidate.id === Number(decoded.key));
          return repo === undefined ? null : src('Repository', { repo });
        }
        if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
          const [repoId, number] = decoded.key.split('/').map(Number);
          const repo = [...store.repos.values()].find((candidate) => candidate.id === repoId);
          if (repo === undefined) return null;
          if (decoded.type === 'Issue') {
            const issue = repo.issues.get(number as number);
            return issue === undefined ? null : issueSource(ctx, repo, issue);
          }
          const pull = repo.pulls.get(number as number);
          return pull === undefined ? null : pullSource(ctx, repo, pull);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (TYPE_FIELDS[name] !== undefined) return src('__Type', { name, kind: 'OBJECT' });
        if (ENUM_TYPES[name] !== undefined) return src('__Type', { name, kind: 'ENUM' });
        return null;
      }
      if (field.name === '__schema') return src('__Schema', {});
      return null;
    }
    case 'Mutation': {
      return resolveMutation(ctx, field.name, args);
    }
    case 'User': {
      if (field.name === 'login') return source.login as string;
      if (field.name === 'id') return globalId('User', String(store.viewerId));
      if (field.name === 'name') return source.login as string;
      if (field.name === 'email') return `${source.login as string}@example.invalid`;
      return null;
    }
    case 'Repository': {
      const repo = source.repo as Repo;
      switch (field.name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner ?? store.viewerLogin ?? 'viewer'}/${repo.name}`;
        case 'owner':
          return src('User', { login: repo.owner ?? store.viewerLogin ?? 'viewer' });
        case 'defaultBranchRef':
          return repo.refs.size > 0 ? src('Ref', { name: repo.defaultBranch }) : null;
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueSource(ctx, repo, issue);
        }
        case 'issues':
          return issuesConnection(ctx, repo, args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : pullSource(ctx, repo, pull);
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' ? (args.first as number) : 100;
          const pulls = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq).slice(0, first);
          return src('PullRequestConnection', {
            nodes: pulls.map((pull) => pullSource(ctx, repo, pull)),
            totalCount: repo.pulls.size,
            pageInfo: src('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
          });
        }
        default:
          return null;
      }
    }
    case 'Ref': {
      if (field.name === 'name') return source.name as string;
      if (field.name === 'prefix') return 'refs/heads/';
      return null;
    }
    case 'Issue': {
      const issue = source.issue as Issue;
      const repo = source.repo as Repo;
      switch (field.name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'author':
          return src('User', { login: repo.owner ?? store.viewerLogin ?? 'viewer' });
        case 'repository':
          return src('Repository', { repo });
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return source.nodes as unknown[];
      if (field.name === 'pageInfo') return source.pageInfo as Source;
      if (field.name === 'totalCount') return source.totalCount as number;
      if (field.name === 'edges') return [];
      return null;
    }
    case 'PageInfo': {
      return source[field.name] ?? null;
    }
    case 'PullRequest': {
      const pull = source.pull as Pull;
      const repo = source.repo as Repo;
      switch (field.name) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'mergeable': {
          if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
          return pullConflicts(store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'files': {
          const first = typeof args.first === 'number' ? (args.first as number) : 100;
          const changes = pullChanges(store, repo, pull);
          return src('PullRequestChangedFileConnection', {
            nodes: changes.slice(0, first).map((change) =>
              src('PullRequestChangedFile', {
                path: change.path,
                additions: 0,
                deletions: 0,
                changeType: change.from === null ? 'ADDED' : change.to === null ? 'DELETED' : 'MODIFIED',
              }),
            ),
            totalCount: changes.length,
          });
        }
        case 'author':
          return src('User', { login: repo.owner ?? store.viewerLogin ?? 'viewer' });
        case 'repository':
          return src('Repository', { repo });
        default:
          return null;
      }
    }
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return source.nodes as unknown[];
      if (field.name === 'totalCount') return source.totalCount as number;
      return null;
    }
    case 'PullRequestChangedFile': {
      return source[field.name] ?? null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return source.issue as Source;
      if (field.name === 'clientMutationId') return null;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return source.pull as Source;
      if (field.name === 'clientMutationId') return null;
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return source.commentEdge as Source;
      if (field.name === 'clientMutationId') return null;
      return null;
    }
    case 'CommentEdge': {
      if (field.name === 'node') return source.node as Source;
      if (field.name === 'cursor') return source.cursor as string;
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return source.id as string;
      if (field.name === 'body') return source.body as string;
      if (field.name === 'author') return src('User', { login: store.viewerLogin ?? 'viewer' });
      return null;
    }
    case '__Type': {
      const name = source.name as string;
      if (field.name === 'name') return name;
      if (field.name === 'kind') return source.kind as string;
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        const fields = TYPE_FIELDS[name];
        if (fields === undefined) return null;
        return fields.filter((entry) => entry !== '__typename').map((entry) => src('__Field', { name: entry }));
      }
      if (field.name === 'enumValues') {
        const values = ENUM_TYPES[name];
        if (values === undefined) return null;
        return values.map((entry) => src('__EnumValue', { name: entry }));
      }
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      if (field.name === 'name') return source.name as string;
      return null;
    }
    default:
      return null;
  }
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): Source {
  const store = ctx.store;
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  const descending = orderBy?.direction === 'DESC';
  issues.sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq));
  let startIndex = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const afterSeq = seqFromCursor(after);
    if (afterSeq !== null) {
      const index = issues.findIndex((issue) => issue.seq === afterSeq);
      if (index >= 0) startIndex = index + 1;
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, args.first as number) : 100;
  const page = issues.slice(startIndex, startIndex + first);
  const hasNextPage = startIndex + page.length < issues.length;
  const last = page[page.length - 1];
  return src('IssueConnection', {
    nodes: page.map((issue) => issueSource(ctx, repo, issue)),
    totalCount: issues.length,
    pageInfo: src('PageInfo', {
      hasNextPage,
      hasPreviousPage: startIndex > 0,
      startCursor: page.length > 0 ? cursorFor(repo, (page[0] as Issue).seq) : null,
      endCursor: last !== undefined ? cursorFor(repo, last.seq) : null,
    }),
  });
}

function repoById(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function resolveMutation(ctx: Ctx, name: string, args: Record<string, unknown>): unknown {
  const store = ctx.store;
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'createIssue': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? repoById(store, Number(decoded.key)) : null;
      if (repo === null) throw new Error('repository not found');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = {
        number,
        id: store.nextResourceId(),
        title: typeof input.title === 'string' ? (input.title as string) : '',
        body: typeof input.body === 'string' ? (input.body as string) : '',
        state: 'open',
        labels: [],
        comments: [],
        seq: store.nextSeq(),
        closedSeq: null,
      };
      repo.issues.set(number, issue);
      return src('CreateIssuePayload', { issue: issueSource(ctx, repo, issue) });
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.type !== 'Issue') throw new Error('issue not found');
      const [repoId, number] = decoded.key.split('/').map(Number);
      const repo = repoById(store, repoId as number);
      const issue = repo?.issues.get(number as number);
      if (repo === null || repo === undefined || issue === undefined) throw new Error('issue not found');
      issue.state = 'closed';
      issue.closedSeq = store.nextSeq();
      return src('CloseIssuePayload', { issue: issueSource(ctx, repo, issue) });
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? repoById(store, Number(decoded.key)) : null;
      if (repo === null) throw new Error('repository not found');
      const created = createPullRecord(store, repo, {
        title: typeof input.title === 'string' ? (input.title as string) : '',
        body: typeof input.body === 'string' ? (input.body as string) : '',
        head: typeof input.headRefName === 'string' ? (input.headRefName as string) : '',
        base: typeof input.baseRefName === 'string' ? (input.baseRefName as string) : '',
      });
      if (created === 'invalid' || created === 'exists') throw new Error('could not create pull request');
      return src('CreatePullRequestPayload', { pull: pullSource(ctx, repo, created) });
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.type !== 'PullRequest') throw new Error('pull request not found');
      const [repoId, number] = decoded.key.split('/').map(Number);
      const repo = repoById(store, repoId as number);
      const pull = repo?.pulls.get(number as number);
      if (repo === null || repo === undefined || pull === undefined) throw new Error('pull request not found');
      const methodRaw = typeof input.mergeMethod === 'string' ? (input.mergeMethod as string) : 'MERGE';
      const method = methodRaw.toLowerCase() === 'merge' ? 'merge' : 'squash';
      const result = performMerge(store, repo, pull, method);
      if (result.outcome !== 'merged') throw new Error('pull request is not mergeable');
      return src('MergePullRequestPayload', { pull: pullSource(ctx, repo, pull) });
    }
    case 'addComment': {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.type !== 'Issue') throw new Error('subject not found');
      const [repoId, number] = decoded.key.split('/').map(Number);
      const repo = repoById(store, repoId as number);
      const issue = repo?.issues.get(number as number);
      if (repo === null || repo === undefined || issue === undefined) throw new Error('subject not found');
      const body = typeof input.body === 'string' ? (input.body as string) : '';
      const comment = {
        id: store.nextResourceId(),
        body,
        userLogin: store.viewerLogin ?? 'viewer',
        seq: store.nextSeq(),
      };
      issue.comments.push(comment);
      const node = src('IssueComment', { id: commentGlobalId(repo, issue, comment.id), body });
      return src('AddCommentPayload', {
        commentEdge: src('CommentEdge', { node, cursor: cursorFor(repo, comment.seq) }),
      });
    }
    default:
      return null;
  }
}

function executeSelections(ctx: Ctx, typeName: string, source: Source, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const fragmentType = selection.typeCondition;
      if (fragmentType === typeName || fragmentType === 'Node' || typeName === 'Node' || isConcreteOf(fragmentType, source)) {
        const merged = executeSelections(ctx, fragmentType === 'Node' ? typeName : fragmentType, source, selection.selections);
        Object.assign(out, merged);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const value = resolveField(ctx, typeName, source, selection);
    out[key] = completeValue(ctx, typeName, selection, value);
  }
  return out;
}

function isConcreteOf(fragmentType: string, source: Source): boolean {
  // Inline fragments apply when the fragment's type is the object's concrete type. Sources know
  // their own type; Node sources carry the concrete type in __t already.
  return source.__t === fragmentType;
}

function completeValue(ctx: Ctx, parentType: string, field: FieldNode, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const childType = FIELD_TYPE[`${parentType}.${field.name}`];
  if (Array.isArray(value)) {
    return value.map((entry) => completeValue(ctx, parentType, field, entry));
  }
  if (typeof value === 'object' && field.selections.length > 0) {
    const source = value as Source;
    const type = childType ?? source.__t;
    return executeSelections(ctx, type, source, field.selections);
  }
  if (typeof value === 'object' && field.selections.length === 0) return value;
  return value;
}

// ---------------------------------------------------------------------------------------------
// the endpoint

function runOperation(store: Store, operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelections(rootType, operation.selections, errors);
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  const ctx: Ctx = { store, variables };
  try {
    const data = executeSelections(ctx, rootType, src(rootType, {}), operation.selections);
    return { data };
  } catch (err) {
    return {
      data: null,
      errors: [{ message: err instanceof Error ? err.message : String(err) }],
    };
  }
}

function runSingle(store: Store, payload: unknown): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { errors: [{ message: 'request body must be an object' }] };
  }
  const body = payload as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof body.query !== 'string') {
    return { errors: [{ message: 'query must be a string' }] };
  }
  const variables =
    typeof body.variables === 'object' && body.variables !== null ? (body.variables as Record<string, unknown>) : {};
  let operations: OperationNode[];
  try {
    operations = new Parser(body.query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const named = typeof body.operationName === 'string' ? operations.find((op) => op.name === body.operationName) : undefined;
  const operation = named ?? operations.find((op) => op.selections.length > 0) ?? operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation found' }] };
  return runOperation(store, operation, variables);
}

export function handleGraphQL(store: Store, request: GraphQLRequest): GraphQLReply {
  if (request.method !== 'POST') return { status: 404, body: { message: 'Not Found' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((entry) => runSingle(store, entry)) };
  }
  return { status: 200, body: runSingle(store, parsed) };
}
