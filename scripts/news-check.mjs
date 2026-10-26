// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Checks the news/ folder against docs/news-format.md: updates.json, each article's and report's front matter, and the
// JSON of every interactive block (and the data files they point at). npm run news:check — exits 1 on a problem.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NEWS = path.join(ROOT, 'news');

export const BLOCKS = ['stat', 'chart', 'timeline', 'lanes', 'flow', 'compare', 'matrix', 'ledger', 'terminal', 'callout', 'local'];
export const KINDS = ['new', 'improved', 'fixed', 'safety'];
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/** Front matter and body of an index.md: { front: { key: value }, body }. Throws when the front matter is missing. */
export function parseFront(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text));
  if (!m) throw new Error('it has no front matter (--- lines at the top)');
  const front = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`front matter line "${line}" is not key: value`);
    front[kv[1]] = kv[2].trim();
  }
  return { front, body: m[2] };
}

/** The interactive blocks in a Markdown body: [{ name, json, line }]. */
export function blocksOf(body) {
  const out = [];
  const re = /^```([a-z]+)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
  let m;
  while ((m = re.exec(body))) if (BLOCKS.includes(m[1])) out.push({ name: m[1], json: m[2], line: body.slice(0, m.index).split('\n').length });
  return out;
}

const PICTURE = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*\.(png|jpe?g|gif|webp|svg)$/i;
/** The pictures a Markdown body shows (outside fenced code): ['chart.png', …]. */
export function picturesOf(body) {
  const text = String(body).replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '').replace(/`[^`\n]*`/g, '');
  return [...text.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)].map((m) => m[1]);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.length > 0;
const arr = (v) => Array.isArray(v);

/** Problems with one block's data (after src files are merged in): [messages]. */
export function checkBlock(name, d) {
  const p = [];
  const need = (ok, msg) => { if (!ok) p.push(msg); };
  if (!d || typeof d !== 'object') return ['its body is not a JSON object'];
  switch (name) {
    case 'stat': need(arr(d.items) && d.items.length && d.items.every((x) => isStr(x.label) && isNum(x.from) && isNum(x.to)), 'items: [{ label, from, to }]'); break;
    case 'chart':
      need(['line', 'bar', 'pairs'].includes(d.type), 'type is line, bar or pairs');
      need(arr(d.x) && d.x.length, 'x: [labels]');
      need(arr(d.series) && d.series.length && d.series.every((s) => isStr(s.name) && arr(s.values) && s.values.every(isNum) && s.values.length === (d.x || []).length), 'series: [{ name, values }] with one number per x label');
      if (d.type === 'pairs') need(d.series?.length === 2, 'pairs needs exactly two series (before, after)');
      break;
    case 'timeline': need(arr(d.items) && d.items.length && d.items.every((x) => isStr(x.when) && isStr(x.title)), 'items: [{ when, title, text }]'); break;
    case 'lanes':
      need(TIME.test(d.start) && TIME.test(d.end), 'start and end are HH:MM');
      need(arr(d.rows) && d.rows.every((r) => isStr(r.label) && arr(r.build) && r.build.every((t) => TIME.test(t)) && (!r.review || r.review.every((t) => TIME.test(t)))), 'rows: [{ label, build: [HH:MM, HH:MM], review? }]');
      break;
    case 'flow': {
      need(arr(d.nodes) && d.nodes.length >= 2 && d.nodes.every((n) => isStr(n.id) && isStr(n.title)), 'nodes: [{ id, title }] (two or more)');
      const ids = new Set((d.nodes || []).map((n) => n.id));
      need(!d.loops || (arr(d.loops) && d.loops.every((l) => ids.has(l.from) && ids.has(l.to))), 'loops: from and to name existing node ids');
      break;
    }
    case 'compare': need(arr(d.options) && d.options.length >= 2 && d.options.every((o) => isStr(o.label) && arr(o.steps) && o.steps.every((s) => isStr(s.title)) && o.verdict && isStr(o.verdict.title)), 'options: two or more [{ label, steps: [{ title, text }], verdict: { title, text } }]'); break;
    case 'matrix': {
      need(arr(d.levels) && d.levels.every((l) => isStr(l.id) && isStr(l.label)), 'levels: [{ id, label }]');
      need(arr(d.columns) && d.columns.length, 'columns: [names]');
      const lv = new Set((d.levels || []).map((l) => l.id));
      need(arr(d.rows) && d.rows.every((r) => lv.has(r.level) && arr(r.cells) && r.cells.length === (d.columns || []).length), 'rows: [{ level (one of levels), cells (one per column) }]');
      break;
    }
    case 'ledger': need(arr(d.rows) && d.rows.length && d.rows.every((r) => isStr(r.gain) && isStr(r.cost)), 'rows: [{ gain, gainText, cost, costText, mitigation? }]'); break;
    case 'terminal': need(arr(d.lines) && d.lines.length && d.lines.every((l) => typeof l.cmd === 'string' || typeof l.out === 'string'), 'lines: [{ cmd } or { out }]'); break;
    case 'callout': need(['info', 'warn', 'good'].includes(d.tone) && isStr(d.title), 'tone (info, warn, good) and title'); break;
    case 'local': need(['models', 'deciders', 'costs', 'tests'].includes(d.view), 'view is models, deciders, costs or tests'); break;
    default: p.push(`unknown block ${name}`);
  }
  return p;
}

/** A block's data: its inline JSON, with a src file merged in first. */
export function blockData(json, dir) {
  const inline = JSON.parse(json);
  if (!inline.src) return inline;
  if (!/^[\w.-]+\.json$/.test(inline.src)) throw new Error(`src ${inline.src} must be a .json file in the same folder`);
  let file = JSON.parse(fs.readFileSync(path.join(dir, inline.src), 'utf8'));
  if (inline.path) file = String(inline.path).split('.').reduce((o, k) => o?.[k], file);
  const { src, path: _p, ...rest } = inline;
  return { ...file, ...rest };
}

/** Every problem in news/: [{ where, problem }]. */
export function checkNews(news = NEWS) {
  const out = [];
  const bad = (where, problem) => out.push({ where, problem });
  const upd = path.join(news, 'updates.json');
  if (fs.existsSync(upd)) {
    let u = null;
    try { u = JSON.parse(fs.readFileSync(upd, 'utf8')); } catch (e) { bad('updates.json', `not valid JSON: ${e.message}`); }
    if (u) {
      if (!arr(u.versions)) bad('updates.json', 'needs a versions array');
      for (const [i, v] of (u.versions || []).entries()) {
        const w = `updates.json versions[${i}]`;
        if (!/^\d+\.\d+\.\d+/.test(v.version || '')) bad(w, 'version like 0.2.0');
        if (!DATE.test(v.date || '')) bad(w, 'date as YYYY-MM-DD');
        if (!arr(v.items) || !v.items.length) bad(w, 'items: at least one');
        for (const [j, it] of (v.items || []).entries()) {
          if (!KINDS.includes(it.kind)) bad(`${w}.items[${j}]`, `kind is one of ${KINDS.join(', ')}`);
          if (!isStr(it.text) || it.text.length > 160) bad(`${w}.items[${j}]`, 'text: one sentence under 160 characters');
          if (it.link && !/^(articles|reports)\/[a-z0-9-]+$/.test(it.link)) bad(`${w}.items[${j}]`, 'link is articles/<slug> or reports/<slug>');
        }
      }
    }
  }
  for (const kind of ['articles', 'reports']) {
    const base = path.join(news, kind);
    if (!fs.existsSync(base)) continue;
    for (const slug of fs.readdirSync(base)) {
      const dir = path.join(base, slug), where = `${kind}/${slug}`;
      if (!fs.statSync(dir).isDirectory()) continue;
      if (!SLUG.test(slug.replace(/^_/, ''))) bad(where, 'folder name: lower case letters, digits and dashes');
      let doc;
      try { doc = parseFront(fs.readFileSync(path.join(dir, 'index.md'), 'utf8')); } catch (e) { bad(where, e.code === 'ENOENT' ? 'no index.md' : e.message); continue; }
      const f = doc.front;
      if (!isStr(f.title)) bad(where, 'front matter needs title');
      if (!DATE.test(f.date || '')) bad(where, 'front matter needs date as YYYY-MM-DD');
      if (!isStr(f.summary) || f.summary.length > 280) bad(where, 'front matter needs a summary under 280 characters');
      for (const pic of picturesOf(doc.body)) {
        if (!PICTURE.test(pic)) bad(where, `picture ${pic}: use a .png, .jpg, .gif, .webp or .svg file in the same folder`);
        else if (!fs.existsSync(path.join(dir, pic))) bad(where, `picture ${pic} is not in the folder`);
      }
      for (const b of blocksOf(doc.body)) {
        let d;
        try { d = blockData(b.json, dir); } catch (e) { bad(`${where}/index.md:${b.line}`, `${b.name} block: ${e.message}`); continue; }
        for (const p of checkBlock(b.name, d)) bad(`${where}/index.md:${b.line}`, `${b.name} block: ${p}`);
      }
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkNews();
  for (const p of problems) console.log(`✗ ${p.where}: ${p.problem}`);
  console.log(problems.length ? `${problems.length} problem${problems.length > 1 ? 's' : ''} in news/` : 'news/ is in order');
  process.exit(problems.length ? 1 : 0);
}
