// http.ts — small shared helpers for the HTTP layer: JSON replies, request
// ids, pagination links. No framework, just node:http.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export interface ReqCtx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  token: string;
  url: URL;
  pathname: string;
  body: Buffer;
  json: unknown;
  jsonError: boolean;
  requestId: string;
}

export function sendJson(ctx: ReqCtx, status: number, value: unknown, extraHeaders?: Record<string, string>): void {
  const body = JSON.stringify(value);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': ctx.requestId,
    'Content-Length': String(Buffer.byteLength(body)),
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  ctx.res.writeHead(status, headers);
  ctx.res.end(body);
}

export function sendBuffer(ctx: ReqCtx, status: number, body: Buffer, contentType: string, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'X-GitHub-Request-Id': ctx.requestId,
    'Content-Length': String(body.length),
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  ctx.res.writeHead(status, headers);
  ctx.res.end(body);
}

export function errorJson(ctx: ReqCtx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

export function sendJsonString(ctx: ReqCtx, status: number, body: string, extraHeaders?: Record<string, string>): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': ctx.requestId,
    'Content-Length': String(Buffer.byteLength(body)),
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  ctx.res.writeHead(status, headers);
  ctx.res.end(body);
}

export function parseBearer(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/.exec(auth);
  return match ? match[1] : null;
}

export interface PageParams {
  page: number;
  perPage: number;
}

export function parsePagination(url: URL): PageParams {
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

export function paginate<T>(items: T[], params: PageParams): { page: T[]; hasNext: boolean; total: number } {
  const total = items.length;
  const start = (params.page - 1) * params.perPage;
  const page = items.slice(start, start + params.perPage);
  return { page, hasNext: start + params.perPage < total, total };
}

// Build a GitHub-style Link header for pagination.
export function linkHeader(ctx: ReqCtx, params: PageParams, hasNext: boolean, hasPrev: boolean): string | null {
  const base = `${ctx.url.origin}${ctx.pathname}`;
  const links: string[] = [];
  const query = new URLSearchParams(ctx.url.searchParams);
  if (hasNext) {
    query.set('page', String(params.page + 1));
    query.set('per_page', String(params.perPage));
    links.push(`<${base}?${query.toString()}>; rel="next"`);
  }
  if (hasPrev) {
    query.set('page', String(params.page - 1));
    query.set('per_page', String(params.perPage));
    links.push(`<${base}?${query.toString()}>; rel="prev"`);
  }
  return links.length > 0 ? links.join(', ') : null;
}

export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
