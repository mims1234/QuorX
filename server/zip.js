// A small ZIP writer (deflate, no dependencies) for exporting a project's files from the pane.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = zlib.crc32 || ((buf) => { let c = 0xffffffff; for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; });
const dosTime = (d) => ({ time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() });

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

const SKIP = new Set(['.git', '.quorx', '.agent', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'target']);
/** A project's own files, without the harness's folder, dependencies, build output and anything over the limits. */
export function zipFolder(root, { maxFile = 25e6, maxTotal = 150e6 } = {}) {
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
      entries.push({ name: r, data: fs.readFileSync(full), mtime: st.mtime });
    }
  };
  walk(root, '');
  return { zip: zipBuffer(entries), files: entries.length, skipped };
}
