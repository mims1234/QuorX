// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// News pages (docs/news-format.md): a small, safe Markdown renderer for articles and reports, and each interactive
// block drawn complete at rest, as HTML and SVG strings. Everything from the file is escaped; only the subset in the
// contract becomes markup. No DOM here, so it runs in the page and in the tests alike; app.js adds the motion.

export const BLOCKS = ['stat', 'chart', 'timeline', 'lanes', 'flow', 'compare', 'matrix', 'ledger', 'terminal', 'callout', 'local'];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const arr = (v) => (Array.isArray(v) ? v : []);
const r1 = (v) => Math.round(v * 10) / 10;

// ---------- inline: code, links, pictures, bold, italic ----------
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9_-]+)*\.(png|jpe?g|gif|webp|svg)$/i;

/** Where a link goes: { href, ext } for the web and mail, { news } for another News page, { anchor }, or null. */
export function linkTarget(href) {
  const h = String(href || '').trim();
  if (/^https?:\/\/[^\s<>"]+$/i.test(h) || /^mailto:[^\s<>"]+$/i.test(h)) return { href: h, ext: true };
  const m = /^(?:\.\.\/)*(?:\.\.\/)?(articles|reports)\/(_?[a-z0-9][a-z0-9-]*)\/?(#[\w-]+)?$/.exec(h);
  if (m) return { news: `${m[1]}/${m[2]}` };
  if (/^#[\w-]+$/.test(h)) return { anchor: h.slice(1) };
  return null;
}

/** One line of Markdown text as HTML. ctx: { kind, slug } for pictures in the article's folder. */
export function inline(src, ctx = {}) {
  const s = String(src ?? '');
  let out = '', i = 0;
  while (i < s.length) {
    const rest = s.slice(i), prev = i ? s[i - 1] : ' ';
    let m;
    if (rest[0] === '\\' && /[\\`*_[\]()#+\-.!|>~]/.test(rest[1] || '')) { out += esc(rest[1]); i += 2; continue; }
    if ((m = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.exec(rest))) { out += `<code>${esc(m[2].trim())}</code>`; i += m[0].length; continue; }
    if ((m = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(rest))) { out += picture(m[1], m[2], ctx); i += m[0].length; continue; }
    if ((m = /^\[((?:[^[\]\\]|\\.|\[[^\]]*\])+)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/.exec(rest))) { out += link(m[2], inline(m[1], ctx), m[3]); i += m[0].length; continue; }
    if ((m = /^<(https?:\/\/[^\s<>]+)>/.exec(rest))) { out += link(m[1], esc(m[1])); i += m[0].length; continue; }
    if ((m = /^\*\*(?=\S)([\s\S]*?\S)\*\*/.exec(rest)) || (!/\w/.test(prev) && (m = /^__(?=\S)([\s\S]*?\S)__(?!\w)/.exec(rest)))) { out += `<strong>${inline(m[1], ctx)}</strong>`; i += m[0].length; continue; }
    if ((m = /^\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/.exec(rest)) || (!/\w/.test(prev) && (m = /^_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/.exec(rest)))) { out += `<em>${inline(m[1], ctx)}</em>`; i += m[0].length; continue; }
    if ((m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest))) { out += `<del>${inline(m[1], ctx)}</del>`; i += m[0].length; continue; }
    m = /^[^\\`![<*_~]+/.exec(rest);
    const run = m ? m[0] : rest[0];
    out += esc(run); i += run.length;
  }
  return out;
}
function link(href, inner, title) {
  const t = linkTarget(href), tt = title ? ` title="${esc(title)}"` : '';
  if (!t) return `<span class="nw-badlink" title="${esc(`Not a link QuorX opens: ${href}`)}">${inner}</span>`;
  // A web link opens with a click in QuorX's Browser tab, or with Ctrl+click in your own browser (data-cl); a mail link stays
  // ordinary.
  if (t.ext) return /^https?:/i.test(t.href) ? `<a href="${esc(t.href)}" rel="noopener noreferrer" data-ext="1" data-cl="1"${tt}>${inner}</a>` : `<a href="${esc(t.href)}" target="_blank" rel="noopener noreferrer" data-ext="1"${tt}>${inner}</a>`;
  if (t.news) return `<a href="#news/${esc(t.news)}" data-news="${esc(t.news)}"${tt}>${inner}</a>`;
  return `<a href="#news" data-anchor="${esc(t.anchor)}"${tt}>${inner}</a>`;
}
function picture(alt, src, ctx) {
  if (!SAFE_NAME.test(src) || !ctx.kind || !ctx.slug) return `<span class="nw-noimg">[picture: ${esc(alt || src)}]</span>`;
  const url = `/api/news/file?kind=${encodeURIComponent(ctx.kind)}&slug=${encodeURIComponent(ctx.slug)}&name=${encodeURIComponent(src)}`;
  return `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy">`;
}

// ---------- blocks: headings, paragraphs, lists, tables, quotes, code, rules ----------
const slugify = (s) => String(s).toLowerCase().replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w-]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const cells = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const starts = (line) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || /^ {0,3}>/.test(line) || LIST.test(line);

/**
 * A Markdown body as HTML. ctx: { kind, slug, block(name, json, n) } — block() returns the HTML for an interactive
 * block (by default a placeholder the page fills in: <div class="nb-slot" data-block data-n>).
 */
export function renderMarkdown(src, ctx = {}) {
  const state = { n: 0, ids: new Set() };
  return blocks(String(src ?? '').replace(/\r\n?/g, '\n').split('\n'), ctx, state);
}
function blocks(lines, ctx, state) {
  let out = '', i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = FENCE.exec(line))) {
      const close = new RegExp(`^ {0,3}${m[1][0]}{${m[1].length},}\\s*$`), body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      i++;
      const lang = m[2].toLowerCase(), text = body.join('\n');
      if (BLOCKS.includes(lang)) {
        const n = state.n++;
        out += ctx.block ? ctx.block(lang, text, n) : `<div class="nb-slot" data-block="${lang}" data-n="${n}"></div>`;
      } else out += `<pre class="nw-code"${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(text)}</code></pre>`;
      continue;
    }
    if ((m = HEADING.exec(line))) {
      const lvl = Math.max(2, m[1].length), html = inline(m[2], ctx);
      let id = slugify(html) || 'section', k = 2;
      while (state.ids.has(id)) id = `${slugify(html)}-${k++}`;
      state.ids.add(id);
      out += `<h${lvl} id="nw-${id}">${html}</h${lvl}>`; i++; continue;
    }
    if (RULE.test(line)) { out += '<hr>'; i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const q = [];
      while (i < lines.length && lines[i].trim() && /^ {0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      out += `<blockquote>${blocks(q, ctx, state)}</blockquote>`; continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = cells(line), align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c, ctx)}</${tag}>`;
      out += `<div class="nw-table"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => td('td', r[k] ?? '', k)).join('')}</tr>`).join('')}</tbody></table></div>`;
      continue;
    }
    if ((m = LIST.exec(line))) { const r = list(lines, i, ctx, state); out += r.html; i = r.next; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && starts(lines[i])) && !(para.length && lines[i].includes('|') && TABLE_SEP.test(lines[i + 1] || ''))) para.push(lines[i++]);
    out += `<p>${para.map((l, k) => inline(l.trim(), ctx) + (k < para.length - 1 ? (/( {2}|\\)$/.test(l) ? '<br>' : ' ') : '')).join('').replace(/\\<br>/g, '<br>')}</p>`;
  }
  return out;
}
function list(lines, i, ctx, state) {
  const first = LIST.exec(lines[i]), indent = first[1].length, ordered = /\d/.test(first[2]);
  const items = [];
  let loose = false;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
    const pad = indent + m[2].length + 1, body = [m[3]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        const nx = lines[i + 1] || '';
        if (nx.trim() && (nx.length - nx.trimStart().length) >= pad) { body.push(''); loose = true; i++; continue; }
        break;
      }
      const lead = l.length - l.trimStart().length, lm = LIST.exec(l);
      if (lm && lead <= indent) break;
      if (lead < pad && !lm && starts(l)) break;
      body.push(lead >= pad ? l.slice(pad) : l.trimStart());
      i++;
    }
    items.push(body);
    const nx = LIST.exec(lines[i + 1] || '');
    if (i < lines.length && !lines[i].trim() && nx && nx[1].length === indent && /\d/.test(nx[2]) === ordered) { loose = true; i++; }
  }
  const start = ordered ? parseInt(first[2], 10) : 1;
  const html = items.map((b) => {
    let h = blocks(b, ctx, state);
    if (!loose) h = h.replace(/^<p>([\s\S]*?)<\/p>/, '$1');
    return `<li>${h}</li>`;
  }).join('');
  return { html: ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${html}</ol>` : `<ul>${html}</ul>`, next: i };
}

// ---------- numbers ----------
const decimals = (n) => { const s = String(n), k = s.indexOf('.'); return k < 0 || /e/i.test(s) ? 0 : Math.min(4, s.length - k - 1); };
/** A number as people read it: 1,234 or 0.039, with the decimals it was written with (or `d`). */
export const fmt = (n, d = decimals(n)) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
/** A value with its unit: $0.04, 40%, 176 tests. */
export function withUnit(text, unit) {
  const u = String(unit ?? '');
  if (!u) return text;
  if (/^[$€£¥]$/.test(u)) return u + text;
  return /^[A-Za-z]/.test(u) ? `${text} ${u}` : text + u;
}
/** Round grid lines for a range: { lo, hi, step, ticks }. */
export function niceTicks(lo, hi, count = 5) {
  if (!(hi > lo)) { hi = lo + (lo === 0 ? 1 : Math.abs(lo)); }
  const raw = (hi - lo) / Math.max(1, count), mag = 10 ** Math.floor(Math.log10(raw)), n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let v = a; v <= b + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return { lo: a, hi: b, step, ticks };
}
const tickText = (v, step) => fmt(v, Math.min(4, Math.max(0, -Math.floor(Math.log10(step) + 1e-9))));

// ---------- the blocks, at rest ----------
/** The HTML of one interactive block, complete at rest. width: the space it has, for the drawn ones. */
export function blockHtml(name, d, width = 720) {
  const data = d && typeof d === 'object' ? d : {};
  switch (name) {
    case 'stat': return statHtml(data);
    case 'chart': return `<figure class="nb nb-chart" data-type="${esc(data.type)}">${data.title ? `<figcaption>${esc(data.title)}${data.unit ? ` <small>${esc(data.unit)}</small>` : ''}</figcaption>` : ''}${chartLegend(data)}<div class="nb-draw-box">${chartSvg(data, width)}</div></figure>`;
    case 'timeline': return timelineHtml(data);
    case 'lanes': return `<div class="nb nb-lanes"><div class="nb-legend"><span><i class="lg-build"></i>building</span><span><i class="lg-review"></i>in review</span><span><i class="lg-back"></i>sent back</span><span class="nb-range">${esc(data.start)} → ${esc(data.end)}</span></div><div class="nb-draw-box">${lanesSvg(data, width)}</div><div class="nb-lane-card" aria-live="polite">${laneCard(data, firstDetail(data))}</div></div>`;
    case 'flow': return `<div class="nb nb-flow"><div class="nb-flow-bar"><p class="nb-flow-cap" aria-live="polite">${flowRestCap(data)}</p><button type="button" class="nb-btn nb-play">▶ Play</button></div><div class="nb-draw-box">${flowSvg(data, width)}</div></div>`;
    case 'compare': return compareHtml(data);
    case 'matrix': return matrixHtml(data);
    case 'ledger': return `<div class="nb nb-ledger">${arr(data.rows).map((r) => `<div class="nb-lg"><div class="lg-gain"><span class="k">Gained</span><b>${esc(r.gain)}</b>${r.gainText ? `<p>${inline(r.gainText)}</p>` : ''}</div><div class="lg-cost"><span class="k">Cost</span><b>${esc(r.cost)}</b>${r.costText ? `<p>${inline(r.costText)}</p>` : ''}${r.mitigation ? `<span class="lg-mit"><b>Kept small by:</b> ${inline(r.mitigation)}</span>` : ''}</div></div>`).join('')}</div>`;
    case 'terminal': return `<div class="nb nb-term"><div class="nb-term-top"><i></i><i></i><i></i><span>${esc(data.title || 'Terminal')}</span><button type="button" class="nb-term-replay">Replay</button></div><pre class="nb-term-out">${termLines(arr(data.lines))}</pre></div>`;
    case 'callout': return `<aside class="nb nb-callout" data-tone="${['info', 'warn', 'good'].includes(data.tone) ? data.tone : 'info'}"><b>${esc(data.title)}</b>${data.text ? `<p>${inline(data.text)}</p>` : ''}</aside>`;
    case 'local': return `<div class="nb nb-local" data-view="${esc(data.view)}"><p class="nb-local-wait">Reading the numbers on this computer…</p></div>`;
    default: return blockError(name, 'is not a block QuorX knows');
  }
}
export const blockError = (name, msg) => `<div class="nb nb-error" role="note"><b>This ${esc(name)} block can't be shown.</b> <span>${esc(msg)}</span></div>`;

function statHtml(d) {
  return `<div class="nb nb-stat">${arr(d.items).map((it, i) => {
    const from = num(it.from), to = num(it.to), max = Math.max(Math.abs(from), Math.abs(to)) || 1;
    const up = to >= from;
    return `<div class="nb-move"><span class="k">${esc(it.label)}</span><div class="v"><span class="from">${esc(withUnit(fmt(from), it.unit))}</span><span class="arrow" aria-hidden="true">→</span><span class="to" data-count="${to}" data-dec="${decimals(to)}" data-unit="${esc(it.unit ?? '')}">${esc(withUnit(fmt(to), it.unit))}</span></div><div class="nb-bars" title="${esc(`${fmt(from)} before, ${fmt(to)} after`)}"><i class="b0 nb-grow" style="width:${r1((Math.abs(from) / max) * 100)}%;--i:${i}"></i><i class="b1 nb-grow${up ? '' : ' down'}" style="width:${r1((Math.abs(to) / max) * 100)}%;--i:${i}"></i></div></div>`;
  }).join('')}</div>`;
}

function chartLegend(d) {
  const s = arr(d.series);
  if (d.type === 'pairs') return `<div class="nb-legend">${s.map((x, k) => `<span><i class="sw ${k ? 'after' : 'before'}"></i>${esc(x.name)}</span>`).join('')}</div>`;
  return s.length > 1 ? `<div class="nb-legend">${s.map((x, k) => `<span><i class="sw s${k % 4}"></i>${esc(x.name)}</span>`).join('')}</div>` : '';
}

/** A chart drawn to scale: line, grouped bars, or before/after pairs, with its grid and labels. */
export function chartSvg(d, width = 720) {
  const W = Math.max(280, Math.round(width)), narrow = W < 520, x = arr(d.x), series = arr(d.series).filter((s) => Array.isArray(s.values));
  if (!x.length || !series.length) return '';
  const unit = d.unit ? ` ${d.unit}` : '';
  const label = `${d.title ? `${d.title}: ` : ''}${series.map((s) => `${s.name} ${s.values.map((v, k) => `${x[k]} ${v}`).join(', ')}`).join('; ')}${unit}`;
  if (d.type === 'pairs') return pairsSvg(d, x, series, W, narrow, label);
  const all = series.flatMap((s) => s.values.map(num));
  let lo = Math.min(...all), hi = Math.max(...all);
  if (d.type !== 'line' || (lo >= 0 && lo <= hi * 0.5)) lo = Math.min(0, lo);
  if (d.type !== 'line') hi = Math.max(0, hi);
  const sc = niceTicks(lo, hi, narrow ? 4 : 5);
  const H = narrow ? 230 : 270, T = 22, B = 34;
  const L = clamp(Math.max(...sc.ticks.map((t) => tickText(t, sc.step).length)) * 7 + 14, 30, 90), R = 14;
  const sy = (v) => r1(T + (1 - (v - sc.lo) / (sc.hi - sc.lo)) * (H - T - B));
  let s = '';
  for (const t of sc.ticks) s += `<line class="grid${t === 0 ? ' zero' : ''}" x1="${L}" x2="${W - R}" y1="${sy(t)}" y2="${sy(t)}"/><text class="tk" x="${L - 8}" y="${sy(t) + 4}" text-anchor="end">${esc(tickText(t, sc.step))}</text>`;
  const plotW = W - L - R, every = Math.max(1, Math.ceil(x.length / Math.max(2, Math.floor(plotW / (narrow ? 52 : 64)))));
  if (d.type === 'line') {
    const sx = (k) => r1(x.length === 1 ? L + plotW / 2 : L + (k / (x.length - 1)) * plotW);
    x.forEach((lab, k) => { if (k % every === 0 || k === x.length - 1) s += `<text class="tk" x="${sx(k)}" y="${H - 12}" text-anchor="middle">${esc(lab)}</text>`; });
    const showVals = x.length <= (narrow ? 8 : 14) && series.length <= 2;
    series.forEach((se, si) => {
      const pts = se.values.map((v, k) => [sx(k), sy(num(v))]);
      let len = 0; for (let k = 1; k < pts.length; k++) len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      if (series.length === 1) s += `<polygon class="area s${si % 4}" points="${pts[0][0]},${sy(Math.max(sc.lo, 0))} ${pts.map((p) => p.join(',')).join(' ')} ${pts[pts.length - 1][0]},${sy(Math.max(sc.lo, 0))}"/>`;
      s += `<polyline class="ln s${si % 4} nb-line" style="--len:${Math.ceil(len) + 2}" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
      pts.forEach(([px, py], k) => {
        const last = k === pts.length - 1;
        s += `<circle class="pt s${si % 4}${last ? ' end' : ''}" cx="${px}" cy="${py}" r="${last ? 4.5 : 3.5}"><title>${esc(`${se.name}, ${x[k]}: ${fmt(num(se.values[k]))}${unit}`)}</title></circle>`;
        if (showVals || last) s += `<text class="val" x="${px}" y="${r1(py - 9 - si * 0)}" text-anchor="middle">${esc(fmt(num(se.values[k])))}</text>`;
      });
    });
  } else {
    const band = plotW / x.length, gap = Math.min(10, band * 0.18), bw = Math.max(2, (band - gap * 2) / series.length), zero = sy(Math.max(sc.lo, Math.min(0, sc.hi)));
    const showVals = x.length * series.length <= (narrow ? 12 : 28) && bw >= 14;
    x.forEach((lab, k) => {
      const bx = L + k * band;
      if (k % every === 0 || k === x.length - 1) s += `<text class="tk" x="${r1(bx + band / 2)}" y="${H - 12}" text-anchor="middle">${esc(lab)}</text>`;
      series.forEach((se, si) => {
        const v = num(se.values[k]), y = sy(v), top = Math.min(y, zero), h = Math.max(1, Math.abs(zero - y));
        const rx = r1(bx + gap + si * bw);
        s += `<rect class="bar s${si % 4} nb-grow-y${v < 0 ? ' neg' : ''}" style="--i:${k}" x="${rx}" y="${r1(top)}" width="${r1(bw - (series.length > 1 ? 2 : 0))}" height="${r1(h)}" rx="2.5"><title>${esc(`${se.name}, ${lab}: ${fmt(v)}${unit}`)}</title></rect>`;
        if (showVals) s += `<text class="val" x="${r1(rx + bw / 2 - 1)}" y="${r1(v < 0 ? top + h + 13 : top - 5)}" text-anchor="middle">${esc(fmt(v))}</text>`;
      });
    });
  }
  return `<svg class="nb-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${s}</svg>`;
}
function pairsSvg(d, x, series, W, narrow, label) {
  const [a, b] = series, vals = [...a.values, ...b.values].map(num);
  const sc = niceTicks(Math.min(0, ...vals), Math.max(0, ...vals), narrow ? 4 : 6);
  const LAB = narrow ? 0 : clamp(Math.max(...x.map((l) => String(l).length)) * 7 + 16, 80, 220), L = narrow ? 8 : LAB, R = 46;
  const ROW = narrow ? 64 : 52, T = 12, H = T + x.length * ROW + 30;
  const sx = (v) => r1(L + ((v - sc.lo) / (sc.hi - sc.lo)) * (W - L - R)), zero = sx(0);
  let s = '';
  for (const t of sc.ticks) s += `<line class="grid${t === 0 ? ' zero' : ''}" x1="${sx(t)}" x2="${sx(t)}" y1="${T - 4}" y2="${H - 26}"/><text class="tk" x="${sx(t)}" y="${H - 10}" text-anchor="middle">${esc(tickText(t, sc.step))}</text>`;
  x.forEach((lab, k) => {
    const y = T + k * ROW + (narrow ? 18 : 6), va = num(a.values[k]), vb = num(b.values[k]);
    s += `<text class="lab" x="${narrow ? L : 0}" y="${narrow ? y - 6 : y + 18}">${esc(lab)}</text>`;
    s += `<rect class="bar before nb-grow" style="--i:${k}" x="${Math.min(zero, sx(va))}" y="${y}" width="${Math.max(1, Math.abs(sx(va) - zero))}" height="12" rx="3"><title>${esc(`${a.name}, ${lab}: ${fmt(va)}`)}</title></rect><text class="tk" x="${r1(Math.max(zero, sx(va)) + 6)}" y="${y + 10}">${esc(fmt(va))}</text>`;
    s += `<rect class="bar after nb-grow" style="--i:${k}" x="${Math.min(zero, sx(vb))}" y="${y + 16}" width="${Math.max(1, Math.abs(sx(vb) - zero))}" height="16" rx="3"><title>${esc(`${b.name}, ${lab}: ${fmt(vb)}`)}</title></rect><text class="val" x="${r1(Math.max(zero, sx(vb)) + 6)}" y="${y + 29}">${esc(fmt(vb))}</text>`;
  });
  return `<svg class="nb-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${s}</svg>`;
}

function timelineHtml(d) {
  const items = arr(d.items);
  return `<ol class="nb nb-tl${items.length > 5 ? ' tall' : ''}" style="--n:${Math.max(1, Math.min(5, items.length))}">${items.map((it, i) => `<li style="--i:${i}"><time>${esc(it.when)}</time><b>${esc(it.title)}</b>${it.text ? `<p>${inline(it.text)}</p>` : ''}${it.tag ? `<span class="nb-tag">${esc(it.tag)}</span>` : ''}</li>`).join('')}</ol>`;
}

// ---------- lanes (Gantt) ----------
const toMin = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const hm = (v) => `${String(Math.floor(((v % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((v % 60) + 60) % 60).padStart(2, '0')}`;
function laneSpan(d) {
  const s0 = toMin(d.start) ?? 0;
  let e0 = toMin(d.end) ?? s0 + 60; if (e0 <= s0) e0 += 1440;
  const at = (t) => { let v = toMin(t); if (v == null) return null; if (v < s0 - 1) v += 1440; return v; };
  return { s0, e0, at };
}
const firstDetail = (d) => Math.max(0, arr(d.rows).findIndex((r) => r.detail));
const times = (p) => (Array.isArray(p) && p.length === 2 ? `${esc(p[0])}–${esc(p[1])}` : '');
/** The card under a lanes chart for row i. */
export function laneCard(d, i) {
  const r = arr(d.rows)[i];
  if (!r) return '';
  const bits = [`building ${times(r.build)}`];
  if (r.review) bits.push(`review ${times(r.review)}`);
  if (r.back) bits.push(`sent back ${r.back === 1 ? 'once' : `${esc(r.back)}×`}`);
  return `<b>${esc(r.label)}</b><span class="nums">${bits.join(' · ')}</span>${r.detail ? `<p>${inline(r.detail)}</p>` : ''}`;
}
export function lanesSvg(d, width = 720) {
  const rows = arr(d.rows), W = Math.max(300, Math.round(width)), narrow = W < 560, { s0, e0, at } = laneSpan(d);
  const LAB = narrow ? 0 : clamp(Math.max(0, ...rows.map((r) => String(r.label).length)) * 7 + 20, 90, 260);
  const X0 = narrow ? 10 : LAB, X1 = W - 14, ROW = narrow ? 48 : 34, TOP = 30, BAR = 20;
  const sx = (v) => r1(X0 + ((v - s0) / (e0 - s0)) * (X1 - X0));
  const span = e0 - s0, room = narrow ? 4 : Math.max(4, Math.floor((X1 - X0) / 70));
  const step = [5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720].find((m) => span / m <= room) || 1440;
  let s = '';
  for (let t = Math.ceil(s0 / step) * step; t <= e0; t += step) s += `<line class="grid" x1="${sx(t)}" x2="${sx(t)}" y1="${TOP - 8}" y2="${TOP + rows.length * ROW}"/><text class="tk" x="${sx(t)}" y="${TOP - 14}" text-anchor="middle">${hm(t)}</text>`;
  rows.forEach((r, i) => {
    const y = TOP + i * ROW + (narrow ? 20 : 6);
    const b0 = at(r.build?.[0]) ?? s0, b1 = at(r.build?.[1]) ?? b0;
    const v0 = r.review ? at(r.review[0]) ?? b1 : null, v1 = r.review ? at(r.review[1]) ?? v0 : null;
    const end = v1 ?? b1, back = Math.max(0, Math.min(9, Math.floor(num(r.back))));
    s += `<g class="nb-lane" data-i="${i}" tabindex="0" role="button" aria-label="${esc(`${r.label}: show its detail`)}">`;
    s += `<rect class="hit" x="0" y="${TOP + i * ROW}" width="${W}" height="${ROW}"/>`;
    s += `<text class="lab" x="${narrow ? X0 : 10}" y="${narrow ? y - 6 : y + 14}">${esc(r.label)}</text>`;
    s += `<rect class="g-build nb-grow" style="--i:${i}" x="${sx(b0)}" y="${y}" width="${Math.max(2, r1(sx(b1) - sx(b0)))}" height="${BAR}" rx="5"/>`;
    if (v0 != null) {
      s += `<rect class="g-review nb-grow" style="--i:${i}" x="${sx(v0)}" y="${y + 3}" width="${Math.max(3, r1(sx(v1) - sx(v0)))}" height="${BAR - 6}" rx="4"/>`;
      for (let k = 0; k < back; k++) s += `<rect class="g-back" x="${r1(sx(v0) + (sx(v1) - sx(v0)) * ((k + 1) / (back + 1)) - 2)}" y="${y - 1}" width="4" height="${BAR + 2}" rx="1.5"/>`;
    }
    s += `<circle class="g-end" cx="${sx(end)}" cy="${y + BAR / 2}" r="5.5"/></g>`;
  });
  const H = TOP + rows.length * ROW + 10;
  return `<svg class="nb-svg nb-gantt" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="${esc(`Lanes from ${d.start} to ${d.end}: ${rows.length} rows. Each row is a button that shows its detail.`)}">${s}</svg>`;
}

// ---------- flow ----------
const flowRestCap = (d) => `<b>${arr(d.nodes).length} steps${arr(d.loops).length ? `, ${arr(d.loops).length} loop${arr(d.loops).length > 1 ? 's' : ''} back` : ''}.</b> Press Play to walk through them.`;
/** What the flow's caption says while step k is lit. */
export function flowCap(d, k) {
  const n = arr(d.nodes)[k];
  if (!n) return flowRestCap(d);
  return `<span class="nb-flow-n">${k + 1}/${arr(d.nodes).length}</span> <b>${esc(n.title)}.</b> ${n.cap ? inline(n.cap) : esc(n.sub || '')}`;
}
function wrap(text, max, lines) {
  const words = String(text).split(/\s+/).filter(Boolean), out = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w; else if ((cur + ' ' + w).length <= max) cur += ' ' + w; else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > lines) { out.length = lines; out[lines - 1] = out[lines - 1].slice(0, Math.max(1, max - 1)) + '…'; }
  return out.map((l) => (l.length > max ? l.slice(0, max - 1) + '…' : l));
}
/** Where each flow node sits: rows that snake left to right, then right to left; one column when narrow. */
export function flowLayout(n, W) {
  const narrow = W < 560;
  let per = narrow ? 1 : Math.min(n, W >= 940 ? 5 : W >= 720 ? 4 : 3);
  const rows = Math.ceil(n / per); per = Math.ceil(n / rows);
  const side = narrow ? 70 : 34, gap = 22, nodeW = narrow ? Math.min(320, W - side - 40) : Math.min(180, (W - side * 2 - gap * (per - 1)) / per);
  const rowH = narrow ? 96 : 150, top = narrow ? 40 : 56;
  const pos = [];
  for (let k = 0; k < n; k++) {
    const r = Math.floor(k / per), c = k % per, col = r % 2 ? per - 1 - c : c;
    const x = narrow ? 20 + nodeW / 2 : side + nodeW / 2 + col * (nodeW + gap) + (W - side * 2 - per * nodeW - (per - 1) * gap) / 2;
    pos.push({ x: r1(x), y: top + r * rowH, r, col });
  }
  return { pos, nodeW: r1(nodeW), narrow, H: top + (rows - 1) * rowH + (narrow ? 60 : 84), per };
}
export function flowSvg(d, width = 720) {
  const nodes = arr(d.nodes), W = Math.max(300, Math.round(width));
  if (nodes.length < 2) return '';
  const { pos, nodeW, narrow, H } = flowLayout(nodes.length, W);
  const maxT = Math.max(6, Math.floor((nodeW - 18) / 7.6)), maxS = Math.max(6, Math.floor((nodeW - 14) / 6.3));
  const boxes = nodes.map((n) => { const t = wrap(n.title, maxT, 2); return { t, s: n.sub ? wrap(n.sub, maxS, 1)[0] : '', h: 50 + (t.length - 1) * 16 + (n.sub ? 0 : -12) }; });
  // The path through every node in order; between rows it bends round the outside.
  let p = `M ${pos[0].x} ${pos[0].y}`;
  for (let k = 1; k < pos.length; k++) {
    const a = pos[k - 1], b = pos[k];
    if (a.r === b.r) p += ` L ${b.x} ${b.y}`;
    else {
      const out = narrow ? 0 : (a.r % 2 ? -1 : 1) * (nodeW / 2 + 26);
      p += narrow ? ` L ${b.x} ${b.y}` : ` C ${r1(a.x + out)} ${a.y} ${r1(b.x + out)} ${b.y} ${b.x} ${b.y}`;
    }
  }
  let s = `<path class="edge" d="${p}"/><path class="edge lit" d="${p}"/>`;
  const ids = new Map(nodes.map((n, k) => [n.id, k]));
  for (const l of arr(d.loops)) {
    const a = ids.get(l.from), b = ids.get(l.to);
    if (a == null || b == null || a === b) continue;
    const A = pos[a], Bp = pos[b];
    let path, lx, ly;
    if (narrow) {
      const xr = A.x + nodeW / 2, bend = xr + 30 + 8 * Math.min(3, Math.abs(a - b));
      path = `M ${xr} ${A.y} C ${bend} ${A.y} ${bend} ${Bp.y} ${xr + 4} ${Bp.y}`; lx = bend - 4; ly = (A.y + Bp.y) / 2;
    } else if (A.r === Bp.r) {
      const dir = A.r === 0 ? -1 : 1, yy = A.y + dir * (boxes[a].h / 2 + 34);
      path = `M ${A.x} ${r1(A.y + dir * boxes[a].h / 2)} C ${A.x} ${yy} ${Bp.x} ${yy} ${Bp.x} ${r1(Bp.y + dir * (boxes[b].h / 2 + 4))}`; lx = (A.x + Bp.x) / 2; ly = yy + dir * -2 + (dir < 0 ? -2 : 12);
    } else {
      const midY = (A.y + Bp.y) / 2, up = Bp.y < A.y ? -1 : 1;
      path = `M ${A.x} ${r1(A.y + up * boxes[a].h / 2)} C ${A.x} ${midY} ${Bp.x} ${midY} ${Bp.x} ${r1(Bp.y - up * (boxes[b].h / 2 + 4))}`; lx = (A.x + Bp.x) / 2; ly = midY - 6;
    }
    s += `<path class="loop" d="${path}" marker-end="url(#nb-arrow)"/>`;
    if (l.label) s += `<text class="note" x="${r1(lx)}" y="${r1(ly)}" text-anchor="${narrow ? 'end' : 'middle'}">${esc(wrap(l.label, narrow ? 18 : 30, 1)[0])}</text>`;
  }
  nodes.forEach((n, k) => {
    const { x, y } = pos[k], b = boxes[k], top = y - b.h / 2;
    s += `<g class="node${n.new ? ' new' : ''}" data-k="${k}"><rect x="${r1(x - nodeW / 2)}" y="${r1(top)}" width="${nodeW}" height="${b.h}" rx="10"/>`;
    s += `<circle class="numdot" cx="${r1(x - nodeW / 2 + 12)}" cy="${r1(top)}" r="9"/><text class="num" x="${r1(x - nodeW / 2 + 12)}" y="${r1(top + 3.5)}" text-anchor="middle">${k + 1}</text>`;
    b.t.forEach((line, li) => { s += `<text class="t" x="${x}" y="${r1(top + 22 + li * 16)}" text-anchor="middle">${esc(line)}</text>`; });
    if (b.s) s += `<text class="s" x="${x}" y="${r1(top + 22 + b.t.length * 16)}" text-anchor="middle">${esc(b.s)}</text>`;
    if (n.new) s += `<text class="newtag" x="${r1(x + nodeW / 2 - 6)}" y="${r1(top - 6)}" text-anchor="end">NEW</text>`;
    s += '</g>';
  });
  s += '<circle class="halo" r="15" cx="0" cy="0" opacity="0"/><circle class="tok" r="7" cx="0" cy="0" opacity="0"/>';
  const defs = '<defs><marker id="nb-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1 L9 5 L0 9 z" class="arrowhead"/></marker></defs>';
  const label = `Flow: ${nodes.map((n, k) => `${k + 1}. ${n.title}`).join(', ')}${arr(d.loops).length ? `; loops: ${arr(d.loops).map((l) => `${l.from} back to ${l.to}${l.label ? ` (${l.label})` : ''}`).join(', ')}` : ''}`;
  return `<svg class="nb-svg nb-flow-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${defs}${s}</svg>`;
}

// ---------- compare ----------
/** The steps and verdict of one compare option. */
export function compareBody(d, o) {
  const opt = arr(d.options)[o] || {}, first = o === 0 && arr(d.options).length === 2;
  const steps = arr(opt.steps).map((st, i) => `<li class="${st.bad ? 'bad' : ''}" style="--i:${i}"><span class="n">${i + 1}</span><div><b>${esc(st.title)}</b>${st.text ? `<span>${inline(st.text)}</span>` : ''}</div></li>`).join('');
  const v = opt.verdict || {};
  return `<ol class="nb-steps${first ? ' before' : ''}">${steps}</ol><div class="nb-verdict${first ? ' before' : ''}"><b>${esc(v.title)}</b>${v.text ? `<p>${inline(v.text)}</p>` : ''}</div>`;
}
function compareHtml(d) {
  const opts = arr(d.options), cur = Math.max(0, opts.length - 1);
  return `<div class="nb nb-compare" data-o="${cur}"><div class="nb-cmp-bar">${d.prompt ? `<div class="nb-cmp-ask">› ${esc(d.prompt)}</div>` : ''}<div class="nb-seg" role="group" aria-label="Which version">${opts.map((o, k) => `<button type="button" data-o="${k}" aria-pressed="${k === cur}"${k === 0 && opts.length === 2 ? ' class="before"' : ''}>${esc(o.label)}</button>`).join('')}</div></div><div class="nb-cmp-body">${compareBody(d, cur)}</div></div>`;
}

// ---------- matrix ----------
const KNOWN_LEVELS = ['proven', 'tested', 'wired', 'next'];
function matrixHtml(d) {
  const levels = arr(d.levels), rows = arr(d.rows), cols = arr(d.columns);
  const label = new Map(levels.map((l) => [l.id, l.label]));
  const tag = (id) => `<span class="nb-level" data-l="${KNOWN_LEVELS.includes(id) ? id : 'other'}">${esc(label.get(id) || id)}</span>`;
  const count = (id) => rows.filter((r) => r.level === id).length;
  const seg = `<div class="nb-seg nb-filter" role="group" aria-label="Show rows by level"><button type="button" data-f="all" aria-pressed="true">All <b>${rows.length}</b></button>${levels.map((l) => `<button type="button" data-f="${esc(l.id)}" aria-pressed="false">${esc(l.label)} <b>${count(l.id)}</b></button>`).join('')}</div>`;
  const at = cols.length > 1 ? 1 : cols.length; // the level sits after the first column
  const head = [...cols.slice(0, at).map(esc), 'Level', ...cols.slice(at).map(esc)];
  const body = rows.map((r) => {
    const c = arr(r.cells).map((x, k) => `<td${k === 0 ? ' class="first"' : ''}>${inline(x)}</td>`);
    c.splice(at, 0, `<td class="lvl">${tag(r.level)}</td>`);
    return `<tr data-l="${esc(r.level)}">${c.join('')}</tr>`;
  }).join('');
  return `<div class="nb nb-matrix">${seg}<div class="nb-tbl"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div><p class="nb-matrix-none" hidden>No rows at this level.</p></div>`;
}

// ---------- terminal ----------
/** The terminal's lines, all of them (its state at rest). */
export function termLines(lines) {
  return lines.map((l) => (typeof l.cmd === 'string' ? `<span class="ps">&gt;</span> ${esc(l.cmd)}` : `<span class="out">${esc(l.out)}</span>`)).join('\n') + '\n<span class="ps">&gt;</span> <span class="cur"></span>';
}

// ---------- numbers from this computer ----------
const LOCAL_EMPTY = {
  models: ['How each model did', 'Once a few models have run replies here, this shows how each one did on this computer: replies, how often its work passed the checks, and what a reply cost and took.'],
  deciders: ['What asking the deciders changed', 'Once the deciders have voted in chats here, this shows how often asking them confirmed the agent, changed its answer, or changed nothing.'],
  costs: ['What QuorX cost here', 'Once QuorX has been used here for a few days, this shows what it cost each day and which models the money went to.'],
  tests: ['Test results', 'Once npm test, npm run test:packs or the UI test has run on this computer, the latest results show here.'],
};
const money = (v) => `$${num(v).toFixed(num(v) && num(v) < 0.1 ? 4 : 2)}`;
const pct = (v) => (v == null || v === '' ? '—' : `${Math.round(num(v) <= 1 ? num(v) * 100 : num(v))}%`);
const table = (head, rows) => `<div class="nb-tbl"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, k) => `<td${k ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
/** A local block's content from /api/news/local, or the friendly empty state. */
export function localHtml(view, r, width = 720) {
  const [title, why] = LOCAL_EMPTY[view] || ['Numbers from this computer', 'They show here once QuorX has some.'];
  const empty = `<div class="nb-local-empty"><b>${esc(title)}: nothing yet</b><p>${esc(why)} They come from this computer's own logs and never leave it.</p></div>`;
  if (!r || r.empty || r.error) return empty;
  const note = (t) => `<p class="nb-local-note">${esc(t)}</p>`;
  if (view === 'models' && arr(r.rows).length) return table(['Model', 'Replies', 'Passed checks', 'Avg cost', 'Avg steps', 'Looks before writing', 'Avg time'], arr(r.rows).map((x) => [String(x.model || '').split('/').pop(), fmt(num(x.replies), 0), pct(x.passRate), money(x.avgCost), fmt(num(x.avgSteps), 1), x.looksFirst == null ? '–' : fmt(num(x.looksFirst), 1), `${fmt(num(x.avgSeconds), 0)} s`])) + note(`From replies run on this computer${r.since ? ` since ${r.since}` : ''}, and only here.`);
  if (view === 'deciders' && num(r.questions)) {
    const it = ['confirmed', 'flipped', 'theater', 'unclear'].map((k) => ({ label: { confirmed: 'Confirmed the agent', flipped: 'Changed its answer', theater: 'Changed nothing (it was sure)', unclear: 'Couldn\'t settle it' }[k], from: 0, to: num(r[k]) }));
    return `<p class="nb-local-big"><b>${fmt(num(r.questions), 0)}</b> questions asked of the deciders</p>${statHtml({ items: it })}${arr(r.byModel).length ? table(['Decider', 'Votes', 'Agreed with the result'], arr(r.byModel).map((x) => [String(x.model || '').split('/').pop(), fmt(num(x.votes), 0), fmt(num(x.agreed), 0)])) : ''}`;
  }
  if (view === 'costs' && arr(r.days).length) {
    const days = arr(r.days).slice(-30);
    return `<div class="nb-draw-box">${chartSvg({ type: 'bar', x: days.map((x) => String(x.date || '').slice(5)), series: [{ name: 'Cost', values: days.map((x) => num(x.cost)) }], unit: 'USD' }, width)}</div>${arr(r.byModel).length ? table(['Model', 'Cost'], arr(r.byModel).map((x) => [String(x.model || '').split('/').pop(), money(x.cost)])) : ''}`;
  }
  if (view === 'tests') {
    const runs = Array.isArray(r) ? r : arr(r.runs).length ? arr(r.runs) : Object.entries(r).filter(([, v]) => v && typeof v === 'object').map(([name, v]) => ({ name, ...v }));
    if (runs.length) return table(['Run', 'Passed', 'Failed', 'When'], runs.map((x) => [x.name || x.kind || 'tests', x.passed ?? x.pass ?? '—', x.failed ?? x.fail ?? '—', x.at || x.when || x.date || ''].map(String)));
  }
  return empty;
}
