// Attached documents: any file the user uploads to a chat is kept in the project's git-ignored
// .quorx/uploads/. The harness reads text out of what it can (plain text and code, PDF, Word,
// PowerPoint, Excel, OpenDocument, EPUB, HTML); small documents go into the message whole, big ones
// are split into passages and embedded with an OpenRouter embedding model so the agent can search
// them (search_docs) and read exact parts (read_doc). Files it can't read are still saved, and the
// agent is told where, so it can try for itself.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { workspaceDir, ensureAgentDir } from './workspace.js';
import { chat, chatModels, embed, embeddingModels } from './openrouter.js';
import { recordRun } from './runs.js';
import { numberedWindow } from './loop.js';

export const DOC_DEFAULTS = { embedModel: 'openai/text-embedding-3-small', inlineDocTokens: 15000, docIndexBudget: 0.5, maxUploadMB: 100, pdfNative: false, readerModel: '' };
const TEXT_EXT = new Set('txt md markdown mdx rst csv tsv json jsonl ndjson yaml yml toml ini cfg conf properties env xml html htm xhtml css scss less js mjs cjs ts tsx jsx vue svelte py pyw ipynb rb go rs java kt kts swift c h cc cpp hpp cs fs php pl lua r m dart scala sh bash zsh ps1 psm1 bat cmd sql graphql gql proto log tex bib srt vtt svg gradle make mk dockerfile gitignore'.split(' '));
const ZIP_KINDS = { docx: 'Word', pptx: 'PowerPoint', xlsx: 'Excel', odt: 'OpenDocument text', odp: 'OpenDocument slides', ods: 'OpenDocument sheet', epub: 'EPUB' };
const tokensOf = (s) => Math.ceil(String(s || '').length / 4);

// ---------- where things live ----------
const dirs = (projectId) => {
  const root = workspaceDir(projectId);
  ensureAgentDir(root);
  const up = path.join(root, '.quorx', 'uploads'), idx = path.join(root, '.quorx', 'index');
  fs.mkdirSync(up, { recursive: true }); fs.mkdirSync(idx, { recursive: true });
  return { root, up, idx, reg: path.join(up, 'docs.json') };
};
// Entries name a file in uploads/ only (the folder can arrive with a project, so a stray entry is dropped, not followed):
// saveUpload names each one `<id>-<name>`, a plain file name with no folder, drive or stream in it. Any letters are
// fine in the name part (résumé.pdf, report [1].pdf), as safeName already took out what Windows won't allow.
export const okEntry = (x) => !!x && typeof x.id === 'string' && /^[\w-]{1,64}$/.test(x.id) && typeof x.file === 'string'
  && x.file.length <= 200 && x.file.startsWith(`${x.id}-`) && !/[\\/:]/.test(x.file) && x.file === path.basename(x.file);
const readReg = (d) => { try { const l = JSON.parse(fs.readFileSync(d.reg, 'utf8')); return Array.isArray(l) ? l.filter(okEntry) : []; } catch { return []; } };
// Through a temp file, so a crash mid-write can't leave a half list that reads as no documents.
const writeReg = (d, list) => { fs.writeFileSync(d.reg + '.tmp', JSON.stringify(list, null, 2)); fs.renameSync(d.reg + '.tmp', d.reg); };
function update(projectId, id, patch) {
  const d = dirs(projectId), list = readReg(d), i = list.findIndex((x) => x.id === id);
  if (i < 0) throw new Error('no such document');
  list[i] = { ...list[i], ...patch };
  writeReg(d, list);
  return list[i];
}
export const listDocs = (projectId) => { try { return readReg(dirs(projectId)); } catch { return []; } };
export const getDoc = (projectId, id) => listDocs(projectId).find((x) => x.id === id || x.name === id) || null;
/** A document by id, exact name, or a name that contains the text. */
export function findDoc(projectId, ref) {
  const all = listDocs(projectId), r = String(ref || '').toLowerCase();
  return all.find((x) => x.id === ref) || all.find((x) => x.name.toLowerCase() === r) || all.filter((x) => x.name.toLowerCase().includes(r)).at(-1) || null;
}
const safeName = (n) => String(n || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';

/** Saves an uploaded file; nothing is read yet. */
export function saveUpload(projectId, name, buf, mime = '') {
  const d = dirs(projectId);
  const id = `d${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const clean = safeName(name), file = `${id}-${clean}`;
  fs.writeFileSync(path.join(d.up, file), buf);
  const ext = (clean.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const meta = { id, name: clean, file, rel: `.quorx/uploads/${file}`, size: buf.length, mime: String(mime || ''), ext, kind: kindOf(ext, buf), status: 'stored', added: Date.now() };
  const list = readReg(d); list.push(meta); writeReg(d, list);
  return meta;
}
function kindOf(ext, buf) {
  if (ext === 'pdf' || buf.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  if (ZIP_KINDS[ext]) return ext;
  if (/^(png|jpe?g|gif|webp|bmp|tiff?|heic|avif)$/.test(ext)) return 'image';
  if (TEXT_EXT.has(ext) || looksLikeText(buf)) return 'text';
  return 'binary';
}
function looksLikeText(buf) {
  const head = buf.subarray(0, 8192);
  if (!head.length || head.includes(0)) return false;
  const s = head.toString('utf8');
  return (s.match(/\uFFFD/g) || []).length < s.length / 50;
}
export function removeDoc(projectId, id) {
  const d = dirs(projectId), list = readReg(d), doc = list.find((x) => x.id === id);
  if (!doc) return false;
  for (const f of [path.join(d.up, doc.file), path.join(d.up, `${id}.txt`), path.join(d.idx, `${id}.json`)]) fs.rmSync(f, { force: true });
  writeReg(d, list.filter((x) => x.id !== id));
  return true;
}

// ---------- reading text out of files ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const codePoint = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '�'); // "&#99999999;" is not a character
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m));
const tidy = (s) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
export function htmlToText(html) {
  return tidy(decode(String(html)
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol)>/gi, '\n')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `).replace(/<li[^>]*>/gi, '- ').replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, '')));
}
// A small ZIP reader (Office files, OpenDocument and EPUB are ZIP archives of XML).
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a ZIP-based file');
  const files = new Map();
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0 && buf.readUInt32LE(p) === 0x02014b50; n--) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    files.set(name, () => {
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(start, start + csize);
      // A capped inflate: a tiny crafted file can't expand into gigabytes and take the harness down.
      return (method === 0 ? data : method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 256 * 1024 * 1024 }) : Buffer.alloc(0)).toString('utf8');
    });
    p += 46 + nlen + xlen + clen;
  }
  return files;
}
const xmlText = (xml, para, extra = (s) => s) => tidy(decode(extra(xml).replace(para, '\n').replace(/<[^>]+>/g, '')));
const byNumber = (a, b) => Number(a.match(/(\d+)\.xml$/)?.[1] || 0) - Number(b.match(/(\d+)\.xml$/)?.[1] || 0);
// Text of an office document in the project, for the Files preview (Word, PowerPoint, Excel, OpenDocument, EPUB).
export const OFFICE_KINDS = ['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'epub'];
export function officeText(file) {
  const kind = path.extname(file).slice(1).toLowerCase();
  if (!OFFICE_KINDS.includes(kind)) throw new Error('not an office document');
  return readZipDoc(kind, fs.readFileSync(file));
}
function readZipDoc(kind, buf) {
  const z = unzip(buf), get = (n) => (z.has(n) ? z.get(n)() : '');
  if (kind === 'docx') {
    const body = ['word/document.xml', ...[...z.keys()].filter((n) => /^word\/(footnotes|endnotes)\.xml$/.test(n))].map(get).join('\n');
    return xmlText(body, /<\/w:p>/g, (s) => s.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n'));
  }
  if (kind === 'pptx') {
    return [...z.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber)
      .map((n, i) => `## Slide ${i + 1}\n${xmlText(get(n), /<\/a:p>/g)}${(() => { const notes = get(n.replace('slides/slide', 'notesSlides/notesSlide')); return notes ? `\n(Notes: ${xmlText(notes, /<\/a:p>/g)})` : ''; })()}`).join('\n\n');
  }
  if (kind === 'xlsx') {
    const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => decode(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<[^>]+>/g, '')));
    const names = [...get('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decode(m[1]));
    return [...z.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber).map((n, i) => {
      const rows = [...get(n).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].slice(0, 50000).map((r) => [...r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
        const t = c[1].match(/t="(\w+)"/)?.[1], v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        return t === 's' ? shared[Number(v)] ?? '' : t === 'inlineStr' ? decode((c[2] || '').replace(/<[^>]+>/g, '')) : decode(v || '');
      }).join('\t'));
      return `## Sheet: ${names[i] || `Sheet ${i + 1}`}\n${rows.join('\n')}`;
    }).join('\n\n');
  }
  if (kind === 'odt' || kind === 'odp' || kind === 'ods') return xmlText(get('content.xml'), /<\/text:(p|h)>/g, (s) => s.replace(/<\/table:table-cell>/g, '\t').replace(/<text:tab\/>/g, '\t'));
  if (kind === 'epub') {
    const opfPath = get('META-INF/container.xml').match(/full-path="([^"]+)"/)?.[1] || [...z.keys()].find((n) => n.endsWith('.opf'));
    const opf = opfPath ? get(opfPath) : '', base = opfPath ? opfPath.replace(/[^/]*$/, '') : '';
    const items = Object.fromEntries([...opf.matchAll(/<item [^>]*id="([^"]+)"[^>]*href="([^"]+)"/g)].map((m) => [m[1], base + decodeURIComponent(m[2])]));
    const order = [...opf.matchAll(/<itemref [^>]*idref="([^"]+)"/g)].map((m) => items[m[1]]).filter(Boolean);
    return (order.length ? order : [...z.keys()].filter((n) => /\.x?html?$/.test(n)).sort()).map((n) => htmlToText(get(n))).filter(Boolean).join('\n\n');
  }
  return '';
}
// PDFs: the free local reader when this computer has it (pdftotext, e.g. from Git for Windows),
// otherwise OpenRouter's file parser through a cheap model with a big context.
export const PDFTOTEXT = ['pdftotext', 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe', 'C:\\Program Files\\Git\\usr\\bin\\pdftotext.exe', '/usr/bin/pdftotext', '/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext'];
function pdfToText(file) {
  return new Promise((resolve) => {
    const tryAt = (i) => {
      if (i >= PDFTOTEXT.length) return resolve(null);
      execFile(PDFTOTEXT[i], ['-enc', 'UTF-8', file, '-'], { maxBuffer: 512 * 1024 * 1024, windowsHide: true, timeout: 180e3 }, (err, out) => {
        if (err && (err.code === 'ENOENT' || /not recognized|cannot find/i.test(err.message))) return tryAt(i + 1);
        if (err && !out) return resolve(null);
        const pages = String(out).split('\f');
        if (pages.at(-1).trim() === '') pages.pop();
        resolve({ pages: pages.length, text: pages.map((p, n) => `[page ${n + 1}]\n${p.trim()}`).join('\n\n') });
      });
    };
    tryAt(0);
  });
}
async function readerModel(wanted, tokens) {
  if (wanted) return wanted;
  const all = await chatModels().catch(() => []);
  const fit = all.filter((m) => m.price[0] > 0 && (m.ctx || 0) >= Math.max(128000, tokens * 1.2) && m.in.includes('text')).sort((a, b) => a.price[0] - b.price[0]);
  return fit[0]?.id || 'google/gemini-2.5-flash-lite';
}
/** OpenRouter's file parser: "cloudflare-ai" (free) for text PDFs, "mistral-ocr" ($2 per 1,000 pages) for scans. */
async function parseViaOpenRouter(file, name, engine, model) {
  const data = fs.readFileSync(file).toString('base64');
  const r = await chat({ model, max_tokens: 16, messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }, { type: 'file', file: { filename: name, file_data: `data:application/pdf;base64,${data}` } }] }], plugins: [{ id: 'file-parser', pdf: { engine } }] });
  const parts = (r.message.annotations || []).filter((a) => a.type === 'file').flatMap((a) => a.file?.content || []);
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
  if (!text.trim()) throw new Error('OpenRouter returned no text for this PDF');
  return { text, cost: Number(r.usage.cost) || 0, model };
}

// ---------- splitting into passages and embedding them ----------
function chunk(text, maxChars) {
  const lines = text.split('\n'), out = [];
  let page = null, cur = [], size = 0, start = 1;
  const flush = (lineNo) => {
    if (!cur.length) return;
    const body = cur.join('\n').trim();
    if (body) out.push({ text: body, from: start, to: lineNo - 1, page });
    // A little overlap: the last two lines start the next passage.
    const keep = cur.slice(-2); cur = [...keep]; size = keep.join('\n').length; start = lineNo - keep.length;
  };
  lines.forEach((raw, i) => {
    const n = i + 1, pm = raw.match(/^\[page (\d+)\]$/);
    if (pm) { flush(n); cur = []; size = 0; start = n; page = Number(pm[1]); }
    for (let line = raw; ;) {
      if (size + line.length > maxChars && cur.length) flush(n);
      if (line.length <= maxChars) { cur.push(line); size += line.length + 1; break; }
      cur.push(line.slice(0, maxChars)); size += maxChars; flush(n + 1); line = line.slice(maxChars);
    }
  });
  flush(lines.length + 1);
  return out.filter((c, i, a) => i === 0 || c.text !== a[i - 1].text);
}
const toB64 = (vecs) => Buffer.from(new Float32Array(vecs.flatMap((v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); })).buffer).toString('base64');
const INDEX_CACHE = new Map(); // file path → { mtime, data, vectors: Float32Array }
function loadIndex(file) {
  const st = fs.statSync(file), c = INDEX_CACHE.get(file);
  if (c && c.mtime === st.mtimeMs) return c;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const b = Buffer.from(data.vectors, 'base64');
  const v = { mtime: st.mtimeMs, data, vectors: new Float32Array(b.buffer, b.byteOffset, b.length / 4) };
  INDEX_CACHE.set(file, v);
  if (INDEX_CACHE.size > 30) INDEX_CACHE.delete(INDEX_CACHE.keys().next().value);
  return v;
}
async function estimateEmbedCost(model, tokens) {
  const m = (await embeddingModels().catch(() => [])).find((x) => x.id === model);
  return { price: m?.price ?? null, ctx: m?.ctx || 8192, cost: m ? (tokens * m.price) / 1e6 : null };
}

/**
 * Reads the document's text and, when it is too big to send whole, indexes it. Steps that cost
 * money beyond the budget wait for the user's OK (`confirm: true`); OCR only runs when asked (`ocr: true`).
 */
export async function processDoc(projectId, id, opts = {}) {
  const S = { ...DOC_DEFAULTS, ...Object.fromEntries(Object.entries(opts.settings || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')) };
  const d = dirs(projectId), doc = getDoc(projectId, id);
  if (!doc) throw new Error('no such document');
  const file = path.join(d.up, doc.file), txtFile = path.join(d.up, `${id}.txt`);
  let spent = 0;
  const charge = (cost, model, what) => { if (!cost) return; spent += cost; recordRun({ ts: new Date().toISOString(), runId: `doc-${id}-${Date.now().toString(36)}`, kind: 'docs', project: projectId, chatId: opts.chatId || null, model, stop: what, cost: +cost.toFixed(6) }); };
  try {
    // 1. Text.
    let text = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, 'utf8') : null, method = doc.method, pages = doc.pages || null;
    if (text == null || opts.ocr) {
      const buf = fs.readFileSync(file);
      if (doc.kind === 'image') return update(projectId, id, { status: 'image', note: 'Pictures are sent to the model as images.' });
      if (doc.kind === 'binary') return update(projectId, id, { status: 'stored', note: 'Saved; the harness can\'t read this type, the agent may try with its own tools.' });
      if (doc.kind === 'text') { text = buf.toString('utf8'); method = 'text'; if (/^(html?|xhtml)$/.test(doc.ext) && text.length > 200000) { text = htmlToText(text); method = 'html → text'; } }
      else if (ZIP_KINDS[doc.kind]) { text = readZipDoc(doc.kind, buf); method = `${ZIP_KINDS[doc.kind]} text`; }
      else if (doc.kind === 'pdf') {
        if (opts.ocr) {
          const r = await parseViaOpenRouter(file, doc.name, 'mistral-ocr', await readerModel(S.readerModel, (doc.pages || 50) * 600));
          charge(r.cost, r.model, 'doc-ocr'); text = r.text; method = `OCR (mistral-ocr via ${r.model})`;
        } else {
          const local = await pdfToText(file);
          if (local) { text = local.text; pages = local.pages; method = 'pdftotext (local, free)'; }
          else {
            const r = await parseViaOpenRouter(file, doc.name, 'cloudflare-ai', await readerModel(S.readerModel, doc.size / 8));
            charge(r.cost, r.model, 'doc-parse'); text = r.text; method = `OpenRouter file parser via ${r.model}`;
          }
          // Almost no text on the pages: a scan. OCR costs money, so it waits for the user.
          const words = text.replace(/\[page \d+\]/g, '').trim().length;
          if (pages && words < pages * 40) {
            return update(projectId, id, { status: 'needs-ocr', pages, method, chars: words, ocrEstimate: +(pages * 0.002).toFixed(4), note: `Looks scanned: ${pages} page${pages > 1 ? 's' : ''} with almost no text. OCR costs about $${(pages * 0.002).toFixed(3)}.` });
          }
        }
      }
      if (text.length > 30e6) text = text.slice(0, 30e6);
      fs.writeFileSync(txtFile, text);
    }
    const tokens = tokensOf(text), lines = text.split('\n').length;
    const base = { chars: text.length, tokens, lines, pages, method, error: null, cost: +((doc.cost || 0) + spent).toFixed(6) };
    // 2. Small enough to send whole: done.
    if (tokens <= Number(S.inlineDocTokens)) return update(projectId, id, { ...base, status: 'text', note: `${tokens.toLocaleString()} tokens: sent whole with your message.` });
    // 3. Big: index it, unless that costs more than the budget and the user hasn't said yes.
    const model = String(S.embedModel || DOC_DEFAULTS.embedModel);
    const est = await estimateEmbedCost(model, tokens);
    if (est.cost != null && est.cost > Number(S.docIndexBudget) && !opts.confirm) {
      return update(projectId, id, { ...base, status: 'needs-ok', embedModel: model, estimate: +est.cost.toFixed(4), note: `${tokens.toLocaleString()} tokens. Making it searchable with ${model} costs about $${est.cost.toFixed(3)}.` });
    }
    const idxFile = path.join(d.idx, `${id}.json`);
    if (fs.existsSync(idxFile) && !opts.ocr) {
      const old = loadIndex(idxFile).data;
      if (old.model === model) return update(projectId, id, { ...base, status: 'indexed', embedModel: model, chunks: old.chunks.length, note: `${tokens.toLocaleString()} tokens in ${old.chunks.length} passages: the agent searches it.` });
    }
    const maxChars = Math.max(400, Math.min(1800, Math.floor(est.ctx * 3)));
    const chunks = chunk(text, maxChars);
    const vectors = [];
    for (let i = 0; i < chunks.length; i += 64) {
      const r = await embed(model, chunks.slice(i, i + 64).map((c) => c.text));
      charge(r.usage.cost, model, 'doc-index');
      vectors.push(...r.vectors);
    }
    fs.writeFileSync(idxFile, JSON.stringify({ model, dims: vectors[0]?.length || 0, built: Date.now(), chunks, vectors: toB64(vectors) }));
    return update(projectId, id, { ...base, cost: +((doc.cost || 0) + spent).toFixed(6), status: 'indexed', embedModel: model, chunks: chunks.length, note: `${tokens.toLocaleString()} tokens in ${chunks.length} passages: the agent searches it.` });
  } catch (e) {
    return update(projectId, id, { status: 'error', error: e.message, note: `Could not read it: ${e.message}`, cost: +((doc.cost || 0) + spent).toFixed(6) });
  }
}

export function docText(projectId, id) {
  const d = dirs(projectId), f = path.join(d.up, `${id}.txt`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}
/** Numbered lines of a document, like read_file. */
export function readDoc(projectId, ref, { offset = 1, limit = 300 } = {}) {
  const doc = findDoc(projectId, ref);
  if (!doc) throw new Error(`no document "${ref}". Documents: ${listDocs(projectId).map((x) => x.name).join(', ') || 'none'}`);
  const text = docText(projectId, doc.id);
  if (text == null) throw new Error(`"${doc.name}" has no text the harness could read (${doc.note || doc.status}). The file is at ${doc.rel}.`);
  return `${doc.name} (${doc.lines} lines${doc.pages ? `, ${doc.pages} pages` : ''})\n${numberedWindow(text, { offset, limit: Math.min(800, limit) })}`;
}
/** Best passages for a question across indexed documents (all of them, or the ones named). */
export async function searchDocs(projectId, query, { docs, k = 6 } = {}) {
  const all = listDocs(projectId).filter((x) => x.status === 'indexed');
  const pick = docs?.length ? all.filter((x) => docs.some((r) => x.id === r || x.name.toLowerCase().includes(String(r).toLowerCase()))) : all;
  if (!pick.length) return { hits: [], cost: 0, note: all.length ? 'none of the named documents are indexed' : 'no indexed documents in this project' };
  const d = dirs(projectId), byModel = new Map();
  for (const doc of pick) { const f = path.join(d.idx, `${doc.id}.json`); if (fs.existsSync(f)) { const ix = loadIndex(f); (byModel.get(ix.data.model) || byModel.set(ix.data.model, []).get(ix.data.model)).push({ doc, ix }); } }
  const words = String(query).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  const hits = []; let cost = 0;
  for (const [model, group] of byModel) {
    const r = await embed(model, [String(query)]);
    cost += r.usage.cost || 0;
    const q = r.vectors[0], n = Math.hypot(...q) || 1, qv = q.map((x) => x / n);
    for (const { doc, ix } of group) {
      const dim = ix.data.dims, V = ix.vectors;
      ix.data.chunks.forEach((c, i) => {
        let s = 0; for (let j = 0; j < dim; j++) s += V[i * dim + j] * qv[j];
        // A small bonus for exact words, so names and numbers aren't lost.
        const low = c.text.toLowerCase(); s += 0.02 * words.filter((w) => low.includes(w)).length;
        hits.push({ doc: doc.name, id: doc.id, page: c.page, from: c.from, to: c.to, score: +s.toFixed(3), text: c.text });
      });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, Math.max(1, Math.min(12, k))), cost };
}
