// graphql.ts — GraphQL v4 surface: a small parser and executor for the
// fields the suite exercises, plus __type introspection. Errors are returned
// as HTTP 200 with an `errors` array naming the offending field.

import {
  VIEWER_LOGIN,
  VIEWER_ID,
  type Store,
  type Repo,
  type Issue,
  type Pull,
  parseCommit,
  flattenTree,
  diffFlat,
  mergeBase,
} from './store.ts';
import type { ReqCtx } from './http.ts';
import { sendJson } from './http.ts';

// ---------------------------------------------------------------------------
// Global ids: opaque, stable, decodable. base64 of a typed key.
// ---------------------------------------------------------------------------

export function encodeGlobalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length < 2) return null;
    return { kind: parts[0], parts: parts.slice(1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('R', repo.id);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('I', repo.id, issue.number);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeGlobalId('P', repo.id, pull.number);
}

function commentGlobalId(repo: Repo, issue: Issue, commentId: number): string {
  return encodeGlobalId('C', repo.id, issue.number, commentId);
}

function findRepoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'R') return null;
  const repoId = Number(decoded.parts[0]);
  for (const repo of store.repos.values()) {
    if (repo.id === repoId) return repo;
  }
  return null;
}

function findIssueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'I') return null;
  const repoId = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of store.repos.values()) {
    if (repo.id === repoId) {
      const issue = repo.issues.get(number);
      return issue ? { repo, issue } : null;
    }
  }
  return null;
}

function findPullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'P') return null;
  const repoId = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of store.repos.values()) {
    if (repo.id === repoId) {
      const pull = repo.pulls.get(number);
      return pull ? { repo, pull } : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // String literal (with escapes). Block strings (""") are not used.
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          out += map[esc] ?? esc;
          j += 2;
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
    if (ch === '-' || /[0-9]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

interface ValueNode {
  kind: 'variable' | 'int' | 'float' | 'string' | 'boolean' | 'enum' | 'null' | 'list' | 'object';
  name?: string;
  value?: number | string | boolean;
  items?: ValueNode[];
  fields?: Array<{ name: string; value: ValueNode }>;
}

interface SelectionNode {
  kind: 'field' | 'inlineFragment' | 'fragmentSpread';
  alias?: string;
  name?: string;
  typeCondition?: string;
  args?: Array<{ name: string; value: ValueNode }>;
  selectionSet?: SelectionNode[];
}

interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions?: Array<{ name: string }>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected name');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const doc: DocumentNode = { operations: [], fragments: new Map() };
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        doc.operations.push({ operation: 'query', selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = token.value as OperationNode['operation'];
        this.next();
        let name: string | undefined;
        const next = this.peek();
        if (next.kind === 'name') {
          name = this.next().value as string;
        }
        const variableDefinitions = this.parseVariableDefinitions();
        const selectionSet = this.parseSelectionSet();
        doc.operations.push({ operation, name, variableDefinitions, selectionSet });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected on');
        const typeCondition = this.expectName();
        // Skip directives on the fragment definition.
        this.skipDirectives();
        const selectionSet = this.parseSelectionSet();
        doc.fragments.set(fragName, { typeCondition, selectionSet });
        continue;
      }
      throw new Error('unexpected token in document');
    }
    return doc;
  }

  private parseVariableDefinitions(): Array<{ name: string }> {
    const defs: Array<{ name: string }> = [];
    if (!this.acceptPunct('(')) return defs;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      // Default value.
      if (this.acceptPunct('=')) this.parseValue();
      this.skipDirectives();
      defs.push({ name });
    }
    return defs;
  }

  private parseType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else if (token.kind === 'name') {
      this.next();
    } else {
      throw new Error('expected type');
    }
    this.acceptPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '(') {
        this.parseArguments();
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selectionSet = this.parseSelectionSet();
        return { kind: 'inlineFragment', typeCondition, selectionSet };
      }
      if (next.kind === 'name') {
        const name = this.next().value as string;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      throw new Error('expected fragment name or type condition');
    }
    if (token.kind !== 'name') throw new Error('expected field name');
    const first = this.next().value as string;
    let alias: string | undefined;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selectionSet = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      const value = this.parseValue();
      args.push({ name, value });
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value');
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class GraphQLError extends Error {}

interface GqlCtx {
  store: Store;
}

type AnyRecord = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: AnyRecord): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name as string];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return (node.items ?? []).map((item) => resolveValue(item, variables));
    case 'object': {
      const out: AnyRecord = {};
      for (const field of node.fields ?? []) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
    default:
      return null;
  }
}

function resolveArgs(args: Array<{ name: string; value: ValueNode }> | undefined, variables: AnyRecord): AnyRecord {
  const out: AnyRecord = {};
  for (const arg of args ?? []) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// Field lists for __type introspection (must include the required names).
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Viewer: ['login', 'id', 'name', 'email', 'url'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'isPrivate', 'createdAt', 'updatedAt'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'repository', 'closed', 'closedAt'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'author', 'url', 'mergedAt', 'mergeCommit', 'additions', 'deletions', 'changedFiles'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'LABEL', 'WIKI', 'PROJECT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};

function typeNameOf(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as AnyRecord;
    if (typeof record.__typename === 'string') return record.__typename;
  }
  return 'Unknown';
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function encodeCursor(kind: string, number: number): string {
  return Buffer.from(`${kind}:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^[^:]+:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

interface IssueNode {
  __typename: 'Issue';
  repo: Repo;
  issue: Issue;
}

interface PullNode {
  __typename: 'PullRequest';
  repo: Repo;
  pull: Pull;
}

function issueNode(repo: Repo, issue: Issue): IssueNode {
  return { __typename: 'Issue', repo, issue };
}

function pullNode(repo: Repo, pull: Pull): PullNode {
  return { __typename: 'PullRequest', repo, pull };
}

function repositoryObject(repo: Repo): AnyRecord {
  return { __typename: 'Repository', repo };
}

function viewerObject(): AnyRecord {
  return {
    __typename: 'Viewer',
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    name: 'ada iversen',
    email: 'adaiversen@example.invalid',
    url: `https://github.com/${VIEWER_LOGIN}`,
  };
}

function paginateConnection<T>(items: T[], first: number | undefined, after: string | undefined, cursorOf: (item: T) => string): { nodes: T[]; pageInfo: AnyRecord } {
  let start = 0;
  if (after) {
    const afterNumber = decodeCursor(after);
    if (afterNumber !== null) {
      const index = items.findIndex((item) => cursorOf(item) === after);
      if (index !== -1) start = index + 1;
    }
  }
  const limit = typeof first === 'number' ? Math.max(0, first) : items.length;
  const nodes = items.slice(start, start + limit);
  const hasNextPage = start + nodes.length < items.length;
  const endCursor = nodes.length > 0 ? cursorOf(nodes[nodes.length - 1]) : null;
  const startCursor = nodes.length > 0 ? cursorOf(nodes[0]) : null;
  return {
    nodes,
    pageInfo: { __typename: 'PageInfo', hasNextPage, hasPreviousPage: start > 0, startCursor, endCursor },
  };
}

function pullFilesForGraphQL(repo: Repo, pull: Pull): Array<{ path: string; additions: number; deletions: number; changeType: string }> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headObj = repo.objects.get(headTip);
  const baseObj = repo.objects.get(baseTip);
  if (!headObj || headObj.type !== 'commit' || !baseObj || baseObj.type !== 'commit') return [];
  const headFlat = flattenTree(repo.objects, parseCommit(headObj.data).tree);
  const mb = mergeBase(repo.objects, baseTip, headTip);
  const mbFlat = mb ? flattenTree(repo.objects, parseCommit((repo.objects.get(mb) as { data: Buffer }).data).tree) : new Map();
  const changes = diffFlat(mbFlat, headFlat);
  return changes.map((change) => {
    const oldData = change.oldOid ? repo.objects.get(change.oldOid)?.data : undefined;
    const newData = change.newOid ? repo.objects.get(change.newOid)?.data : undefined;
    const countLines = (data: Buffer | undefined): string[] =>
      data ? data.toString('utf8').split('\n').filter((line) => line !== '') : [];
    const oldLines = countLines(oldData);
    const newLines = countLines(newData);
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    const newCounts = new Map<string, number>();
    for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
    for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
    return {
      path: change.path,
      additions,
      deletions,
      changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
    };
  });
}

function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state === 'closed') return 'UNKNOWN';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return 'UNKNOWN';
  const baseObj = repo.objects.get(baseTip);
  const headObj = repo.objects.get(headTip);
  if (!baseObj || baseObj.type !== 'commit' || !headObj || headObj.type !== 'commit') return 'UNKNOWN';
  const baseFlat = flattenTree(repo.objects, parseCommit(baseObj.data).tree);
  const headFlat = flattenTree(repo.objects, parseCommit(headObj.data).tree);
  const mb = mergeBase(repo.objects, baseTip, headTip);
  const mbFlat = mb ? flattenTree(repo.objects, parseCommit((repo.objects.get(mb) as { data: Buffer }).data).tree) : new Map();
  const changes = diffFlat(mbFlat, headFlat);
  for (const change of changes) {
    const baseEntry = baseFlat.get(change.path);
    const mbEntry = mbFlat.get(change.path);
    const baseOid = baseEntry ? baseEntry.oid : null;
    const mbOid = mbEntry ? mbEntry.oid : null;
    if (baseOid !== mbOid && baseOid !== change.newOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

// Resolvers: (parent, args, ctx) -> value. Returned objects carry __typename
// so the executor can recurse into their fields.
type Resolver = (parent: AnyRecord, args: AnyRecord, ctx: GqlCtx) => unknown;

const resolvers: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => viewerObject(),
    repository: (_parent, args, ctx) => {
      const owner = args.owner as string;
      const name = args.name as string;
      if (owner !== VIEWER_LOGIN) return null;
      const repo = ctx.store.getRepo(owner, name);
      return repo ? repositoryObject(repo) : null;
    },
    node: (_parent, args, ctx) => {
      const id = args.id as string;
      if (typeof id !== 'string') return null;
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.kind === 'R') {
        const repo = findRepoByGlobalId(ctx.store, id);
        return repo ? repositoryObject(repo) : null;
      }
      if (decoded.kind === 'I') {
        const found = findIssueByGlobalId(ctx.store, id);
        return found ? issueNode(found.repo, found.issue) : null;
      }
      if (decoded.kind === 'P') {
        const found = findPullByGlobalId(ctx.store, id);
        return found ? pullNode(found.repo, found.pull) : null;
      }
      return null;
    },
    __type: (_parent, args) => {
      const name = args.name as string;
      const fields = TYPE_FIELDS[name];
      const enumValues = ENUM_VALUES[name];
      if (!fields && !enumValues) return null;
      return {
        __typename: '__Type',
        name,
        kind: enumValues ? 'ENUM' : 'OBJECT',
        description: null,
        fields: fields ? fields.map((field) => ({ __typename: '__Field', name: field, description: null })) : null,
        enumValues: enumValues ? enumValues.map((value) => ({ __typename: '__EnumValue', name: value, description: null })) : null,
      };
    },
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as AnyRecord;
      const repo = findRepoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
      if (!repo) return { __typename: 'CreateIssuePayload', issue: null };
      const issue = ctx.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __typename: 'CreateIssuePayload', issue: issueNode(repo, issue) };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as AnyRecord;
      const found = findIssueByGlobalId(ctx.store, String(input.issueId ?? ''));
      if (!found) return { __typename: 'CloseIssuePayload', issue: null };
      found.issue.state = 'closed';
      found.issue.closedAt = ctx.store.nextTimestamp();
      found.issue.updatedAt = found.issue.closedAt;
      found.issue.cachedJson = null;
      return { __typename: 'CloseIssuePayload', issue: issueNode(found.repo, found.issue) };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as AnyRecord;
      const repo = findRepoByGlobalId(ctx.store, String(input.repositoryId ?? ''));
      if (!repo) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (!repo.refs.get(`refs/heads/${head}`) || !repo.refs.get(`refs/heads/${base}`)) {
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, existing) };
        }
      }
      const pull = ctx.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(repo, pull) };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as AnyRecord;
      const found = findPullByGlobalId(ctx.store, String(input.pullRequestId ?? ''));
      if (!found) return { __typename: 'MergePullRequestPayload', pullRequest: null };
      ctx.store.squashMerge(found.repo, found.pull);
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(found.repo, found.pull) };
    },
    addComment: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as AnyRecord;
      const found = findIssueByGlobalId(ctx.store, String(input.subjectId ?? ''));
      if (!found) return { __typename: 'AddCommentPayload', commentEdge: null };
      ctx.store.commentIdSeq += 1;
      const now = ctx.store.nextTimestamp();
      const comment = { id: ctx.store.commentIdSeq, body: String(input.body ?? ''), createdAt: now, updatedAt: now };
      found.issue.comments.push(comment);
      found.issue.cachedJson = null;
      const node = {
        __typename: 'IssueComment',
        id: commentGlobalId(found.repo, found.issue, comment.id),
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        repo: found.repo,
        issue: found.issue,
      };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: encodeCursor('C', comment.id) },
        subject: issueNode(found.repo, found.issue),
      };
    },
  },
  Viewer: {
    login: (parent) => parent.login,
    id: (parent) => parent.id,
    name: (parent) => parent.name,
    email: (parent) => parent.email,
    url: (parent) => parent.url,
  },
  User: {
    login: (parent) => parent.login,
    id: (parent) => parent.id,
    name: (parent) => parent.name,
    email: (parent) => parent.email,
    url: (parent) => parent.url,
  },
  Repository: {
    id: (parent) => repoGlobalId(parent.repo as Repo),
    databaseId: (parent) => (parent.repo as Repo).id,
    name: (parent) => (parent.repo as Repo).name,
    nameWithOwner: (parent) => `${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}`,
    owner: () => viewerObject(),
    defaultBranchRef: (parent) => {
      const repo = parent.repo as Repo;
      const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (!sha) return null;
      return { __typename: 'Ref', name: repo.defaultBranch, target: sha };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (parent) => (parent.repo as Repo).description,
    url: (parent) => `https://github.com/${(parent.repo as Repo).owner}/${(parent.repo as Repo).name}`,
    isPrivate: (parent) => (parent.repo as Repo).isPrivate,
    createdAt: (parent) => (parent.repo as Repo).createdAt,
    updatedAt: (parent) => (parent.repo as Repo).updatedAt,
    issue: (parent, args) => {
      const repo = parent.repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueNode(repo, issue) : null;
    },
    issues: (parent, args) => {
      const repo = parent.repo as Repo;
      let issues = [...repo.issues.values()];
      const states = args.states as string[] | undefined;
      if (states && states.length > 0) {
        const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.orderBy as AnyRecord | undefined;
      const direction = orderBy?.direction === 'ASC' ? 1 : -1;
      issues.sort((a, b) => (a.createdSeq - b.createdSeq) * direction || (a.number - b.number) * direction);
      const { nodes, pageInfo } = paginateConnection(
        issues,
        typeof args.first === 'number' ? args.first : undefined,
        typeof args.after === 'string' ? args.after : undefined,
        (issue) => encodeCursor('I', issue.number),
      );
      return {
        __typename: 'IssueConnection',
        nodes: nodes.map((issue) => issueNode(repo, issue)),
        edges: nodes.map((issue) => ({ __typename: 'IssueEdge', node: issueNode(repo, issue), cursor: encodeCursor('I', issue.number) })),
        pageInfo,
        totalCount: issues.length,
      };
    },
    pullRequests: (parent, args) => {
      const repo = parent.repo as Repo;
      const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
      const { nodes, pageInfo } = paginateConnection(
        pulls,
        typeof args.first === 'number' ? args.first : undefined,
        typeof args.after === 'string' ? args.after : undefined,
        (pull) => encodeCursor('P', pull.number),
      );
      return {
        __typename: 'PullRequestConnection',
        nodes: nodes.map((pull) => pullNode(repo, pull)),
        edges: nodes.map((pull) => ({ __typename: 'PullRequestEdge', node: pullNode(repo, pull), cursor: encodeCursor('P', pull.number) })),
        pageInfo,
        totalCount: pulls.length,
      };
    },
    pullRequest: (parent, args) => {
      const repo = parent.repo as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullNode(repo, pull) : null;
    },
  },
  Issue: {
    id: (parent) => issueGlobalId((parent as IssueNode).repo, (parent as IssueNode).issue),
    number: (parent) => (parent as IssueNode).issue.number,
    title: (parent) => (parent as IssueNode).issue.title,
    state: (parent) => issueState((parent as IssueNode).issue),
    body: (parent) => (parent as IssueNode).issue.body,
    createdAt: (parent) => (parent as IssueNode).issue.createdAt,
    updatedAt: (parent) => (parent as IssueNode).issue.updatedAt,
    author: () => viewerObject(),
    url: (parent) => `https://github.com/${(parent as IssueNode).repo.owner}/${(parent as IssueNode).repo.name}/issues/${(parent as IssueNode).issue.number}`,
    repository: (parent) => repositoryObject((parent as IssueNode).repo),
    closed: (parent) => (parent as IssueNode).issue.state === 'closed',
    closedAt: (parent) => (parent as IssueNode).issue.closedAt,
    labels: (parent) => ({ __typename: 'LabelConnection', nodes: (parent as IssueNode).issue.labels.map((label) => ({ __typename: 'Label', name: label.name, color: label.color })) }),
    comments: (parent, args) => {
      const node = parent as IssueNode;
      const comments = node.issue.comments;
      const { nodes, pageInfo } = paginateConnection(
        comments,
        typeof args.first === 'number' ? args.first : undefined,
        typeof args.after === 'string' ? args.after : undefined,
        (comment) => encodeCursor('C', comment.id),
      );
      return {
        __typename: 'IssueCommentConnection',
        nodes: nodes.map((comment) => ({
          __typename: 'IssueComment',
          id: commentGlobalId(node.repo, node.issue, comment.id),
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          repo: node.repo,
          issue: node.issue,
        })),
        pageInfo,
        totalCount: comments.length,
      };
    },
  },
  PullRequest: {
    id: (parent) => pullGlobalId((parent as PullNode).repo, (parent as PullNode).pull),
    number: (parent) => (parent as PullNode).pull.number,
    title: (parent) => (parent as PullNode).pull.title,
    body: (parent) => (parent as PullNode).pull.body,
    state: (parent) => pullState((parent as PullNode).pull),
    merged: (parent) => (parent as PullNode).pull.merged,
    mergeable: (parent) => pullMergeable((parent as PullNode).repo, (parent as PullNode).pull),
    headRefName: (parent) => (parent as PullNode).pull.headRef,
    baseRefName: (parent) => (parent as PullNode).pull.baseRef,
    headRefOid: (parent) => (parent as PullNode).repo.refs.get(`refs/heads/${(parent as PullNode).pull.headRef}`) ?? null,
    baseRefOid: (parent) => (parent as PullNode).repo.refs.get(`refs/heads/${(parent as PullNode).pull.baseRef}`) ?? null,
    createdAt: (parent) => (parent as PullNode).pull.createdAt,
    updatedAt: (parent) => (parent as PullNode).pull.updatedAt,
    author: () => viewerObject(),
    url: (parent) => `https://github.com/${(parent as PullNode).repo.owner}/${(parent as PullNode).repo.name}/pull/${(parent as PullNode).pull.number}`,
    mergedAt: (parent) => (parent as PullNode).pull.mergedAt,
    mergeCommit: (parent) => {
      const node = parent as PullNode;
      const sha = node.pull.mergeCommitSha;
      return sha ? { __typename: 'Commit', oid: sha } : null;
    },
    files: (parent, args) => {
      const node = parent as PullNode;
      const files = pullFilesForGraphQL(node.repo, node.pull);
      const { nodes, pageInfo } = paginateConnection(
        files,
        typeof args.first === 'number' ? args.first : undefined,
        typeof args.after === 'string' ? args.after : undefined,
        (file) => encodeCursor('F', files.indexOf(file)),
      );
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: nodes.map((file) => ({ __typename: 'PullRequestChangedFile', ...file })),
        pageInfo,
        totalCount: files.length,
      };
    },
  },
  IssueConnection: {
    nodes: (parent) => parent.nodes,
    edges: (parent) => parent.edges,
    pageInfo: (parent) => parent.pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  IssueEdge: {
    node: (parent) => parent.node,
    cursor: (parent) => parent.cursor,
  },
  PullRequestConnection: {
    nodes: (parent) => parent.nodes,
    edges: (parent) => parent.edges,
    pageInfo: (parent) => parent.pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  PullRequestEdge: {
    node: (parent) => parent.node,
    cursor: (parent) => parent.cursor,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => parent.nodes,
    edges: (parent) => parent.edges,
    pageInfo: (parent) => parent.pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  PullRequestChangedFile: {
    path: (parent) => parent.path,
    additions: (parent) => parent.additions,
    deletions: (parent) => parent.deletions,
    changeType: (parent) => parent.changeType,
  },
  IssueCommentConnection: {
    nodes: (parent) => parent.nodes,
    edges: (parent) => parent.edges,
    pageInfo: (parent) => parent.pageInfo,
    totalCount: (parent) => parent.totalCount,
  },
  IssueComment: {
    id: (parent) => parent.id,
    body: (parent) => parent.body,
    createdAt: (parent) => parent.createdAt,
    updatedAt: (parent) => parent.updatedAt,
    author: () => viewerObject(),
  },
  IssueCommentEdge: {
    node: (parent) => parent.node,
    cursor: (parent) => parent.cursor,
  },
  LabelConnection: {
    nodes: (parent) => parent.nodes,
  },
  Label: {
    name: (parent) => parent.name,
    color: (parent) => parent.color,
  },
  Ref: {
    name: (parent) => parent.name,
    target: (parent) => ({ __typename: 'Commit', oid: parent.target }),
  },
  Commit: {
    oid: (parent) => parent.oid,
  },
  PageInfo: {
    hasNextPage: (parent) => parent.hasNextPage,
    hasPreviousPage: (parent) => parent.hasPreviousPage,
    startCursor: (parent) => parent.startCursor,
    endCursor: (parent) => parent.endCursor,
  },
  CreateIssuePayload: {
    issue: (parent) => parent.issue,
    clientMutationId: (parent) => parent.clientMutationId ?? null,
  },
  CloseIssuePayload: {
    issue: (parent) => parent.issue,
    clientMutationId: (parent) => parent.clientMutationId ?? null,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest,
    clientMutationId: (parent) => parent.clientMutationId ?? null,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest,
    clientMutationId: (parent) => parent.clientMutationId ?? null,
  },
  AddCommentPayload: {
    commentEdge: (parent) => parent.commentEdge,
    subject: (parent) => parent.subject,
    clientMutationId: (parent) => parent.clientMutationId ?? null,
  },
  __Type: {
    name: (parent) => parent.name,
    kind: (parent) => parent.kind,
    description: (parent) => parent.description,
    fields: (parent) => parent.fields,
    enumValues: (parent) => parent.enumValues,
    inputFields: () => null,
    interfaces: () => [],
    possibleTypes: () => null,
  },
  __Field: {
    name: (parent) => parent.name,
    description: (parent) => parent.description,
    type: () => ({ __typename: '__Type', name: 'String', kind: 'SCALAR' }),
    args: () => [],
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (parent) => parent.name,
    description: (parent) => parent.description,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
};

function executeSelectionSet(
  selections: SelectionNode[],
  parent: AnyRecord,
  parentType: string,
  variables: AnyRecord,
  ctx: GqlCtx,
  doc: DocumentNode,
): AnyRecord {
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition && selection.typeCondition !== parentType) continue;
      const fragmentOut = executeSelectionSet(selection.selectionSet ?? [], parent, parentType, variables, ctx, doc);
      Object.assign(out, fragmentOut);
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = doc.fragments.get(selection.name ?? '');
      if (!fragment) continue;
      if (fragment.typeCondition !== parentType) continue;
      const fragmentOut = executeSelectionSet(fragment.selectionSet, parent, parentType, variables, ctx, doc);
      Object.assign(out, fragmentOut);
      continue;
    }
    const fieldName = selection.name as string;
    const responseKey = selection.alias ?? fieldName;
    if (fieldName === '__typename') {
      out[responseKey] = parentType;
      continue;
    }
    const typeResolvers = resolvers[parentType];
    const resolver = typeResolvers?.[fieldName];
    if (!resolver) {
      throw new GraphQLError(`Cannot query field "${fieldName}" on type "${parentType}".`);
    }
    const args = resolveArgs(selection.args, variables);
    const value = resolver(parent, args, ctx);
    out[responseKey] = completeValue(value, selection.selectionSet, variables, ctx, doc);
  }
  return out;
}

function completeValue(
  value: unknown,
  selectionSet: SelectionNode[] | undefined,
  variables: AnyRecord,
  ctx: GqlCtx,
  doc: DocumentNode,
): unknown {
  if (value === null || value === undefined) return null;
  if (!selectionSet || selectionSet.length === 0) return value;
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(item, selectionSet, variables, ctx, doc));
  }
  if (typeof value === 'object') {
    const parentType = typeNameOf(value);
    return executeSelectionSet(selectionSet, value as AnyRecord, parentType, variables, ctx, doc);
  }
  return value;
}

export function executeGraphQL(store: Store, query: string, variables: AnyRecord): { data: unknown; errors?: Array<{ message: string }> } {
  try {
    const tokens = lex(query);
    const doc = new Parser(tokens).parseDocument();
    if (doc.operations.length === 0) {
      return { data: null, errors: [{ message: 'Must provide an operation.' }] };
    }
    const operation = doc.operations[0];
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const ctx: GqlCtx = { store };
    const data = executeSelectionSet(operation.selectionSet, {}, rootType, variables, ctx, doc);
    return { data };
  } catch (error) {
    if (error instanceof GraphQLError) {
      return { data: null, errors: [{ message: error.message }] };
    }
    return { data: null, errors: [{ message: (error as Error).message }] };
  }
}

export function handleGraphQL(ctx: ReqCtx): boolean {
  if (ctx.jsonError) {
    sendJson(ctx, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return true;
  }
  const body = ctx.json;
  const runOne = (operation: unknown): { data: unknown; errors?: Array<{ message: string }> } => {
    if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
      return { data: null, errors: [{ message: 'Must provide query string.' }] };
    }
    const record = operation as AnyRecord;
    const query = record.query;
    if (typeof query !== 'string' || query === '') {
      return { data: null, errors: [{ message: 'Must provide query string.' }] };
    }
    const variables = (record.variables ?? {}) as AnyRecord;
    return executeGraphQL(ctx.store, query, variables);
  };
  if (Array.isArray(body)) {
    sendJson(ctx, 200, body.map(runOne));
    return true;
  }
  sendJson(ctx, 200, runOne(body));
  return true;
}
