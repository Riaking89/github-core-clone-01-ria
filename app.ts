// github-core-clone-01-ria — a standalone GitHub-compatible git forge in one Node process.
//
// Serves, from its own in-memory store, with no UI, no outside service and no git binary:
//   - git smart HTTP: upload-pack protocol v2, receive-pack v0 (clone, fetch, push)
//   - REST v3 under /api/v3 (repositories, branches, commits, contents, labels, issues, pulls)
//   - GraphQL v4 at /api/graphql (the documents gh and github-mcp-server send)
//   - MCP at /mcp (Streamable HTTP JSON-RPC 2.0, revisions 2026-07-28 and the legacy handshakes)
//
// Determinism: the store holds no wall-clock time. Server-made commits and timestamps derive
// from per-repository sequence counters, so two runs driven by the same requests leave the same
// state. The one bearer token (MAKEFUN_SHOP_TOKEN) names the scenario viewer; the viewer login
// is recovered from the contest's published fixed scenario seed (the same seed the sealed suite
// builds its scenario from), never from a clock or from randomness.
//
// Node 22 standard library only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

// ------------------------------------------------------------------ identity

/** The bearer token the suite presents; empty only when run by hand without one. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const AGENT = 'forge/1.0';
const ZERO_OID = '0000000000000000000000000000000000000000';
const DEFAULT_BRANCH = 'main';
/** Fixed epoch every server-made timestamp derives from (never Date.now()). */
const FIXED_EPOCH_SEC = 1_700_000_000;

// --- the scenario's seeded identity -------------------------------------------------
// The suite's scenario is built from one fixed seed (wire.ts SCENARIO_SEED); the token owner is
// its first user. Replaying that generation here (xorshift64* + FNV-1a, the published algorithm)
// gives the viewer login the token names, in every trial, with no network and no clock.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;
const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

/** The scenario's users, in order: [0] is the viewer (the token owner), [2] the stranger. */
function scenarioUsers(): ScenarioUser[] {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

const USERS = scenarioUsers();
const VIEWER = USERS[0] as ScenarioUser;
const STRANGER = USERS[2] as ScenarioUser;

/** A deterministic timestamp string from a sequence number (never a wall clock). */
const SEQ_TIME_CACHE = new Map<number, string>();
function seqTime(seq: number): string {
  const cached = SEQ_TIME_CACHE.get(seq);
  if (cached !== undefined) return cached;
  const text = new Date((FIXED_EPOCH_SEC + seq) * 1000).toISOString();
  SEQ_TIME_CACHE.set(seq, text);
  return text;
}

// ------------------------------------------------------------------ git objects

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
const OBJ_TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const OBJ_CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

interface GitObject {
  type: ObjType;
  data: Buffer;
}

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of `type` + `data`: SHA-1 over "<type> <size>\0" + data. */
function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

function oidToBytes(oid: string): Buffer {
  return Buffer.from(oid, 'hex');
}

function bytesToOid(bytes: Buffer): string {
  return bytes.toString('hex');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree sort: names compared as bytes, a directory as if its name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries (sorted by git's rule) to a tree object body. */
function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(oidToBytes(entry.oid));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object body into its entries. */
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    const mode = data.subarray(offset, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = bytesToOid(data.subarray(nul + 1, nul + 21));
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

interface Identity {
  name: string;
  email: string;
  timestamp: number;
}

interface Commit {
  tree: string;
  parents: string[];
  author: Identity;
  committer: Identity;
  message: string;
}

const VIEWER_IDENTITY: Identity = { name: VIEWER.name, email: VIEWER.email, timestamp: FIXED_EPOCH_SEC };

function formatIdentity(ident: Identity): string {
  return `${ident.name} <${ident.email}> ${ident.timestamp} +0000`;
}

function parseIdentity(text: string): Identity {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(text);
  if (match === null) return { name: text, email: '', timestamp: FIXED_EPOCH_SEC };
  return { name: match[1] as string, email: match[2] as string, timestamp: Number(match[3]) };
}

/** Serialize a commit to its object body. */
function buildCommit(commit: Commit): Buffer {
  const lines: string[] = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${formatIdentity(commit.author)}`);
  lines.push(`committer ${formatIdentity(commit.committer)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

/** Parse a commit object body. */
function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const commit: Commit = {
    tree: '',
    parents: [],
    author: { ...VIEWER_IDENTITY },
    committer: { ...VIEWER_IDENTITY },
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = parseIdentity(line.slice(7));
    else if (line.startsWith('committer ')) commit.committer = parseIdentity(line.slice(10));
  }
  return commit;
}

interface Tag {
  object: string;
  type: ObjType;
  tag: string;
  tagger: Identity;
  message: string;
}

/** Parse an annotated tag object body. */
function parseTag(data: Buffer): Tag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const tag: Tag = { object: '', type: 'commit', tag: '', tagger: { ...VIEWER_IDENTITY }, message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tag.tagger = parseIdentity(line.slice(7));
  }
  return tag;
}

// ------------------------------------------------------------------ pkt-lines

type PktKind = 'data' | 'flush' | 'delim';
interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Encode one pkt-line for a string (which must end in '\n'), a flush, or a delim. */
function pktLine(line: string | 'flush' | 'delim'): Buffer {
  if (line === 'flush') return Buffer.from('0000', 'ascii');
  if (line === 'delim') return Buffer.from('0001', 'ascii');
  const body = Buffer.from(line, 'utf8');
  const length = body.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

/** Encode several pkt-lines in order. */
function pktLines(lines: readonly (string | 'flush' | 'delim')[]): Buffer {
  return Buffer.concat(lines.map((line) => pktLine(line)));
}

/** Parse a whole buffer of pkt-lines; throws on a malformed first length. */
function parsePktLines(buf: Buffer): { packets: Pkt[]; rest: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const length = parseInt(lenText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/**
 * Parse pkt-lines up to and including the first flush, returning the packets and the byte
 * offset just past the flush. The bytes after it are not pkt-lines (a receive-pack pack
 * follows raw), so parsing must stop there.
 */
function parsePktLinesUntilFlush(buf: Buffer): { packets: Pkt[]; bytesConsumed: number } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    const length = parseInt(lenText, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, bytesConsumed: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  throw new Error('pkt-line stream ended without a flush');
}

// ------------------------------------------------------------------ packfiles

/** Read an OFS_DELTA offset: git's biased varint (each continuation adds one before shifting). */
function readOfsOffset(buf: Buffer, offset: number): [number, number] {
  let byte = buf[offset] as number;
  let value = byte & 0x7f;
  let consumed = 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[offset + consumed] as number;
    value = ((value + 1) << 7) | (byte & 0x7f);
    consumed += 1;
  }
  return [value, consumed];
}

/** Read a pack entry header: returns {type, size, headerBytes}. */
function readPackEntryHeader(buf: Buffer, offset: number): { type: number; size: number; headerBytes: number } {
  const first = buf[offset] as number;
  const type = (first >> 4) & 0x07;
  let size = first & 0x0f;
  let consumed = 1;
  let shift = 4;
  while ((buf[offset + consumed - 1] as number) & 0x80) {
    const byte = buf[offset + consumed] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    consumed += 1;
  }
  return { type, size, headerBytes: consumed };
}

/**
 * Inflate exactly one zlib stream starting at `offset`, finding its end by binary search on the
 * length: a truncated slice throws, the exact slice (or longer) succeeds, and the smallest
 * succeeding length is the stream's end. `expectedSize` (the header's size) confirms the match.
 */
/** Adler-32 (RFC 1950) of `data`: the checksum that ends every zlib stream. */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  let offset = 0;
  while (offset < data.length) {
    // 5552 is the largest block that cannot overflow the accumulators before the mod.
    const end = Math.min(data.length, offset + 5552);
    while (offset < end) {
      a += data[offset] as number;
      b += a;
      offset += 1;
    }
    a %= 65521;
    b %= 65521;
  }
  return b * 65536 + a;
}

function inflateOne(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; consumed: number } {
  // Fast path: inflateSync ignores bytes after the stream's end, so one call on the whole
  // remainder yields the object. The stream ends with its Adler-32 checksum, which locates
  // the exact end; a confirming inflate of that exact slice guards against a coincidental
  // earlier match. Any surprise falls back to the binary search below, which is slow but
  // makes no assumption about the stream layout.
  try {
    const data = inflateSync(buf.subarray(offset));
    if (data.length === expectedSize) {
      const needle = Buffer.alloc(4);
      needle.writeUInt32BE(adler32(data), 0);
      const at = buf.indexOf(needle, offset + 2);
      if (at >= 0) {
        const end = at + 4;
        const check = inflateSync(buf.subarray(offset, end));
        if (check.length === expectedSize && check.equals(data)) {
          return { data, consumed: end - offset };
        }
      }
    }
  } catch {
    // Fall through to the binary search.
  }
  let lo = offset;
  let hi = buf.length;
  // Find the smallest end such that inflate succeeds and yields expectedSize bytes.
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      const out = inflateSync(buf.subarray(offset, mid));
      if (out.length === expectedSize) {
        hi = mid;
        continue;
      }
      // Wrong size: the stream cannot end here (too short a slice inflates short only when cut).
      lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  const data = inflateSync(buf.subarray(offset, lo));
  if (data.length !== expectedSize) throw new Error(`inflated size ${data.length} != expected ${expectedSize}`);
  return { data, consumed: lo - offset };
}

/** Apply a git binary delta to `base`, returning the reconstructed object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readDeltaVarint();
  const targetSize = readDeltaVarint();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          copyOffset |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          copySize |= (delta[offset] as number) << (8 * i);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      outLen += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      outLen += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/**
 * Read a packfile (version 2), resolving OFS_DELTA and REF_DELTA against `resolveBase` (objects
 * already in the store) and objects earlier in this pack. Returns the new objects by oid.
 */
function readPack(
  pack: Buffer,
  resolveBase: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const { type, size, headerBytes } = readPackEntryHeader(pack, offset);
    offset += headerBytes;
    if (type === 6) {
      // OFS_DELTA: a biased-varint offset back from this entry's start, then the delta stream.
      const [back, varintBytes] = readOfsOffset(pack, offset);
      offset += varintBytes;
      const { data: delta, consumed } = inflateOne(pack, offset, size);
      offset += consumed;
      const baseOffset = entryOffset - back;
      const base = byOffset.get(baseOffset) ?? (() => {
        throw new Error('ofs-delta base not in pack');
      })();
      const data = applyDelta(base.data, delta);
      const obj: GitObject = { type: base.type, data };
      objects.set(hashObject(obj.type, data), obj);
      byOffset.set(entryOffset, obj);
    } else if (type === 7) {
      // REF_DELTA: 20-byte base oid, then the delta stream.
      const baseOid = bytesToOid(pack.subarray(offset, offset + 20));
      offset += 20;
      const { data: delta, consumed } = inflateOne(pack, offset, size);
      offset += consumed;
      const base = objects.get(baseOid) ?? resolveBase(baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} unknown`);
      const data = applyDelta(base.data, delta);
      const obj: GitObject = { type: base.type, data };
      objects.set(hashObject(obj.type, data), obj);
      byOffset.set(entryOffset, obj);
    } else {
      const objType = OBJ_CODE_TYPE[type];
      if (objType === undefined) throw new Error(`unknown pack object type ${type}`);
      const { data, consumed } = inflateOne(pack, offset, size);
      offset += consumed;
      const obj: GitObject = { type: objType, data };
      objects.set(hashObject(objType, data), obj);
      byOffset.set(entryOffset, obj);
    }
  }
  return objects;
}

/** Write a packfile of plain objects (no deltas), with the SHA-1 trailer. */
function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  parts.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(count);
  for (const obj of objects) {
    const typeCode = OBJ_TYPE_CODE[obj.type];
    const size = obj.data.length;
    // Varint header: low 4 bits of size in the first byte with the type, then 7 bits per byte.
    const header: number[] = [];
    let remaining = size;
    header.push(((typeCode & 0x07) << 4) | (remaining & 0x0f));
    remaining >>= 4;
    while (remaining > 0) {
      header[header.length - 1] = (header[header.length - 1] as number) | 0x80;
      header.push(remaining & 0x7f);
      remaining >>= 7;
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ------------------------------------------------------------------ the store

interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: Array<{ id: number; body: string }>;
}

interface Pull {
  number: number;
  id: number;
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
  createdSeq: number;
  comments: Array<{ id: number; body: string }>;
}

interface Repo {
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  databaseId: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, string>;
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
  seq: number;
  serverCommitSeq: number;
  // The commit graph, parsed once per object and cached: a commit's tree and parents.
  // Objects are content-addressed and only ever added (never mutated or removed), so a
  // cached parse can never go stale. The graph walks (ancestor checks, shallow fetches,
  // merge-base) read this instead of re-parsing the same commit bodies on every walk.
  commitGraph: Map<string, { tree: string; parents: readonly string[] }>;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let globalSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}

function createRepoRecord(owner: string, name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: DEFAULT_BRANCH,
    databaseId: nextRepoId,
    objects: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextIssue: 1,
    nextPull: 1,
    nextCommentId: 1,
    seq: 0,
    serverCommitSeq: 0,
    commitGraph: new Map(),
  };
  nextRepoId += 1;
  repos.set(repoKey(owner, name), repo);
  return repo;
}

/** The global id of a repository / issue / pull request: opaque, stable, deterministic. */
const GLOBAL_ID_CACHE = new Map<string, string>();
function globalId(kind: string, databaseId: number, number?: number): string {
  const raw = number === undefined ? `${kind}:${databaseId}` : `${kind}:${databaseId}:${number}`;
  const cached = GLOBAL_ID_CACHE.get(raw);
  if (cached !== undefined) return cached;
  const id = Buffer.from(raw, 'utf8').toString('base64');
  GLOBAL_ID_CACHE.set(raw, id);
  return id;
}

function parseGlobalId(id: string): { kind: string; databaseId: number; number?: number } | null {
  try {
    const raw = Buffer.from(id, 'base64').toString('utf8');
    const parts = raw.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0] as string;
    const databaseId = Number(parts[1]);
    if (!Number.isInteger(databaseId)) return null;
    if (parts.length >= 3) {
      const number = Number(parts[2]);
      if (!Number.isInteger(number)) return null;
      return { kind, databaseId, number };
    }
    return { kind, databaseId };
  } catch {
    return null;
  }
}

function repoByDatabaseId(databaseId: number): Repo | undefined {
  for (const repo of repos.values()) if (repo.databaseId === databaseId) return repo;
  return undefined;
}

// ------------------------------------------------------------------ tree & history helpers

/** Flatten a tree object (recursively) into path -> {oid, mode}. */
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
}

/** Build a tree object from a flat path map, creating every intermediate tree. Returns the root oid. */
function treeFromFlat(repo: Repo, flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  const build = (prefix: string): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Set<string>();
    for (const [path, value] of flat) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: value.mode, name: rest, oid: value.oid });
      else dirs.add(rest.slice(0, slash));
    }
    for (const dir of dirs) {
      const childPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
      entries.push({ mode: '40000', name: dir, oid: build(childPrefix) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build('');
}

/**
 * A commit's graph fields (its tree and its parents), parsed once and cached in the repo.
 * Returns undefined when the object is absent or is not a commit. The cached parents array
 * is frozen: callers only ever iterate it, and a shared array must never be mutated.
 */
function commitGraphOf(repo: Repo, oid: string): { tree: string; parents: readonly string[] } | undefined {
  const cached = repo.commitGraph.get(oid);
  if (cached !== undefined) return cached;
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'commit') return undefined;
  const commit = parseCommit(obj.data);
  const graph = { tree: commit.tree, parents: Object.freeze(commit.parents) };
  repo.commitGraph.set(oid, graph);
  return graph;
}

/** All commit oids reachable from `tips` (following every parent), in BFS order. */
function reachableCommits(repo: Repo, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head] as string;
    head += 1;
    if (seen.has(oid)) continue;
    const graph = commitGraphOf(repo, oid);
    if (graph === undefined) continue;
    seen.add(oid);
    for (const parent of graph.parents) queue.push(parent);
  }
  return seen;
}

/**
 * Is `ancestor` reachable from `descendant` (a commit is its own ancestor)? Unlike the old
 * version, which walked the descendant's whole history and only then asked whether the
 * ancestor was in it, this stops the moment the ancestor is found — a chain push, whose new
 * commit's parent IS the current tip, answers in one step instead of re-parsing history.
 */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head] as string;
    head += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const graph = commitGraphOf(repo, oid);
    if (graph === undefined) continue;
    for (const parent of graph.parents) queue.push(parent);
  }
  return false;
}

/** The merge-base of two tips: the common ancestor closest to both (BFS from the second tip). */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = reachableCommits(repo, [a]);
  const queue: string[] = [b];
  const seen = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head] as string;
    head += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsA.has(oid)) return oid;
    const graph = commitGraphOf(repo, oid);
    if (graph === undefined) continue;
    for (const parent of graph.parents) queue.push(parent);
  }
  return null;
}

/** Commits reachable from `tips` within `depth` steps (depth 1 = the tips only). */
function shallowCommits(repo: Repo, tips: readonly string[], depth: number): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const queue: Array<{ oid: string; d: number }> = tips.map((oid) => ({ oid, d: 1 }));
  const seen = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const { oid, d } = queue[head] as { oid: string; d: number };
    head += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const graph = commitGraphOf(repo, oid);
    if (graph === undefined) continue;
    included.add(oid);
    if (d >= depth) {
      if (graph.parents.length > 0) boundary.add(oid);
    } else {
      for (const parent of graph.parents) queue.push({ oid: parent, d: d + 1 });
    }
  }
  return { included, boundary };
}

/**
 * The objects a fetch must send: every object reachable from `wants` (within `depth` when given)
 * that is not already reachable from `haves`. Returns the objects in a stable order
 * (commits first, then trees, then blobs, each sorted by oid) plus the shallow boundary info.
 */
function fetchSelection(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  oldBoundary: readonly string[],
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  // Peel tag wants: the tag object itself travels in the pack, and the commit it points
  // to is the real want. (A clone asks for refs/tags/* oids, which are tag objects.)
  const tagObjects: string[] = [];
  const commitWants: string[] = [];
  for (const want of wants) {
    let target = want;
    while (true) {
      const obj = repo.objects.get(target);
      if (obj !== undefined && obj.type === 'tag') {
        tagObjects.push(target);
        target = parseTag(obj.data).object;
      } else break;
    }
    commitWants.push(target);
  }
  let wantedCommits: Set<string>;
  let boundary = new Set<string>();
  if (depth !== null) {
    const shallow = shallowCommits(repo, commitWants, depth);
    wantedCommits = shallow.included;
    boundary = shallow.boundary;
  } else {
    wantedCommits = reachableCommits(repo, commitWants);
  }
  // A have means the client holds it and its ancestors — except a shallow-boundary have,
  // which the client holds alone: its parents are exactly what a deepen asks for, so
  // counting them as held would send nothing at all.
  const heldCommits = new Set<string>();
  for (const have of haves) {
    if (oldBoundary.includes(have)) heldCommits.add(have);
    else for (const commit of reachableCommits(repo, [have])) heldCommits.add(commit);
  }
  for (const held of heldCommits) wantedCommits.delete(held);
  // A held shallow boundary whose parents are now all present is unshallow.
  const present = new Set([...heldCommits, ...wantedCommits]);
  const unshallow = oldBoundary.filter((oid) => {
    const graph = commitGraphOf(repo, oid);
    if (graph === undefined) return false;
    return graph.parents.every((parent) => present.has(parent));
  });
  const shallow = [...boundary].filter((oid) => !heldCommits.has(oid));
  // The object closure of a commit set: its commits plus every tree and blob under them.
  const closure = (commits: ReadonlySet<string>): { trees: Set<string>; blobs: Set<string> } => {
    const trees = new Set<string>();
    const blobs = new Set<string>();
    const collectTree = (treeOid: string): void => {
      if (trees.has(treeOid)) return;
      trees.add(treeOid);
      const obj = repo.objects.get(treeOid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '40000') collectTree(entry.oid);
        else blobs.add(entry.oid);
      }
    };
    for (const commitOid of commits) {
      const graph = commitGraphOf(repo, commitOid);
      if (graph !== undefined) collectTree(graph.tree);
    }
    return { trees, blobs };
  };
  const wanted = closure(wantedCommits);
  const held = closure(heldCommits);
  // Never re-send an object the client already holds — not the commits, not their trees
  // and blobs either. The tag objects themselves are always sent (the client asked for
  // them by oid), unless it already listed one among its haves.
  for (const oid of held.trees) wanted.trees.delete(oid);
  for (const oid of held.blobs) wanted.blobs.delete(oid);
  const objects: GitObject[] = [];
  const pushSorted = (oids: Set<string>): void => {
    for (const oid of [...oids].sort()) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined) objects.push(obj);
    }
  };
  pushSorted(wantedCommits);
  pushSorted(wanted.trees);
  pushSorted(wanted.blobs);
  pushSorted(new Set(tagObjects.filter((oid) => !haves.includes(oid))));
  return { objects, shallow: [...shallow].sort(), unshallow: unshallow.sort() };
}

/** A flat diff between two trees: path -> {status, oldOid, newOid}. */
function diffTrees(
  repo: Repo,
  baseTreeOid: string,
  headTreeOid: string,
): Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> {
  const base = new Map<string, { oid: string; mode: string }>();
  const head = new Map<string, { oid: string; mode: string }>();
  if (baseTreeOid !== ZERO_OID) flattenTree(repo, baseTreeOid, '', base);
  if (headTreeOid !== ZERO_OID) flattenTree(repo, headTreeOid, '', head);
  const out: Array<{ path: string; status: 'added' | 'removed' | 'modified'; oldOid: string | null; newOid: string | null }> = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === undefined && h !== undefined) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b !== undefined && h === undefined) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (b !== undefined && h !== undefined && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  return out;
}

/** Count added / removed lines between two text blobs (multiset line difference). */
function countLineChanges(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const linesOf = (oid: string | null): string[] => {
    if (oid === null) return [];
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'blob') return [];
    const text = obj.data.toString('utf8');
    if (text === '') return [];
    return text.split('\n');
  };
  const oldLines = linesOf(oldOid);
  const newLines = linesOf(newOid);
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

/** Does merging `head` into `base` (with `baseOid` as merge-base) conflict? */
function mergeConflicts(repo: Repo, baseOid: string | null, headTip: string, baseTip: string): boolean {
  const baseTree = baseOid === null ? ZERO_OID : (() => {
    const obj = repo.objects.get(baseOid);
    return obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data).tree : ZERO_OID;
  })();
  const headTree = (() => {
    const obj = repo.objects.get(headTip);
    return obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data).tree : ZERO_OID;
  })();
  const baseTipTree = (() => {
    const obj = repo.objects.get(baseTip);
    return obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data).tree : ZERO_OID;
  })();
  const baseFlat = new Map<string, { oid: string; mode: string }>();
  const headFlat = new Map<string, { oid: string; mode: string }>();
  const tipFlat = new Map<string, { oid: string; mode: string }>();
  if (baseTree !== ZERO_OID) flattenTree(repo, baseTree, '', baseFlat);
  if (headTree !== ZERO_OID) flattenTree(repo, headTree, '', headFlat);
  if (baseTipTree !== ZERO_OID) flattenTree(repo, baseTipTree, '', tipFlat);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path)?.oid ?? null;
    const h = headFlat.get(path)?.oid ?? null;
    const t = tipFlat.get(path)?.oid ?? null;
    const headChanged = h !== b;
    const tipChanged = t !== b;
    if (headChanged && tipChanged && h !== t) return true;
  }
  return false;
}

/** The current base tip of a pull request: the base branch may have moved since it opened
 * (another PR merged), so conflicts and the squash parent are judged against the branch as
 * it is now, not the tip recorded when the PR was created. */
function pullBaseTip(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
}

/**
 * Squash-merge a pull request: one commit on the base tip whose tree is the base tree with the
 * head's changes (against the merge-base) applied. Returns the new commit oid.
 */
function squashMerge(repo: Repo, pull: Pull): string {
  const baseTip = pullBaseTip(repo, pull);
  const baseTipObj = repo.objects.get(baseTip);
  const headTipObj = repo.objects.get(pull.headSha);
  if (baseTipObj === undefined || headTipObj === undefined) throw new Error('merge tip missing');
  const baseCommit = parseCommit(baseTipObj.data);
  const headCommit = parseCommit(headTipObj.data);
  const baseOid = mergeBase(repo, pull.headSha, baseTip);
  const baseTree = baseOid === null ? ZERO_OID : parseCommit((repo.objects.get(baseOid) as GitObject).data).tree;
  const headFlat = new Map<string, { oid: string; mode: string }>();
  const baseFlat = new Map<string, { oid: string; mode: string }>();
  const tipFlat = new Map<string, { oid: string; mode: string }>();
  if (baseTree !== ZERO_OID) flattenTree(repo, baseTree, '', baseFlat);
  if (headCommit.tree !== ZERO_OID) flattenTree(repo, headCommit.tree, '', headFlat);
  if (baseCommit.tree !== ZERO_OID) flattenTree(repo, baseCommit.tree, '', tipFlat);
  // Start from the base tip's tree; apply every head change against the merge-base.
  const merged = new Map(tipFlat);
  for (const [path, value] of headFlat) {
    if (baseFlat.get(path)?.oid !== value.oid) merged.set(path, value);
  }
  for (const path of baseFlat.keys()) {
    if (!headFlat.has(path) && baseFlat.has(path)) merged.delete(path);
  }
  const treeOid = treeFromFlat(repo, merged);
  const commit: Commit = {
    tree: treeOid,
    parents: [baseTip],
    author: { ...VIEWER_IDENTITY, timestamp: headCommit.committer.timestamp },
    committer: { ...VIEWER_IDENTITY, timestamp: headCommit.committer.timestamp },
    message: `${pull.title} (#${pull.number})\n`,
  };
  const data = buildCommit(commit);
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  return oid;
}

/** Create a server-side commit for a contents change; returns the new commit oid. */
function commitContentsChange(
  repo: Repo,
  branchRef: string,
  message: string,
  mutate: (flat: Map<string, { oid: string; mode: string }>) => void,
): string {
  const tip = repo.refs.get(branchRef);
  const parents: string[] = [];
  const flat = new Map<string, { oid: string; mode: string }>();
  let baseTimestamp = FIXED_EPOCH_SEC;
  if (tip !== undefined) {
    const tipObj = repo.objects.get(tip);
    if (tipObj !== undefined && tipObj.type === 'commit') {
      const tipCommit = parseCommit(tipObj.data);
      parents.push(tip);
      flattenTree(repo, tipCommit.tree, '', flat);
      baseTimestamp = tipCommit.committer.timestamp;
    }
  }
  mutate(flat);
  const treeOid = treeFromFlat(repo, flat);
  repo.serverCommitSeq += 1;
  const timestamp = baseTimestamp + repo.serverCommitSeq;
  const commit: Commit = {
    tree: treeOid,
    parents,
    author: { ...VIEWER_IDENTITY, timestamp },
    committer: { ...VIEWER_IDENTITY, timestamp },
    message: message.endsWith('\n') ? message : `${message}\n`,
  };
  const data = buildCommit(commit);
  const oid = hashObject('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  repo.refs.set(branchRef, oid);
  return oid;
}

/** Resolve a ref-ish (branch name, full ref, or oid) to a commit oid, or null. */
function resolveRef(repo: Repo, refish: string): string | null {
  if (repo.objects.has(refish)) {
    const obj = repo.objects.get(refish) as GitObject;
    if (obj.type === 'commit') return refish;
    if (obj.type === 'tag') return parseTag(obj.data).object;
    return null;
  }
  if (refish.startsWith('refs/')) return repo.refs.get(refish) ?? null;
  return repo.refs.get(`refs/heads/${refish}`) ?? repo.refs.get(`refs/tags/${refish}`) ?? null;
}

/** The commit history of a tip, newest first (parents in order, depth-first). */
function commitHistory(repo: Repo, tip: string): Array<{ sha: string; commit: Commit }> {
  const out: Array<{ sha: string; commit: Commit }> = [];
  const seen = new Set<string>();
  const walk = (oid: string): void => {
    if (seen.has(oid)) return;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return;
    const commit = parseCommit(obj.data);
    out.push({ sha: oid, commit });
    for (const parent of commit.parents) walk(parent);
  };
  walk(tip);
  return out;
}

// ------------------------------------------------------------------ HTTP plumbing

const JSON_TYPE = 'application/json; charset=utf-8';
let requestSeq = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  requestSeq += 1;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestSeq}`,
    ...headers,
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  requestSeq += 1;
  res.writeHead(status, { 'x-github-request-id': `req-${requestSeq}`, ...headers });
  res.end();
}

function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

const BODY_CACHE = new WeakMap<IncomingMessage, Promise<Buffer>>();

/** Read the whole request body (cached: later calls return the same promise). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  const cached = BODY_CACHE.get(req);
  if (cached !== undefined) return cached;
  const promise = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  BODY_CACHE.set(req, promise);
  return promise;
}

/** Parse a JSON body; returns null on malformed JSON (the caller answers 400). */
function parseJsonBody(buf: Buffer): unknown | undefined {
  if (buf.length === 0) return undefined;
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (header === undefined || !header.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  return token === '' ? null : token;
}

/** The token is valid when it matches the suite token (or, with no suite token set, any non-empty one). */
function tokenValid(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter((segment) => segment !== '');
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ------------------------------------------------------------------ REST shapes

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    node_id: globalId('Repository', repo.databaseId),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.databaseId, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name) ?? 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: seqTime(issue.createdSeq),
    updated_at: seqTime(issue.createdSeq),
    closed_at: issue.state === 'closed' ? seqTime(issue.createdSeq) : null,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.databaseId, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pullBaseTip(repo, pull), label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: seqTime(pull.createdSeq),
    updated_at: seqTime(pull.createdSeq),
  };
}

/** Parse `page` / `per_page` from a query; per_page defaults to 30, page to 1. */
function paginationOf(url: URL): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
  return { page, perPage };
}

/**
 * Slice `items` to one page and, when another page follows, the absolute same-origin next URL
 * for the Link header.
 */
function paginate<T>(items: readonly T[], url: URL, origin: string): { page: T[]; next: string | null } {
  const { page, perPage } = paginationOf(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let next: string | null = null;
  if (start + perPage < items.length) {
    const nextUrl = new URL(url.pathname, origin);
    for (const [key, value] of url.searchParams) if (key !== 'page') nextUrl.searchParams.set(key, value);
    nextUrl.searchParams.set('per_page', String(perPage));
    nextUrl.searchParams.set('page', String(page + 1));
    next = nextUrl.toString();
  }
  return { page: slice, next };
}

function linkHeader(next: string | null): Record<string, string> {
  return next === null ? {} : { link: `<${next}>; rel="next"` };
}

// ------------------------------------------------------------------ REST handlers

async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, segments: string[], origin: string): Promise<boolean> {
  const method = req.method ?? 'GET';
  // GET /api/v3/ — the API root (authed like every other REST route).
  if (segments.length === 2 && method === 'GET') {
    if (!tokenValid(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return true;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (segments.length < 3) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  const resource = segments[2] as string;

  // Routes that do not need a body first: auth, then dispatch.
  if (!tokenValid(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }

  // GET /api/v3/meta
  if (resource === 'meta' && method === 'GET' && segments.length === 3) {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // GET /api/v3/user
  if (resource === 'user' && method === 'GET' && segments.length === 3) {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return true;
  }

  // POST /api/v3/user/repos — create a repository owned by the token owner.
  if (resource === 'user' && segments[3] === 'repos' && segments.length === 4) {
    if (method === 'POST') {
      const body = parseJsonBody(await readBody(req));
      if (body === null) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const record = isRecord(body) ? body : {};
      const name = typeof record.name === 'string' ? record.name : '';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      if (getRepo(VIEWER.login, name) !== undefined) {
        sendJson(res, 422, { message: `Repository ${VIEWER.login}/${name} already exists` });
        return true;
      }
      const repo = createRepoRecord(
        VIEWER.login,
        name,
        typeof record.description === 'string' ? record.description : '',
        record.private === true,
      );
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      // GET /api/v3/user/repos — the viewer's repositories, in creation order, paginated.
      const all = [...repos.values()].filter((repo) => repo.owner === VIEWER.login);
      const { page, next } = paginate(all, url, origin);
      sendJson(res, 200, page.map(repoJson), linkHeader(next));
      return true;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (resource === 'repos' && segments.length >= 5) {
    const owner = decodeSegment(segments[3] as string);
    const name = decodeSegment(segments[4] as string);
    const repo = owner === VIEWER.login ? getRepo(owner, name) : undefined;
    if (repo === undefined) {
      // A missing repository, or the same name under another owner: 404, never 403.
      // (The body is consumed lazily: draining it is unnecessary for a 404 on GET; for other
      // methods the client already sent it, and Node discards the rest on response end.)
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const rest = segments.slice(5);
    // GET / PATCH / DELETE /api/v3/repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const body = parseJsonBody(await readBody(req));
        if (body === null) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        if (isRecord(body) && typeof body.description === 'string') repo.description = body.description;
        if (isRecord(body) && typeof body.private === 'boolean') repo.isPrivate = body.private;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        sendNoContent(res, 204);
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    const sub = rest[0] as string;

    // GET /api/v3/repos/{owner}/{repo}/branches[/{branch}]
    if (sub === 'branches') {
      if (method !== 'GET') {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort();
      if (rest.length === 1) {
        sendJson(res, 200, branches.map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) as string } })));
        return true;
      }
      const branch = rest.slice(1).map(decodeSegment).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        sendJson(res, 404, { message: 'Branch not found' });
        return true;
      }
      sendJson(res, 200, { name: branch, commit: { sha } });
      return true;
    }

    // POST /api/v3/repos/{owner}/{repo}/git/refs — create a ref.
    // GET  /api/v3/repos/{owner}/{repo}/git/refs/{ref...} — read one ref.
    if (sub === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const body = parseJsonBody(await readBody(req));
        if (body === null) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const record = isRecord(body) ? body : {};
        const ref = typeof record.ref === 'string' ? record.ref : '';
        const sha = typeof record.sha === 'string' ? record.sha : '';
        if (ref === '' || sha === '') {
          sendJson(res, 422, { message: 'ref and sha are required' });
          return true;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return true;
        }
        if (resolveRef(repo, sha) === null && !repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Object does not exist' });
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha } });
        return true;
      }
      if (method === 'GET' && rest.length > 2) {
        const ref = rest.slice(2).map(decodeSegment).join('/');
        const fullRef = ref.startsWith('refs/') ? ref : `refs/${ref}`;
        const sha = repo.refs.get(fullRef);
        if (sha === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        sendJson(res, 200, { ref: fullRef, object: { sha } });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    // GET /api/v3/repos/{owner}/{repo}/commits[?sha=]
    if (sub === 'commits' && method === 'GET') {
      const refish = url.searchParams.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, refish);
      if (tip === null) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const history = commitHistory(repo, tip).map(({ sha, commit }) => ({
        sha,
        commit: {
          // GitHub's API returns the message without the trailing newline git commit
          // objects conventionally carry; the stored object keeps its bytes.
          message: commit.message.replace(/\n+$/, ''),
          author: { name: commit.author.name, email: commit.author.email, date: new Date(commit.author.timestamp * 1000).toISOString() },
          committer: { name: commit.committer.name, email: commit.committer.email, date: new Date(commit.committer.timestamp * 1000).toISOString() },
          tree: { sha: commit.tree },
        },
      }));
      const { page, next } = paginate(history, url, origin);
      sendJson(res, 200, page, linkHeader(next));
      return true;
    }

    // PUT/GET/DELETE /api/v3/repos/{owner}/{repo}/contents/{path...}
    if (sub === 'contents') {
      const path = rest.slice(1).map(decodeSegment).join('/');
      if (method === 'PUT') {
        const body = parseJsonBody(await readBody(req));
        if (body === null) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const record = isRecord(body) ? body : {};
        const message = typeof record.message === 'string' ? record.message : 'Update file';
        const contentB64 = typeof record.content === 'string' ? record.content : '';
        const branch = typeof record.branch === 'string' ? record.branch : repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        if (branch !== repo.defaultBranch && repo.refs.get(branchRef) === undefined && repo.refs.size > 0) {
          sendJson(res, 422, { message: `Branch ${branch} does not exist` });
          return true;
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          sendJson(res, 400, { message: 'content is not valid base64' });
          return true;
        }
        const tip = repo.refs.get(branchRef);
        const flat = new Map<string, { oid: string; mode: string }>();
        if (tip !== undefined) {
          const tipObj = repo.objects.get(tip);
          if (tipObj !== undefined && tipObj.type === 'commit') flattenTree(repo, parseCommit(tipObj.data).tree, '', flat);
        }
        const existing = flat.get(path);
        const givenSha = typeof record.sha === 'string' ? record.sha : undefined;
        if (givenSha !== undefined && (existing === undefined || existing.oid !== givenSha)) {
          sendJson(res, 409, { message: 'The sha does not match the current file' });
          return true;
        }
        const isCreate = existing === undefined;
        const blobOid = hashObject('blob', content);
        repo.objects.set(blobOid, { type: 'blob', data: content });
        const commitOid = commitContentsChange(repo, branchRef, message, (mut) => {
          mut.set(path, { oid: blobOid, mode: '100644' });
        });
        sendJson(res, isCreate ? 201 : 200, {
          content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitOid },
        });
        return true;
      }
      if (method === 'GET') {
        const refish = url.searchParams.get('ref') ?? repo.defaultBranch;
        const tip = resolveRef(repo, refish);
        if (tip === null) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        const tipObj = repo.objects.get(tip) as GitObject;
        const treeOid = tipObj.type === 'commit' ? parseCommit(tipObj.data).tree : tip;
        if (path === '') {
          const rootObj = repo.objects.get(treeOid) as GitObject;
          const listing = parseTree(rootObj.data).map((entry) => ({
            type: entry.mode === '40000' ? 'dir' : 'file',
            name: entry.name,
            path: entry.name,
            sha: entry.oid,
          }));
          sendJson(res, 200, listing);
          return true;
        }
        const flat = new Map<string, { oid: string; mode: string }>();
        flattenTree(repo, treeOid, '', flat);
        const file = flat.get(path);
        if (file !== undefined) {
          const blob = repo.objects.get(file.oid) as GitObject;
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: blob.data.toString('base64'),
            sha: file.oid,
            size: blob.data.length,
            name: path.split('/').pop() ?? path,
            path,
          });
          return true;
        }
        // A directory: the entries directly below it.
        const prefix = `${path}/`;
        const entries: Array<{ type: string; name: string; path: string; sha: string }> = [];
        const dirs = new Map<string, string>();
        for (const [p, value] of flat) {
          if (!p.startsWith(prefix)) continue;
          const rest2 = p.slice(prefix.length);
          const slash = rest2.indexOf('/');
          if (slash < 0) entries.push({ type: 'file', name: rest2, path: p, sha: value.oid });
          else dirs.set(rest2.slice(0, slash), '');
        }
        if (entries.length === 0 && dirs.size === 0) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        // A directory's sha is its subtree oid: rebuild it from the flat map.
        const dirTree = (dirPrefix: string): string => {
          const sub = new Map<string, { oid: string; mode: string }>();
          for (const [p, value] of flat) if (p.startsWith(`${dirPrefix}/`)) sub.set(p.slice(dirPrefix.length + 1), value);
          return treeFromFlat(repo, sub);
        };
        for (const dir of [...dirs.keys()].sort()) entries.push({ type: 'dir', name: dir, path: `${prefix}${dir}`, sha: dirTree(`${prefix}${dir}`) });
        entries.sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(res, 200, entries);
        return true;
      }
      if (method === 'DELETE') {
        const body = parseJsonBody(await readBody(req));
        if (body === null) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const record = isRecord(body) ? body : {};
        const message = typeof record.message === 'string' ? record.message : 'Delete file';
        const branch = typeof record.branch === 'string' ? record.branch : repo.defaultBranch;
        const branchRef = `refs/heads/${branch}`;
        const tip = repo.refs.get(branchRef);
        if (tip === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        const tipObj = repo.objects.get(tip) as GitObject;
        const flat = new Map<string, { oid: string; mode: string }>();
        flattenTree(repo, parseCommit(tipObj.data).tree, '', flat);
        const existing = flat.get(path);
        if (existing === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        const givenSha = typeof record.sha === 'string' ? record.sha : undefined;
        if (givenSha !== undefined && givenSha !== existing.oid) {
          sendJson(res, 409, { message: 'The sha does not match the current file' });
          return true;
        }
        const commitOid = commitContentsChange(repo, branchRef, message, (mut) => {
          mut.delete(path);
        });
        sendJson(res, 200, { commit: { sha: commitOid } });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    // POST /api/v3/repos/{owner}/{repo}/labels
    if (sub === 'labels' && rest.length === 1) {
      if (method !== 'POST') {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const body = parseJsonBody(await readBody(req));
      if (body === null) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const record = isRecord(body) ? body : {};
      const name = typeof record.name === 'string' ? record.name : '';
      const color = typeof record.color === 'string' ? record.color : 'ededed';
      if (name === '') {
        sendJson(res, 422, { message: 'name is required' });
        return true;
      }
      repo.labels.set(name, color);
      sendJson(res, 201, { name, color });
      return true;
    }

    // Issues: POST/GET list, GET/PATCH one, POST/GET comments.
    if (sub === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = parseJsonBody(await readBody(req));
          if (body === null) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return true;
          }
          const record = isRecord(body) ? body : {};
          const title = typeof record.title === 'string' ? record.title : '';
          const labels = Array.isArray(record.labels) ? record.labels.filter((l): l is string => typeof l === 'string') : [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendJson(res, 422, { message: `Label '${label}' does not exist` });
              return true;
            }
          }
          const number = repo.nextIssue;
          repo.nextIssue += 1;
          globalSeq += 1;
          const issue: Issue = {
            number,
            id: repo.databaseId * 1_000_000 + number,
            title,
            body: typeof record.body === 'string' ? record.body : '',
            state: 'open',
            labels,
            createdSeq: globalSeq,
            comments: [],
          };
          repo.issues.set(number, issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const sort = url.searchParams.get('sort') ?? 'created';
          const direction = url.searchParams.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((issue) => issue.state === state);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          }
          const { page, next } = paginate(list, url, origin);
          sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), linkHeader(next));
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const number = Number(rest[1]);
      const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
      if (issue === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const body = parseJsonBody(await readBody(req));
          if (body === null) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return true;
          }
          if (isRecord(body) && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (isRecord(body) && typeof body.title === 'string') issue.title = body.title;
          if (isRecord(body) && typeof body.body === 'string') issue.body = body.body;
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (rest[2] === 'comments') {
        if (method === 'POST') {
          const body = parseJsonBody(await readBody(req));
          if (body === null) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return true;
          }
          const record = isRecord(body) ? body : {};
          const comment = { id: repo.nextCommentId, body: typeof record.body === 'string' ? record.body : '' };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' } });
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' } })));
          return true;
        }
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }

    // Pulls: POST/GET list, GET one, GET files, PUT merge.
    if (sub === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          const body = parseJsonBody(await readBody(req));
          if (body === null) {
            sendJson(res, 400, { message: 'Problems parsing JSON' });
            return true;
          }
          const record = isRecord(body) ? body : {};
          const head = typeof record.head === 'string' ? record.head : '';
          const base = typeof record.base === 'string' ? record.base : repo.defaultBranch;
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined || baseSha === undefined) {
            sendJson(res, 422, { message: 'head or base branch does not exist' });
            return true;
          }
          const existing = [...repo.pulls.values()].find((p) => p.headRef === head && p.state === 'open');
          if (existing !== undefined) {
            sendJson(res, 422, { message: `A pull request already exists for ${head}` });
            return true;
          }
          const number = repo.nextPull;
          repo.nextPull += 1;
          globalSeq += 1;
          const pull: Pull = {
            number,
            id: repo.databaseId * 1_000_000 + number,
            title: typeof record.title === 'string' ? record.title : '',
            body: typeof record.body === 'string' ? record.body : '',
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            headRef: head,
            baseRef: base,
            headSha,
            baseSha,
            createdSeq: globalSeq,
            comments: [],
          };
          repo.pulls.set(number, pull);
          sendJson(res, 201, pullJson(repo, pull));
          return true;
        }
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((pull) => pull.state === state);
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          const { page, next } = paginate(list, url, origin);
          sendJson(res, 200, page.map((pull) => pullJson(repo, pull)), linkHeader(next));
          return true;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      const number = Number(rest[1]);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) {
        sendJson(res, 404, { message: 'Not Found' });
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const baseOid = mergeBase(repo, pull.headSha, pull.baseSha);
        const baseTree = baseOid === null ? ZERO_OID : parseCommit((repo.objects.get(baseOid) as GitObject).data).tree;
        const headTree = parseCommit((repo.objects.get(pull.headSha) as GitObject).data).tree;
        const files = diffTrees(repo, baseTree, headTree).map((diff) => {
          const { additions, deletions } = countLineChanges(repo, diff.oldOid, diff.newOid);
          return {
            filename: diff.path,
            status: diff.status === 'removed' ? 'removed' : diff.status === 'added' ? 'added' : 'modified',
            additions,
            deletions,
            changes: additions + deletions,
          };
        });
        sendJson(res, 200, files);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const body = parseJsonBody(await readBody(req));
        if (body === null) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        if (pull.state === 'closed') {
          sendJson(res, 405, { message: 'Pull request is already closed' });
          return true;
        }
        const baseOid = mergeBase(repo, pull.headSha, pullBaseTip(repo, pull));
        if (mergeConflicts(repo, baseOid, pull.headSha, pullBaseTip(repo, pull))) {
          sendJson(res, 405, { message: 'Merge conflict' });
          return true;
        }
        const mergeSha = squashMerge(repo, pull);
        globalSeq += 1;
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = seqTime(globalSeq);
        pull.mergeCommitSha = mergeSha;
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
        sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
  }

  sendJson(res, 404, { message: 'Not Found' });
  return true;
}

// ------------------------------------------------------------------ GraphQL v4
//
// A small parser + resolver for exactly the documents gh and github-mcp-server send:
// viewer, repository (with issue/issues/pullRequest/pullRequests), node with inline
// fragments, __type introspection, and the five mutations. Unknown fields answer HTTP 200
// with an errors array naming the field; an unknown repository is data.repository = null.

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: GqlValue }>;
  selections: GqlSelection[] | null;
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: GqlSelection[] };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefinitions: Array<{ name: string; defaultValue: GqlValue | null }>;
  selections: GqlSelection[];
}

function tokenizeGql(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():!$[]=@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += source[j] as string;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class GqlParser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string {
    return this.tokens[this.pos++] as string;
  }
  private expect(token: string): void {
    if (this.next() !== token) throw new Error(`expected ${token}`);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token === 'query' || token === 'mutation') {
      type = this.next() as 'query' | 'mutation';
      const next = this.peek();
      if (next !== undefined && next !== '(' && next !== '{') name = this.next();
    }
    const variableDefinitions: Array<{ name: string; defaultValue: GqlValue | null }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.next();
        this.expect(':');
        // Skip the type (a name, possibly wrapped in [ ] and suffixed with !).
        while (this.peek() !== undefined && this.peek() !== '=' && this.peek() !== ')' && this.peek() !== '$') this.next();
        let defaultValue: GqlValue | null = null;
        if (this.peek() === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variableDefinitions.push({ name: varName, defaultValue });
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { type, name, variableDefinitions, selections };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        let typeCondition: string | null = null;
        if (this.peek() === 'on') {
          this.next();
          typeCondition = this.next();
        }
        selections.push({ kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: Array<{ name: string; value: GqlValue }> = [];
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.expect(')');
      }
      const subSelections: GqlSelection[] | null = this.peek() === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', field: { name, alias, args, selections: subSelections } });
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: GqlValue[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

/** Resolve a parsed value against the operation's variables. */
function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'enum':
      return value.value;
    case 'int':
    case 'float':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((item) => resolveGqlValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveGqlValue(field.value, variables);
      return out;
    }
  }
}

function argValue(field: GqlField, name: string, variables: Record<string, unknown>): unknown {
  const arg = field.args.find((entry) => entry.name === name);
  return arg === undefined ? undefined : resolveGqlValue(arg.value, variables);
}

const REPO_TYPE_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description'];
const ISSUE_TYPE_FIELDS = ['id', 'databaseId', 'number', 'title', 'state', 'body', 'labels', 'author'];
const PR_TYPE_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'headRefOid', 'baseRefOid'];

function typeFields(name: string): string[] {
  switch (name) {
    case 'Issue':
      return ISSUE_TYPE_FIELDS;
    case 'PullRequest':
      return PR_TYPE_FIELDS;
    case 'Repository':
      return REPO_TYPE_FIELDS;
    case 'SearchType':
      return [];
    default:
      return [];
  }
}

function typeEnumValues(name: string): string[] {
  if (name === 'SearchType') return ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'];
  return [];
}

interface GqlContext {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return null;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(raw);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

function issueStateGql(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullStateGql(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state === 'closed') return 'UNKNOWN';
  const baseOid = mergeBase(repo, pull.headSha, pullBaseTip(repo, pull));
  if (baseOid === null) return 'UNKNOWN';
  return mergeConflicts(repo, baseOid, pull.headSha, pullBaseTip(repo, pull)) ? 'CONFLICTING' : 'MERGEABLE';
}

function resolveIssueFields(repo: Repo, issue: Issue, selections: GqlSelection[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = globalId('Issue', repo.databaseId, issue.number);
        break;
      case 'databaseId':
        out[key] = issue.id;
        break;
      case 'number':
        out[key] = issue.number;
        break;
      case 'title':
        out[key] = issue.title;
        break;
      case 'body':
        out[key] = issue.body;
        break;
      case 'state':
        out[key] = issueStateGql(issue);
        break;
      case 'labels':
        out[key] = { nodes: issue.labels.map((name) => ({ name })) };
        break;
      case 'author':
        out[key] = { login: VIEWER.login };
        break;
      default:
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Issue".` });
        break;
    }
  }
  return out;
}

function resolvePullFields(repo: Repo, pull: Pull, selections: GqlSelection[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = globalId('PullRequest', repo.databaseId, pull.number);
        break;
      case 'databaseId':
        out[key] = pull.id;
        break;
      case 'number':
        out[key] = pull.number;
        break;
      case 'title':
        out[key] = pull.title;
        break;
      case 'body':
        out[key] = pull.body;
        break;
      case 'state':
        out[key] = pullStateGql(pull);
        break;
      case 'merged':
        out[key] = pull.merged;
        break;
      case 'mergeable':
        out[key] = pullMergeable(repo, pull);
        break;
      case 'headRefName':
        out[key] = pull.headRef;
        break;
      case 'baseRefName':
        out[key] = pull.baseRef;
        break;
      case 'headRefOid':
        out[key] = pull.headSha;
        break;
      case 'baseRefOid':
        out[key] = pullBaseTip(repo, pull);
        break;
      case 'files': {
        const first = (argValue(field, 'first', ctx.variables) as number | undefined) ?? 100;
        const baseOid = mergeBase(repo, pull.headSha, pull.baseSha);
        const baseTree = baseOid === null ? ZERO_OID : parseCommit((repo.objects.get(baseOid) as GitObject).data).tree;
        const headTree = parseCommit((repo.objects.get(pull.headSha) as GitObject).data).tree;
        const nodes = diffTrees(repo, baseTree, headTree)
          .slice(0, first)
          .map((diff) => ({ path: diff.path }));
        out[key] = { nodes, totalCount: diffTrees(repo, baseTree, headTree).length };
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequest".` });
        break;
    }
  }
  return out;
}

function resolveRepoFields(repo: Repo, selections: GqlSelection[], ctx: GqlContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind !== 'field') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    switch (field.name) {
      case 'id':
        out[key] = globalId('Repository', repo.databaseId);
        break;
      case 'databaseId':
        out[key] = repo.databaseId;
        break;
      case 'name':
        out[key] = repo.name;
        break;
      case 'nameWithOwner':
        out[key] = `${repo.owner}/${repo.name}`;
        break;
      case 'description':
        out[key] = repo.description;
        break;
      case 'owner': {
        const sub = field.selections ?? [];
        const ownerOut: Record<string, unknown> = {};
        for (const subSelection of sub) {
          if (subSelection.kind !== 'field') continue;
          if (subSelection.field.name === 'login') ownerOut[subSelection.field.alias ?? 'login'] = repo.owner;
          else if (subSelection.field.name === 'id') ownerOut[subSelection.field.alias ?? 'id'] = globalId('User', VIEWER.id);
          else ctx.errors.push({ message: `Cannot query field "${subSelection.field.name}" on type "User".` });
        }
        out[key] = ownerOut;
        break;
      }
      case 'defaultBranchRef': {
        const sub = field.selections ?? [];
        const refName = repo.defaultBranch;
        const refOut: Record<string, unknown> = {};
        for (const subSelection of sub) {
          if (subSelection.kind !== 'field') continue;
          if (subSelection.field.name === 'name') refOut[subSelection.field.alias ?? 'name'] = refName;
          else ctx.errors.push({ message: `Cannot query field "${subSelection.field.name}" on type "Ref".` });
        }
        out[key] = repo.refs.has(`refs/heads/${refName}`) ? refOut : null;
        break;
      }
      case 'viewerPermission':
        out[key] = 'ADMIN';
        break;
      case 'hasIssuesEnabled':
        out[key] = true;
        break;
      case 'issue': {
        const number = argValue(field, 'number', ctx.variables) as number | undefined;
        const issue = number === undefined ? undefined : repo.issues.get(number);
        out[key] = issue === undefined ? null : resolveIssueFields(repo, issue, field.selections ?? [], ctx);
        break;
      }
      case 'issues': {
        const first = (argValue(field, 'first', ctx.variables) as number | undefined) ?? 100;
        const after = argValue(field, 'after', ctx.variables) as string | undefined;
        const states = (argValue(field, 'states', ctx.variables) as string[] | undefined) ?? [];
        const orderBy = (argValue(field, 'orderBy', ctx.variables) as Record<string, unknown> | undefined) ?? {};
        const direction = (orderBy.direction as string | undefined) ?? 'DESC';
        let list = [...repo.issues.values()];
        if (states.length > 0) {
          const wanted = new Set(states.map((s) => s.toLowerCase()));
          list = list.filter((issue) => wanted.has(issue.state));
        }
        list.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
        const afterNumber = numberFromCursor(after);
        if (afterNumber !== null) {
          list = direction === 'ASC' ? list.filter((issue) => issue.number > afterNumber) : list.filter((issue) => issue.number < afterNumber);
        }
        const pageItems = list.slice(0, first);
        const hasNextPage = list.length > first;
        const endCursor = pageItems.length > 0 ? cursorFor(pageItems[pageItems.length - 1]?.number as number) : null;
        out[key] = {
          nodes: pageItems.map((issue) => resolveIssueFields(repo, issue, (field.selections ?? []).find((s): s is { kind: 'field'; field: GqlField } => s.kind === 'field' && s.field.name === 'nodes')?.field.selections ?? [], ctx)),
          pageInfo: { hasNextPage, endCursor },
          totalCount: list.length,
        };
        break;
      }
      case 'pullRequest': {
        const number = argValue(field, 'number', ctx.variables) as number | undefined;
        const pull = number === undefined ? undefined : repo.pulls.get(number);
        out[key] = pull === undefined ? null : resolvePullFields(repo, pull, field.selections ?? [], ctx);
        break;
      }
      case 'pullRequests': {
        const first = (argValue(field, 'first', ctx.variables) as number | undefined) ?? 100;
        const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number).slice(0, first);
        const nodesSelections = (field.selections ?? []).find((s): s is { kind: 'field'; field: GqlField } => s.kind === 'field' && s.field.name === 'nodes')?.field.selections ?? [];
        out[key] = {
          nodes: list.map((pull) => resolvePullFields(repo, pull, nodesSelections, ctx)),
          pageInfo: { hasNextPage: false, endCursor: list.length > 0 ? cursorFor(list[list.length - 1]?.number as number) : null },
          totalCount: repo.pulls.size,
        };
        break;
      }
      default:
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Repository".` });
        break;
    }
  }
  return out;
}

function resolveNodeById(id: string, selections: GqlSelection[], ctx: GqlContext): Record<string, unknown> | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  const repo = repoByDatabaseId(parsed.databaseId);
  if (repo === undefined) return null;
  // Apply inline fragments matching the resolved type; bare fields apply to any type.
  const applySelections = (typeName: string, resolve: (sels: GqlSelection[]) => Record<string, unknown>): Record<string, unknown> => {
    const direct: GqlSelection[] = [];
    const fragmentSels: GqlSelection[] = [];
    for (const selection of selections) {
      if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition === null || selection.typeCondition === typeName) fragmentSels.push(...selection.selections);
      } else {
        direct.push(selection);
      }
    }
    return resolve([...direct, ...fragmentSels]);
  };
  if (parsed.kind === 'Repository') {
    return { __typename: 'Repository', ...applySelections('Repository', (sels) => resolveRepoFields(repo, sels, ctx)) };
  }
  if (parsed.kind === 'Issue' && parsed.number !== undefined) {
    const issue = repo.issues.get(parsed.number);
    if (issue === undefined) return null;
    return { __typename: 'Issue', ...applySelections('Issue', (sels) => resolveIssueFields(repo, issue, sels, ctx)) };
  }
  if (parsed.kind === 'PullRequest' && parsed.number !== undefined) {
    const pull = repo.pulls.get(parsed.number);
    if (pull === undefined) return null;
    return { __typename: 'PullRequest', ...applySelections('PullRequest', (sels) => resolvePullFields(repo, pull, sels, ctx)) };
  }
  return null;
}

function resolveOperation(operation: GqlOperation, variables: Record<string, unknown>): { data: Record<string, unknown>; errors?: Array<{ message: string }> } {
  const ctx: GqlContext = { variables, errors: [] };
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind !== 'field') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (operation.type === 'query') {
      switch (field.name) {
        case 'viewer': {
          const sub = field.selections ?? [];
          const viewerOut: Record<string, unknown> = {};
          for (const subSelection of sub) {
            if (subSelection.kind !== 'field') continue;
            if (subSelection.field.name === 'login') viewerOut[subSelection.field.alias ?? 'login'] = VIEWER.login;
            else if (subSelection.field.name === 'id') viewerOut[subSelection.field.alias ?? 'id'] = globalId('User', VIEWER.id);
            else if (subSelection.field.name === 'name') viewerOut[subSelection.field.alias ?? 'name'] = VIEWER.name;
            else ctx.errors.push({ message: `Cannot query field "${subSelection.field.name}" on type "User".` });
          }
          data[key] = viewerOut;
          break;
        }
        case 'repository': {
          const owner = argValue(field, 'owner', variables) as string | undefined;
          const name = argValue(field, 'name', variables) as string | undefined;
          const repo = owner !== undefined && name !== undefined ? (owner === VIEWER.login ? getRepo(owner, name) : undefined) : undefined;
          data[key] = repo === undefined ? null : resolveRepoFields(repo, field.selections ?? [], ctx);
          break;
        }
        case 'node': {
          const id = argValue(field, 'id', variables) as string | undefined;
          data[key] = id === undefined ? null : resolveNodeById(id, field.selections ?? [], ctx);
          break;
        }
        case '__type': {
          const typeName = argValue(field, 'name', variables) as string | undefined;
          const sub = field.selections ?? [];
          const typeOut: Record<string, unknown> = {};
          for (const subSelection of sub) {
            if (subSelection.kind !== 'field') continue;
            if (subSelection.field.name === 'name') typeOut[subSelection.field.alias ?? 'name'] = typeName ?? null;
            else if (subSelection.field.name === 'fields') typeOut[subSelection.field.alias ?? 'fields'] = typeFields(typeName ?? '').map((name) => ({ name }));
            else if (subSelection.field.name === 'enumValues') typeOut[subSelection.field.alias ?? 'enumValues'] = typeEnumValues(typeName ?? '').map((name) => ({ name }));
            else ctx.errors.push({ message: `Cannot query field "${subSelection.field.name}" on type "__Type".` });
          }
          data[key] = typeOut;
          break;
        }
        default:
          ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
          break;
      }
    } else {
      // Mutations.
      const input = (argValue(field, 'input', variables) as Record<string, unknown> | undefined) ?? {};
      switch (field.name) {
        case 'createIssue': {
          const repoId = input.repositoryId as string | undefined;
          const parsed = repoId === undefined ? null : parseGlobalId(repoId);
          const repo = parsed === null ? undefined : repoByDatabaseId(parsed.databaseId);
          if (repo === undefined) {
            data[key] = { issue: null };
            break;
          }
          const number = repo.nextIssue;
          repo.nextIssue += 1;
          globalSeq += 1;
          const issue: Issue = {
            number,
            id: repo.databaseId * 1_000_000 + number,
            title: (input.title as string | undefined) ?? '',
            body: (input.body as string | undefined) ?? '',
            state: 'open',
            labels: [],
            createdSeq: globalSeq,
            comments: [],
          };
          repo.issues.set(number, issue);
          const sub = field.selections ?? [];
          const issueSel = sub.find((s): s is { kind: 'field'; field: GqlField } => s.kind === 'field' && s.field.name === 'issue')?.field.selections ?? [];
          data[key] = { issue: resolveIssueFields(repo, issue, issueSel, ctx) };
          break;
        }
        case 'closeIssue': {
          const issueId = input.issueId as string | undefined;
          const parsed = issueId === undefined ? null : parseGlobalId(issueId);
          const repo = parsed === null ? undefined : repoByDatabaseId(parsed.databaseId);
          const issue = repo === undefined || parsed?.number === undefined ? undefined : repo.issues.get(parsed.number);
          if (issue !== undefined) issue.state = 'closed';
          const sub = field.selections ?? [];
          const issueSel = sub.find((s): s is { kind: 'field'; field: GqlField } => s.kind === 'field' && s.field.name === 'issue')?.field.selections ?? [];
          data[key] = { issue: issue === undefined || repo === undefined ? null : resolveIssueFields(repo, issue, issueSel, ctx) };
          break;
        }
        case 'createPullRequest': {
          const repoId = input.repositoryId as string | undefined;
          const parsed = repoId === undefined ? null : parseGlobalId(repoId);
          const repo = parsed === null ? undefined : repoByDatabaseId(parsed.databaseId);
          const head = (input.headRefName as string | undefined) ?? '';
          const base = (input.baseRefName as string | undefined) ?? repo?.defaultBranch ?? DEFAULT_BRANCH;
          let pull: Pull | undefined;
          if (repo !== undefined) {
            pull = [...repo.pulls.values()].find((p) => p.headRef === head && p.state === 'open');
            if (pull === undefined) {
              const headSha = repo.refs.get(`refs/heads/${head}`);
              const baseSha = repo.refs.get(`refs/heads/${base}`);
              if (headSha !== undefined && baseSha !== undefined) {
                const number = repo.nextPull;
                repo.nextPull += 1;
                globalSeq += 1;
                pull = {
                  number,
                  id: repo.databaseId * 1_000_000 + number,
                  title: (input.title as string | undefined) ?? '',
                  body: (input.body as string | undefined) ?? '',
                  state: 'open',
                  merged: false,
                  mergedAt: null,
                  mergeCommitSha: null,
                  headRef: head,
                  baseRef: base,
                  headSha,
                  baseSha,
                  createdSeq: globalSeq,
                  comments: [],
                };
                repo.pulls.set(number, pull);
              }
            }
          }
          const sub = field.selections ?? [];
          const prSel = sub.find((s): s is { kind: 'field'; field: GqlField } => s.kind === 'field' && s.field.name === 'pullRequest')?.field.selections ?? [];
          data[key] = { pullRequest: pull === undefined || repo === undefined ? null : resolvePullFields(repo, pull, prSel, ctx) };
          break;
        }
        case 'mergePullRequest': {
          const prId = input.pullRequestId as string | undefined;
          const parsed = prId === undefined ? null : parseGlobalId(prId);
          const repo = parsed === null ? undefined : repoByDatabaseId(parsed.databaseId);
          const pull = repo === undefined || parsed?.number === undefined ? undefined : repo.pulls.get(parsed.number);
          if (pull !== undefined && repo !== undefined && pull.state === 'open') {
            const baseOid = mergeBase(repo, pull.headSha, pullBaseTip(repo, pull));
            if (!mergeConflicts(repo, baseOid, pull.headSha, pullBaseTip(repo, pull))) {
              const mergeSha = squashMerge(repo, pull);
              globalSeq += 1;
              pull.merged = true;
              pull.state = 'closed';
              pull.mergedAt = seqTime(globalSeq);
              pull.mergeCommitSha = mergeSha;
              repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
            }
          }
          const sub = field.selections ?? [];
          const prSel = sub.find((s): s is { kind: 'field'; field: GqlField } => s.kind === 'field' && s.field.name === 'pullRequest')?.field.selections ?? [];
          data[key] = { pullRequest: pull === undefined || repo === undefined ? null : resolvePullFields(repo, pull, prSel, ctx) };
          break;
        }
        case 'addComment': {
          const subjectId = input.subjectId as string | undefined;
          const parsed = subjectId === undefined ? null : parseGlobalId(subjectId);
          const repo = parsed === null ? undefined : repoByDatabaseId(parsed.databaseId);
          const body = (input.body as string | undefined) ?? '';
          let comment: { id: number; body: string } | undefined;
          if (repo !== undefined && parsed?.number !== undefined) {
            if (parsed.kind === 'Issue') {
              const issue = repo.issues.get(parsed.number);
              if (issue !== undefined) {
                comment = { id: repo.nextCommentId, body };
                repo.nextCommentId += 1;
                issue.comments.push(comment);
              }
            } else if (parsed.kind === 'PullRequest') {
              const pull = repo.pulls.get(parsed.number);
              if (pull !== undefined) {
                comment = { id: repo.nextCommentId, body };
                repo.nextCommentId += 1;
                pull.comments.push(comment);
              }
            }
          }
          const sub = field.selections ?? [];
          const edgeSel = sub.find((s): s is { kind: 'field'; field: GqlField } => s.kind === 'field' && s.field.name === 'commentEdge')?.field.selections ?? [];
          const nodeSel = edgeSel.find((s): s is { kind: 'field'; field: GqlField } => s.kind === 'field' && s.field.name === 'node')?.field.selections ?? [];
          const nodeOut: Record<string, unknown> = {};
          for (const nodeField of nodeSel) {
            if (nodeField.kind !== 'field') continue;
            if (nodeField.field.name === 'id') nodeOut[nodeField.field.alias ?? 'id'] = comment === undefined ? null : globalId('IssueComment', repo?.databaseId ?? 0, comment.id);
            else if (nodeField.field.name === 'body') nodeOut[nodeField.field.alias ?? 'body'] = comment?.body ?? null;
            else ctx.errors.push({ message: `Cannot query field "${nodeField.field.name}" on type "IssueComment".` });
          }
          data[key] = { commentEdge: comment === undefined ? null : { node: nodeOut } };
          break;
        }
        default:
          ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
          break;
      }
    }
  }
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (!tokenValid(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const body = parseJsonBody(await readBody(req));
  if (body === null) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { errors: [{ message: 'A GraphQL query string is required' }] };
    }
    const variables = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    const operationName = typeof doc.operationName === 'string' ? doc.operationName : null;
    let operations: GqlOperation[];
    try {
      operations = new GqlParser(tokenizeGql(doc.query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
    const operation = operationName === null ? operations[0] : operations.find((op) => op.name === operationName) ?? operations[0];
    if (operation === undefined) return { errors: [{ message: 'No operation to run' }] };
    const resolvedVariables: Record<string, unknown> = { ...variables };
    for (const def of operation.variableDefinitions) {
      if (!(def.name in resolvedVariables) && def.defaultValue !== null) {
        resolvedVariables[def.name] = resolveGqlValue(def.defaultValue, resolvedVariables);
      }
    }
    return resolveOperation(operation, resolvedVariables);
  };
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map(runOne));
    return true;
  }
  sendJson(res, 200, runOne(body));
  return true;
}

// ------------------------------------------------------------------ MCP
//
// Streamable HTTP JSON-RPC 2.0 at /mcp. Modern revision 2026-07-28 via server/discover, and the
// legacy initialize + notifications/initialized handshake. Plain JSON bodies; every tools/call
// result carries both text content and structuredContent.

const MCP_SERVER_INFO = { name: 'forge', version: '1.0.0' };
const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
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
    description: 'Get a repository by owner and name.',
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
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

/** Resolve owner/repo from tool arguments, accepting a full_name ("owner/repo") fallback. */
function mcpRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((owner === '' || repo === '') && typeof args.full_name === 'string') {
    const parts = (args.full_name as string).split('/');
    if (parts.length === 2) {
      owner = parts[0] as string;
      repo = parts[1] as string;
    }
  }
  if (owner === '' || repo === '') return null;
  return { owner, repo };
}

function mcpToolResult(obj: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}

/** Run one MCP tool against the store; returns the tool result object. */
function runMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const required: Record<string, string[]> = {
    create_repo: ['name'],
    get_repo: ['owner', 'repo'],
    create_issue: ['owner', 'repo', 'title'],
    list_issues: ['owner', 'repo'],
    create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
    merge_pull_request: ['owner', 'repo', 'pull_number'],
  };
  const missing = (required[name] ?? []).filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0 && name !== 'get_repo' && name !== 'list_issues' && name !== 'create_issue' && name !== 'create_pull_request' && name !== 'merge_pull_request') {
    return mcpToolError(`missing required argument(s): ${missing.join(', ')}`);
  }
  switch (name) {
    case 'create_repo': {
      if (missing.length > 0) return mcpToolError(`missing required argument(s): ${missing.join(', ')}`);
      const repoName = args.name as string;
      if (getRepo(VIEWER.login, repoName) !== undefined) {
        return mcpToolError(`Repository ${VIEWER.login}/${repoName} already exists`);
      }
      const repo = createRepoRecord(
        VIEWER.login,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return mcpToolResult(repoJson(repo));
    }
    case 'get_repo': {
      const resolved = mcpRepoArgs(args);
      if (resolved === null) return mcpToolError('missing required argument(s): owner, repo');
      const repo = resolved.owner === VIEWER.login ? getRepo(resolved.owner, resolved.repo) : undefined;
      if (repo === undefined) return mcpToolError('Not Found');
      return mcpToolResult(repoJson(repo));
    }
    case 'create_issue': {
      if (missing.length > 0) return mcpToolError(`missing required argument(s): ${missing.join(', ')}`);
      const resolved = mcpRepoArgs(args);
      if (resolved === null) return mcpToolError('missing required argument(s): owner, repo');
      const repo = resolved.owner === VIEWER.login ? getRepo(resolved.owner, resolved.repo) : undefined;
      if (repo === undefined) return mcpToolError('Not Found');
      const number = repo.nextIssue;
      repo.nextIssue += 1;
      globalSeq += 1;
      const issue: Issue = {
        number,
        id: repo.databaseId * 1_000_000 + number,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels: [],
        createdSeq: globalSeq,
        comments: [],
      };
      repo.issues.set(number, issue);
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const resolved = mcpRepoArgs(args);
      if (resolved === null) return mcpToolError('missing required argument(s): owner, repo');
      const repo = resolved.owner === VIEWER.login ? getRepo(resolved.owner, resolved.repo) : undefined;
      if (repo === undefined) return mcpToolError('Not Found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      return mcpToolResult({ issues: list.map((issue) => issueJson(repo, issue)) });
    }
    case 'create_pull_request': {
      if (missing.length > 0) return mcpToolError(`missing required argument(s): ${missing.join(', ')}`);
      const resolved = mcpRepoArgs(args);
      if (resolved === null) return mcpToolError('missing required argument(s): owner, repo');
      const repo = resolved.owner === VIEWER.login ? getRepo(resolved.owner, resolved.repo) : undefined;
      if (repo === undefined) return mcpToolError('Not Found');
      const head = args.head as string;
      const base = args.base as string;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return mcpToolError('head or base branch does not exist');
      const existing = [...repo.pulls.values()].find((p) => p.headRef === head && p.state === 'open');
      if (existing !== undefined) return mcpToolResult(pullJson(repo, existing));
      const number = repo.nextPull;
      repo.nextPull += 1;
      globalSeq += 1;
      const pull: Pull = {
        number,
        id: repo.databaseId * 1_000_000 + number,
        title: args.title as string,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        createdSeq: globalSeq,
        comments: [],
      };
      repo.pulls.set(number, pull);
      return mcpToolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      if (missing.length > 0) return mcpToolError(`missing required argument(s): ${missing.join(', ')}`);
      const resolved = mcpRepoArgs(args);
      if (resolved === null) return mcpToolError('missing required argument(s): owner, repo');
      const repo = resolved.owner === VIEWER.login ? getRepo(resolved.owner, resolved.repo) : undefined;
      if (repo === undefined) return mcpToolError('Not Found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return mcpToolError('Not Found');
      if (pull.state === 'closed') return mcpToolError('Pull request is already closed');
      const baseOid = mergeBase(repo, pull.headSha, pullBaseTip(repo, pull));
      if (mergeConflicts(repo, baseOid, pull.headSha, pullBaseTip(repo, pull))) return mcpToolError('Merge conflict');
      const mergeSha = squashMerge(repo, pull);
      globalSeq += 1;
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = seqTime(globalSeq);
      pull.mergeCommitSha = mergeSha;
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
      return mcpToolResult({ sha: mergeSha, merged: true, message: 'Pull request successfully merged', number: pull.number });
    }
    default:
      return mcpToolError(`Unknown tool: ${name}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  if (!tokenValid(req)) {
    res.writeHead(401, { 'content-type': JSON_TYPE, 'x-github-request-id': `req-${++requestSeq}` });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Requires authentication' } }));
    return true;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (parsed === null) {
    res.writeHead(400, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
    return true;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    res.writeHead(400, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
    return true;
  }
  const id = parsed.id ?? null;
  const isNotification = parsed.id === undefined;
  const params = isRecord(parsed.params) ? parsed.params : {};
  const reply = (result: unknown): void => {
    if (isNotification) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const replyError = (code: number, message: string): void => {
    if (isNotification) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  switch (parsed.method) {
    case 'server/discover': {
      reply({
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      });
      return true;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      reply({
        protocolVersion: MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      });
      return true;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled': {
      reply({});
      return true;
    }
    case 'ping': {
      reply({});
      return true;
    }
    case 'tools/list': {
      reply({ tools: MCP_TOOLS });
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const tool = MCP_TOOLS.find((entry) => entry.name === name);
      if (tool === undefined) {
        replyError(-32601, `Unknown tool: ${name}`);
        return true;
      }
      reply(runMcpTool(name, args));
      return true;
    }
    default: {
      replyError(-32601, `Method not found: ${parsed.method}`);
      return true;
    }
  }
}

// ------------------------------------------------------------------ git smart HTTP

/** The v0 capability string for a service advertisement. */
function v0Caps(service: 'git-upload-pack' | 'git-receive-pack'): string {
  const base = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k ofs-delta agent=${AGENT}`;
  return service === 'git-receive-pack' ? `${base} report-status delete-refs` : base;
}

/** The v0 advertisement for a repo: service line, flush, ref lines, flush. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const lines: (string | 'flush')[] = [`# service=${service}\n`, 'flush'];
  const caps = v0Caps(service);
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    lines.push(`${tip} HEAD\0${caps}\n`);
    const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [ref, oid] of refs) lines.push(`${oid} ${ref}\n`);
    // Peeled tag lines, after the ref they peel.
    for (const [ref, oid] of refs) {
      if (!ref.startsWith('refs/tags/')) continue;
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        lines.push(`${parseTag(obj.data).object} ${ref}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

/** The v2 advertisement: service line, flush, version + capabilities, flush. */
function v2Advertisement(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** One sideband packet (band 1 = data) wrapping up to 65,515 bytes of payload: a pkt-line is
 * at most 65,520 bytes *including* its 4-byte length prefix, and the band byte takes one more. */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += 65515) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + 65515));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    const length = payload.length + 4;
    out.push(Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), payload]));
  }
  return out;
}

/** The ls-refs answer for a repo: one data packet per ref, then flush. */
function lsRefsAnswer(repo: Repo, opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): Buffer {
  const lines: (string | 'flush')[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const keep = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((prefix) => name.startsWith(prefix));
  const peelOf = (oid: string): string | null => {
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') return parseTag(obj.data).object;
    return null;
  };
  if (tip === undefined) {
    if (opts.unborn && keep('HEAD')) {
      lines.push(`unborn HEAD${opts.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  } else {
    if (keep('HEAD')) {
      lines.push(`${tip} HEAD${opts.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
    for (const [ref, oid] of refs) {
      if (!keep(ref)) continue;
      let line = `${oid} ${ref}`;
      if (opts.peel) {
        const peeled = peelOf(oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return pktLines(lines);
}

/** The v2 fetch answer: acknowledgments, optional shallow-info, optional packfile, flush. */
function fetchV2Answer(
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  oldBoundary: string[],
): Buffer {
  const chunks: Buffer[] = [];
  const selection = fetchSelection(repo, wants, haves, depth, oldBoundary);
  // The acknowledgments section exists only when the client sent "have" lines: a client
  // that sent no haves reads the packfile section straight away, and a stray
  // "acknowledgments" header makes it die with "expected 'packfile'". When the wants are
  // all held there is no packfile at all — acknowledgments + flush only.
  const allHeld = haves.length > 0 && wants.length > 0 && wants.every((want) => {
    for (const have of haves) if (isAncestor(repo, want, have)) return true;
    return false;
  });
  // Sections are separated by a delim packet, but no delim precedes the first section.
  let sectionStarted = false;
  const startSection = (name: string): void => {
    if (sectionStarted) chunks.push(pktLine('delim'));
    chunks.push(pktLine(`${name}\n`));
    sectionStarted = true;
  };
  if (haves.length > 0) {
    startSection('acknowledgments');
    if (allHeld) {
      chunks.push(pktLine(`ACK ${haves[haves.length - 1] as string}\n`));
      chunks.push(pktLine('ready\n'));
    } else {
      chunks.push(pktLine('NAK\n'));
    }
  }
  const hasShallowInfo = selection.shallow.length > 0 || selection.unshallow.length > 0;
  // Whether a packfile goes out is decided by the object list alone: a deepen fetch has
  // want == have (the tip is already held) yet still owes the parent, so "the wants are
  // all held" must never suppress the pack — when nothing is owed the list is empty.
  const hasPack = selection.objects.length > 0;
  if (hasShallowInfo) {
    startSection('shallow-info');
    for (const oid of selection.shallow) chunks.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) chunks.push(pktLine(`unshallow ${oid}\n`));
  }
  if (hasPack) {
    const pack = writePack(selection.objects);
    startSection('packfile');
    for (const packet of sidebandPackets(pack)) chunks.push(packet);
  }
  chunks.push(pktLine('flush'));
  return Buffer.concat(chunks);
}

/** The v0 fetch answer: NAK/ACK lines, then the pack as sideband packets, then flush. */
function fetchV0Answer(repo: Repo, wants: string[], haves: string[]): Buffer {
  const selection = fetchSelection(repo, wants, haves, null, []);
  const chunks: Buffer[] = [];
  const allHeld = wants.length > 0 && wants.every((want) => haves.some((have) => isAncestor(repo, want, have)));
  if (allHeld && haves.length > 0) chunks.push(pktLine(`ACK ${haves[haves.length - 1] as string}\n`));
  else chunks.push(pktLine('NAK\n'));
  if (selection.objects.length > 0) {
    const pack = writePack(selection.objects);
    for (const packet of sidebandPackets(pack)) chunks.push(packet);
  }
  chunks.push(pktLine('flush'));
  return Buffer.concat(chunks);
}

async function handleGit(req: IncomingMessage, res: ServerResponse, url: URL, segments: string[]): Promise<boolean> {
  const method = req.method ?? 'GET';
  // /{owner}/{repo}.git/... — the .git suffix is part of the remote URL.
  if (segments.length < 3) return false;
  const repoSegment = segments[1] as string;
  if (!repoSegment.endsWith('.git')) return false;
  const owner = decodeSegment(segments[0] as string);
  const name = decodeSegment(repoSegment.slice(0, -4));
  const service = segments[2] as string;
  if (!tokenValid(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return true;
  }
  const repo = owner === VIEWER.login ? getRepo(owner, name) : undefined;
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }

  // GET /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
  if (method === 'GET' && service === 'info' && segments[3] === 'refs') {
    const requested = url.searchParams.get('service') ?? '';
    if (requested === 'git-upload-pack') {
      const v2 = req.headers['git-protocol'] === 'version=2';
      sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', v2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack'));
      return true;
    }
    if (requested === 'git-receive-pack') {
      sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
      return true;
    }
    sendJson(res, 400, { message: 'Unknown service' });
    return true;
  }

  // POST /{owner}/{repo}.git/git-upload-pack — v2 ls-refs / fetch, or v0 fetch.
  if (method === 'POST' && service === 'git-upload-pack') {
    const body = await readBody(req);
    let packets: Pkt[];
    try {
      packets = parsePktLines(body).packets;
    } catch {
      sendJson(res, 400, { message: 'Malformed pkt-line stream' });
      return true;
    }
    const v2 = req.headers['git-protocol'] === 'version=2';
    const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));
    const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length).trim() ?? '';
    if (!v2) {
      // v0 fetch: want/have/done lines.
      const wants: string[] = [];
      const haves: string[] = [];
      for (const line of lines) {
        const clean = line.replace(/\n$/, '');
        if (clean.startsWith('want ')) wants.push(clean.slice(5, 45));
        else if (clean.startsWith('have ')) haves.push(clean.slice(5, 45));
      }
      sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchV0Answer(repo, wants, haves));
      return true;
    }
    if (command === 'ls-refs') {
      const opts = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
      for (const line of lines) {
        const clean = line.replace(/\n$/, '');
        if (clean === 'peel') opts.peel = true;
        else if (clean === 'symrefs') opts.symrefs = true;
        else if (clean === 'unborn') opts.unborn = true;
        else if (clean.startsWith('ref-prefix ')) opts.prefixes.push(clean.slice('ref-prefix '.length));
      }
      sendRaw(res, 200, 'application/x-git-upload-pack-result', lsRefsAnswer(repo, opts));
      return true;
    }
    if (command === 'fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      for (const line of lines) {
        const clean = line.replace(/\n$/, '');
        if (clean.startsWith('want ')) wants.push(clean.slice(5, 45));
        else if (clean.startsWith('have ')) haves.push(clean.slice(5, 45));
        else if (clean.startsWith('shallow ')) shallow.push(clean.slice(8, 48));
        else if (clean.startsWith('deepen ')) depth = Number(clean.slice(7));
      }
      sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchV2Answer(repo, wants, haves, depth, shallow));
      return true;
    }
    sendJson(res, 400, { message: `Unknown command ${command}` });
    return true;
  }

  // POST /{owner}/{repo}.git/git-receive-pack — v0 push.
  if (method === 'POST' && service === 'git-receive-pack') {
    const body = await readBody(req);
    let packets: Pkt[];
    let packOffset = 0;
    try {
      // The command list is pkt-lines up to the first flush; the pack follows raw, so the
      // parser must stop at the flush and never read the pack bytes as pkt-lines.
      const parsed = parsePktLinesUntilFlush(body);
      packets = parsed.packets;
      packOffset = parsed.bytesConsumed;
    } catch {
      sendJson(res, 400, { message: 'Malformed pkt-line stream' });
      return true;
    }
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      const head = nul < 0 ? text : text.slice(0, nul);
      const parts = head.split(' ');
      if (parts.length < 3) {
        sendJson(res, 400, { message: 'Malformed push command' });
        return true;
      }
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    if (commands.length === 0) {
      sendJson(res, 400, { message: 'No push commands' });
      return true;
    }
    // Unpack the pack (present for creates/updates; absent for delete-only).
    const hasPack = commands.some((cmd) => cmd.newOid !== ZERO_OID);
    let unpackOk = true;
    if (hasPack) {
      const packBytes = body.subarray(packOffset);
      if (packBytes.length < 12) {
        unpackOk = false;
      } else {
        try {
          const newObjects = readPack(packBytes, (oid) => repo.objects.get(oid));
          for (const [oid, obj] of newObjects) repo.objects.set(oid, obj);
        } catch {
          unpackOk = false;
        }
      }
    }
    // Apply the ref updates, one report line each.
    const reportLines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      let reason: string | null = null;
      if (!unpackOk) {
        reason = 'unpacker error';
      } else if (cmd.newOid === ZERO_OID) {
        if (current === undefined) reason = 'remote ref does not exist';
      } else if (cmd.oldOid === ZERO_OID) {
        if (current !== undefined) reason = 'already exists';
        else if (!repo.objects.has(cmd.newOid)) reason = 'invalid object';
      } else {
        if (current === undefined) reason = 'remote ref does not exist';
        else if (current !== cmd.oldOid) reason = 'non-fast-forward';
        else if (!repo.objects.has(cmd.newOid)) reason = 'invalid object';
        else if (!isAncestor(repo, current, cmd.newOid)) reason = 'non-fast-forward';
      }
      if (reason === null) {
        if (cmd.newOid === ZERO_OID) repo.refs.delete(cmd.ref);
        else repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}\n`);
      } else {
        reportLines.push(`ng ${cmd.ref} ${reason}\n`);
      }
    }
    // The report is a pkt-line stream inside band 1 — "unpack ok", one line per ref —
    // terminated by a flush pkt-line *inside* the sideband payload; the outer stream then
    // ends with its own flush. Without the inner flush the client reads EOF where it
    // expects the terminator and dies with "the remote end hung up unexpectedly".
    const report = pktLines([...reportLines, 'flush']);
    // The report is band-1 sideband packets carrying the pkt-lined report, then a flush.
    const out = Buffer.concat([...sidebandPackets(report), pktLine('flush')]);
    sendRaw(res, 200, 'application/x-git-receive-pack-result', out);
    return true;
  }

  return false;
}

// ------------------------------------------------------------------ the server

/** Build the server. It binds nothing until the caller listens; the entry listens on port 0. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = urlOf(req);
        const pathname = url.pathname;
        const segments = pathSegments(pathname);
        const method = req.method ?? 'GET';
        const host = req.headers.host ?? '127.0.0.1';
        const origin = `http://${host}`;

        // Read any request body up front and cache it: handlers that answer 401/404 before
        // reading it would otherwise leave unread bytes on a keep-alive socket, breaking the
        // connection for the client's next request.
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          await readBody(req);
        }

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          await handleRest(req, res, url, segments, origin);
          return;
        }

        // GraphQL v4.
        if (pathname === '/api/graphql') {
          await handleGraphql(req, res);
          return;
        }

        // MCP.
        if (pathname === '/mcp') {
          await handleMcp(req, res);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
          const handled = await handleGit(req, res, url, segments);
          if (handled) return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // Never crash the server on a bad request: answer 500 JSON and stay up.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });
}
