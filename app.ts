// A GitHub-compatible git forge in one file: git smart HTTP (protocol v2 + v0
// receive-pack), the REST v3 surface, GraphQL v4 and an MCP endpoint, all over
// one shared in-memory store. Node standard library only — the git object
// model, packfiles and the three API dialects are implemented here directly.
//
// main.ts owns the entry <-> env lifecycle; this file exports createApp().

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// Identity, clock, small utilities
// ---------------------------------------------------------------------------------------------

/**
 * The token holder. The suite's scenario names one fixed viewer (wire.ts
 * buildScenario is a constant), and every surface resolves the bearer token to
 * that login: repositories belong to it, and the same name under any other
 * owner is a 404.
 */
const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

const ZERO_OID = '0000000000000000000000000000000000000000';
const JSON_TYPE = 'application/json; charset=utf-8';
const FORGE_VERSION = '1.0.0';

/**
 * A deterministic clock: MAKEFUN_TRIAL_NOW when the env provides it, else a
 * fixed base, advanced by a monotonic counter so two timestamps never repeat
 * and nothing a check can observe depends on the wall clock.
 */
function initialClockSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  if (raw !== '') {
    if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return 1_767_225_600; // 2026-01-01T00:00:00Z
}
let clockSec = initialClockSec();
function nowSec(): number {
  clockSec += 1;
  return clockSec;
}
function nowIso(): string {
  return new Date(nowSec() * 1000).toISOString();
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function b64decodeBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/\s+/g, ''), 'base64');
}

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

type ObjType = 'blob' | 'tree' | 'commit' | 'tag';

interface GitObj {
  type: ObjType;
  data: Buffer;
}

interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
}

interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
}

interface PullRec {
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
  createdAt: string;
}

interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  nextIssueNumber: number;
  pulls: Map<number, PullRec>;
  nextPullNumber: number;
  createdSeq: number;
}

const reposByKey = new Map<string, RepoRec>();
const reposById = new Map<number, RepoRec>();
let nextRepoId = 1;
let nextIssueId = 1;
let nextCommentId = 1;
let nextPullId = 1;
let repoSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function findRepo(owner: string, name: string): RepoRec | null {
  if (owner !== VIEWER.login) return null;
  return reposByKey.get(repoKey(owner, name)) ?? null;
}

function createRepoRec(name: string, description: string, isPrivate: boolean): RepoRec {
  const repo: RepoRec = {
    id: nextRepoId,
    owner: VIEWER.login,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    nextIssueNumber: 1,
    pulls: new Map(),
    nextPullNumber: 1,
    createdSeq: repoSeq,
  };
  nextRepoId += 1;
  repoSeq += 1;
  reposByKey.set(repoKey(repo.owner, repo.name), repo);
  reposById.set(repo.id, repo);
  return repo;
}

function deleteRepoRec(repo: RepoRec): void {
  reposByKey.delete(repoKey(repo.owner, repo.name));
  reposById.delete(repo.id);
}

// ---------------------------------------------------------------------------------------------
// The git object model
// ---------------------------------------------------------------------------------------------

function hashObject(type: ObjType, data: Buffer): string {
  return sha1Hex(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}

function storeObj(repo: RepoRec, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  time: number;
  author: string;
  committer: string;
}

function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const sep = text.indexOf('\n\n');
  const head = sep === -1 ? text : text.slice(0, sep);
  const message = sep === -1 ? '' : text.slice(sep + 2);
  let tree = '';
  let author = '';
  let committer = '';
  let time = 0;
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('committer ')) {
      committer = line.slice(10);
      const match = / (\d+) [+-]\d{4}\s*$/.exec(committer);
      if (match) time = Number.parseInt(match[1], 10);
    } else if (line.startsWith('author ')) author = line.slice(7);
  }
  return { tree, parents, message, time, author, committer };
}

function buildCommitData(tree: string, parents: readonly string[], message: string, timeSec: number): Buffer {
  const ident = `${VIEWER.name} <${VIEWER.email}> ${timeSec} +0000`;
  let head = `tree ${tree}\n`;
  for (const parent of parents) head += `parent ${parent}\n`;
  head += `author ${ident}\ncommitter ${ident}\n`;
  return Buffer.from(`${head}\n${message}`, 'utf8');
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

function isDirMode(mode: string): boolean {
  return mode.replace(/^0+/, '') === '40000';
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    entries.push({
      mode: data.toString('ascii', off, sp),
      name: data.toString('utf8', sp + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return isDirMode(entry.mode) ? `${entry.name}/` : entry.name;
}

function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface FileSlot {
  oid: string;
  mode: string;
}

/** Every blob under a tree, by slash path. */
function flattenTree(repo: RepoRec, treeOid: string): Map<string, FileSlot> {
  const out = new Map<string, FileSlot>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (isDirMode(entry.mode)) walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) the nested trees for a flat path -> blob map; returns the root tree oid. */
function buildTreeFromFiles(repo: RepoRec, files: ReadonlyMap<string, FileSlot>): string {
  const buildLevel = (prefix: string, items: ReadonlyArray<readonly [string, FileSlot]>): string => {
    const entries: TreeEntry[] = [];
    const dirs = new Map<string, Array<readonly [string, FileSlot]>>();
    for (const item of items) {
      const rest = item[0].slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: item[1].mode, name: rest, oid: item[1].oid });
      } else {
        const dir = rest.slice(0, slash);
        const list = dirs.get(dir) ?? [];
        list.push(item);
        dirs.set(dir, list);
      }
    }
    for (const [dir, sub] of dirs) {
      const oid = buildLevel(`${prefix}${dir}/`, sub);
      entries.push({ mode: '40000', name: dir, oid });
    }
    return storeObj(repo, 'tree', buildTreeData(entries));
  };
  return buildLevel('', [...files.entries()]);
}

/** The target oid of an annotated tag object, or null. */
function parseTagTarget(data: Buffer): string | null {
  const match = /^object ([0-9a-f]{40})$/m.exec(data.toString('utf8'));
  return match ? match[1] : null;
}

/** Peel an object to the commit it names (through annotated tags), or null. */
function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const obj = repo.objects.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target === null) return null;
      current = target;
      continue;
    }
    return null;
  }
  return null;
}

/** BFS distances from a commit over parent edges (the commit itself is 0). */
function commitDistances(repo: RepoRec, tip: string): Map<string, number> {
  const dist = new Map<string, number>();
  const start = peelToCommit(repo, tip);
  if (start === null) return dist;
  dist.set(start, 0);
  const queue = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'commit') continue;
    const next = (dist.get(current) ?? 0) + 1;
    for (const parent of parseCommit(obj.data).parents) {
      if (!dist.has(parent) && repo.objects.get(parent)?.type === 'commit') {
        dist.set(parent, next);
        queue.push(parent);
      }
    }
  }
  return dist;
}

function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  for (let head = 0; head < queue.length; head += 1) {
    const obj = repo.objects.get(queue[head] as string);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** The nearest common ancestor of two commits, or null. */
function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const fromA = commitDistances(repo, a);
  const fromB = commitDistances(repo, b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, da] of fromA) {
    const db = fromB.get(oid);
    if (db !== undefined && da + db < bestScore) {
      bestScore = da + db;
      best = oid;
    }
  }
  return best;
}

/** Every object reachable from the given tips (commits, their trees and blobs, tags). */
function reachableObjects(repo: RepoRec, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree, ...info.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const target = parseTagTarget(obj.data);
      if (target !== null) stack.push(target);
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------------------------

const PACK_TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPES: Record<number, ObjType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

/** A version-2 pack of plain (non-delta) objects, with its SHA-1 trailer. */
function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    let size = obj.data.length;
    const typeCode = PACK_TYPE_CODES[obj.type] ?? 3;
    const first = (size & 0x0f) | (typeCode << 4) | (size > 0x0f ? 0x80 : 0);
    const varint: number[] = [first];
    size >>= 4;
    while (size > 0) {
      const byte = size & 0x7f;
      size >>= 7;
      varint.push(size > 0 ? byte | 0x80 : byte);
    }
    parts.push(Buffer.from(varint));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

/**
 * Inflate one zlib stream starting at `offset`. inflateSync ignores trailing
 * bytes and throws on a truncated stream, so the shortest prefix that
 * inflates is exactly the stream: binary-search it.
 */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const remaining = buffer.length - offset;
  let lo = 1;
  let hi = remaining;
  try {
    inflateSync(buffer.subarray(offset, offset + hi));
  } catch {
    throw new Error('pack object does not inflate');
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buffer.subarray(offset, offset + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data: inflateSync(buffer.subarray(offset, offset + lo)), next: offset + lo };
}

/** Apply a git delta buffer to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[off] as number;
      off += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off] as number;
    off += 1;
    if ((op & 0x80) !== 0) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          cpOff |= (delta[off] as number) << (8 * i);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          cpSize |= (delta[off] as number) << (8 * i);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      parts.push(delta.subarray(off, off + op));
      off += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(parts);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta result size mismatch');
  return result;
}

interface PackObject {
  oid: string;
  type: ObjType;
  data: Buffer;
}

function repoObjectAsPack(repo: RepoRec, oid: string): PackObject | undefined {
  const obj = repo.objects.get(oid);
  return obj ? { oid, type: obj.type, data: obj.data } : undefined;
}

/**
 * Read a pack into resolved objects. Delta bases may live earlier in the same
 * pack or, for a thin pack, in the receiving repository's store.
 */
function readPack(repo: RepoRec, pack: Buffer): PackObject[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const computed = Buffer.from(sha1Hex(pack.subarray(0, pack.length - 20)), 'hex');
  if (!trailer.equals(computed)) throw new Error('pack checksum mismatch');
  const limit = pack.length - 20;
  const resolved = new Map<number, PackObject>();
  const byOid = new Map<string, PackObject>();
  let off = 12;
  for (let index = 0; index < count; index += 1) {
    const start = off;
    let byte = pack[off] as number;
    off += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[off] as number;
      off += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const kind = PACK_CODE_TYPES[typeCode];
    if (kind === undefined) throw new Error(`pack object type ${typeCode}`);
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (kind === 'ofs-delta') {
      let b = pack[off] as number;
      off += 1;
      let back = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[off] as number;
        off += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = start - back;
    } else if (kind === 'ref-delta') {
      baseOid = pack.toString('hex', off, off + 20);
      off += 20;
    }
    const inflated = inflateAt(pack.subarray(0, limit), off);
    off = inflated.next;
    if (inflated.data.length !== size) throw new Error('pack object size mismatch');
    let obj: PackObject;
    if (kind === 'ofs-delta' || kind === 'ref-delta') {
      const base = baseOffset >= 0 ? resolved.get(baseOffset) : baseOid !== null ? byOid.get(baseOid) ?? repoObjectAsPack(repo, baseOid) : undefined;
      if (!base) throw new Error('delta base not found');
      const data = applyDelta(base.data, inflated.data);
      obj = { oid: hashObject(base.type, data), type: base.type, data };
    } else {
      obj = { oid: hashObject(kind, inflated.data), type: kind, data: inflated.data };
    }
    resolved.set(start, obj);
    byOid.set(obj.oid, obj);
  }
  return [...byOid.values()];
}

// ---------------------------------------------------------------------------------------------
// Domain operations shared by REST, GraphQL and MCP
// ---------------------------------------------------------------------------------------------

function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(branchRef(branch)) ?? null;
}

/** Resolve a branch name, a full ref, HEAD, or a raw object id to an oid. */
function resolveRefish(repo: RepoRec, ref: string): string | null {
  if (ref === 'HEAD') return branchTip(repo, repo.defaultBranch);
  const direct = repo.refs.get(ref);
  if (direct !== undefined) return direct;
  const asBranch = repo.refs.get(branchRef(ref));
  if (asBranch !== undefined) return asBranch;
  const asTag = repo.refs.get(`refs/tags/${ref}`);
  if (asTag !== undefined) return asTag;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

function treeOfCommit(repo: RepoRec, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

function filesAtCommit(repo: RepoRec, commitOid: string): Map<string, FileSlot> {
  const tree = treeOfCommit(repo, commitOid);
  return tree === null ? new Map() : flattenTree(repo, tree);
}

/**
 * Commit file changes (path -> new bytes, or null to delete) onto a branch,
 * creating the branch (and the repository's first commit) when needed. A
 * branch that does not exist yet forks from the default branch's tip.
 * The commit message is stored byte-exactly as given.
 */
function commitFiles(
  repo: RepoRec,
  branch: string,
  changes: ReadonlyMap<string, Buffer | null>,
  message: string,
): { commitOid: string; created: Map<string, string> } {
  let parent = branchTip(repo, branch);
  let files: Map<string, FileSlot>;
  if (parent !== null) {
    files = filesAtCommit(repo, parent);
  } else if (branch !== repo.defaultBranch) {
    const defaultTip = branchTip(repo, repo.defaultBranch);
    if (defaultTip !== null) {
      parent = defaultTip;
      files = filesAtCommit(repo, defaultTip);
    } else {
      files = new Map();
    }
  } else {
    files = new Map();
  }
  const created = new Map<string, string>();
  for (const [path, content] of changes) {
    if (content === null) {
      files.delete(path);
    } else {
      const oid = storeObj(repo, 'blob', content);
      const existing = files.get(path);
      files.set(path, { oid, mode: existing?.mode ?? '100644' });
      created.set(path, oid);
    }
  }
  const treeOid = buildTreeFromFiles(repo, files);
  const commitOid = storeObj(repo, 'commit', buildCommitData(treeOid, parent !== null ? [parent] : [], message, nowSec()));
  repo.refs.set(branchRef(branch), commitOid);
  return { commitOid, created };
}

function newIssueRec(repo: RepoRec, title: string, body: string, labels: readonly string[]): IssueRec {
  const issue: IssueRec = {
    id: nextIssueId,
    number: repo.nextIssueNumber,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: nowIso(),
  };
  nextIssueId += 1;
  repo.nextIssueNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

function newPullRec(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
  const pull: PullRec = {
    id: nextPullId,
    number: repo.nextPullNumber,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef,
    baseRef,
    createdAt: nowIso(),
  };
  nextPullId += 1;
  repo.nextPullNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

function findOpenPull(repo: RepoRec, headRef: string, baseRef: string): PullRec | null {
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return pull;
  }
  return null;
}

/**
 * Three-way tree merge of `theirs` into `ours` against their merge base.
 * Returns the merged tree oid, or null when a path changed both ways.
 * Side effect: stores the merged tree objects (harmless when only probing).
 */
function threeWayMergeTrees(repo: RepoRec, baseCommit: string | null, ourCommit: string, theirCommit: string): string | null {
  const baseFiles = baseCommit !== null ? filesAtCommit(repo, baseCommit) : new Map<string, FileSlot>();
  const ourFiles = filesAtCommit(repo, ourCommit);
  const theirFiles = filesAtCommit(repo, theirCommit);
  const paths = new Set<string>([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()]);
  const result = new Map<string, FileSlot>();
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid;
    const o = ourFiles.get(path)?.oid;
    const t = theirFiles.get(path)?.oid;
    let chosen: FileSlot | undefined;
    if (o === t) chosen = ourFiles.get(path) ?? theirFiles.get(path);
    else if (b === o) chosen = theirFiles.get(path);
    else if (b === t) chosen = ourFiles.get(path);
    else return null;
    if (chosen !== undefined) result.set(path, chosen);
  }
  return buildTreeFromFiles(repo, result);
}

type MergeOutcome = { ok: true; sha: string } | { ok: false; reason: string };

/** Merge a pull request into its base branch (squash or merge commit). */
function mergePullRec(repo: RepoRec, pull: PullRec, method: string): MergeOutcome {
  if (pull.merged) return { ok: false, reason: 'already-merged' };
  if (pull.state !== 'open') return { ok: false, reason: 'not-open' };
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return { ok: false, reason: 'missing-branch' };
  const base = mergeBase(repo, baseTip, headTip);
  const mergedTree = threeWayMergeTrees(repo, base, baseTip, headTip);
  if (mergedTree === null) return { ok: false, reason: 'conflict' };
  let sha: string;
  if (method === 'merge') {
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}`;
    sha = storeObj(repo, 'commit', buildCommitData(mergedTree, [baseTip, headTip], message, nowSec()));
  } else {
    const message = pull.body !== '' ? `${pull.title} (#${pull.number})\n\n${pull.body}` : `${pull.title} (#${pull.number})`;
    sha = storeObj(repo, 'commit', buildCommitData(mergedTree, [baseTip], message, nowSec()));
  }
  repo.refs.set(branchRef(pull.baseRef), sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

/** Whether a pull request would merge cleanly right now. */
function pullMergeable(repo: RepoRec, pull: PullRec): boolean {
  if (pull.merged || pull.state !== 'open') return false;
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return false;
  const base = mergeBase(repo, baseTip, headTip);
  return threeWayMergeTrees(repo, base, baseTip, headTip) !== null;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level diff counts via a longest-common-subsequence length. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  let prev = new Uint32Array(b.length + 1);
  let curr = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, curr[j - 1] ?? 0);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
    curr.fill(0);
  }
  const lcs = prev[b.length] ?? 0;
  return { additions: b.length - lcs, deletions: a.length - lcs };
}

interface PullFileEntry {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** The changed-file list of a pull request, diffed against its merge base. */
function pullFiles(repo: RepoRec, pull: PullRec): PullFileEntry[] {
  const baseTip = branchTip(repo, pull.baseRef);
  const headTip = branchTip(repo, pull.headRef);
  if (baseTip === null || headTip === null) return [];
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  const baseFiles = filesAtCommit(repo, base);
  const headFiles = filesAtCommit(repo, headTip);
  const paths = [...new Set([...baseFiles.keys(), ...headFiles.keys()])].sort();
  const out: PullFileEntry[] = [];
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b?.oid === h?.oid) continue;
    const oldText = b ? (repo.objects.get(b.oid)?.data.toString('utf8') ?? '') : '';
    const newText = h ? (repo.objects.get(h.oid)?.data.toString('utf8') ?? '') : '';
    const { additions, deletions } = lineDiff(oldText, newText);
    out.push({
      filename: path,
      status: b === undefined ? 'added' : h === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// pkt-lines (git wire framing)
// ---------------------------------------------------------------------------------------------

function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const hex = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hex, 'ascii'), body]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

type PktEvent = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Read one pkt-line from `buf` at state.pos; null when the buffer is short, throws when malformed. */
function nextPkt(buf: Buffer, state: { pos: number }): PktEvent | null {
  if (state.pos + 4 > buf.length) return null;
  const hex = buf.toString('ascii', state.pos, state.pos + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
  const len = Number.parseInt(hex, 16);
  if (len === 0) {
    state.pos += 4;
    return { kind: 'flush' };
  }
  if (len === 1) {
    state.pos += 4;
    return { kind: 'delim' };
  }
  if (len === 2) {
    state.pos += 4;
    return { kind: 'end' };
  }
  if (len < 4 || state.pos + len > buf.length) throw new Error('pkt-line overruns the body');
  const payload = buf.subarray(state.pos + 4, state.pos + len);
  state.pos += len;
  return { kind: 'data', payload };
}

/** Frame bytes as sideband packets on one band (payload per packet stays under the 65520 cap). */
function sidebandPackets(data: Buffer, band: number): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65_515;
  for (let off = 0; off < data.length; off += CHUNK) {
    const slice = data.subarray(off, Math.min(data.length, off + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([band])));
  return packets;
}

// ---------------------------------------------------------------------------------------------
// HTTP plumbing and JSON shapes
// ---------------------------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendApiError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body: an empty body is {}, a malformed one is a 400 in the making. */
function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  const text = raw.toString('utf8');
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** The bearer-token check every surface shares; no header at all is always a refusal. */
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  if (expected === '') return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
  return header === `Bearer ${expected}`;
}

/** Opaque, stable Relay-style global ids (never the bare database id). */
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

function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', String(repo.id)),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: new Date(1_767_225_600_000 + repo.createdSeq * 1000).toISOString(),
    updated_at: new Date(1_767_225_600_000 + repo.createdSeq * 1000).toISOString(),
    pushed_at: new Date(1_767_225_600_000 + repo.createdSeq * 1000).toISOString(),
  };
}

function labelJson(label: LabelRec): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ededed', description: null, default: false };
    }),
    comments: issue.comments.length,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
  };
}

function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    head: { ref: pull.headRef, sha: headTip ?? ZERO_OID, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseTip ?? ZERO_OID, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
  };
}

// ---------------------------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------------------------

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The base a contents write reads from: the branch tip, else (for a new branch) the default tip. */
function baseState(repo: RepoRec, branch: string): { tip: string | null; files: Map<string, FileSlot> } {
  const tip = branchTip(repo, branch);
  if (tip !== null) return { tip, files: filesAtCommit(repo, tip) };
  if (branch !== repo.defaultBranch) {
    const defaultTip = branchTip(repo, repo.defaultBranch);
    if (defaultTip !== null) return { tip: defaultTip, files: filesAtCommit(repo, defaultTip) };
  }
  return { tip: null, files: new Map() };
}

type TreeWalk = { kind: 'tree'; oid: string } | { kind: 'blob'; oid: string; mode: string } | null;

/** Walk a tree by path segments. */
function walkTree(repo: RepoRec, treeOid: string, segments: readonly string[]): TreeWalk {
  let current: TreeWalk = { kind: 'tree', oid: treeOid };
  for (const segment of segments) {
    if (current === null || current.kind !== 'tree') return null;
    const obj = repo.objects.get(current.oid);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((candidate) => candidate.name === segment);
    if (!entry) return null;
    current = isDirMode(entry.mode) ? { kind: 'tree', oid: entry.oid } : { kind: 'blob', oid: entry.oid, mode: entry.mode };
  }
  return current;
}

function identJson(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(ident);
  if (!match) return { name: ident, email: '', date: new Date(0).toISOString() };
  return { name: match[1] ?? '', email: match[2] ?? '', date: new Date(Number(match[3]) * 1000).toISOString() };
}

function pageParams(url: URL): { page: number; perPage: number } {
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  return {
    perPage: Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30,
    page: Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1,
  };
}

function pageSlice<T>(items: readonly T[], url: URL): T[] {
  const { page, perPage } = pageParams(url);
  return items.slice((page - 1) * perPage, page * perPage);
}

/** Route one /api/v3 request. Auth has already been enforced by the caller. */
async function routeRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const rest = url.pathname.slice('/api/v3'.length);
  const segments = rest.split('/').filter((segment) => segment !== '').map(decodeSegment);
  const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  let body: Record<string, unknown> = {};
  if (rawBody.length > 0) {
    const parsed = parseJsonBody(rawBody);
    if (!parsed.ok) {
      sendApiError(res, 400, 'Problems parsing JSON');
      return;
    }
    if (isRecord(parsed.value)) body = parsed.value;
  }
  const notFound = (): void => sendApiError(res, 404, 'Not Found');

  // The API root and meta.
  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', user_repositories_url: '/api/v3/user/repos', repository_url: '/api/v3/repos/{owner}/{repo}' },
      { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo, read:org' },
    );
    return;
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return notFound();
    sendJson(res, 200, { verifiable_password_authentication: false, installed_version: `forge-${FORGE_VERSION}` });
    return;
  }
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return notFound();
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return;
  }

  // Repository creation and the owner's list.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
        sendApiError(res, 422, 'name is invalid');
        return;
      }
      if (reposByKey.has(repoKey(VIEWER.login, name))) {
        sendApiError(res, 422, 'name already exists on this account');
        return;
      }
      const repo = createRepoRec(name, typeof body.description === 'string' ? body.description : '', typeof body.private === 'boolean' ? body.private : false);
      if (body.auto_init === true) {
        commitFiles(repo, repo.defaultBranch, new Map([['README.md', Buffer.from(`# ${name}\n`, 'utf8')]]), 'Initial commit');
      }
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const all = [...reposByKey.values()].filter((repo) => repo.owner === VIEWER.login).sort((a, b) => a.createdSeq - b.createdSeq);
      const { page, perPage } = pageParams(url);
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const items = all.slice((page - 1) * perPage, page * perPage).map(repoJson);
      const headers: Record<string, string> = {};
      if (page < totalPages) {
        const base = `http://${req.headers.host ?? 'localhost'}${url.pathname}`;
        const next = new URLSearchParams(url.searchParams);
        next.set('page', String(page + 1));
        next.set('per_page', String(perPage));
        const last = new URLSearchParams(url.searchParams);
        last.set('page', String(totalPages));
        last.set('per_page', String(perPage));
        headers.link = `<${base}?${next.toString()}>; rel="next", <${base}?${last.toString()}>; rel="last"`;
      }
      sendJson(res, 200, items, headers);
      return;
    }
    return notFound();
  }

  if (segments.length < 3 || segments[0] !== 'repos') return notFound();
  const owner = segments[1] as string;
  const repoName = segments[2] as string;
  const tail = segments.slice(3);
  const repo = findRepo(owner, repoName);
  if (repo === null) return notFound();
  const repoBase = `/api/v3/repos/${owner}/${repoName}`;

  // The repository itself.
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      deleteRepoRec(repo);
      res.writeHead(204, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    return notFound();
  }

  // Contents.
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') {
      const refish = url.searchParams.get('ref') ?? repo.defaultBranch;
      const commitOid = resolveRefish(repo, refish);
      if (commitOid === null) return notFound();
      const commit = peelToCommit(repo, commitOid);
      if (commit === null) return notFound();
      const tree = treeOfCommit(repo, commit);
      if (tree === null) return notFound();
      const found = walkTree(repo, tree, path === '' ? [] : path.split('/'));
      if (found === null) return notFound();
      if (found.kind === 'blob') {
        const blob = repo.objects.get(found.oid);
        if (!blob) return notFound();
        sendJson(res, 200, {
          type: 'file',
          name: path.split('/').pop() ?? path,
          path,
          sha: found.oid,
          size: blob.data.length,
          encoding: 'base64',
          content: blob.data.toString('base64'),
        });
        return;
      }
      const treeObj = repo.objects.get(found.oid);
      if (!treeObj || treeObj.type !== 'tree') return notFound();
      const entries = parseTree(treeObj.data).map((entry) => {
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
        const child = repo.objects.get(entry.oid);
        return {
          type: isDirMode(entry.mode) ? 'dir' : 'file',
          name: entry.name,
          path: childPath,
          sha: entry.oid,
          size: isDirMode(entry.mode) ? 0 : (child?.data.length ?? 0),
        };
      });
      sendJson(res, 200, entries);
      return;
    }
    if (method === 'PUT') {
      const message = typeof body.message === 'string' ? body.message : null;
      if (message === null) {
        sendApiError(res, 422, 'message is required');
        return;
      }
      if (typeof body.content !== 'string') {
        sendApiError(res, 422, 'content is required');
        return;
      }
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : (url.searchParams.get('branch') ?? repo.defaultBranch);
      const state = baseState(repo, branch);
      const existing = state.files.get(path);
      if (existing !== undefined) {
        if (typeof body.sha !== 'string') {
          sendApiError(res, 422, 'sha is required when updating a file');
          return;
        }
        if (body.sha !== existing.oid) {
          sendApiError(res, 409, `${path} has changed since it was read`);
          return;
        }
      }
      const content = b64decodeBuffer(body.content);
      const { commitOid, created } = commitFiles(repo, branch, new Map([[path, content]]), message);
      const blobOid = created.get(path) as string;
      sendJson(res, existing !== undefined ? 200 : 201, {
        content: {
          type: 'file',
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: content.length,
          encoding: 'base64',
          content: content.toString('base64'),
        },
        commit: { sha: commitOid, message },
      });
      return;
    }
    if (method === 'DELETE') {
      const message = typeof body.message === 'string' ? body.message : null;
      if (message === null) {
        sendApiError(res, 422, 'message is required');
        return;
      }
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : (url.searchParams.get('branch') ?? repo.defaultBranch);
      const state = baseState(repo, branch);
      const existing = state.files.get(path);
      if (existing === undefined) return notFound();
      if (typeof body.sha === 'string' && body.sha !== existing.oid) {
        sendApiError(res, 409, `${path} has changed since it was read`);
        return;
      }
      const { commitOid } = commitFiles(repo, branch, new Map([[path, null]]), message);
      sendJson(res, 200, { content: null, commit: { sha: commitOid, message } });
      return;
    }
    return notFound();
  }

  // Commit list.
  if (tail.length === 1 && tail[0] === 'commits' && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    let tip: string | null;
    if (shaParam !== null && shaParam !== '') {
      const resolved = resolveRefish(repo, shaParam);
      if (resolved === null) return notFound();
      tip = peelToCommit(repo, resolved);
    } else {
      tip = branchTip(repo, repo.defaultBranch);
    }
    if (tip === null) {
      sendJson(res, 200, []);
      return;
    }
    const distances = commitDistances(repo, tip);
    const commits = [...distances.entries()]
      .map(([oid, distance]) => {
        const obj = repo.objects.get(oid);
        const info = obj && obj.type === 'commit' ? parseCommit(obj.data) : null;
        return { oid, distance, info };
      })
      .filter((entry) => entry.info !== null)
      .sort((a, b) => (b.info?.time ?? 0) - (a.info?.time ?? 0) || a.distance - b.distance);
    const items = pageSlice(commits, url).map(({ oid, info }) => ({
      sha: oid,
      commit: {
        message: info?.message ?? '',
        author: identJson(info?.author ?? ''),
        committer: identJson(info?.committer ?? ''),
        tree: { sha: info?.tree ?? '' },
      },
      parents: (info?.parents ?? []).map((parent) => ({ sha: parent })),
    }));
    sendJson(res, 200, items);
    return;
  }

  // Branches.
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      sendJson(res, 200, branches);
      return;
    }
    if (tail.length >= 2 && method === 'GET') {
      const branch = tail.slice(1).join('/');
      const tip = branchTip(repo, branch);
      if (tip === null) return notFound();
      sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
      return;
    }
    return notFound();
  }

  // Git Data refs.
  if (tail[0] === 'git' && (tail[1] === 'refs' || tail[1] === 'ref')) {
    if (tail.length === 2 && tail[1] === 'refs') {
      if (method === 'GET') {
        const refs = [...repo.refs.entries()].map(([ref, oid]) => ({
          ref,
          object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' },
        }));
        sendJson(res, 200, refs);
        return;
      }
      if (method === 'POST') {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
          sendApiError(res, 422, 'invalid ref or sha');
          return;
        }
        if (repo.refs.has(ref)) {
          sendApiError(res, 422, 'Reference already exists');
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
        return;
      }
      return notFound();
    }
    if (tail.length >= 3) {
      const ref = `refs/${tail.slice(2).join('/')}`;
      if (method === 'GET') {
        const oid = repo.refs.get(ref);
        if (oid === undefined) return notFound();
        sendJson(res, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' } });
        return;
      }
      if (method === 'DELETE') {
        if (!repo.refs.delete(ref)) return notFound();
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      return notFound();
    }
    return notFound();
  }

  // Labels.
  if (tail[0] === 'labels') {
    if (tail.length === 1) {
      if (method === 'GET') {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson));
        return;
      }
      if (method === 'POST') {
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') {
          sendApiError(res, 422, 'name is required');
          return;
        }
        if (repo.labels.has(name)) {
          sendApiError(res, 422, 'Label already exists');
          return;
        }
        const label: LabelRec = {
          name,
          color: typeof body.color === 'string' ? body.color : 'ededed',
          description: typeof body.description === 'string' ? body.description : null,
        };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label));
        return;
      }
      return notFound();
    }
    if (tail.length === 2) {
      const label = repo.labels.get(tail[1] as string);
      if (!label) return notFound();
      if (method === 'GET') {
        sendJson(res, 200, labelJson(label));
        return;
      }
      if (method === 'DELETE') {
        repo.labels.delete(label.name);
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      return notFound();
    }
    return notFound();
  }

  // Issues and comments.
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') {
          sendApiError(res, 422, 'title is required');
          return;
        }
        const labelNames: string[] = [];
        if (Array.isArray(body.labels)) {
          for (const entry of body.labels) {
            const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : null;
            if (name === null) continue;
            if (!repo.labels.has(name)) {
              sendApiError(res, 422, `Label '${name}' does not exist`);
              return;
            }
            labelNames.push(name);
          }
        }
        const issue = newIssueRec(repo, title, typeof body.body === 'string' ? body.body : '', labelNames);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        const direction = url.searchParams.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        sendJson(res, 200, pageSlice(issues, url).map((issue) => issueJson(repo, issue)));
        return;
      }
      return notFound();
    }
    const number = Number.parseInt(tail[1] ?? '', 10);
    const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
    if (tail.length === 2) {
      if (issue === undefined) return notFound();
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      if (method === 'PATCH') {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (Array.isArray(body.labels)) {
          const names: string[] = [];
          for (const entry of body.labels) {
            const name = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.name === 'string' ? entry.name : null;
            if (name === null) continue;
            if (!repo.labels.has(name)) {
              sendApiError(res, 422, `Label '${name}' does not exist`);
              return;
            }
            names.push(name);
          }
          issue.labels = names;
        }
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      return notFound();
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (issue === undefined) return notFound();
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map(commentJson));
        return;
      }
      if (method === 'POST') {
        const text = typeof body.body === 'string' ? body.body : '';
        if (text === '') {
          sendApiError(res, 422, 'body is required');
          return;
        }
        const comment: CommentRec = { id: nextCommentId, body: text, createdAt: nowIso() };
        nextCommentId += 1;
        issue.comments.push(comment);
        sendJson(res, 201, commentJson(comment));
        return;
      }
      return notFound();
    }
    return notFound();
  }

  // Pull requests.
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        let head = typeof body.head === 'string' ? body.head : '';
        let base = typeof body.base === 'string' ? body.base : '';
        if (head.includes(':')) head = head.split(':').pop() as string;
        if (base.includes(':')) base = base.split(':').pop() as string;
        if (title === '' || head === '' || base === '') {
          sendApiError(res, 422, 'title, head and base are required');
          return;
        }
        if (branchTip(repo, base) === null) {
          sendApiError(res, 422, `base branch '${base}' does not exist`);
          return;
        }
        if (branchTip(repo, head) === null) {
          sendApiError(res, 422, `head branch '${head}' does not exist`);
          return;
        }
        if (findOpenPull(repo, head, base) !== null) {
          sendApiError(res, 422, `A pull request already exists for ${head} into ${base}`);
          return;
        }
        const pull = newPullRec(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
        sendJson(res, 201, pullJson(repo, pull));
        return;
      }
      if (method === 'GET') {
        const state = url.searchParams.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls.sort((a, b) => b.number - a.number);
        sendJson(res, 200, pageSlice(pulls, url).map((pull) => pullJson(repo, pull)));
        return;
      }
      return notFound();
    }
    const number = Number.parseInt(tail[1] ?? '', 10);
    const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
    if (tail.length === 2) {
      if (pull === undefined) return notFound();
      if (method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      if (method === 'PATCH') {
        if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
        if (typeof body.title === 'string') pull.title = body.title;
        if (typeof body.body === 'string') pull.body = body.body;
        sendJson(res, 200, pullJson(repo, pull));
        return;
      }
      return notFound();
    }
    if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
      if (pull === undefined) return notFound();
      sendJson(res, 200, pullFiles(repo, pull));
      return;
    }
    if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return notFound();
      const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
      const outcome = mergePullRec(repo, pull, mergeMethod);
      if (!outcome.ok) {
        sendApiError(res, 405, outcome.reason === 'conflict' ? 'Pull Request is not mergeable' : `Pull Request is not mergeable (${outcome.reason})`);
        return;
      }
      sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    return notFound();
  }

  return notFound();
}

// ---------------------------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = 'multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

function wantsV2(req: IncomingMessage): boolean {
  const header = req.headers['git-protocol'];
  if (typeof header !== 'string') return false;
  return header.split(':').some((part) => part.trim() === 'version=2');
}

/** The refs a v0 advertisement lists: HEAD first, then every ref in name order, tags peeled. */
function v0Advertisement(repo: RepoRec, service: string): Buffer {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS_V0 : `${UPLOAD_CAPS_V0} symref=HEAD:${branchRef(repo.defaultBranch)}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines: Array<{ oid: string; name: string; peeled?: string }> = [];
  const headTip = branchTip(repo, repo.defaultBranch);
  if (headTip !== null) lines.push({ oid: headTip, name: 'HEAD' });
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    const obj = repo.objects.get(oid);
    const peeled = obj?.type === 'tag' ? peelToCommit(repo, oid) : null;
    lines.push({ oid, name, peeled: peeled !== null && peeled !== oid ? peeled : undefined });
  }
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    lines.forEach((line, index) => {
      parts.push(pktLine(index === 0 ? `${line.oid} ${line.name}\0${caps}` : `${line.oid} ${line.name}`));
      if (line.peeled !== undefined) parts.push(pktLine(`${line.peeled} ${line.name}^{}`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

interface FetchSelection {
  objects: GitObj[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/** The object selection a fetch answers: closure of the wants, minus what the client holds, cut at the depth. */
function selectFetch(repo: RepoRec, args: FetchArgs): FetchSelection {
  const shallowSet = new Set(args.shallow);
  const excluded = new Set<string>();
  const shallowExcluded = new Set<string>();
  for (const have of args.haves) {
    if (!repo.objects.has(have)) continue;
    if (shallowSet.has(have)) shallowExcluded.add(have);
    else for (const oid of reachableObjects(repo, [have])) excluded.add(oid);
  }
  for (const ref of args.deepenNot) {
    const tip = resolveRefish(repo, ref);
    if (tip !== null) for (const oid of reachableObjects(repo, [tip])) excluded.add(oid);
  }
  const depthLimit = args.deepen ?? Number.POSITIVE_INFINITY;
  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const want of args.wants) {
    const commit = peelToCommit(repo, want);
    if (commit !== null && !dist.has(commit)) {
      dist.set(commit, 0);
      queue.push(commit);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head] as string;
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'commit') continue;
    const next = (dist.get(current) ?? 0) + 1;
    if (next >= depthLimit) continue; // deeper commits can never be included
    for (const parent of parseCommit(obj.data).parents) {
      if (!dist.has(parent) && repo.objects.get(parent)?.type === 'commit') {
        dist.set(parent, next);
        queue.push(parent);
      }
    }
  }
  const includedCommits = new Set<string>();
  for (const [oid, distance] of dist) {
    if (excluded.has(oid) || shallowExcluded.has(oid)) continue;
    if (distance >= depthLimit) continue;
    if (args.deepenSince !== null) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit' || parseCommit(obj.data).time < args.deepenSince) continue;
    }
    includedCommits.add(oid);
  }
  const objectIds = new Set<string>();
  for (const want of args.wants) {
    if (repo.objects.get(want)?.type === 'tag') objectIds.add(want);
  }
  for (const oid of includedCommits) {
    objectIds.add(oid);
    const tree = treeOfCommit(repo, oid);
    if (tree !== null) for (const inner of reachableObjects(repo, [tree])) objectIds.add(inner);
  }
  for (const oid of excluded) objectIds.delete(oid);
  const typeOrder: Record<ObjType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  const objects = [...objectIds]
    .map((oid) => repo.objects.get(oid))
    .filter((obj): obj is GitObj => obj !== undefined)
    .sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (args.deepen !== null || args.shallow.length > 0 || args.deepenSince !== null) {
    for (const oid of includedCommits) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const boundary = parseCommit(obj.data).parents.some(
        (parent) => !includedCommits.has(parent) && !shallowSet.has(parent) && !excluded.has(parent) && repo.objects.has(parent),
      );
      if (boundary) shallow.push(oid);
    }
    for (const oid of shallowSet) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length > 0 && parents.every((parent) => includedCommits.has(parent) || excluded.has(parent))) unshallow.push(oid);
    }
  }
  const acks = args.haves.filter((have) => repo.objects.get(have)?.type === 'commit');
  return { objects, shallow, unshallow, acks, nak: acks.length === 0 };
}

/** Parse a v2 command request body into capability lines and argument lines. */
function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const state = { pos: 0 };
  let command = '';
  const args: string[] = [];
  let phase: 'command' | 'args' = 'command';
  for (;;) {
    const event = nextPkt(body, state);
    if (event === null || event.kind === 'flush' || event.kind === 'end') break;
    if (event.kind === 'delim') {
      phase = 'args';
      continue;
    }
    const line = event.payload.toString('utf8').replace(/\n$/, '');
    if (phase === 'command') {
      if (line.startsWith('command=')) command = line.slice('command='.length);
    } else {
      args.push(line);
    }
  }
  return { command, args };
}

function lsRefsV2(repo: RepoRec, args: readonly string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTip = branchTip(repo, repo.defaultBranch);
  if (matches('HEAD')) {
    if (headTip !== null) {
      parts.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${branchRef(repo.defaultBranch)}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${branchRef(repo.defaultBranch)}` : ''}\n`));
    }
  }
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [name, oid] of refs) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') {
        const target = peelToCommit(repo, oid);
        if (target !== null) line += ` peeled:${target}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV2(repo: RepoRec, args: readonly string[]): Buffer {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [] };
  for (const arg of args) {
    if (arg.startsWith('want ')) parsed.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) parsed.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) parsed.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) parsed.deepen = Number.parseInt(arg.slice(7), 10);
    else if (arg.startsWith('deepen-since ')) parsed.deepenSince = Number.parseInt(arg.slice(13), 10);
    else if (arg.startsWith('deepen-not ')) parsed.deepenNot.push(arg.slice(11).trim());
    else if (arg.startsWith('want-ref ')) {
      const resolved = resolveRefish(repo, arg.slice(9).trim());
      if (resolved !== null) parsed.wants.push(resolved);
    }
  }
  const selection = selectFetch(repo, parsed);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  if (selection.nak) parts.push(pktLine('NAK\n'));
  else for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(PKT_DELIM);
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack, 1));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: RepoRec, body: Buffer): Buffer {
  const parsed: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [] };
  const state = { pos: 0 };
  for (;;) {
    const event = nextPkt(body, state);
    if (event === null || event.kind === 'end') break;
    if (event.kind !== 'data') continue;
    const line = event.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) parsed.wants.push(line.slice(5, 45));
    else if (line.startsWith('have ')) parsed.haves.push(line.slice(5, 45));
    else if (line.startsWith('shallow ')) parsed.shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) parsed.deepen = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) parsed.deepenSince = Number.parseInt(line.slice(13), 10);
    else if (line.startsWith('deepen-not ')) parsed.deepenNot.push(line.slice(11).trim());
  }
  const selection = selectFetch(repo, parsed);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (selection.nak) parts.push(pktLine('NAK\n'));
  else for (const ack of selection.acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(...sidebandPackets(pack, 1));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface PushCommandRec {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: RepoRec, body: Buffer): Buffer {
  const state = { pos: 0 };
  const commands: PushCommandRec[] = [];
  let clientCaps = '';
  let first = true;
  for (;;) {
    const event = nextPkt(body, state);
    if (event === null || event.kind === 'flush' || event.kind === 'end') break;
    if (event.kind !== 'data') continue;
    let line = event.payload.toString('utf8').replace(/\n$/, '');
    if (first) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        clientCaps = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
      first = false;
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
    if (!match) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(state.pos);
  if (packBytes.length > 0) {
    if (packBytes.toString('ascii', 0, 4) === 'PACK') {
      try {
        const objects = readPack(repo, Buffer.from(packBytes));
        for (const obj of objects) {
          if (!repo.objects.has(obj.oid)) repo.objects.set(obj.oid, { type: obj.type, data: obj.data });
        }
      } catch (error) {
        unpackOk = false;
        unpackDetail = `error ${error instanceof Error ? error.message : String(error)}`;
      }
    } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
      unpackOk = false;
      unpackDetail = 'error not a pack';
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (command.ref === branchRef(repo.defaultBranch) && repo.refs.has(command.ref)) {
        results.push({ ref: command.ref, ok: false, reason: 'deletion of the current branch prohibited' });
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && command.oldOid !== ZERO_OID) {
      const newCommit = peelToCommit(repo, command.newOid);
      if (newCommit === null || !isAncestor(repo, command.oldOid, newCommit)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  const reportParts: Buffer[] = [pktLine(`unpack ${unpackDetail}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  if (clientCaps.split(' ').includes('side-band-64k')) {
    return Buffer.concat([...sidebandPackets(report, 1), PKT_FLUSH]);
  }
  return report;
}

/** Route one git smart-HTTP request. Auth has already been enforced by the caller. */
async function routeGit(req: IncomingMessage, res: ServerResponse, url: URL, owner: string, name: string, action: string): Promise<void> {
  const repo = findRepo(owner, name);
  if (action === 'info/refs') {
    const service = url.searchParams.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('unknown service');
      return;
    }
    if (repo === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('repository not found');
      return;
    }
    const body = service === 'git-receive-pack' ? v0Advertisement(repo, service) : wantsV2(req) ? v2Advertisement() : v0Advertisement(repo, service);
    res.writeHead(200, {
      'content-type': `application/x-${service}-advertisement`,
      'content-length': body.length,
      'cache-control': 'no-cache, max-age=0, must-revalidate',
    });
    res.end(body);
    return;
  }
  if (repo === null) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('repository not found');
    return;
  }
  const body = await readBody(req);
  try {
    if (action === 'git-upload-pack') {
      const isV2 = wantsV2(req);
      let answer: Buffer;
      if (isV2) {
        const { command, args } = parseV2Request(body);
        if (command === 'ls-refs') answer = lsRefsV2(repo, args);
        else if (command === 'fetch') answer = fetchV2(repo, args);
        else {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(`unknown command ${command}`);
          return;
        }
      } else {
        answer = fetchV0(repo, body);
      }
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': answer.length });
      res.end(answer);
      return;
    }
    const answer = receivePack(repo, body);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': answer.length });
    res.end(answer);
  } catch {
    // A malformed request body must never take the server down.
    if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
  }
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4: a small executor for the documents gh and github-mcp-server send
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlFieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selectionSet: GqlSelection[] | null;
}

type GqlSelection =
  | { kind: 'field'; field: GqlFieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: GqlSelection[] }
  | { kind: 'fragmentSpread'; name: string };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: GqlSelection[] }>;
}

interface GqlToken {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'spread' | 'eof';
  value: string;
}

function gqlTokenize(input: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\uFEFF') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        const text = end === -1 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text });
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') j += 1;
        j += 1;
      }
      const raw = input.slice(i, j + 1);
      tokens.push({ kind: 'string', value: JSON.parse(raw) as string });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(input.slice(i));
      if (!match) throw new Error('bad number');
      const text = match[0];
      tokens.push({ kind: text.includes('.') || /[eE]/.test(text) ? 'float' : 'int', value: text });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      const match = /^[_0-9A-Za-z]+/.exec(input.slice(i));
      tokens.push({ kind: 'name', value: (match as RegExpExecArray)[0] });
      i += (match as RegExpExecArray)[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class GqlParser {
  private tokens: GqlToken[];
  private pos: number;

  constructor(input: string) {
    this.tokens = gqlTokenize(input);
    this.pos = 0;
  }

  private peek(): GqlToken {
    return this.tokens[this.pos] as GqlToken;
  }

  private next(): GqlToken {
    const token = this.tokens[this.pos] as GqlToken;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private parseType(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.next();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      return { kind: 'variable', name: name.value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!this.atPunct('}')) {
        const name = this.next();
        this.expectPunct(':');
        fields.push({ name: name.value, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }

  private parseArguments(): Array<{ name: string; value: GqlValue }> {
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (!this.atPunct('(')) return args;
    this.next();
    while (!this.atPunct(')')) {
      const name = this.next();
      this.expectPunct(':');
      args.push({ name: name.value, value: this.parseValue() });
    }
    this.next();
    return args;
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.next();
      this.parseArguments();
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        const head = this.peek();
        if (head.kind === 'name' && head.value === 'on') {
          this.next();
          const type = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition: type.value, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.next();
          selections.push({ kind: 'fragmentSpread', name: name.value });
        }
        continue;
      }
      let name = this.next();
      if (name.kind !== 'name') throw new Error(`expected a field name, got ${name.value}`);
      let alias: string | null = null;
      if (this.atPunct(':')) {
        this.next();
        alias = name.value;
        name = this.next();
      }
      const args = this.parseArguments();
      this.skipDirectives();
      const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', field: { alias, name: name.value, args, selectionSet } });
    }
    this.next();
    return selections;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: GqlSelection[] }>();
    while (this.peek().kind !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.next();
      if (keyword.kind === 'name' && (keyword.value === 'query' || keyword.value === 'mutation')) {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.atPunct('(')) {
          this.next();
          while (!this.atPunct(')')) {
            this.expectPunct('$');
            this.next();
            this.expectPunct(':');
            this.parseType();
            if (this.atPunct('=')) {
              this.next();
              this.parseValue();
            }
            this.skipDirectives();
          }
          this.next();
        }
        this.skipDirectives();
        operations.push({ type: keyword.value, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (keyword.kind === 'name' && keyword.value === 'fragment') {
        const fragName = this.next().value;
        const on = this.next();
        if (on.value !== 'on') throw new Error('expected on in a fragment definition');
        const type = this.next().value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition: type, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected definition ${keyword.value}`);
    }
    return { operations, fragments };
  }
}

function gqlResolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => gqlResolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = gqlResolveValue(field.value, variables);
      return out;
    }
  }
}

interface GqlNode {
  gqlType: string;
  data: unknown;
}

function gqlNode(gqlType: string, data: unknown): GqlNode {
  return { gqlType, data };
}

function isGqlNode(value: unknown): value is GqlNode {
  return isRecord(value) && typeof value.gqlType === 'string' && 'data' in value;
}

const GQL_TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['id', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'isPrivate', 'description', 'url',
  ],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'labels', 'comments', 'author', 'repository', 'createdAt', 'updatedAt'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit',
  ],
  Ref: ['name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const GQL_TYPE_ENUMS: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  Permission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
};

interface GqlExec {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selectionSet: GqlSelection[] }>;
  errors: Array<{ message: string }>;
}

function issueGqlNode(repo: RepoRec, issue: IssueRec): GqlNode {
  return gqlNode('Issue', { repo, issue });
}

function pullGqlNode(repo: RepoRec, pull: PullRec): GqlNode {
  return gqlNode('PullRequest', { repo, pull });
}

function issueCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeIssueCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1] as string, 10) : null;
  } catch {
    return null;
  }
}

function nodeByGlobalId(id: string): GqlNode | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = reposById.get(Number.parseInt(decoded.key, 10));
    return repo ? gqlNode('Repository', repo) : null;
  }
  if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
    const [repoId, number] = decoded.key.split(':').map((part) => Number.parseInt(part, 10));
    const repo = repoId !== undefined ? reposById.get(repoId) : undefined;
    if (!repo || number === undefined) return null;
    if (decoded.type === 'Issue') {
      const issue = repo.issues.get(number);
      return issue ? issueGqlNode(repo, issue) : null;
    }
    const pull = repo.pulls.get(number);
    return pull ? pullGqlNode(repo, pull) : null;
  }
  if (decoded.type === 'User') return gqlNode('User', VIEWER);
  return null;
}

function gqlResolveField(exec: GqlExec, typeName: string, source: GqlNode | null, name: string, args: Record<string, unknown>): { found: boolean; value: unknown } {
  const ok = (value: unknown): { found: boolean; value: unknown } => ({ found: true, value });
  const data = source?.data;
  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') return ok(gqlNode('User', VIEWER));
      if (name === 'repository') {
        const repo = findRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return ok(repo ? gqlNode('Repository', repo) : null);
      }
      if (name === 'node') return ok(typeof args.id === 'string' ? nodeByGlobalId(args.id) : null);
      if (name === '__type') {
        const typeNameArg = String(args.name ?? '');
        if (GQL_TYPE_FIELDS[typeNameArg] !== undefined || GQL_TYPE_ENUMS[typeNameArg] !== undefined) return ok(gqlNode('__Type', { name: typeNameArg }));
        return ok(null);
      }
      if (name === '__schema') return ok(gqlNode('__Schema', {}));
      break;
    }
    case 'Mutation': {
      const input = isRecord(args.input) ? args.input : {};
      if (name === 'createIssue') {
        const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = decoded?.type === 'Repository' ? reposById.get(Number.parseInt(decoded.key, 10)) : undefined;
        if (!repo) {
          exec.errors.push({ message: 'repository not found for createIssue' });
          return ok(null);
        }
        const issue = newIssueRec(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
        return ok(gqlNode('CreateIssuePayload', { issue: issueGqlNode(repo, issue) }));
      }
      if (name === 'closeIssue') {
        const target = typeof input.issueId === 'string' ? nodeByGlobalId(input.issueId) : null;
        if (target === null || target.gqlType !== 'Issue') {
          exec.errors.push({ message: 'issue not found for closeIssue' });
          return ok(null);
        }
        const { repo, issue } = target.data as { repo: RepoRec; issue: IssueRec };
        issue.state = 'closed';
        return ok(gqlNode('CloseIssuePayload', { issue: issueGqlNode(repo, issue) }));
      }
      if (name === 'createPullRequest') {
        const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        const repo = decoded?.type === 'Repository' ? reposById.get(Number.parseInt(decoded.key, 10)) : undefined;
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (!repo || branchTip(repo, head) === null || branchTip(repo, base) === null) {
          exec.errors.push({ message: 'repository or branch not found for createPullRequest' });
          return ok(null);
        }
        const existing = findOpenPull(repo, head, base);
        const pull = existing ?? newPullRec(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base);
        return ok(gqlNode('CreatePullRequestPayload', { pullRequest: pullGqlNode(repo, pull) }));
      }
      if (name === 'mergePullRequest') {
        const target = typeof input.pullRequestId === 'string' ? nodeByGlobalId(input.pullRequestId) : null;
        if (target === null || target.gqlType !== 'PullRequest') {
          exec.errors.push({ message: 'pull request not found for mergePullRequest' });
          return ok(null);
        }
        const { repo, pull } = target.data as { repo: RepoRec; pull: PullRec };
        const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
        const outcome = mergePullRec(repo, pull, method === 'merge' ? 'merge' : 'squash');
        if (!outcome.ok && outcome.reason === 'conflict') {
          exec.errors.push({ message: 'Pull Request is not mergeable' });
          return ok(null);
        }
        return ok(gqlNode('MergePullRequestPayload', { pullRequest: pullGqlNode(repo, pull) }));
      }
      if (name === 'addComment') {
        const target = typeof input.subjectId === 'string' ? nodeByGlobalId(input.subjectId) : null;
        if (target === null || target.gqlType !== 'Issue') {
          exec.errors.push({ message: 'subject not found for addComment' });
          return ok(null);
        }
        const { repo, issue } = target.data as { repo: RepoRec; issue: IssueRec };
        const comment: CommentRec = { id: nextCommentId, body: String(input.body ?? ''), createdAt: nowIso() };
        nextCommentId += 1;
        issue.comments.push(comment);
        const commentNode = gqlNode('IssueComment', { repo, issue, comment });
        return ok(gqlNode('AddCommentPayload', { commentEdge: gqlNode('IssueCommentEdge', { node: commentNode }) }));
      }
      break;
    }
    case 'User': {
      const user = data as typeof VIEWER;
      if (name === 'id') return ok(globalId('User', user.login));
      if (name === 'login') return ok(user.login);
      if (name === 'name') return ok(user.name);
      if (name === 'email') return ok(user.email);
      break;
    }
    case 'Repository': {
      const repo = data as RepoRec;
      if (name === 'id') return ok(globalId('Repository', String(repo.id)));
      if (name === 'databaseId') return ok(repo.id);
      if (name === 'name') return ok(repo.name);
      if (name === 'nameWithOwner') return ok(`${repo.owner}/${repo.name}`);
      if (name === 'owner') return ok(gqlNode('User', VIEWER));
      if (name === 'defaultBranchRef') return ok(gqlNode('Ref', { name: repo.defaultBranch }));
      if (name === 'viewerPermission') return ok('ADMIN');
      if (name === 'hasIssuesEnabled') return ok(true);
      if (name === 'isPrivate') return ok(repo.isPrivate);
      if (name === 'description') return ok(repo.description);
      if (name === 'url') return ok(`/${repo.owner}/${repo.name}`);
      if (name === 'issue') {
        const issue = repo.issues.get(typeof args.number === 'number' ? args.number : -1);
        return ok(issue ? issueGqlNode(repo, issue) : null);
      }
      if (name === 'issues') {
        let list = [...repo.issues.values()];
        if (Array.isArray(args.states)) {
          const states = new Set(args.states.map((state) => String(state).toLowerCase()));
          list = list.filter((issue) => states.has(issue.state));
        }
        let descending = false;
        if (isRecord(args.orderBy) && args.orderBy.direction === 'DESC') descending = true;
        list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
        let start = 0;
        if (typeof args.after === 'string' && args.after !== '') {
          const cursorNumber = decodeIssueCursor(args.after);
          const index = cursorNumber === null ? -1 : list.findIndex((issue) => issue.number === cursorNumber);
          if (index >= 0) start = index + 1;
        }
        const first = typeof args.first === 'number' ? Math.max(0, args.first) : list.length;
        const page = list.slice(start, start + first);
        const hasNextPage = start + page.length < list.length;
        const pageInfo = gqlNode('PageInfo', {
          hasNextPage,
          endCursor: page.length > 0 ? issueCursor((page[page.length - 1] as IssueRec).number) : typeof args.after === 'string' ? args.after : '',
        });
        return ok(gqlNode('IssueConnection', { nodes: page.map((issue) => issueGqlNode(repo, issue)), pageInfo, totalCount: list.length }));
      }
      if (name === 'pullRequest') {
        const pull = repo.pulls.get(typeof args.number === 'number' ? args.number : -1);
        return ok(pull ? pullGqlNode(repo, pull) : null);
      }
      if (name === 'pullRequests') {
        let list = [...repo.pulls.values()];
        if (Array.isArray(args.states)) {
          const states = new Set(args.states.map((state) => String(state)));
          list = list.filter((pull) => states.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
        }
        list.sort((a, b) => b.number - a.number);
        const first = typeof args.first === 'number' ? Math.max(0, args.first) : list.length;
        const page = list.slice(0, first);
        const pageInfo = gqlNode('PageInfo', { hasNextPage: page.length < list.length, endCursor: '' });
        return ok(gqlNode('PullRequestConnection', { nodes: page.map((pull) => pullGqlNode(repo, pull)), pageInfo, totalCount: list.length }));
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = data as { repo: RepoRec; issue: IssueRec };
      if (name === 'id') return ok(globalId('Issue', `${repo.id}:${issue.number}`));
      if (name === 'databaseId') return ok(issue.id);
      if (name === 'number') return ok(issue.number);
      if (name === 'title') return ok(issue.title);
      if (name === 'state') return ok(issue.state.toUpperCase());
      if (name === 'body') return ok(issue.body);
      if (name === 'author') return ok(gqlNode('User', VIEWER));
      if (name === 'repository') return ok(gqlNode('Repository', repo));
      if (name === 'createdAt' || name === 'updatedAt') return ok(issue.createdAt);
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = data as { repo: RepoRec; pull: PullRec };
      if (name === 'id') return ok(globalId('PullRequest', `${repo.id}:${pull.number}`));
      if (name === 'databaseId') return ok(pull.id);
      if (name === 'number') return ok(pull.number);
      if (name === 'title') return ok(pull.title);
      if (name === 'body') return ok(pull.body);
      if (name === 'state') return ok(pull.merged ? 'MERGED' : pull.state.toUpperCase());
      if (name === 'merged') return ok(pull.merged);
      if (name === 'mergedAt') return ok(pull.mergedAt);
      if (name === 'mergeable') return ok(pull.merged ? 'MERGEABLE' : pullMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING');
      if (name === 'headRefName') return ok(pull.headRef);
      if (name === 'baseRefName') return ok(pull.baseRef);
      if (name === 'author') return ok(gqlNode('User', VIEWER));
      if (name === 'repository') return ok(gqlNode('Repository', repo));
      if (name === 'createdAt' || name === 'updatedAt') return ok(pull.createdAt);
      if (name === 'files') {
        const files = pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? Math.max(0, args.first) : files.length;
        const nodes = files.slice(0, first).map((file) => gqlNode('PullRequestChangedFile', file));
        return ok(gqlNode('PullRequestChangedFileConnection', { nodes, totalCount: files.length }));
      }
      break;
    }
    case 'Ref': {
      const ref = data as { name: string };
      if (name === 'name') return ok(ref.name);
      if (name === 'prefix') return ok('refs/heads/');
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      const connection = data as { nodes: GqlNode[]; pageInfo: GqlNode; totalCount: number };
      if (name === 'nodes') return ok(connection.nodes);
      if (name === 'pageInfo') return ok(connection.pageInfo);
      if (name === 'totalCount') return ok(connection.totalCount);
      if (name === 'edges') return ok(connection.nodes.map((node) => gqlNode('IssueCommentEdge', { node })));
      break;
    }
    case 'PullRequestChangedFileConnection': {
      const connection = data as { nodes: GqlNode[]; totalCount: number };
      if (name === 'nodes') return ok(connection.nodes);
      if (name === 'totalCount') return ok(connection.totalCount);
      if (name === 'pageInfo') return ok(gqlNode('PageInfo', { hasNextPage: false, endCursor: '' }));
      break;
    }
    case 'PullRequestChangedFile': {
      const file = data as PullFileEntry;
      if (name === 'path') return ok(file.filename);
      if (name === 'additions') return ok(file.additions);
      if (name === 'deletions') return ok(file.deletions);
      break;
    }
    case 'PageInfo': {
      const pageInfo = data as { hasNextPage: boolean; endCursor: string };
      if (name === 'hasNextPage') return ok(pageInfo.hasNextPage);
      if (name === 'hasPreviousPage') return ok(false);
      if (name === 'endCursor') return ok(pageInfo.endCursor);
      if (name === 'startCursor') return ok(pageInfo.endCursor);
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = data as { issue: GqlNode };
      if (name === 'issue') return ok(payload.issue);
      if (name === 'clientMutationId') return ok(null);
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = data as { pullRequest: GqlNode };
      if (name === 'pullRequest') return ok(payload.pullRequest);
      if (name === 'clientMutationId') return ok(null);
      break;
    }
    case 'AddCommentPayload': {
      const payload = data as { commentEdge: GqlNode };
      if (name === 'commentEdge') return ok(payload.commentEdge);
      if (name === 'clientMutationId') return ok(null);
      break;
    }
    case 'IssueCommentEdge': {
      const edge = data as { node: GqlNode };
      if (name === 'node') return ok(edge.node);
      if (name === 'cursor') return ok('');
      break;
    }
    case 'IssueComment': {
      const { comment } = data as { comment: CommentRec };
      if (name === 'id') {
        const full = data as { repo: RepoRec; issue: IssueRec; comment: CommentRec };
        return ok(globalId('IssueComment', `${full.repo.id}:${full.issue.number}:${comment.id}`));
      }
      if (name === 'databaseId') return ok(comment.id);
      if (name === 'body') return ok(comment.body);
      if (name === 'author') return ok(gqlNode('User', VIEWER));
      if (name === 'createdAt') return ok(comment.createdAt);
      break;
    }
    case '__Type': {
      const type = data as { name: string };
      if (name === 'name') return ok(type.name);
      if (name === 'kind') return ok(GQL_TYPE_ENUMS[type.name] !== undefined ? 'ENUM' : 'OBJECT');
      if (name === 'description') return ok(null);
      if (name === 'fields') {
        const fields = GQL_TYPE_FIELDS[type.name];
        return ok(fields ? fields.map((fieldName) => gqlNode('__Field', { name: fieldName })) : null);
      }
      if (name === 'enumValues') {
        const values = GQL_TYPE_ENUMS[type.name];
        return ok(values ? values.map((valueName) => gqlNode('__EnumValue', { name: valueName })) : null);
      }
      if (name === 'possibleTypes') return ok(null);
      break;
    }
    case '__Field':
    case '__EnumValue': {
      const field = data as { name: string };
      if (name === 'name') return ok(field.name);
      if (name === 'description') return ok(null);
      break;
    }
    case '__Schema': {
      if (name === 'queryType') return ok(gqlNode('__Type', { name: 'Query' }));
      if (name === 'mutationType') return ok(gqlNode('__Type', { name: 'Mutation' }));
      if (name === 'types') return ok(Object.keys(GQL_TYPE_FIELDS).map((typeName) => gqlNode('__Type', { name: typeName })));
      break;
    }
    default:
      break;
  }
  return { found: false, value: null };
}

function gqlCompleteValue(exec: GqlExec, value: unknown, field: GqlFieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((entry) => gqlCompleteValue(exec, entry, field));
  if (isGqlNode(value)) {
    if (field.selectionSet === null) return null;
    return gqlExecuteSelectionSet(exec, field.selectionSet, value.gqlType, value);
  }
  return value;
}

function gqlExecuteField(exec: GqlExec, typeName: string, source: GqlNode | null, field: GqlFieldNode): unknown {
  if (field.name === '__typename') return typeName;
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = gqlResolveValue(arg.value, exec.variables);
  const resolved = gqlResolveField(exec, typeName, source, field.name, args);
  if (!resolved.found) {
    exec.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
    return null;
  }
  return gqlCompleteValue(exec, resolved.value, field);
}

function gqlExecuteSelectionSet(exec: GqlExec, selections: readonly GqlSelection[], typeName: string, source: GqlNode | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out[selection.field.alias ?? selection.field.name] = gqlExecuteField(exec, typeName, source, selection.field);
    } else if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, gqlExecuteSelectionSet(exec, selection.selectionSet, typeName, source));
      }
    } else {
      const fragment = exec.fragments.get(selection.name);
      if (fragment && (fragment.typeCondition === null || fragment.typeCondition === typeName)) {
        Object.assign(out, gqlExecuteSelectionSet(exec, fragment.selectionSet, typeName, source));
      }
    }
  }
  return out;
}

function gqlRunOperation(operation: unknown): Record<string, unknown> {
  if (!isRecord(operation) || typeof operation.query !== 'string') {
    return { errors: [{ message: 'a GraphQL operation needs a query string' }] };
  }
  let document: GqlDocument;
  try {
    document = new GqlParser(operation.query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const wanted = typeof operation.operationName === 'string' ? operation.operationName : null;
  const op = (wanted !== null ? document.operations.find((candidate) => candidate.name === wanted) : undefined) ?? document.operations[0];
  if (!op) return { errors: [{ message: 'no operation in the document' }] };
  const exec: GqlExec = {
    variables: isRecord(operation.variables) ? operation.variables : {},
    fragments: document.fragments,
    errors: [],
  };
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
  const data = gqlExecuteSelectionSet(exec, op.selectionSet, rootType, null);
  const result: Record<string, unknown> = { data };
  if (exec.errors.length > 0) result.errors = exec.errors;
  return result;
}

/** Route one /api/graphql request (single or batched). Auth has already been enforced. */
async function routeGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map((operation) => gqlRunOperation(operation)));
    return;
  }
  sendJson(res, 200, gqlRunOperation(parsed.value));
}

// ---------------------------------------------------------------------------------------------
// MCP: JSON-RPC 2.0 over streamable HTTP, modern (server/discover) era
// ---------------------------------------------------------------------------------------------

const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'forge', version: FORGE_VERSION };

interface McpToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

const MCP_TOOL_DEFS: readonly McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'integer', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

/** The tools/list answer: one frozen structure, byte-identical on every call. */
const MCP_TOOLS_LIST: readonly Record<string, unknown>[] = MCP_TOOL_DEFS.map((def) => ({
  name: def.name,
  description: def.description,
  inputSchema: { type: 'object', properties: def.properties, required: def.required },
}));

type McpOutcome = { kind: 'result'; value: unknown } | { kind: 'error'; code: number; message: string } | { kind: 'toolError'; message: string };

function mcpToolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function mcpCallTool(name: string, args: Record<string, unknown>): McpOutcome {
  const def = MCP_TOOL_DEFS.find((candidate) => candidate.name === name);
  if (!def) return { kind: 'error', code: -32602, message: `unknown tool ${name}` };
  for (const required of def.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return { kind: 'error', code: -32602, message: `missing required argument ${required}` };
    }
  }
  const repoOf = (): RepoRec | null => findRepo(String(args.owner ?? ''), String(args.repo ?? ''));
  switch (def.name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (reposByKey.has(repoKey(VIEWER.login, repoName))) return { kind: 'toolError', message: `repository ${repoName} already exists` };
      const repo = createRepoRec(repoName, typeof args.description === 'string' ? args.description : '', typeof args.private === 'boolean' ? args.private : false);
      return { kind: 'result', value: mcpToolResult(repoJson(repo)) };
    }
    case 'get_repo': {
      const repo = repoOf();
      if (repo === null) return { kind: 'toolError', message: 'repository not found' };
      return { kind: 'result', value: mcpToolResult(repoJson(repo)) };
    }
    case 'create_issue': {
      const repo = repoOf();
      if (repo === null) return { kind: 'toolError', message: 'repository not found' };
      const issue = newIssueRec(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return { kind: 'result', value: mcpToolResult(issueJson(repo, issue)) };
    }
    case 'list_issues': {
      const repo = repoOf();
      if (repo === null) return { kind: 'toolError', message: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return { kind: 'result', value: mcpToolResult(issues.map((issue) => issueJson(repo, issue))) };
    }
    case 'create_pull_request': {
      const repo = repoOf();
      if (repo === null) return { kind: 'toolError', message: 'repository not found' };
      let head = String(args.head);
      let base = String(args.base);
      if (head.includes(':')) head = head.split(':').pop() as string;
      if (base.includes(':')) base = base.split(':').pop() as string;
      if (branchTip(repo, head) === null || branchTip(repo, base) === null) return { kind: 'toolError', message: 'head or base branch does not exist' };
      const existing = findOpenPull(repo, head, base);
      const pull = existing ?? newPullRec(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      return { kind: 'result', value: mcpToolResult(pullJson(repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = repoOf();
      if (repo === null) return { kind: 'toolError', message: 'repository not found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number), 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (!pull) return { kind: 'toolError', message: 'pull request not found' };
      const outcome = mergePullRec(repo, pull, 'squash');
      if (!outcome.ok) return { kind: 'toolError', message: `pull request is not mergeable (${outcome.reason})` };
      return { kind: 'result', value: mcpToolResult(pullJson(repo, pull)) };
    }
    default:
      return { kind: 'error', code: -32602, message: `unknown tool ${name}` };
  }
}

/** Handle one JSON-RPC message; null means "no answer" (a notification). */
function mcpHandleMessage(message: unknown): Record<string, unknown> | null {
  if (!isRecord(message) || typeof message.method !== 'string') {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const hasId = 'id' in message && message.id !== undefined;
  const id = hasId ? message.id : null;
  const method = message.method;
  const params = isRecord(message.params) ? message.params : {};
  const respond = (value: unknown): Record<string, unknown> | null => (hasId ? { jsonrpc: '2.0', id, result: value } : null);
  const respondError = (code: number, text: string): Record<string, unknown> | null =>
    hasId ? { jsonrpc: '2.0', id, error: { code, message: text } } : null;
  switch (method) {
    case 'server/discover':
      return respond({
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: MCP_SERVER_INFO,
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = MCP_SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return respond({ protocolVersion, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
    }
    case 'ping':
      return respond({});
    case 'tools/list':
      return respond({ tools: MCP_TOOLS_LIST });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = isRecord(params.arguments) ? params.arguments : {};
      const outcome = mcpCallTool(toolName, toolArgs);
      if (outcome.kind === 'error') return respondError(outcome.code, outcome.message);
      if (outcome.kind === 'toolError') return respond({ content: [{ type: 'text', text: outcome.message }], isError: true });
      return respond(outcome.value);
    }
    default:
      if (method.startsWith('notifications/')) return null;
      return respondError(-32601, `Method not found: ${method}`);
  }
}

/** Route one /mcp request. Auth has already been enforced by the caller. */
async function routeMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } });
    return;
  }
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((message) => mcpHandleMessage(message)).filter((answer) => answer !== null);
    if (answers.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, answers);
    return;
  }
  const answer = mcpHandleMessage(parsed);
  if (answer === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, answer);
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

const GIT_PATH_PATTERN = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendApiError(res, 400, 'Bad Request');
    return;
  }
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const gitMatch = GIT_PATH_PATTERN.exec(path);
  const isRest = path === '/api/v3' || path.startsWith('/api/v3/');
  const isGraphql = path === '/api/graphql';
  const isMcp = path === '/mcp';
  if (!isRest && !isGraphql && !isMcp && gitMatch === null) {
    sendApiError(res, 404, 'Not Found');
    return;
  }
  if (!authorized(req)) {
    sendApiError(res, 401, 'Requires authentication');
    return;
  }
  if (isMcp) {
    await routeMcp(req, res);
    return;
  }
  if (isGraphql) {
    if (method !== 'POST') {
      sendApiError(res, 404, 'Not Found');
      return;
    }
    await routeGraphql(req, res);
    return;
  }
  if (isRest) {
    await routeRest(req, res, url);
    return;
  }
  if (gitMatch !== null) {
    await routeGit(req, res, url, decodeSegment(gitMatch[1] as string), decodeSegment(gitMatch[2] as string), gitMatch[3] as string);
  }
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res).catch(() => {
      try {
        if (!res.headersSent) res.writeHead(500, { 'content-type': JSON_TYPE });
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      } catch {
        // The socket is already gone; nothing left to answer on.
      }
    });
  });
  server.keepAliveTimeout = 30_000;
  return server;
}
