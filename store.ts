// store.ts — in-memory data model for the forge.
// Git objects (blob/tree/commit/tag) plus repositories, issues, pull requests,
// labels and comments. Everything is deterministic: no wall clock, no
// unseeded randomness in anything the server sends.

import { createHash } from 'node:crypto';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';
// Fixed epoch for every timestamp the server generates. A counter keeps
// values distinct and ordered without touching the clock.
export const TIME_BASE_MS = 1735689600000; // 2025-01-01T00:00:00Z
export const COMMIT_BASE_TS = 1735689600; // 2025-01-01T00:00:00Z, seconds

export type GitType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitType;
  data: Buffer;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: GitType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

export function storeObject(objects: Map<string, GitObject>, type: GitType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

export function getObject(objects: Map<string, GitObject>, oid: string): GitObject | undefined {
  return objects.get(oid);
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // '100644' | '40000' | '100755' | '120000'
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTreeData(entries: TreeEntry[]): Buffer {
  // Git sorts tree entries by name, treating directories as if the name ends
  // in '/'. All our directory modes are '40000'.
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// A flat file map: path -> {oid, mode}. Directories are implied.
export type FlatTree = Map<string, { oid: string; mode: string }>;

export function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix = '', out: FlatTree = new Map()): FlatTree {
  const obj = objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') {
      flattenTree(objects, entry.oid, path, out);
    } else {
      out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  }
  return out;
}

// Build nested trees from a flat map, storing every tree object. Returns the
// root tree oid.
export function buildTreeFromFlat(objects: Map<string, GitObject>, flat: FlatTree): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const subdirs = new Set<string>();
    for (const [path, file] of flat) {
      if (prefix !== '' && !path.startsWith(prefix + '/')) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: file.mode, name: rest, oid: file.oid });
      } else {
        subdirs.add(rest.slice(0, slash));
      }
    }
    for (const dir of subdirs) {
      const childPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
      entries.push({ mode: '40000', name: dir, oid: build(childPrefix) });
    }
    return storeObject(objects, 'tree', buildTreeData(entries));
  };
  return build('');
}

// ---------------------------------------------------------------------------
// Commits and tags
// ---------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const message = headerEnd === -1 ? '' : text.slice(headerEnd + 2);
  const commit: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5);
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7));
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

export function buildCommitData(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  let text = `tree ${tree}\n`;
  for (const parent of parents) text += `parent ${parent}\n`;
  text += `author ${author}\ncommitter ${committer}\n\n${message}`;
  return Buffer.from(text, 'utf8');
}

export function formatIdentity(name: string, email: string, ts: number): string {
  return `${name} <${email}> ${ts} +0000`;
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd === -1 ? text : text.slice(0, headerEnd);
  const message = headerEnd === -1 ? '' : text.slice(headerEnd + 2);
  const tag: ParsedTag = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7);
    else if (line.startsWith('type ')) tag.type = line.slice(5);
    else if (line.startsWith('tag ')) tag.tag = line.slice(4);
    else if (line.startsWith('tagger ')) tag.tagger = line.slice(7);
  }
  return tag;
}

// Peel a tag (possibly nested) down to the object it ultimately points at.
export function peelToNonTag(objects: Map<string, GitObject>, oid: string): string {
  let current = oid;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const obj = objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTag(obj.data).object;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Graph traversal
// ---------------------------------------------------------------------------

// All commits reachable from `tips` (parents walked), in discovery order.
export function reachableCommits(objects: Map<string, GitObject>, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

// All objects (commits, trees, blobs, tags) reachable from the given commits.
export function reachableObjects(objects: Map<string, GitObject>, tips: string[]): Set<string> {
  const commits = reachableCommits(objects, tips);
  const out = new Set<string>();
  const walkTree = (treeOid: string): void => {
    if (out.has(treeOid)) return;
    out.add(treeOid);
    const obj = objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walkTree(entry.oid);
      else out.add(entry.oid);
    }
  };
  for (const oid of commits) {
    out.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    const commit = parseCommit(obj.data);
    walkTree(commit.tree);
  }
  return out;
}

// Reachable commits from tips, but never walking past a commit in `cut`
// (the cut commit itself is included, its parents are not).
export function reachableCommitsWithCut(objects: Map<string, GitObject>, tips: string[], cut: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    if (cut.has(oid)) continue;
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

// Objects reachable from tips with a cut (for shallow boundaries).
export function reachableObjectsWithCut(objects: Map<string, GitObject>, tips: string[], cut: Set<string>): Set<string> {
  const commits = reachableCommitsWithCut(objects, tips, cut);
  const out = new Set<string>();
  const walkTree = (treeOid: string): void => {
    if (out.has(treeOid)) return;
    out.add(treeOid);
    const obj = objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walkTree(entry.oid);
      else out.add(entry.oid);
    }
  };
  for (const oid of commits) {
    out.add(oid);
    const obj = objects.get(oid);
    if (!obj) continue;
    walkTree(parseCommit(obj.data).tree);
  }
  return out;
}

// First common ancestor of a and b (BFS from a, then walk b).
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const ancestorsA = reachableCommits(objects, [a]);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

export function isAncestor(objects: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return reachableCommits(objects, [descendant]).has(ancestor);
}

// Distance (edges) from each commit reachable from tips, BFS.
export function commitDistances(objects: Map<string, GitObject>, tips: string[]): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const tip of tips) {
    if (!dist.has(tip)) {
      dist.set(tip, 0);
      queue.push(tip);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const d = dist.get(oid) as number;
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!dist.has(parent)) {
        dist.set(parent, d + 1);
        queue.push(parent);
      }
    }
  }
  return dist;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

export function diffFlat(a: FlatTree, b: FlatTree): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...a.keys(), ...b.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = a.get(path);
    const newEntry = b.get(path);
    if (oldEntry && !newEntry) {
      changes.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    } else if (!oldEntry && newEntry) {
      changes.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) {
      changes.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return changes;
}

export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  // A trailing newline does not create an extra line.
  return text.endsWith('\n') ? lines.length - 1 : lines.length;
}

// ---------------------------------------------------------------------------
// Repositories, issues, pull requests
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  createdSeq: number;
  // Serialized JSON cache for the single-issue GET (the read workload hits
  // one issue thousands of times). Cleared on any mutation of the issue.
  cachedJson: string | null;
  cachedJsonOrigin: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  numberSeq: number;
  labelSeq: number;
}

export class Store {
  repos = new Map<string, Repo>(); // key: owner/name
  repoSeq = 0;
  issueIdSeq = 0;
  commentIdSeq = 0;
  pullIdSeq = 0;
  labelGlobalSeq = 0;
  commitSeq = 0;
  timeSeq = 0;

  nextTimestamp(): string {
    this.timeSeq += 1;
    return new Date(TIME_BASE_MS + this.timeSeq * 1000).toISOString().replace('.000Z', 'Z');
  }

  nextCommitTs(): number {
    this.commitSeq += 1;
    return COMMIT_BASE_TS + this.commitSeq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    this.repoSeq += 1;
    const now = this.nextTimestamp();
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      numberSeq: 0,
      labelSeq: 0,
    };
    // Default GitHub labels, in the order the suite expects.
    const defaults: Array<[string, string]> = [
      ['bug', 'd73a4a'],
      ['enhancement', 'a2eeef'],
      ['documentation', '0075ca'],
      ['question', 'd876e3'],
      ['good first issue', '7057ff'],
      ['help wanted', '008672'],
    ];
    for (const [labelName, color] of defaults) {
      repo.labelSeq += 1;
      this.labelGlobalSeq += 1;
      repo.labels.set(labelName, { id: this.labelGlobalSeq, name: labelName, color, description: '' });
    }
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listReposForOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  // Create a commit on a branch from a flat-tree mutation. `apply` receives
  // the current flat tree (empty for an unborn branch) and returns the new
  // flat tree. Returns the new commit oid.
  commitOnBranch(
    repo: Repo,
    branch: string,
    message: string,
    apply: (flat: FlatTree) => FlatTree,
  ): string {
    const refName = `refs/heads/${branch}`;
    const current = repo.refs.get(refName);
    let flat: FlatTree = new Map();
    let parents: string[] = [];
    if (current) {
      const obj = repo.objects.get(current);
      if (obj && obj.type === 'commit') {
        flat = flattenTree(repo.objects, parseCommit(obj.data).tree);
        parents = [current];
      }
    }
    const next = apply(flat);
    const treeOid = buildTreeFromFlat(repo.objects, next);
    const ts = this.nextCommitTs();
    const identity = formatIdentity(VIEWER_NAME, VIEWER_EMAIL, ts);
    const commitData = buildCommitData(treeOid, parents, identity, identity, message);
    const commitOid = storeObject(repo.objects, 'commit', commitData);
    repo.refs.set(refName, commitOid);
    return commitOid;
  }

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue {
    this.issueIdSeq += 1;
    repo.numberSeq += 1;
    const now = this.nextTimestamp();
    const labels: Label[] = [];
    for (const labelName of labelNames) {
      const label = repo.labels.get(labelName);
      if (label) labels.push(label);
    }
    const issue: Issue = {
      id: this.issueIdSeq,
      number: repo.numberSeq,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      createdSeq: this.timeSeq,
      cachedJson: null,
      cachedJsonOrigin: '',
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    this.pullIdSeq += 1;
    repo.numberSeq += 1;
    const now = this.nextTimestamp();
    const pull: Pull = {
      id: this.pullIdSeq,
      number: repo.numberSeq,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha: repo.refs.get(`refs/heads/${headRef}`) ?? ZERO_OID,
      baseSha: repo.refs.get(`refs/heads/${baseRef}`) ?? ZERO_OID,
      createdAt: now,
      updatedAt: now,
      createdSeq: this.timeSeq,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  // Squash-merge a pull request. Returns the merge commit oid, or null when
  // the merge conflicts with the current base tip.
  squashMerge(repo: Repo, pull: Pull): string | null {
    const baseRefName = `refs/heads/${pull.baseRef}`;
    const headRefName = `refs/heads/${pull.headRef}`;
    const baseTip = repo.refs.get(baseRefName);
    const headTip = repo.refs.get(headRefName);
    if (!baseTip || !headTip) return null;
    const baseObj = repo.objects.get(baseTip);
    const headObj = repo.objects.get(headTip);
    if (!baseObj || baseObj.type !== 'commit' || !headObj || headObj.type !== 'commit') return null;
    const baseFlat = flattenTree(repo.objects, parseCommit(baseObj.data).tree);
    const headFlat = flattenTree(repo.objects, parseCommit(headObj.data).tree);
    const mb = mergeBase(repo.objects, baseTip, headTip);
    const mbFlat: FlatTree = mb ? flattenTree(repo.objects, parseCommit((repo.objects.get(mb) as GitObject).data).tree) : new Map();
    const changes = diffFlat(mbFlat, headFlat);
    // Conflict: a file the PR changes was also changed on the base tip in a
    // different way since the merge base.
    for (const change of changes) {
      const baseEntry = baseFlat.get(change.path);
      const mbEntry = mbFlat.get(change.path);
      const baseOid = baseEntry ? baseEntry.oid : null;
      const mbOid = mbEntry ? mbEntry.oid : null;
      if (baseOid !== mbOid && baseOid !== change.newOid) return null;
    }
    const next = new Map(baseFlat);
    for (const change of changes) {
      if (change.newOid === null) next.delete(change.path);
      else next.set(change.path, { oid: change.newOid, mode: '100644' });
    }
    const treeOid = buildTreeFromFlat(repo.objects, next);
    const ts = this.nextCommitTs();
    const identity = formatIdentity(VIEWER_NAME, VIEWER_EMAIL, ts);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
    const commitData = buildCommitData(treeOid, [baseTip, headTip], identity, identity, message);
    const mergeOid = storeObject(repo.objects, 'commit', commitData);
    repo.refs.set(baseRefName, mergeOid);
    const now = this.nextTimestamp();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = now;
    pull.mergeCommitSha = mergeOid;
    pull.updatedAt = now;
    return mergeOid;
  }
}
