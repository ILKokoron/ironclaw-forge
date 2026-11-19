// Git smart-HTTP service (upload-pack v2/v0 + receive-pack v0). Node stdlib only.
// Deterministic: no wall-clock, no random; pack object order is sorted by oid.
import type { Ctx } from '../app.ts';
import { store, type Repo } from '../store.ts';
import { sendRaw, err, readBody } from '../http.ts';
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const ZERO = '0'.repeat(40);
const HEX4 = /^[0-9a-fA-F]{4}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const TYPE_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PKT_MAX_CHUNK = 65000; // band-1 payload chunk (pkt payload = 1 + chunk <= 65516)

// --------------------------------------------------------------------------- pkt-line
type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' | 'delim' | 'end' };

function pkt(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function parsePackets(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (!HEX4.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) { out.push({ kind: 'flush' }); i += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim' }); i += 4; continue; }
    if (len === 2) { out.push({ kind: 'end' }); i += 4; continue; }
    if (len < 4 || i + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

// --------------------------------------------------------------------------- loose objects
interface GitObj { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer; }

function sha1(buf: Buffer): string { return createHash('sha1').update(buf).digest('hex'); }

function ensureState(repo: Repo): void {
  if (!repo.refs) repo.refs = new Map();
  if (!repo.branches) repo.branches = new Set();
  if (!repo.gitObjects) repo.gitObjects = new Map();
}

function readObj(repo: Repo, oid: string): GitObj | null {
  const raw = repo.gitObjects?.get(oid);
  if (!raw) return null;
  const nul = raw.indexOf(0);
  if (nul < 0) return null;
  const space = raw.indexOf(0x20);
  if (space < 0 || space > nul) return null;
  const type = raw.subarray(0, space).toString('ascii');
  if (!TYPE_CODE[type]) return null;
  return { type: type as GitObj['type'], data: raw.subarray(nul + 1) };
}

function writeObj(repo: Repo, type: string, data: Buffer): string {
  ensureState(repo);
  const raw = Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]);
  const oid = sha1(raw);
  if (!repo.gitObjects.has(oid)) repo.gitObjects.set(oid, raw);
  return oid;
}

// --------------------------------------------------------------------------- object parsers
interface TreeEntry { mode: string; name: string; oid: string; }
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const mode = data.subarray(i, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}
function parseCommit(data: Buffer): { tree: string; parents: string[] } {
  const cut = data.indexOf('\n\n');
  const head = (cut < 0 ? data : data.subarray(0, cut)).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}
function parseTag(data: Buffer): string | null {
  const cut = data.indexOf('\n\n');
  const head = (cut < 0 ? data : data.subarray(0, cut)).toString('utf8');
  for (const line of head.split('\n')) if (line.startsWith('object ')) return line.slice(7).trim();
  return null;
}

// --------------------------------------------------------------------------- reachability
function collect(repo: Repo, roots: Iterable<string>, stopAt?: Set<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const oid = queue.pop()!;
    if (!HEX40.test(oid) || seen.has(oid)) continue;
    const obj = readObj(repo, oid);
    if (!obj) continue;
    seen.add(oid);
    const stop = stopAt ? stopAt.has(oid) : false;
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (c.tree) queue.push(c.tree);
      if (!stop) for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.data);
      if (target) queue.push(target);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue; // gitlink
        queue.push(e.oid);
      }
    }
  }
  return seen;
}

function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  const visited = new Set<string>();
  for (;;) {
    if (visited.has(current)) return null;
    visited.add(current);
    const obj = readObj(repo, current);
    if (!obj) return null;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data);
      if (!target) return null;
      current = target;
      continue;
    }
    return obj.type === 'commit' ? current : null;
  }
}

function headTarget(repo: Repo): string | null {
  const heads = [...repo.refs.keys()].filter((n) => n.startsWith('refs/heads/'));
  if (!heads.length) return null;
  const def = `refs/heads/${repo.default_branch || 'main'}`;
  if (repo.refs.has(def)) return def;
  if (repo.refs.has('refs/heads/main')) return 'refs/heads/main';
  heads.sort();
  return heads[0];
}

// --------------------------------------------------------------------------- pack writing
function packHeader(type: string, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function buildPack(repo: Repo, oids: Set<string>): Buffer {
  const sorted = [...oids].filter((o) => HEX40.test(o)).sort();
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const oid of sorted) {
    const obj = readObj(repo, oid);
    if (!obj) continue;
    parts.push(packHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// --------------------------------------------------------------------------- pack reading (incoming push)
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset);
  const result: any = inflateSync(view, { info: true });
  const data: Buffer = Buffer.isBuffer(result) ? result : result.buffer;
  const written: number = result.engine && result.engine.bytesWritten ? result.engine.bytesWritten : view.length;
  if (!written || written <= 0) throw new Error('inflate consumed no bytes');
  return { data, next: offset + written };
}

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let i = start + 1;
  while (byte & 0x80) {
    if (i >= buf.length) throw new Error('varint truncated');
    byte = buf[i++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('varint too long');
  }
  return { size, next: i, first };
}
function readOfs(buf: Buffer, start: number): { base: number; next: number } {
  let byte = buf[start];
  let i = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (i >= buf.length) throw new Error('ofs truncated');
    byte = buf[i++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { base: value, next: i };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readSize = (): number => {
    let value = 0; let shift = 0;
    for (;;) {
      const byte = delta[i++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0; let size = 0; let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) { if (op & (1 << bit)) off += delta[i++] * 2 ** shift; shift += 8; }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) { if (op & (1 << bit)) size += delta[i++] * 2 ** shift; shift += 8; }
      if (size === 0) size = 0x10000;
      base.copy(out, written, off, off + size);
      written += size;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, i, i + n);
      i += n; written += n;
    } else throw new Error('invalid delta opcode');
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

function ingestPack(repo: Repo, pack: Buffer): void {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const body = pack.subarray(0, trailerStart);
  let offset = 12;
  const raw: any[] = [];
  const byOffset = new Map<number, any>();
  for (let idx = 0; idx < count; idx += 1) {
    const entryOffset = offset;
    const h = readVarint(body, offset);
    offset = h.next;
    const typeCode = (h.first >> 4) & 0x07;
    const e: any = { entryOffset, typeCode, size: h.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const b = readOfs(body, offset);
      offset = b.next;
      e.baseOffset = entryOffset - b.base;
    } else if (typeCode === 7) {
      e.baseOid = body.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error('bad pack type');
    const inf = inflateAt(body, offset);
    if (inf.data.length !== h.size) throw new Error('pack entry size mismatch');
    e.data = inf.data;
    offset = inf.next;
    raw.push(e);
    byOffset.set(entryOffset, e);
  }
  if (offset !== trailerStart) throw new Error('pack trailing bytes');
  const byOid = new Map<string, any>();
  const resolving = new Set<number>();
  const resolve = (e: any): { type: string; data: Buffer; oid: string } => {
    if (e.resolved) return { type: e.resolvedType, data: e.resolved, oid: e.oid };
    if (resolving.has(e.entryOffset)) throw new Error('delta cycle');
    resolving.add(e.entryOffset);
    let type: string; let data: Buffer;
    if (e.typeCode === 6) {
      const baseEntry = byOffset.get(e.baseOffset);
      if (!baseEntry) throw new Error('missing ofs base');
      const base = resolve(baseEntry);
      type = base.type; data = applyDelta(base.data, e.data);
    } else if (e.typeCode === 7) {
      const inPack = byOid.get(e.baseOid);
      if (inPack) {
        const base = resolve(inPack);
        type = base.type; data = applyDelta(base.data, e.data);
      } else {
        const ext = readObj(repo, e.baseOid);
        if (!ext) throw new Error('missing ref base');
        type = ext.type; data = applyDelta(ext.data, e.data);
      }
    } else {
      type = CODE_TYPE[e.typeCode];
      data = e.data;
    }
    e.resolved = data; e.resolvedType = type;
    e.oid = sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
    byOid.set(e.oid, e);
    resolving.delete(e.entryOffset);
    return { type, data, oid: e.oid };
  };
  for (const e of raw) {
    const r = resolve(e);
    writeObj(repo, r.type, r.data);
  }
}

// --------------------------------------------------------------------------- sideband
function sideband(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < pack.length; i += PKT_MAX_CHUNK) {
    const chunk = pack.subarray(i, i + PKT_MAX_CHUNK);
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- advertisement
function advertise(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', v2: boolean): Buffer {
  ensureState(repo);
  if (v2) {
    const caps = ['ls-refs', 'fetch=shallow', 'object-format=sha1', 'agent=forge-git/1.0'];
    return Buffer.concat([pkt('version 2\n'), ...caps.map((c) => pkt(`${c}\n`)), FLUSH]);
  }
  const target = headTarget(repo);
  let caps = service === 'git-receive-pack'
    ? 'report-status side-band-64k delete-refs ofs-delta'
    : 'side-band-64k ofs-delta shallow no-progress';
  if (target) caps += ` symref=HEAD:${target}`;
  caps += ' agent=forge-git/1.0';

  const lines: string[] = [];
  if (target) {
    lines.push(`${repo.refs.get(target) ?? ZERO} HEAD`);
  }
  const names = [...repo.refs.keys()].filter((n) => n.startsWith('refs/')).sort();
  for (const name of names) {
    lines.push(`${repo.refs.get(name)!} ${name}`);
    if (name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo, repo.refs.get(name)!);
      if (peeled && peeled !== repo.refs.get(name)) lines.push(`${peeled} ${name}^{}`);
    }
  }
  if (!lines.length) lines.push(`${ZERO} capabilities^{}`);
  lines[0] += `\0${caps}`;

  const parts = [pkt(`# service=${service}\n`)];
  for (const line of lines) parts.push(pkt(`${line}\n`));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- ls-refs (v2)
function lsRefs(repo: Repo, body: Buffer): Buffer {
  const packets = parsePackets(body);
  let peel = false; let symrefs = false; let afterDelim = false;
  const prefixes: string[] = [];
  for (const p of packets) {
    if (p.kind === 'delim') { afterDelim = true; continue; }
    if (p.kind === 'flush' || p.kind === 'end') continue;
    if (!afterDelim) continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string) => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const target = headTarget(repo);
  if (target && keep('HEAD')) {
    const oid = repo.refs.get(target) ?? ZERO;
    lines.push(`${oid} HEAD${symrefs ? ` symref-target:${target}` : ''}`);
  }
  const names = [...repo.refs.keys()].filter((n) => n.startsWith('refs/')).filter(keep).sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    let line = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const peeled = peelToCommit(repo, oid);
      if (peeled && peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((l) => pkt(`${l}\n`)), FLUSH]);
}

// --------------------------------------------------------------------------- fetch
function collectDepth(
  repo: Repo,
  wants: string[],
  depth: number,
  clientShallow: Set<string>,
): { include: Set<string>; shallow: string[]; unshallow: string[] } {
  const include = new Set<string>();
  const shallow: string[] = [];
  const unshallow: string[] = [];
  const minLevel = new Map<string, number>();
  const queue: Array<{ oid: string; level: number }> = [];

  for (const want of wants) {
    const obj = readObj(repo, want);
    if (!obj) continue;
    include.add(want);
    let oid = want; let o = obj;
    while (o && o.type === 'tag') {
      const target = parseTag(o.data);
      if (!target) break;
      oid = target; include.add(oid); o = readObj(repo, oid);
    }
    if (o && o.type === 'commit') queue.push({ oid, level: 1 });
  }

  while (queue.length) {
    const { oid, level } = queue.shift()!;
    const obj = readObj(repo, oid);
    if (!obj) continue;
    const prev = minLevel.get(oid);
    if (prev !== undefined && prev <= level) continue;
    minLevel.set(oid, level);
    include.add(oid);
    const c = parseCommit(obj.data);
    if (c.tree) for (const e of collect(repo, [c.tree])) include.add(e);
    if (level < depth) {
      if (clientShallow.has(oid)) unshallow.push(oid);
      for (const p of c.parents) queue.push({ oid: p, level: level + 1 });
    } else if (c.parents.length) {
      shallow.push(oid);
    }
  }
  return { include, shallow, unshallow };
}

function fetchUploadPack(repo: Repo, body: Buffer, v2: boolean): Buffer {
  const packets = parsePackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  let afterDelim = !v2;
  let inSecondV0Section = false;
  for (const p of packets) {
    if (p.kind === 'delim') { afterDelim = true; continue; }
    if (p.kind === 'flush') { if (!v2) inSecondV0Section = true; continue; }
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8').replace(/\n$/, '');
    if (!v2) {
      // v0: wants (with caps) and shallow/deepen before the first flush, haves/done after.
      if (!inSecondV0Section) {
        if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0]);
        else if (text.startsWith('shallow ')) shallowIn.push(text.slice(8));
        else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7), 10);
      } else if (text.startsWith('have ')) haves.push(text.slice(5));
      continue;
    }
    if (!afterDelim) continue;
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowIn.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7), 10);
  }

  const clientShallow = new Set(shallowIn);
  const haveSet = collect(repo, haves, clientShallow);
  let include: Set<string>;
  let newShallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== null && depth > 0) {
    const result = collectDepth(repo, wants, depth, clientShallow);
    include = result.include;
    newShallow = result.shallow;
    unshallow = result.unshallow;
  } else {
    include = collect(repo, wants);
  }
  const send = new Set<string>();
  for (const oid of include) if (!haveSet.has(oid)) send.add(oid);
  const pack = buildPack(repo, send);

  const parts: Buffer[] = [];
  if (v2) {
    parts.push(pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH);
    if (newShallow.length || unshallow.length) {
      parts.push(pkt('shallow-info\n'));
      for (const oid of newShallow) parts.push(pkt(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
      parts.push(FLUSH);
    }
    parts.push(pkt('packfile\n'), sideband(pack), FLUSH);
  } else {
    parts.push(pkt('NAK\n'));
    for (const oid of newShallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(sideband(pack), FLUSH);
  }
  return Buffer.concat(parts);
}

// --------------------------------------------------------------------------- receive-pack
function receivePack(repo: Repo, body: Buffer): Buffer {
  ensureState(repo);
  const lines: string[] = [];
  let i = 0;
  let packBuf = Buffer.alloc(0);
  let sawFlush = false;
  while (i + 4 <= body.length) {
    const hex = body.subarray(i, i + 4).toString('ascii');
    if (!HEX4.test(hex)) { sawFlush = true; break; }
    const len = parseInt(hex, 16);
    if (len === 0) { i += 4; sawFlush = true; break; }
    if (len < 4 || i + len > body.length) { sawFlush = true; break; }
    lines.push(body.subarray(i + 4, i + len).toString('utf8').replace(/\n$/, ''));
    i += len;
  }
  packBuf = sawFlush ? body.subarray(i) : Buffer.alloc(0);

  let unpackOk = true;
  if (packBuf.length) {
    try { ingestPack(repo, packBuf); } catch { unpackOk = false; }
  }
  const reports: string[] = [];
  if (unpackOk) {
    for (const line of lines) {
      const cmd = line.split('\0')[0];
      const bits = cmd.split(' ');
      if (bits.length < 3) { reports.push(`ng ${cmd} malformed`); continue; }
      const [oldOid, newOid, ref] = bits;
      const current = repo.refs.get(ref);
      const setBranch = (oid: string | null) => {
        if (!ref.startsWith('refs/heads/')) return;
        const name = ref.slice('refs/heads/'.length);
        if (oid === null) repo.branches.delete(name);
        else repo.branches.add(name);
      };
      if (newOid === ZERO) {
        if (!current) { reports.push(`ng ${ref} not-found`); continue; }
        repo.refs.delete(ref);
        setBranch(null);
        reports.push(`ok ${ref}`);
      } else if (oldOid === ZERO) {
        if (current) { reports.push(`ng ${ref} already-exists`); continue; }
        if (!repo.gitObjects.has(newOid)) { reports.push(`ng ${ref} missing-object`); continue; }
        repo.refs.set(ref, newOid);
        setBranch(newOid);
        reports.push(`ok ${ref}`);
      } else {
        if (current !== oldOid) { reports.push(`ng ${ref} fetch-first`); continue; }
        if (!collect(repo, [newOid]).has(oldOid)) { reports.push(`ng ${ref} non-fast-forward`); continue; }
        repo.refs.set(ref, newOid);
        setBranch(newOid);
        reports.push(`ok ${ref}`);
      }
    }
  }

  const inner: Buffer[] = [pkt(`${unpackOk ? 'unpack ok' : 'unpack error'}\n`)];
  for (const r of reports) inner.push(pkt(`${r}\n`));
  inner.push(FLUSH);
  return Buffer.concat([sideband(Buffer.concat(inner)), FLUSH]);
}

// --------------------------------------------------------------------------- entry point
export async function handleGit(ctx: Ctx): Promise<boolean> {
  if (ctx.parts.length < 2 || !ctx.parts[1].endsWith('.git')) return false;
  const match = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(ctx.path);
  if (!match) return false;
  const owner = match[1];
  const repoName = match[2];
  const rest = match[3] ?? '';
  const repo = store.getRepo(owner, repoName);
  if (!repo) { err(ctx.res, 404, 'Not Found'); return true; }
  ensureState(repo);

  // GET <repo>.git/info/refs?service=<svc>
  if (ctx.method === 'GET' && rest === 'info/refs') {
    const url = new URL(ctx.req.url ?? '/', 'http://entry');
    const serviceParam = url.searchParams.get('service');
    if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') {
      err(ctx.res, 404, 'Not Found'); return true;
    }
    const gp = String(ctx.req.headers['git-protocol'] ?? '');
    const v2 = serviceParam === 'git-upload-pack' && /version=2/.test(gp);
    const body = advertise(repo, serviceParam, v2);
    sendRaw(ctx.res, 200, body, { 'content-type': `application/x-${serviceParam}-advertisement` });
    return true;
  }

  // POST <repo>.git/git-upload-pack | git-receive-pack
  if (ctx.method === 'POST' && (rest === 'git-upload-pack' || rest === 'git-receive-pack')) {
    const body = await readBody(ctx.req);
    if (rest === 'git-receive-pack') {
      const out = receivePack(repo, body);
      sendRaw(ctx.res, 200, out, { 'content-type': 'application/x-git-receive-pack-result' });
      return true;
    }
    const first = parsePackets(body).find((p) => p.kind === 'data');
    const text = first && first.kind === 'data' ? first.payload.toString('utf8') : '';
    const isLsRefs = text.startsWith('command=ls-refs');
    const gp = String(ctx.req.headers['git-protocol'] ?? '');
    const v2 = /version=2/.test(gp) || text.startsWith('command=');
    const out = isLsRefs ? lsRefs(repo, body) : fetchUploadPack(repo, body, v2);
    sendRaw(ctx.res, 200, out, { 'content-type': 'application/x-git-upload-pack-result' });
    return true;
  }

  err(ctx.res, 404, 'Not Found');
  return true;
}
