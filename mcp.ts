// mcp.ts — Model Context Protocol surface (Streamable HTTP, JSON-RPC 2.0).
// Implements the modern 2026-07-28 era (server/discover) plus the legacy
// initialize handshake as a fallback. Tools act on the same store as REST.

import { VIEWER_LOGIN, type Store, type Repo } from './store.ts';
import type { ReqCtx } from './http.ts';
import { sendJson } from './http.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Frozen tool list: byte-identical across calls.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'Short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'Owner login of the repository.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository (owner/repo).' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
        body: { type: 'string', description: 'Body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function resolveRepo(store: Store, args: Record<string, unknown>): { owner: string; repoName: string; repo: Repo | null } {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repoName = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repoName === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      owner = owner === '' ? parts[0] : owner;
      repoName = repoName === '' ? parts[1] : repoName;
    }
  }
  const repo = owner !== '' && repoName !== '' ? store.getRepo(owner, repoName) ?? null : null;
  return { owner, repoName, repo };
}

function repoSummary(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return toolError('name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(repoName)) return toolError('name is invalid');
      if (store.getRepo(VIEWER_LOGIN, repoName)) return toolError(`Repository ${repoName} already exists`);
      const repo = store.createRepo(
        VIEWER_LOGIN,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        typeof args.private === 'boolean' ? args.private : false,
      );
      return toolResult(repoSummary(repo));
    }
    case 'get_repo': {
      const { repo } = resolveRepo(store, args);
      if (!repo) return toolError('Not Found');
      return toolResult(repoSummary(repo));
    }
    case 'create_issue': {
      const { repo } = resolveRepo(store, args);
      if (!repo) return toolError('Not Found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return toolError('title is required');
      const issue = store.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return toolResult({
        id: issue.id,
        node_id: `I_${repo.id}_${issue.number}`,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: [],
        user: { login: VIEWER_LOGIN },
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
        html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
      });
    }
    case 'list_issues': {
      const { repo } = resolveRepo(store, args);
      if (!repo) return toolError('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      return toolResult({
        issues: issues.map((issue) => ({
          id: issue.id,
          node_id: `I_${repo.id}_${issue.number}`,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
          user: { login: VIEWER_LOGIN },
          created_at: issue.createdAt,
          updated_at: issue.updatedAt,
          html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
        })),
        total_count: issues.length,
      });
    }
    case 'create_pull_request': {
      const { repo } = resolveRepo(store, args);
      if (!repo) return toolError('Not Found');
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (title === '' || head === '' || base === '') return toolError('title, head and base are required');
      if (!repo.refs.get(`refs/heads/${head}`)) return toolError(`Head branch "${head}" does not exist`);
      if (!repo.refs.get(`refs/heads/${base}`)) return toolError(`Base branch "${base}" does not exist`);
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
          return toolError(`A pull request already exists for ${repo.owner}:${head}`);
        }
      }
      const pull = store.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      return toolResult({
        id: pull.id,
        node_id: `P_${repo.id}_${pull.number}`,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        merged: pull.merged,
        head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
        base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
        user: { login: VIEWER_LOGIN },
        created_at: pull.createdAt,
        updated_at: pull.updatedAt,
        html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
      });
    }
    case 'merge_pull_request': {
      const { repo } = resolveRepo(store, args);
      if (!repo) return toolError('Not Found');
      const pullNumber = Number(args.pull_number);
      if (!Number.isInteger(pullNumber) || pullNumber < 1) return toolError('pull_number is required');
      const pull = repo.pulls.get(pullNumber);
      if (!pull) return toolError('Not Found');
      if (pull.state === 'closed' && pull.merged) return toolError('Pull request already merged');
      if (pull.state === 'closed') return toolError('Pull request is closed');
      const mergeSha = store.squashMerge(repo, pull);
      if (mergeSha === null) return toolError('Merge conflict');
      return toolResult({
        sha: mergeSha,
        merged: true,
        message: `Pull request #${pull.number} successfully merged`,
        number: pull.number,
        state: pull.state,
      });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

export function handleMcp(ctx: ReqCtx): boolean {
  if (ctx.jsonError) {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const body = ctx.json;
  if (!isRecord(body)) {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = body.id ?? null;
  const method = body.method;
  const reply = (result: unknown): void => {
    sendJson(ctx, 200, { jsonrpc: '2.0', id, result });
  };
  const replyError = (code: number, message: string): void => {
    sendJson(ctx, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  if (typeof method !== 'string') {
    replyError(-32600, 'Invalid Request');
    return true;
  }

  // Notifications have no id and expect HTTP 202 with an empty body.
  if (method === 'notifications/initialized') {
    ctx.res.writeHead(202, { 'X-GitHub-Request-Id': ctx.requestId });
    ctx.res.end();
    return true;
  }
  if (method.startsWith('notifications/')) {
    ctx.res.writeHead(202, { 'X-GitHub-Request-Id': ctx.requestId });
    ctx.res.end();
    return true;
  }

  switch (method) {
    case 'server/discover': {
      reply({
        supportedVersions: ['2026-07-28', '2026-03-26', '2025-06-18', '2025-03-26', '2024-11-05'],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: {
          'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return true;
    }
    case 'initialize': {
      reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return true;
    }
    case 'ping': {
      reply({});
      return true;
    }
    case 'tools/list': {
      reply({ tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const params = isRecord(body.params) ? body.params : {};
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const tool = TOOLS.find((entry) => entry.name === toolName);
      if (!tool) {
        replyError(-32601, `Method not found: ${toolName}`);
        return true;
      }
      // Missing required arguments are a tool error, not a transport error.
      const schema = tool.inputSchema as { required?: string[] };
      const missing = (schema.required ?? []).filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        reply(toolError(`Missing required argument: ${missing.join(', ')}`));
        return true;
      }
      reply(callTool(ctx.store, toolName, args));
      return true;
    }
    default: {
      replyError(-32601, `Method not found: ${method}`);
      return true;
    }
  }
}
