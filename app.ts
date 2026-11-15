// app.ts — HTTP server: routes git smart HTTP, REST v3, GraphQL v4 and MCP
// onto one in-memory store. /healthz needs no auth; every /api/v3,
// /api/graphql and /mcp route requires the Bearer token from
// MAKEFUN_SHOP_TOKEN.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { parseBearer, sendJson, errorJson, sendBuffer, type ReqCtx } from './http.ts';
import {
  v0UploadAdvertisement,
  v0ReceiveAdvertisement,
  v2Advertisement,
  lsRefsResponse,
  v2FetchResponse,
  v0FetchResponse,
  handleReceivePack,
  receivePackResponse,
  parseV2Request,
  parsePktLines,
  type FetchRequest,
} from './git.ts';

const MAX_BODY_BYTES = 16 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseV0Fetch(body: Buffer): FetchRequest {
  const { lines } = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    let text = line.text;
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul);
    const trimmed = text.trim();
    if (trimmed.startsWith('want ')) wants.push(trimmed.slice(5).trim());
    else if (trimmed.startsWith('have ')) haves.push(trimmed.slice(5).trim());
    else if (trimmed.startsWith('shallow ')) shallow.push(trimmed.slice(8).trim());
    else if (trimmed.startsWith('deepen ')) {
      const parsed = Number(trimmed.slice(7).trim());
      if (Number.isFinite(parsed)) depth = parsed;
    }
  }
  return { wants, haves, shallow, depth, thinPack: true, ofsDelta: true };
}

export function createApp(store: Store, token: string) {
  let requestCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      let body = Buffer.alloc(0);
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Request body too large' }));
        return;
      }
      const host = req.headers.host ?? '127.0.0.1';
      const url = new URL(req.url ?? '/', `http://${host}`);
      const pathname = url.pathname;
      requestCounter += 1;
      const requestId = `forge-${requestCounter.toString(16)}`;
      let json: unknown = undefined;
      let jsonError = false;
      if (body.length > 0) {
        try {
          json = JSON.parse(body.toString('utf8'));
        } catch {
          jsonError = true;
        }
      }
      const ctx: ReqCtx = { req, res, store, token, url, pathname, body, json, jsonError, requestId };

      try {
        // Health probe: no auth.
        if (pathname === '/healthz' && req.method === 'GET') {
          sendJson(ctx, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
        if (gitMatch) {
          handleGit(ctx, gitMatch[1], gitMatch[2], gitMatch[3]);
          return;
        }

        // Authenticated surfaces.
        if (pathname.startsWith('/api/v3') || pathname === '/api/graphql' || pathname === '/mcp') {
          const bearer = parseBearer(req);
          if (bearer === null || bearer !== token) {
            errorJson(ctx, 401, 'Bad credentials');
            return;
          }
          if (pathname === '/api/graphql') {
            if (req.method !== 'POST') {
              errorJson(ctx, 405, 'Method Not Allowed');
              return;
            }
            handleGraphQL(ctx);
            return;
          }
          if (pathname === '/mcp') {
            if (req.method !== 'POST') {
              errorJson(ctx, 405, 'Method Not Allowed');
              return;
            }
            handleMcp(ctx);
            return;
          }
          if (handleRest(ctx)) return;
          errorJson(ctx, 404, 'Not Found');
          return;
        }

        errorJson(ctx, 404, 'Not Found');
      } catch (error) {
        // A handler must never take the server down.
        if (!res.headersSent) {
          try {
            sendJson(ctx, 500, { message: (error as Error).message || 'Internal Server Error' });
          } catch {
            res.writeHead(500);
            res.end();
          }
        } else {
          try {
            res.end();
          } catch {
            // Already gone.
          }
        }
      }
    })();
  });

  return server;
}

function handleGit(ctx: ReqCtx, owner: string, repoName: string, suffix: string): void {
  const repo = ctx.store.getRepo(owner, repoName);
  if (!repo || owner !== VIEWER_LOGIN) {
    errorJson(ctx, 404, 'Not Found');
    return;
  }
  const method = ctx.req.method ?? 'GET';

  if (suffix === 'info/refs' && method === 'GET') {
    const service = ctx.url.searchParams.get('service');
    const protocol = ctx.req.headers['git-protocol'];
    if (service === 'git-upload-pack' && protocol === 'version=2') {
      sendBuffer(ctx, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-upload-pack') {
      sendBuffer(ctx, 200, v0UploadAdvertisement(repo.objects, repo.refs), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(ctx, 200, v0ReceiveAdvertisement(repo.objects, repo.refs), 'application/x-git-receive-pack-advertisement');
      return;
    }
    errorJson(ctx, 400, 'Missing service parameter');
    return;
  }

  if (suffix === 'git-upload-pack' && method === 'POST') {
    const protocol = ctx.req.headers['git-protocol'];
    try {
      if (protocol === 'version=2') {
        const { command, args } = parseV2Request(ctx.body);
        if (command === 'ls-refs') {
          const request = {
            peel: args.includes('peel'),
            symrefs: args.includes('symrefs'),
            unborn: args.includes('unborn'),
            prefixes: args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length)),
          };
          sendBuffer(ctx, 200, lsRefsResponse(repo.objects, repo.refs, request), 'application/x-git-upload-pack-result');
          return;
        }
        if (command === 'fetch') {
          const fetchReq: FetchRequest = {
            wants: [],
            haves: [],
            shallow: [],
            depth: null,
            thinPack: args.includes('thin-pack'),
            ofsDelta: args.includes('ofs-delta'),
          };
          for (const arg of args) {
            if (arg.startsWith('want ')) fetchReq.wants.push(arg.slice(5).trim());
            else if (arg.startsWith('have ')) fetchReq.haves.push(arg.slice(5).trim());
            else if (arg.startsWith('shallow ')) fetchReq.shallow.push(arg.slice(8).trim());
            else if (arg.startsWith('deepen ')) {
              const parsed = Number(arg.slice(7).trim());
              if (Number.isFinite(parsed)) fetchReq.depth = parsed;
            }
          }
          sendBuffer(ctx, 200, v2FetchResponse(repo.objects, fetchReq), 'application/x-git-upload-pack-result');
          return;
        }
        errorJson(ctx, 400, `Unknown command: ${command}`);
        return;
      }
      // Protocol v0 fetch.
      const fetchReq = parseV0Fetch(ctx.body);
      sendBuffer(ctx, 200, v0FetchResponse(repo.objects, fetchReq), 'application/x-git-upload-pack-result');
    } catch (error) {
      errorJson(ctx, 400, (error as Error).message || 'Bad request');
    }
    return;
  }

  if (suffix === 'git-receive-pack' && method === 'POST') {
    try {
      const result = handleReceivePack(repo.objects, repo.refs, ctx.body);
      sendBuffer(ctx, 200, receivePackResponse(result), 'application/x-git-receive-pack-result');
    } catch (error) {
      errorJson(ctx, 400, (error as Error).message || 'Bad request');
    }
    return;
  }

  errorJson(ctx, 404, 'Not Found');
}
