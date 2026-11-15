// rest.ts — GitHub REST API v3 surface. Every reply is JSON with a
// non-empty X-GitHub-Request-Id; errors carry a string `message`. Unknown
// routes are JSON 404s. Auth is enforced by app.ts before this runs.

import {
  VIEWER_LOGIN,
  VIEWER_ID,
  VIEWER_NAME,
  VIEWER_EMAIL,
  ZERO_OID,
  DEFAULT_BRANCH,
  type Store,
  type Repo,
  type Issue,
  type Pull,
  type Label,
  parseCommit,
  mergeBase,
  flattenTree,
  diffFlat,
  countLines,
  storeObject,
  getObject,
} from './store.ts';
import type { ReqCtx } from './http.ts';
import { sendJson, errorJson, paginate, parsePagination, linkHeader, decodeSegment, sendJsonString } from './http.ts';

function origin(ctx: ReqCtx): string {
  return ctx.url.origin;
}

function userView(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: `U_${VIEWER_ID}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
    gravatar_id: '',
    url: `https://api.github.com/users/${VIEWER_LOGIN}`,
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
    name: VIEWER_NAME,
    company: null,
    blog: '',
    location: null,
    email: VIEWER_EMAIL,
    hireable: null,
    bio: null,
    public_repos: 0,
    public_gists: 0,
    followers: 0,
    following: 0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function ownerView(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: `U_${VIEWER_ID}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${VIEWER_ID}?v=4`,
    gravatar_id: '',
    url: `https://api.github.com/users/${VIEWER_LOGIN}`,
    html_url: `https://github.com/${VIEWER_LOGIN}`,
    type: 'User',
    site_admin: false,
  };
}

function repoView(ctx: ReqCtx, repo: Repo): Record<string, unknown> {
  const base = origin(ctx);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: ownerView(),
    private: repo.isPrivate,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://${base}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `${base}/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length + [...repo.pulls.values()].filter((p) => p.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: 0,
    watchers: 0,
    default_branch: repo.defaultBranch,
  };
}

function labelView(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    url: `https://api.github.com/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueView(ctx: ReqCtx, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = origin(ctx);
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: ownerView(),
    labels: issue.labels.map(labelView),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: null,
  };
}

// Send a single-issue GET, reusing the cached serialized JSON when the
// issue has not changed since it was built.
function sendIssueView(ctx: ReqCtx, repo: Repo, issue: Issue): void {
  const base = origin(ctx);
  if (issue.cachedJson !== null && issue.cachedJsonOrigin === base) {
    sendJsonString(ctx, 200, issue.cachedJson);
    return;
  }
  const json = JSON.stringify(issueView(ctx, repo, issue));
  issue.cachedJson = json;
  issue.cachedJsonOrigin = base;
  sendJsonString(ctx, 200, json);
}

// Clear the cached JSON after any mutation of an issue.
function touchIssue(issue: Issue): void {
  issue.cachedJson = null;
}

function commentView(ctx: ReqCtx, repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  const base = origin(ctx);
  return {
    id: comment.id,
    node_id: `C_${repo.id}_${issue.number}_${comment.id}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: ownerView(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

function pullView(ctx: ReqCtx, repo: Repo, pull: Pull): Record<string, unknown> {
  const base = origin(ctx);
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: `P_${repo.id}_${pull.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: ownerView(),
    labels: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: null,
    mergeable_state: 'unknown',
    merged_by: pull.merged ? ownerView() : null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: headSha,
      user: ownerView(),
      repo: repoView(ctx, repo),
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: baseSha,
      user: ownerView(),
      repo: repoView(ctx, repo),
    },
    draft: false,
    author_association: 'OWNER',
  };
}

function commitView(ctx: ReqCtx, repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  const message = commit.message.endsWith('\n') ? commit.message.slice(0, -1) : commit.message;
  const parseIdentity = (raw: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(raw);
    if (!match) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: '2025-01-01T00:00:00Z' };
    return {
      name: match[1],
      email: match[2],
      date: new Date(Number(match[3]) * 1000).toISOString().replace('.000Z', 'Z'),
    };
  };
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      author,
      committer,
      message,
      tree: { sha: commit.tree, url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
      url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `${origin(ctx)}/${repo.owner}/${repo.name}/commit/${sha}`,
    comments_url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}/comments`,
    author: ownerView(),
    committer: ownerView(),
    parents: commit.parents.map((parent) => ({
      sha: parent,
      url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}`,
      html_url: `${origin(ctx)}/${repo.owner}/${repo.name}/commit/${parent}`,
    })),
  };
}

function branchView(ctx: ReqCtx, repo: Repo, branch: string): Record<string, unknown> | null {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) return null;
  return {
    name: branch,
    commit: {
      sha,
      url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    },
    protected: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function bodyBoolean(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  return typeof value === 'boolean' ? value : fallback;
}

// Resolve a ref (branch name or commit sha) to a commit oid.
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch) return branch;
  const obj = repo.objects.get(ref);
  if (obj && obj.type === 'commit') return ref;
  return null;
}

export function handleRest(ctx: ReqCtx): boolean {
  const method = ctx.req.method ?? 'GET';
  const parts = ctx.pathname.split('/').filter((part) => part !== '');
  // All REST routes live under /api/v3.
  if (parts[0] !== 'api' || parts[1] !== 'v3') return false;
  const rest = parts.slice(2);

  // GET /api/v3/ — API root.
  if (rest.length === 0) {
    if (method !== 'GET') return methodNotAllowed(ctx);
    const base = origin(ctx);
    sendJson(ctx, 200, {
      current_user_url: `${base}/api/v3/user`,
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: `${base}/api/v3/authorizations`,
      code_search_url: `${base}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
      commit_search_url: `${base}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
      emails_url: `${base}/api/v3/user/emails`,
      emojis_url: `${base}/api/v3/emojis`,
      events_url: `${base}/api/v3/events`,
      feeds_url: `${base}/api/v3/feeds`,
      followers_url: `${base}/api/v3/user/followers`,
      following_url: `${base}/api/v3/user/following{/target}`,
      gists_url: `${base}/api/v3/gists{/gist_id}`,
      hub_url: `${base}/api/v3/hub`,
      issue_search_url: `${base}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
      issues_url: `${base}/api/v3/issues`,
      keys_url: `${base}/api/v3/user/keys`,
      label_search_url: `${base}/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
      notifications_url: `${base}/api/v3/notifications`,
      organization_url: `${base}/api/v3/orgs/{org}`,
      organization_repositories_url: `${base}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
      organization_teams_url: `${base}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${base}/api/v3/gists/public`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${base}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
      current_user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${base}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${base}/api/v3/gists/starred`,
      topic_search_url: `${base}/api/v3/search/topics?q={query}{&page,per_page}`,
      user_url: `${base}/api/v3/users/{user}`,
      user_organizations_url: `${base}/api/v3/users/{user}/orgs`,
      search_url: `${base}/api/v3/search`,
      user_search_url: `${base}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return methodNotAllowed(ctx);
    sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }

  // /api/v3/user and /api/v3/user/repos
  if (rest[0] === 'user') {
    if (rest.length === 1) {
      if (method !== 'GET') return methodNotAllowed(ctx);
      sendJson(ctx, 200, userView());
      return true;
    }
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'GET') {
        const params = parsePagination(ctx.url);
        const repos = ctx.store.listReposForOwner(VIEWER_LOGIN);
        const { page, hasNext } = paginate(repos, params);
        const link = linkHeader(ctx, params, hasNext, params.page > 1);
        sendJson(ctx, 200, page.map((repo) => repoView(ctx, repo)), link ? { Link: link } : undefined);
        return true;
      }
      if (method === 'POST') {
        if (ctx.jsonError || !isRecord(ctx.json)) return malformedJson(ctx);
        const name = bodyString(ctx.json, 'name');
        if (name === '') return errorJson(ctx, 422, 'name is required');
        if (!/^[A-Za-z0-9._-]+$/.test(name)) return errorJson(ctx, 422, 'name is invalid');
        if (ctx.store.getRepo(VIEWER_LOGIN, name)) {
          return errorJson(ctx, 422, `Repository ${name} already exists`);
        }
        const repo = ctx.store.createRepo(
          VIEWER_LOGIN,
          name,
          bodyString(ctx.json, 'description'),
          bodyBoolean(ctx.json, 'private', false),
        );
        sendJson(ctx, 201, repoView(ctx, repo));
        return true;
      }
      return methodNotAllowed(ctx);
    }
    return false;
  }

  // /api/v3/repos/{owner}/{name}/...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeSegment(rest[1]);
    const name = decodeSegment(rest[2]);
    const repo = ctx.store.getRepo(owner, name);
    if (!repo || owner !== VIEWER_LOGIN) {
      errorJson(ctx, 404, 'Not Found');
      return true;
    }
    return handleRepoRoute(ctx, repo, rest.slice(3), method);
  }

  return false;
}

function methodNotAllowed(ctx: ReqCtx): boolean {
  errorJson(ctx, 405, 'Method Not Allowed');
  return true;
}

function malformedJson(ctx: ReqCtx): boolean {
  errorJson(ctx, 400, 'Problems parsing JSON');
  return true;
}

function handleRepoRoute(ctx: ReqCtx, repo: Repo, tail: string[], method: string): boolean {
  // /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, repoView(ctx, repo));
      return true;
    }
    if (method === 'PATCH') {
      if (ctx.jsonError || !isRecord(ctx.json)) return malformedJson(ctx);
      if (typeof ctx.json.description === 'string') repo.description = ctx.json.description;
      if (typeof ctx.json.private === 'boolean') repo.isPrivate = ctx.json.private;
      if (typeof ctx.json.name === 'string' && ctx.json.name !== '' && ctx.json.name !== repo.name) {
        const newName = ctx.json.name as string;
        if (!/^[A-Za-z0-9._-]+$/.test(newName)) return errorJson(ctx, 422, 'name is invalid');
        if (ctx.store.getRepo(repo.owner, newName)) {
          return errorJson(ctx, 422, `Repository ${newName} already exists`);
        }
        ctx.store.deleteRepo(repo.owner, repo.name);
        repo.name = newName;
        ctx.store.repos.set(ctx.store.repoKey(repo.owner, newName), repo);
      }
      sendJson(ctx, 200, repoView(ctx, repo));
      return true;
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(repo.owner, repo.name);
      ctx.res.writeHead(204, { 'X-GitHub-Request-Id': ctx.requestId });
      ctx.res.end();
      return true;
    }
    return methodNotAllowed(ctx);
  }

  const head = tail[0];

  // Branches.
  if (head === 'branches') {
    if (tail.length === 1) {
      if (method !== 'GET') return methodNotAllowed(ctx);
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((branch) => branchView(ctx, repo, branch));
      sendJson(ctx, 200, branches);
      return true;
    }
    if (tail.length === 2) {
      if (method !== 'GET') return methodNotAllowed(ctx);
      const view = branchView(ctx, repo, decodeSegment(tail[1]));
      if (!view) return errorJson(ctx, 404, 'Branch not found'), true;
      sendJson(ctx, 200, view);
      return true;
    }
    return false;
  }

  // Commits.
  if (head === 'commits') {
    if (tail.length === 1) {
      if (method !== 'GET') return methodNotAllowed(ctx);
      const shaParam = ctx.url.searchParams.get('sha');
      const tip = resolveRef(repo, shaParam);
      const commits: Record<string, unknown>[] = [];
      if (tip) {
        const seen = new Set<string>();
        const stack = [tip];
        while (stack.length > 0) {
          const oid = stack.pop() as string;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const view = commitView(ctx, repo, oid);
          if (!view) continue;
          commits.push(view);
          const obj = repo.objects.get(oid);
          if (obj && obj.type === 'commit') {
            const parents = parseCommit(obj.data).parents;
            for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]);
          }
        }
      }
      const params = parsePagination(ctx.url);
      const { page, hasNext } = paginate(commits, params);
      const link = linkHeader(ctx, params, hasNext, params.page > 1);
      sendJson(ctx, 200, page, link ? { Link: link } : undefined);
      return true;
    }
    return false;
  }

  // Git refs.
  if (head === 'git' && tail[1] === 'refs') {
    if (method === 'POST' && tail.length === 2) {
      if (ctx.jsonError || !isRecord(ctx.json)) return malformedJson(ctx);
      const ref = bodyString(ctx.json, 'ref');
      const sha = bodyString(ctx.json, 'sha');
      if (!ref.startsWith('refs/') || sha === '') {
        return errorJson(ctx, 422, 'Invalid request');
      }
      const obj = repo.objects.get(sha);
      if (!obj || obj.type !== 'commit') {
        return errorJson(ctx, 422, 'Object does not exist');
      }
      if (repo.refs.has(ref)) {
        return errorJson(ctx, 422, 'Reference already exists');
      }
      repo.refs.set(ref, sha);
      sendJson(ctx, 201, {
        ref,
        node_id: `R_${repo.id}_${ref}`,
        url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}`,
        object: { sha, type: 'commit', url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
      });
      return true;
    }
    if (method === 'GET' && tail.length >= 4) {
      // /git/refs/heads/{branch} or /git/refs/tags/{tag}
      const refName = tail.slice(2).map(decodeSegment).join('/');
      const sha = repo.refs.get(refName);
      if (!sha) return errorJson(ctx, 404, 'Not Found'), true;
      sendJson(ctx, 200, {
        ref: refName,
        node_id: `R_${repo.id}_${refName}`,
        url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${refName}`,
        object: { sha, type: 'commit', url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
      });
      return true;
    }
    return false;
  }

  // Contents.
  if (head === 'contents') {
    return handleContents(ctx, repo, tail.slice(1), method);
  }

  // Labels.
  if (head === 'labels') {
    if (tail.length === 1) {
      if (method === 'GET') {
        sendJson(ctx, 200, [...repo.labels.values()].sort((a, b) => a.id - b.id).map(labelView));
        return true;
      }
      if (method === 'POST') {
        if (ctx.jsonError || !isRecord(ctx.json)) return malformedJson(ctx);
        const name = bodyString(ctx.json, 'name');
        if (name === '') return errorJson(ctx, 422, 'name is required');
        const existing = repo.labels.get(name);
        if (existing) {
          sendJson(ctx, 201, labelView(existing));
          return true;
        }
        repo.labelSeq += 1;
        ctx.store.labelGlobalSeq += 1;
        const label: Label = {
          id: ctx.store.labelGlobalSeq,
          name,
          color: typeof ctx.json.color === 'string' ? (ctx.json.color as string).replace(/^#/, '') : 'ededed',
          description: bodyString(ctx.json, 'description'),
        };
        repo.labels.set(name, label);
        sendJson(ctx, 201, labelView(label));
        return true;
      }
      return methodNotAllowed(ctx);
    }
    return false;
  }

  // Issues.
  if (head === 'issues') {
    return handleIssues(ctx, repo, tail.slice(1), method);
  }

  // Pulls.
  if (head === 'pulls') {
    return handlePulls(ctx, repo, tail.slice(1), method);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

function handleContents(ctx: ReqCtx, repo: Repo, tail: string[], method: string): boolean {
  const path = tail.map(decodeSegment).join('/');
  const refParam = ctx.url.searchParams.get('ref');
  const tip = resolveRef(repo, refParam);
  const flat = tip ? flattenTree(repo.objects, parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree) : null;

  if (method === 'GET') {
    if (!tip || !flat) return errorJson(ctx, 404, 'Not Found'), true;
    if (path === '') {
      // Root directory listing.
      sendJson(ctx, 200, directoryEntries(ctx, repo, flat, ''));
      return true;
    }
    const file = flat.get(path);
    if (file) {
      const obj = repo.objects.get(file.oid);
      if (!obj) return errorJson(ctx, 404, 'Not Found'), true;
      sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: obj.data.length,
        name: path.split('/').pop(),
        path,
        content: obj.data.toString('base64'),
        sha: file.oid,
        url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `${origin(ctx)}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
        git_url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.oid}`,
        download_url: `${origin(ctx)}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
        _links: {
          git: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.oid}`,
          self: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
          html: `${origin(ctx)}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
        },
      });
      return true;
    }
    // Directory?
    const prefix = `${path}/`;
    let isDir = false;
    for (const key of flat.keys()) {
      if (key.startsWith(prefix)) {
        isDir = true;
        break;
      }
    }
    if (isDir) {
      sendJson(ctx, 200, directoryEntries(ctx, repo, flat, path));
      return true;
    }
    return errorJson(ctx, 404, 'Not Found'), true;
  }

  if (method === 'PUT') {
    if (ctx.jsonError || !isRecord(ctx.json)) return malformedJson(ctx);
    const message = bodyString(ctx.json, 'message');
    const contentB64 = bodyString(ctx.json, 'content');
    const sha = typeof ctx.json.sha === 'string' ? (ctx.json.sha as string) : null;
    const branch = typeof ctx.json.branch === 'string' && (ctx.json.branch as string) !== ''
      ? (ctx.json.branch as string)
      : repo.defaultBranch;
    if (message === '' || contentB64 === '') return errorJson(ctx, 422, 'message and content are required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return errorJson(ctx, 422, 'content is not valid base64');
    }
    const branchTip = repo.refs.get(`refs/heads/${branch}`);
    const currentFlat: Map<string, { oid: string; mode: string }> = branchTip
      ? flattenTree(repo.objects, parseCommit((repo.objects.get(branchTip) as { data: Buffer }).data).tree)
      : new Map();
    const existing = currentFlat.get(path);
    if (sha !== null) {
      // Update: sha must match the current blob.
      if (!existing || existing.oid !== sha) return errorJson(ctx, 409, 'sha does not match');
    }
    const isUpdate = existing !== undefined;
    let createdSha = '';
    ctx.store.commitOnBranch(repo, branch, message, (flatMap) => {
      const next = new Map(flatMap);
      createdSha = storeObject(repo.objects, 'blob', content);
      next.set(path, { oid: createdSha, mode: '100644' });
      return next;
    });
    const commitSha = repo.refs.get(`refs/heads/${branch}`) as string;
    sendJson(ctx, isUpdate ? 200 : 201, {
      content: {
        name: path.split('/').pop(),
        path,
        sha: createdSha,
        size: content.length,
        url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        html_url: `${origin(ctx)}/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
        git_url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${createdSha}`,
        download_url: `${origin(ctx)}/${repo.owner}/${repo.name}/raw/${branch}/${path}`,
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
        _links: {
          git: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${createdSha}`,
          self: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
          html: `${origin(ctx)}/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
        },
      },
      commit: commitView(ctx, repo, commitSha),
    });
    return true;
  }

  if (method === 'DELETE') {
    if (ctx.jsonError || !isRecord(ctx.json)) return malformedJson(ctx);
    const message = bodyString(ctx.json, 'message');
    const sha = typeof ctx.json.sha === 'string' ? (ctx.json.sha as string) : null;
    const branch = typeof ctx.json.branch === 'string' && (ctx.json.branch as string) !== ''
      ? (ctx.json.branch as string)
      : repo.defaultBranch;
    if (message === '') return errorJson(ctx, 422, 'message is required');
    const branchTip = repo.refs.get(`refs/heads/${branch}`);
    if (!branchTip) return errorJson(ctx, 404, 'Not Found'), true;
    const currentFlat = flattenTree(repo.objects, parseCommit((repo.objects.get(branchTip) as { data: Buffer }).data).tree);
    const existing = currentFlat.get(path);
    if (!existing) return errorJson(ctx, 404, 'Not Found'), true;
    if (sha !== null && existing.oid !== sha) return errorJson(ctx, 409, 'sha does not match');
    ctx.store.commitOnBranch(repo, branch, message, (flatMap) => {
      const next = new Map(flatMap);
      next.delete(path);
      return next;
    });
    const commitSha = repo.refs.get(`refs/heads/${branch}`) as string;
    sendJson(ctx, 200, { commit: commitView(ctx, repo, commitSha) });
    return true;
  }

  return methodNotAllowed(ctx);
}

function directoryEntries(ctx: ReqCtx, repo: Repo, flat: Map<string, { oid: string; mode: string }>, dir: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; oid: string }>();
  for (const [path, file] of flat) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      entries.set(rest, { type: 'file', oid: file.oid });
    } else {
      entries.set(rest.slice(0, slash), { type: 'dir', oid: '' });
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const name of [...entries.keys()].sort()) {
    const entry = entries.get(name) as { type: 'file' | 'dir'; oid: string };
    const entryPath = prefix + name;
    out.push({
      type: entry.type,
      size: entry.type === 'file' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0,
      name,
      path: entryPath,
      sha: entry.oid,
      url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${entryPath}`,
      html_url: `${origin(ctx)}/${repo.owner}/${repo.name}/${entry.type === 'dir' ? 'tree' : 'blob'}/${repo.defaultBranch}/${entryPath}`,
      git_url: entry.type === 'file'
        ? `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`
        : `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${entry.oid}`,
      download_url: entry.type === 'file' ? `${origin(ctx)}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${entryPath}` : null,
      _links: {
        git: entry.type === 'file'
          ? `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${entry.oid}`
          : `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${entry.oid}`,
        self: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${entryPath}`,
        html: `${origin(ctx)}/${repo.owner}/${repo.name}/${entry.type === 'dir' ? 'tree' : 'blob'}/${repo.defaultBranch}/${entryPath}`,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function handleIssues(ctx: ReqCtx, repo: Repo, tail: string[], method: string): boolean {
  // /issues
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      const sort = ctx.url.searchParams.get('sort') ?? 'created';
      const direction = ctx.url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      if (sort === 'created') {
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      const params = parsePagination(ctx.url);
      const { page, hasNext } = paginate(issues, params);
      const link = linkHeader(ctx, params, hasNext, params.page > 1);
      sendJson(ctx, 200, page.map((issue) => issueView(ctx, repo, issue)), link ? { Link: link } : undefined);
      return true;
    }
    if (method === 'POST') {
      if (ctx.jsonError || !isRecord(ctx.json)) return malformedJson(ctx);
      const title = bodyString(ctx.json, 'title');
      if (title === '') return errorJson(ctx, 422, 'title is required');
      const labelNames: string[] = [];
      if (Array.isArray(ctx.json.labels)) {
        for (const label of ctx.json.labels as unknown[]) {
          if (typeof label === 'string') labelNames.push(label);
          else if (isRecord(label) && typeof label.name === 'string') labelNames.push(label.name as string);
        }
      }
      for (const labelName of labelNames) {
        if (!repo.labels.has(labelName)) {
          return errorJson(ctx, 422, `Label "${labelName}" does not exist`);
        }
      }
      const issue = ctx.store.createIssue(repo, title, bodyString(ctx.json, 'body'), labelNames);
      sendJson(ctx, 201, issueView(ctx, repo, issue));
      return true;
    }
    return methodNotAllowed(ctx);
  }

  // /issues/{number}
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return errorJson(ctx, 404, 'Not Found'), true;
  const issue = repo.issues.get(number);
  if (!issue) return errorJson(ctx, 404, 'Not Found'), true;

  if (tail.length === 1) {
    if (method === 'GET') {
      sendIssueView(ctx, repo, issue);
      return true;
    }
    if (method === 'PATCH') {
      if (ctx.jsonError || !isRecord(ctx.json)) return malformedJson(ctx);
      if (typeof ctx.json.title === 'string') issue.title = ctx.json.title as string;
      if (typeof ctx.json.body === 'string') issue.body = ctx.json.body as string;
      if (typeof ctx.json.state === 'string') {
        const state = ctx.json.state as string;
        if (state === 'open' || state === 'closed') {
          issue.state = state;
          issue.closedAt = state === 'closed' ? ctx.store.nextTimestamp() : null;
        }
      }
      if (Array.isArray(ctx.json.labels)) {
        const labelNames: string[] = [];
        for (const label of ctx.json.labels as unknown[]) {
          if (typeof label === 'string') labelNames.push(label);
          else if (isRecord(label) && typeof label.name === 'string') labelNames.push(label.name as string);
        }
        for (const labelName of labelNames) {
          if (!repo.labels.has(labelName)) {
            return errorJson(ctx, 422, `Label "${labelName}" does not exist`);
          }
        }
        issue.labels = labelNames.map((labelName) => repo.labels.get(labelName) as Label);
      }
      issue.updatedAt = ctx.store.nextTimestamp();
      touchIssue(issue);
      sendJson(ctx, 200, issueView(ctx, repo, issue));
      return true;
    }
    return methodNotAllowed(ctx);
  }

  // /issues/{number}/comments
  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'GET') {
      const params = parsePagination(ctx.url);
      const { page, hasNext } = paginate(issue.comments, params);
      const link = linkHeader(ctx, params, hasNext, params.page > 1);
      sendJson(ctx, 200, page.map((comment) => commentView(ctx, repo, issue, comment)), link ? { Link: link } : undefined);
      return true;
    }
    if (method === 'POST') {
      if (ctx.jsonError || !isRecord(ctx.json)) return malformedJson(ctx);
      const body = bodyString(ctx.json, 'body');
      if (body === '') return errorJson(ctx, 422, 'body is required');
      ctx.store.commentIdSeq += 1;
      const now = ctx.store.nextTimestamp();
      const comment = { id: ctx.store.commentIdSeq, body, createdAt: now, updatedAt: now };
      issue.comments.push(comment);
      issue.updatedAt = now;
      touchIssue(issue);
      sendJson(ctx, 201, commentView(ctx, repo, issue, comment));
      return true;
    }
    return methodNotAllowed(ctx);
  }

  return false;
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function pullFiles(ctx: ReqCtx, repo: Repo, pull: Pull): Record<string, unknown>[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headObj = repo.objects.get(headTip);
  const baseObj = repo.objects.get(baseTip);
  if (!headObj || headObj.type !== 'commit' || !baseObj || baseObj.type !== 'commit') return [];
  const headFlat = flattenTree(repo.objects, parseCommit(headObj.data).tree);
  // Diff merge-base -> head (GitHub shows the PR diff, not base-tip -> head).
  const mb = mergeBase(repo.objects, baseTip, headTip);
  const mbFlat = mb ? flattenTree(repo.objects, parseCommit((repo.objects.get(mb) as { data: Buffer }).data).tree) : new Map();
  const changes = diffFlat(mbFlat, headFlat);
  return changes.map((change) => {
    const oldData = change.oldOid ? repo.objects.get(change.oldOid)?.data : undefined;
    const newData = change.newOid ? repo.objects.get(change.newOid)?.data : undefined;
    const oldLines = oldData ? oldData.toString('utf8').split('\n').filter((line) => line !== '') : [];
    const newLines = newData ? newData.toString('utf8').split('\n').filter((line) => line !== '') : [];
    const oldCounts = new Map<string, number>();
    for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
    const newCounts = new Map<string, number>();
    for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of newCounts) additions += Math.max(0, count - (oldCounts.get(line) ?? 0));
    for (const [line, count] of oldCounts) deletions += Math.max(0, count - (newCounts.get(line) ?? 0));
    return {
      sha: change.newOid ?? change.oldOid ?? ZERO_OID,
      filename: change.path,
      status: change.status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `${origin(ctx)}/${repo.owner}/${repo.name}/blob/${headTip}/${change.path}`,
      raw_url: `${origin(ctx)}/${repo.owner}/${repo.name}/raw/${headTip}/${change.path}`,
      contents_url: `${origin(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/contents/${change.path}?ref=${headTip}`,
      patch: '',
    };
  });
}

function handlePulls(ctx: ReqCtx, repo: Repo, tail: string[], method: string): boolean {
  // /pulls
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const params = parsePagination(ctx.url);
      const { page, hasNext } = paginate(pulls, params);
      const link = linkHeader(ctx, params, hasNext, params.page > 1);
      sendJson(ctx, 200, page.map((pull) => pullView(ctx, repo, pull)), link ? { Link: link } : undefined);
      return true;
    }
    if (method === 'POST') {
      if (ctx.jsonError || !isRecord(ctx.json)) return malformedJson(ctx);
      const title = bodyString(ctx.json, 'title');
      const head = bodyString(ctx.json, 'head');
      const base = bodyString(ctx.json, 'base');
      if (title === '' || head === '' || base === '') {
        return errorJson(ctx, 422, 'title, head and base are required');
      }
      const headTip = repo.refs.get(`refs/heads/${head}`);
      const baseTip = repo.refs.get(`refs/heads/${base}`);
      if (!headTip) return errorJson(ctx, 422, `Head branch "${head}" does not exist`);
      if (!baseTip) return errorJson(ctx, 422, `Base branch "${base}" does not exist`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return errorJson(ctx, 422, `A pull request already exists for ${repo.owner}:${head}`);
        }
      }
      if (headTip === baseTip) {
        return errorJson(ctx, 422, `No commits between ${base} and ${head}`);
      }
      const pull = ctx.store.createPull(repo, title, bodyString(ctx.json, 'body'), head, base);
      sendJson(ctx, 201, pullView(ctx, repo, pull));
      return true;
    }
    return methodNotAllowed(ctx);
  }

  // /pulls/{number}
  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return errorJson(ctx, 404, 'Not Found'), true;
  const pull = repo.pulls.get(number);
  if (!pull) return errorJson(ctx, 404, 'Not Found'), true;

  if (tail.length === 1) {
    if (method !== 'GET') return methodNotAllowed(ctx);
    sendJson(ctx, 200, pullView(ctx, repo, pull));
    return true;
  }

  if (tail.length === 2 && tail[1] === 'files') {
    if (method !== 'GET') return methodNotAllowed(ctx);
    sendJson(ctx, 200, pullFiles(ctx, repo, pull));
    return true;
  }

  if (tail.length === 2 && tail[1] === 'merge') {
    if (method !== 'PUT') return methodNotAllowed(ctx);
    if (pull.state === 'closed' && pull.merged) {
      return errorJson(ctx, 405, 'Pull request already merged'), true;
    }
    if (pull.state === 'closed') {
      return errorJson(ctx, 405, 'Pull request is closed'), true;
    }
    const mergeSha = ctx.store.squashMerge(repo, pull);
    if (mergeSha === null) {
      return errorJson(ctx, 405, 'Merge conflict'), true;
    }
    sendJson(ctx, 200, {
      sha: mergeSha,
      merged: true,
      message: `Pull request #${pull.number} successfully merged`,
    });
    return true;
  }

  return false;
}
