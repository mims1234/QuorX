// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// A small ZIP writer and reader (deflate, no dependencies): a project's files from the pane, and the backup.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';

const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = zlib.crc32 || ((buf, prev = 0) => { let c = (prev ^ 0xffffffff) >>> 0; for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; });
const dosTime = (d) => {
  if (d.getFullYear() < 1980 || d.getFullYear() > 2107) d = new Date(1980, 0, 1); // the years a ZIP can hold
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
};
const deflateRaw = promisify(zlib.deflateRaw);

/** entries: [{ name: 'dir/file.txt', data: Buffer, mtime?: Date }] → one ZIP file as a Buffer. */
export function zipBuffer(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name.replaceAll('\\', '/'), 'utf8');
    const raw = e.data, packed = zlib.deflateRawSync(raw);
    const stored = packed.length >= raw.length; // already compressed (pictures, zips): keep as is
    const body = stored ? raw : packed, crc = crc32(raw) >>> 0, { time, date } = dosTime(e.mtime || new Date());
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    locals.push(head, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(stored ? 0 : 8, 10);
    cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    centrals.push(cen, name);
    offset += head.length + name.length + body.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---------- writing entry by entry ----------
const U32 = 0xffffffff, U16 = 0xffff;
// Already compressed: deflating these again costs time and saves next to nothing, so they are stored as they are.
const PACKED = /\.(png|jpe?g|gif|webp|avif|heic|mp4|m4v|mov|webm|mkv|ogv|mp3|m4a|aac|ogg|oga|opus|flac|zip|gz|tgz|7z|rar|xz|bz2|zst|woff2?|docx|xlsx|pptx)$/i;
const SMALL = 8e6; // a file up to this size is read whole; a bigger one flows through in pieces

// A local header; `z64` (a file past the 32-bit limit) puts both sizes in a ZIP64 extra field.
function localHeader(name, m, z64) {
  const h = Buffer.alloc(30 + name.length + (z64 ? 20 : 0));
  h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(z64 ? 45 : 20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(m.method, 8);
  h.writeUInt16LE(m.time, 10); h.writeUInt16LE(m.date, 12); h.writeUInt32LE(m.crc, 14); h.writeUInt32LE(z64 ? U32 : m.csize, 18); h.writeUInt32LE(z64 ? U32 : m.size, 22);
  h.writeUInt16LE(name.length, 26); h.writeUInt16LE(z64 ? 20 : 0, 28); name.copy(h, 30);
  if (z64) { const x = 30 + name.length; h.writeUInt16LE(1, x); h.writeUInt16LE(16, x + 2); h.writeBigUInt64LE(BigInt(m.size), x + 4); h.writeBigUInt64LE(BigInt(m.csize), x + 12); }
  return h;
}
// A central directory header; only the values past `big` go in its ZIP64 extra field (in the order the format fixes).
function centralHeader(name, m, big) {
  const wide = [m.size >= big && m.size, m.csize >= big && m.csize, m.offset >= big && m.offset].filter((v) => v !== false);
  const xlen = wide.length ? 4 + 8 * wide.length : 0, v = wide.length ? 45 : 20;
  const h = Buffer.alloc(46 + name.length + xlen);
  h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(v, 4); h.writeUInt16LE(v, 6); h.writeUInt16LE(0x0800, 8); h.writeUInt16LE(m.method, 10);
  h.writeUInt16LE(m.time, 12); h.writeUInt16LE(m.date, 14); h.writeUInt32LE(m.crc, 16); h.writeUInt32LE(m.csize >= big ? U32 : m.csize, 20); h.writeUInt32LE(m.size >= big ? U32 : m.size, 24);
  h.writeUInt16LE(name.length, 28); h.writeUInt16LE(xlen, 30); h.writeUInt32LE(m.offset >= big ? U32 : m.offset, 42); name.copy(h, 46);
  if (xlen) { let p = 46 + name.length; h.writeUInt16LE(1, p); h.writeUInt16LE(8 * wide.length, p + 2); for (const w of wide) { h.writeBigUInt64LE(BigInt(w), p + 4); p += 8; } }
  return h;
}
// Streams the first `size` bytes of `file` to the sink at `at`, deflated or not, and counts and checksums them on the way.
async function pump(sink, file, at, size, deflate) {
  let crc = 0, n = 0, p = at;
  const count = async function* (src) { for await (const c of src) { crc = crc32(c, crc); n += c.length; yield c; } };
  const write = async (src) => { for await (const c of src) { await sink.write(c, p); p += c.length; } };
  const read = fs.createReadStream(file, { start: 0, end: size - 1, highWaterMark: 1 << 20 });
  await (deflate ? pipeline(read, count, zlib.createDeflateRaw(), write) : pipeline(read, count, write));
  return { crc: crc >>> 0, size: n, csize: p - at };
}

/**
 * Writes a ZIP to `sink` ({ write(buf, pos), truncate?(len) }, both async) one entry at a time, never holding more than
 * one small file in memory. entries (an array or async iterable): { name, data?: Buffer | string | () => either, file?: path, mtime? }.
 * ZIP64 records go in only for what passes the 32-bit limits (a size, an offset, 65535 entries), so any other archive
 * is byte for byte what older readers know. at: where in the sink the archive starts; limits: { u32, u16 } for tests.
 * Returns where the archive ends.
 */
export async function writeZip(sink, entries, { at = 0, limits = {} } = {}) {
  const big = limits.u32 ?? U32, many = limits.u16 ?? U16, cen = [];
  let pos = at, far = at;
  for await (const e of entries) {
    const name = Buffer.from(e.name.replaceAll('\\', '/'), 'utf8');
    let data = typeof e.data === 'function' ? await e.data() : e.data, size = data?.length ?? 0, mtime = e.mtime;
    if (typeof data === 'string') { data = Buffer.from(data); size = data.length; }
    if (!data) {
      const st = await fs.promises.stat(e.file);
      size = st.size; mtime ||= st.mtime;
      if (size <= SMALL) { data = await fs.promises.readFile(e.file); size = data.length; }
    }
    const m = { ...dosTime(mtime || new Date()), offset: pos }, store = PACKED.test(e.name);
    if (data) {
      const packed = store ? data : await deflateRaw(data), stored = store || packed.length >= data.length;
      Object.assign(m, { method: stored ? 0 : 8, crc: crc32(data) >>> 0, size: data.length, csize: stored ? data.length : packed.length });
      const z64 = m.size >= big, head = localHeader(name, m, z64);
      await sink.write(Buffer.concat([head, stored ? data : packed]), pos);
      pos += head.length + m.csize;
    } else {
      // The header goes in once the data is written and its checksum and sizes are known.
      const z64 = size >= big, dataAt = pos + 30 + name.length + (z64 ? 20 : 0);
      let r = await pump(sink, e.file, dataAt, size, !store), method = store ? 0 : 8;
      if (!store && r.csize >= r.size) { far = Math.max(far, dataAt + r.csize); r = await pump(sink, e.file, dataAt, size, false); method = 0; } // deflating didn't help
      Object.assign(m, r, { method });
      await sink.write(localHeader(name, m, z64), pos);
      pos = dataAt + m.csize;
    }
    cen.push(centralHeader(name, m, big));
  }
  // The central directory, in pieces of about a megabyte.
  const cdAt = pos;
  for (let i = 0; i < cen.length;) {
    const part = [];
    for (let n = 0; i < cen.length && n < 1 << 20; i++) { part.push(cen[i]); n += cen[i].length; }
    const b = Buffer.concat(part);
    await sink.write(b, pos); pos += b.length;
  }
  const count = cen.length, cdSize = pos - cdAt, tail = [];
  if (count >= many || cdSize >= big || cdAt >= big) {
    // ZIP64 end of central directory record, then the locator that points at it.
    const r = Buffer.alloc(56), l = Buffer.alloc(20);
    r.writeUInt32LE(0x06064b50, 0); r.writeBigUInt64LE(44n, 4); r.writeUInt16LE(45, 12); r.writeUInt16LE(45, 14);
    r.writeBigUInt64LE(BigInt(count), 24); r.writeBigUInt64LE(BigInt(count), 32); r.writeBigUInt64LE(BigInt(cdSize), 40); r.writeBigUInt64LE(BigInt(cdAt), 48);
    l.writeUInt32LE(0x07064b50, 0); l.writeBigUInt64LE(BigInt(pos), 8); l.writeUInt32LE(1, 16);
    tail.push(r, l);
  }
  const end = Buffer.alloc(22), n16 = count >= many ? U16 : count;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n16, 8); end.writeUInt16LE(n16, 10); end.writeUInt32LE(cdSize >= big ? U32 : cdSize, 12); end.writeUInt32LE(cdAt >= big ? U32 : cdAt, 16);
  const last = Buffer.concat([...tail, end]);
  await sink.write(last, pos); pos += last.length;
  if (far > pos) await sink.truncate?.(pos);
  return pos;
}

/** A sink for writeZip that writes into an open file (fs.promises.open). */
export const fileSink = (fh) => ({ write: (b, p) => fh.write(b, 0, b.length, p), truncate: (n) => fh.truncate(n) });
// A sink that keeps the archive in memory; buffer(end) puts it together.
const memorySink = () => {
  const parts = [];
  return { write: async (b, p) => { parts.push([p, b]); }, buffer: (len) => { const out = Buffer.alloc(len); for (const [p, b] of parts) if (p < len) b.copy(out, p, 0, Math.min(b.length, len - p)); return out; } };
};

// ---------- reading ----------
/** A source for readZip over an open file: reads at any position, past 4 GB too. */
export function fileSource(fd) {
  const size = fs.fstatSync(fd).size;
  return {
    size,
    read: (pos, len) => {
      const b = Buffer.alloc(len);
      let n = 0;
      while (n < len) { const r = fs.readSync(fd, b, n, Math.min(len - n, 1 << 30), pos + n); if (!r) break; n += r; }
      return n < len ? b.subarray(0, n) : b;
    },
  };
}
export const bufferSource = (buf) => ({ size: buf.length, read: (pos, len) => buf.subarray(pos, pos + len) });

/**
 * The entries of a ZIP, ZIP64 or not, from src ({ size, read(pos, len) → Buffer }): Map name → { method, size, csize,
 * read() }, each read on demand with a capped inflate. null when it is not a ZIP.
 */
export function readZip(src, { maxEntry = 512 * 1024 * 1024 } = {}) {
  const base = Math.max(0, src.size - 65557), tail = src.read(base, src.size - base);
  let e = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) return null;
  let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdAt = tail.readUInt32LE(e + 16);
  // ZIP64: a locator just before the end record points at the 64-bit one.
  const loc = base + e >= 20 ? src.read(base + e - 20, 20) : null;
  if (loc?.length === 20 && loc.readUInt32LE(0) === 0x07064b50) {
    const r = src.read(Number(loc.readBigUInt64LE(8)), 56);
    if (r.length === 56 && r.readUInt32LE(0) === 0x06064b50) { count = Number(r.readBigUInt64LE(32)); cdSize = Number(r.readBigUInt64LE(40)); cdAt = Number(r.readBigUInt64LE(48)); }
  }
  const cd = src.read(cdAt, cdSize), out = new Map();
  for (let p = 0; count > 0 && p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; count--) {
    const method = cd.readUInt16LE(p + 10), nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
    let csize = cd.readUInt32LE(p + 20), size = cd.readUInt32LE(p + 24), off = cd.readUInt32LE(p + 42);
    // A ZIP64 extra field holds the 64-bit values of the ones set to 0xffffffff, in this order.
    for (let x = p + 46 + nlen, end = x + xlen; x + 4 <= end; x += 4 + cd.readUInt16LE(x + 2)) {
      if (cd.readUInt16LE(x) !== 1) continue;
      let q = x + 4;
      const u64 = () => { const v = Number(cd.readBigUInt64LE(q)); q += 8; return v; };
      if (size === U32) size = u64();
      if (csize === U32) csize = u64();
      if (off === U32) off = u64();
      break;
    }
    const name = cd.toString('utf8', p + 46, p + 46 + nlen);
    const read = () => {
      const h = src.read(off, 30), data = src.read(off + 30 + h.readUInt16LE(26) + h.readUInt16LE(28), csize);
      return method === 0 ? data : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: maxEntry }) : Buffer.alloc(0);
    };
    out.set(name, { method, size, csize, read });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

const SKIP = new Set(['.git', '.quorx', '.agent', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target']);
/** A project's own files, without the harness's folder, dependencies, build output and anything over the limits. */
export async function zipFolder(root, { maxFile = 25e6, maxTotal = 150e6 } = {}) {
  const entries = [], skipped = [];
  let total = 0;
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(full, r); continue; }
      if (!e.isFile()) continue;
      const st = fs.statSync(full);
      if (st.size > maxFile || total + st.size > maxTotal) { skipped.push(r); continue; }
      total += st.size;
      entries.push({ name: r, file: full, mtime: st.mtime });
    }
  };
  walk(root, '');
  const mem = memorySink(), end = await writeZip(mem, entries);
  return { zip: mem.buffer(end), files: entries.length, skipped };
}
