// git.ts — git smart-HTTP protocol (upload-pack v2 + v0, receive-pack v0)
// and packfile read/write. Plain objects only on write; deltas are resolved
// on read. Pure Node stdlib (node:crypto for SHA-1, node:zlib for deflate).

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  DEFAULT_BRANCH,
  type GitObject,
  type GitType,
  hashObject,
  storeObject,
  parseTree,
  parseCommit,
  parseTag,
  peelToNonTag,
  reachableObjects,
  reachableObjectsWithCut,
  reachableCommits,
  commitDistances,
} from './store.ts';

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export function pktLine(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'utf8'), payload]);
}

export const FLUSH = Buffer.from('0000', 'utf8');
export const DELIM = Buffer.from('0001', 'utf8');
export const RESPONSE_END = Buffer.from('0002', 'utf8');

export interface PktLine {
  kind: 'data' | 'flush' | 'delim' | 'end';
  text: string;
}

// Parse pkt-lines from a buffer. Returns lines and the byte offset just past
// the last complete line (the rest is raw data, e.g. a packfile).
export function parsePktLines(buf: Buffer): { lines: PktLine[]; offset: number } {
  const lines: PktLine[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenHex = buf.subarray(offset, offset + 4).toString('utf8');
    if (lenHex === '0000') {
      lines.push({ kind: 'flush', text: '' });
      offset += 4;
      continue;
    }
    if (lenHex === '0001') {
      lines.push({ kind: 'delim', text: '' });
      offset += 4;
      continue;
    }
    if (lenHex === '0002') {
      lines.push({ kind: 'end', text: '' });
      offset += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (Number.isNaN(len) || len < 4 || offset + len > buf.length) break;
    const text = buf.subarray(offset + 4, offset + len).toString('utf8');
    lines.push({ kind: 'data', text });
    offset += len;
  }
  return { lines, offset };
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

function readVarint(data: Buffer, offset: number): { value: number; next: number } {
  let value = data[offset] & 0x7f;
  let next = offset + 1;
  while ((data[next - 1] & 0x80) !== 0) {
    value = ((value + 1) << 7) | (data[next] & 0x7f);
    next += 1;
  }
  return { value, next };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    while (true) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readDeltaVarint();
  const resultSize = readDeltaVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const chunks: Buffer[] = [];
  let total = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          offset |= delta[pos] << (i * 8);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          size |= delta[pos] << (i * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      total += size;
    } else if (op !== 0) {
      chunks.push(delta.subarray(pos, pos + op));
      total += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(chunks, total);
  if (out.length !== resultSize) throw new Error('delta result size mismatch');
  return out;
}

export interface ParsedPack {
  objects: Array<{ type: GitType; data: Buffer }>;
}

// Read a packfile (version 2). Resolves OFS_DELTA and REF_DELTA against
// objects already in the pack and against `known` (the repo's store).
export function parsePack(pack: Buffer, known: Map<string, GitObject>): ParsedPack {
  if (pack.length < 12) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('latin1') !== 'PACK') throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Trailer: last 20 bytes are the pack checksum.
  const expectedTrailer = pack.subarray(pack.length - 20).toString('hex');
  const actualTrailer = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (expectedTrailer !== actualTrailer) throw new Error('pack checksum mismatch');
  const objects: Array<{ type: GitType; data: Buffer; oid: string }> = [];
  const byOffset = new Map<number, { type: GitType; data: Buffer }>();
  const typeNames: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  let offset = 12;
  const pending: Array<{ offset: number; baseOffset: number; data: Buffer }> = [];
  const pendingRef: Array<{ offset: number; baseOid: string; data: Buffer }> = [];
  for (let i = 0; i < count; i += 1) {
    const startOffset = offset;
    const first = pack[offset];
    const typeNum = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    while ((pack[offset - 1] & 0x80) !== 0) {
      size |= (pack[offset] & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    let data: Buffer;
    if (typeNum === 6) {
      // OFS_DELTA
      const { value: baseOffset, next } = readVarint(pack, offset);
      offset = next;
      const inflated = inflateSync(pack.subarray(offset, pack.length - 20));
      offset += inflated.length === 0 ? 0 : compressedLength(pack, offset);
      pending.push({ offset: startOffset, baseOffset: startOffset - baseOffset, data: inflated });
      continue;
    }
    if (typeNum === 7) {
      // REF_DELTA
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateSync(pack.subarray(offset, pack.length - 20));
      offset += compressedLength(pack, offset);
      pendingRef.push({ offset: startOffset, baseOid, data: inflated });
      continue;
    }
    const type = typeNames[typeNum];
    if (!type) throw new Error(`unknown pack object type ${typeNum}`);
    const inflated = inflateSync(pack.subarray(offset, pack.length - 20));
    offset += compressedLength(pack, offset);
    if (inflated.length !== size) throw new Error('object size mismatch');
    const oid = hashObject(type, inflated);
    objects.push({ type, data: inflated, oid });
    byOffset.set(startOffset, { type, data: inflated });
  }
  // Resolve deltas (possibly chained, in offset order).
  const resolveOfs = (item: { offset: number; baseOffset: number; data: Buffer }): { type: GitType; data: Buffer } => {
    const base = byOffset.get(item.baseOffset);
    if (!base) throw new Error('ofs delta base not found');
    const resolved = applyDelta(base.data, item.data);
    return { type: base.type, data: resolved };
  };
  for (const item of pending) {
    const resolved = resolveOfs(item);
    const oid = hashObject(resolved.type, resolved.data);
    objects.push({ type: resolved.type, data: resolved.data, oid });
    byOffset.set(item.offset, resolved);
  }
  for (const item of pendingRef) {
    const base = byOffset.get(item.offset) ?? objects.find((o) => o.oid === item.baseOid);
    let baseObj: { type: GitType; data: Buffer } | undefined;
    if (base) baseObj = base;
    else if (known.has(item.baseOid)) baseObj = known.get(item.baseOid) as GitObject;
    if (!baseObj) throw new Error('ref delta base not found');
    const resolved = applyDelta(baseObj.data, item.data);
    const oid = hashObject(baseObj.type, resolved);
    objects.push({ type: baseObj.type, data: resolved, oid });
    byOffset.set(item.offset, { type: baseObj.type, data: resolved });
  }
  return { objects: objects.map(({ type, data }) => ({ type, data })) };
}

// Length of the zlib stream starting at `offset` (scan for the stream end).
function compressedLength(pack: Buffer, offset: number): number {
  // zlib streams end with a 4-byte adler32; find the end by inflating with
  // increasing slices is wasteful, so use a streaming approach: inflate in
  // chunks until the inflater reports the stream end. Node's inflateSync on
  // a truncated buffer throws; binary search on length instead.
  let low = 1;
  let high = pack.length - 20 - offset;
  // First try: inflateSync consumes exactly the stream when given the whole
  // tail; to get the exact length, use a manual incremental decode via
  // zlib.inflateSync on growing slices is O(n^2) in the worst case but
  // packs here are small. Use a simpler approach: try candidate lengths by
  // checking the last 4 bytes' adler32? Not reliable. Instead, inflate with
  // the full tail and measure via a raw inflate that reports bytes read.
  // Node does not expose bytes-read, so fall back to binary search.
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(pack.subarray(offset, offset + mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return low;
}

// Build a version-2 packfile with plain objects only (no deltas).
export function buildPack(objects: Array<{ type: GitType; data: Buffer }>): Buffer {
  const typeNums: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeNum = typeNums[obj.type];
    const size = obj.data.length;
    const firstByte = (typeNum << 4) | (size & 0x0f);
    const headerBytes: number[] = [];
    let remaining = size >> 4;
    if (remaining === 0) {
      headerBytes.push(firstByte);
    } else {
      headerBytes.push(firstByte | 0x80);
      while (true) {
        let byte = remaining & 0x7f;
        remaining >>= 7;
        if (remaining !== 0) byte |= 0x80;
        headerBytes.push(byte);
        if (remaining === 0) break;
      }
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(createHash('sha1').update(body).digest('hex'), 'hex');
  return Buffer.concat([body, trailer]);
}

// Wrap pack bytes in sideband band-1 packets (chunks of at most 32768 bytes).
export function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const maxChunk = 32768;
  for (let offset = 0; offset < pack.length; offset += maxChunk) {
    const slice = pack.subarray(offset, Math.min(offset + maxChunk, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(pktLineRaw(payload));
  }
  if (pack.length === 0) {
    // No pack data at all: send nothing (caller still sends the packfile
    // section header and a flush).
  }
  return chunks;
}

// pkt-line with a raw binary payload (not text).
export function pktLineRaw(payload: Buffer): Buffer {
  const len = payload.length + 4;
  const header = Buffer.from(len.toString(16).padStart(4, '0'), 'utf8');
  return Buffer.concat([header, payload]);
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

const AGENT = 'agent=forge/1.0';

function v0UploadCaps(): string {
  return `side-band-64k thin-pack ofs-delta multi_ack shallow ${AGENT} symref=HEAD:refs/heads/${DEFAULT_BRANCH}`;
}

function v0ReceiveCaps(): string {
  return `report-status side-band-64k delete-refs ofs-delta ${AGENT} symref=HEAD:refs/heads/${DEFAULT_BRANCH}`;
}

// All refs of a repo, sorted by name, with HEAD first.
export interface RefLine {
  oid: string;
  name: string;
  symrefTarget?: string;
  peeled?: string;
}

export function collectRefs(objects: Map<string, GitObject>, refs: Map<string, string>): RefLine[] {
  const out: RefLine[] = [];
  const names = [...refs.keys()].sort();
  for (const name of names) {
    const oid = refs.get(name) as string;
    const obj = objects.get(oid);
    const line: RefLine = { oid, name };
    if (obj && obj.type === 'tag') {
      line.peeled = peelToNonTag(objects, oid);
    }
    out.push(line);
  }
  return out;
}

function headOid(objects: Map<string, GitObject>, refs: Map<string, string>): string {
  const tip = refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  return tip ?? ZERO_OID;
}

export function v0UploadAdvertisement(objects: Map<string, GitObject>, refs: Map<string, string>): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH];
  const refLines = collectRefs(objects, refs);
  const caps = v0UploadCaps();
  if (refLines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = headOid(objects, refs);
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const line of refLines) {
      parts.push(pktLine(`${line.oid} ${line.name}\n`));
      if (line.peeled) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function v0ReceiveAdvertisement(objects: Map<string, GitObject>, refs: Map<string, string>): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
  const refLines = collectRefs(objects, refs);
  const caps = v0ReceiveCaps();
  if (refLines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const head = headOid(objects, refs);
    parts.push(pktLine(`${head} HEAD\0${caps}\n`));
    for (const line of refLines) {
      parts.push(pktLine(`${line.oid} ${line.name}\n`));
      if (line.peeled) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow thin-pack ofs-delta wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`${AGENT}\n`),
    FLUSH,
  ];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

export interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function lsRefsResponse(
  objects: Map<string, GitObject>,
  refs: Map<string, string>,
  req: LsRefsRequest,
): Buffer {
  const parts: Buffer[] = [];
  const refLines = collectRefs(objects, refs);
  const hasRefs = refLines.length > 0;
  const sendHead = req.prefixes.length === 0;
  if (sendHead) {
    const head = headOid(objects, refs);
    if (hasRefs) {
      let line = `${head} HEAD`;
      if (req.symrefs) line += ` symref-target:refs/heads/${DEFAULT_BRANCH}`;
      parts.push(pktLine(line + '\n'));
    } else if (req.unborn) {
      let line = 'unborn HEAD';
      if (req.symrefs) line += ` symref-target:refs/heads/${DEFAULT_BRANCH}`;
      parts.push(pktLine(line + '\n'));
    }
  }
  for (const line of refLines) {
    if (req.prefixes.length > 0 && !req.prefixes.some((prefix) => line.name.startsWith(prefix))) continue;
    let out = `${line.oid} ${line.name}`;
    if (req.peel && line.peeled) out += ` peeled:${line.peeled}`;
    parts.push(pktLine(out + '\n'));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch (protocol v2 and v0)
// ---------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  thinPack: boolean;
  ofsDelta: boolean;
}

export interface FetchSelection {
  objects: Array<{ type: GitType; data: Buffer }>;
  shallow: string[];
  unshallow: string[];
}

// Decide which objects to send for a fetch.
export function selectFetchObjects(
  objects: Map<string, GitObject>,
  req: FetchRequest,
): FetchSelection {
  const wants = req.wants.filter((oid) => objects.has(oid));
  const haves = req.haves.filter((oid) => objects.has(oid));
  const shallowSet = new Set(req.shallow.filter((oid) => objects.has(oid)));

  // A want may be a tag object (annotated tag): include the tag itself and
  // walk from the commit it peels to. A want may also be a bare tree/blob.
  const directOids: string[] = [];
  const commitTips: string[] = [];
  for (const oid of wants) {
    const obj = objects.get(oid);
    if (obj?.type === 'tag') {
      directOids.push(oid);
      const peeled = peelToNonTag(objects, oid);
      if (objects.get(peeled)?.type === 'commit') commitTips.push(peeled);
    } else if (obj?.type === 'commit') {
      commitTips.push(oid);
    } else if (obj) {
      directOids.push(oid);
    }
  }

  // Objects the client already holds: reachable from its haves, never
  // walking past a shallow boundary (it holds the boundary commit itself,
  // but not its parents).
  const held = reachableObjectsWithCut(objects, haves, shallowSet);

  // Commits to include.
  let includedCommits: Set<string>;
  let distances: Map<string, number> | null = null;
  if (req.depth !== null) {
    distances = commitDistances(objects, commitTips);
    includedCommits = new Set<string>();
    for (const [oid, d] of distances) {
      if (d <= req.depth - 1) includedCommits.add(oid);
    }
  } else {
    includedCommits = reachableCommits(objects, commitTips);
  }
  // Drop commits the client already holds.
  for (const oid of [...includedCommits]) {
    if (held.has(oid)) includedCommits.delete(oid);
  }

  // Trees and blobs of the included commits, minus held objects.
  const objectOids = new Set<string>();
  for (const oid of directOids) {
    if (!held.has(oid)) objectOids.add(oid);
  }
  const walkTree = (treeOid: string): void => {
    if (objectOids.has(treeOid) || held.has(treeOid)) return;
    objectOids.add(treeOid);
    const obj = objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walkTree(entry.oid);
      else if (!held.has(entry.oid)) objectOids.add(entry.oid);
    }
  };
  for (const oid of includedCommits) {
    objectOids.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    walkTree(parseCommit(obj.data).tree);
  }

  const out: Array<{ type: GitType; data: Buffer }> = [];
  for (const oid of objectOids) {
    const obj = objects.get(oid);
    if (obj) out.push({ type: obj.type, data: obj.data });
  }
  // Deterministic pack order: commits first (in discovery order), then
  // trees, then blobs, each sorted by oid. Order does not matter to the
  // client, but determinism keeps replays identical.
  const typeOrder: Record<GitType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  out.sort((a, b) => {
    const order = typeOrder[a.type] - typeOrder[b.type];
    if (order !== 0) return order;
    return hashObject(a.type, a.data) < hashObject(b.type, b.data) ? -1 : 1;
  });

  // Shallow info.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (req.depth !== null || shallowSet.size > 0) {
    for (const oid of includedCommits) {
      const obj = objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      const atDepthLimit = distances !== null && distances.get(oid) === (req.depth as number) - 1;
      const parentsMissing = parents.some((parent) => !includedCommits.has(parent));
      if (atDepthLimit || (shallowSet.has(oid) && parentsMissing)) {
        if (!shallow.includes(oid)) shallow.push(oid);
      }
    }
    for (const oid of shallowSet) {
      if (!includedCommits.has(oid)) continue;
      const obj = objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.every((parent) => includedCommits.has(parent))) unshallow.push(oid);
    }
    shallow.sort();
    unshallow.sort();
  }
  return { objects: out, shallow, unshallow };
}

export function v2FetchResponse(objects: Map<string, GitObject>, req: FetchRequest): Buffer {
  const selection = selectFetchObjects(objects, req);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(FLUSH);
  if (req.depth !== null || req.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  const pack = buildPack(selection.objects);
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function v0FetchResponse(objects: Map<string, GitObject>, req: FetchRequest): Buffer {
  const selection = selectFetchObjects(objects, req);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = buildPack(selection.objects);
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack (protocol v0)
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushResult {
  unpackOk: boolean;
  unpackDetail: string;
  results: Array<{ ref: string; ok: boolean; reason: string | null }>;
}

export function handleReceivePack(
  objects: Map<string, GitObject>,
  refs: Map<string, string>,
  body: Buffer,
): PushResult {
  const { lines, offset } = parsePktLines(body);
  const commands: PushCommand[] = [];
  for (const line of lines) {
    if (line.kind !== 'data') break;
    let text = line.text;
    const nul = text.indexOf('\0');
    if (nul !== -1) text = text.slice(0, nul);
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(text.trim());
    if (!match) {
      return { unpackOk: false, unpackDetail: 'error: malformed command', results: [] };
    }
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  if (commands.length === 0) {
    return { unpackOk: false, unpackDetail: 'error: no commands', results: [] };
  }
  const packBytes = body.subarray(offset);
  const hasPack = commands.some((cmd) => cmd.newOid !== ZERO_OID);
  let unpacked: Array<{ type: GitType; data: Buffer }> = [];
  if (hasPack) {
    if (packBytes.length < 32) {
      return { unpackOk: false, unpackDetail: 'error: missing packfile', results: [] };
    }
    try {
      unpacked = parsePack(packBytes, objects).objects;
    } catch (error) {
      return { unpackOk: false, unpackDetail: `error: ${(error as Error).message}`, results: [] };
    }
  }
  for (const obj of unpacked) storeObject(objects, obj.type, obj.data);

  const results: PushResult['results'] = [];
  for (const cmd of commands) {
    const current = refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (!current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: null });
      }
      continue;
    }
    const newObj = objects.get(cmd.newOid);
    if (!newObj) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (!current) {
      // Create.
      if (cmd.oldOid !== ZERO_OID) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: null });
      }
      continue;
    }
    // Update.
    if (cmd.oldOid !== current) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!reachableCommits(objects, [cmd.newOid]).has(current)) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: null });
  }
  return { unpackOk: true, unpackDetail: 'ok', results };
}

export function receivePackResponse(result: PushResult): Buffer {
  const inner: Buffer[] = [];
  inner.push(pktLine(result.unpackOk ? 'unpack ok\n' : `unpack ${result.unpackDetail}\n`));
  for (const item of result.results) {
    inner.push(pktLine(item.ok ? `ok ${item.ref}\n` : `ng ${item.ref} ${item.reason ?? 'error'}\n`));
  }
  const payload = Buffer.concat(inner);
  // Sideband band 1, chunked like a pack.
  const parts: Buffer[] = [];
  const maxChunk = 32768;
  for (let offset = 0; offset < payload.length; offset += maxChunk) {
    const slice = payload.subarray(offset, Math.min(offset + maxChunk, payload.length));
    parts.push(pktLineRaw(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// Parse a v2 request body (ls-refs or fetch) into command lines and the
// argument lines after the delimiter.
export function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const { lines } = parsePktLines(body);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const line of lines) {
    if (line.kind === 'flush') break;
    if (line.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (line.kind !== 'data') continue;
    const text = line.text.trim();
    if (!pastDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
    } else {
      args.push(text);
    }
  }
  return { command, args };
}

export { reachableObjects };
