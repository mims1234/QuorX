// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// What the agent's browser does inside a page: wait until it is ready, read what is on screen, list what can be
// pointed at (a snapshot with refs), find things, scroll the part that scrolls, check a control before clicking it,
// and collect a feed while scrolling. One function, injected as source and run in the page (every transport: the
// headless browser, the desktop app's tabs and the user's Chrome), so it must not use anything from this module.
// It installs itself once per page under a symbol and keeps its refs there.

/* eslint-disable no-restricted-globals */
export function qxPage() {
  const KEY = Symbol.for('quorx.ops'), VERSION = 5;
  if (window[KEY] && window[KEY].v === VERSION) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  // The page and the same-origin frames inside it (other sites' frames can't be read from here).
  const docs = () => {
    const out = [document];
    for (let i = 0; i < out.length && out.length < 12; i++) {
      for (const f of out[i].querySelectorAll('iframe, frame')) { try { if (f.contentDocument && f.contentDocument.body) out.push(f.contentDocument); } catch (e) { /* another site */ } }
    }
    return out;
  };
  // Where an element is in the top page's view (a frame adds its own position).
  const offset = (el) => {
    let x = 0, y = 0, w = el.ownerDocument.defaultView;
    while (w && w !== window) { let fe = null; try { fe = w.frameElement; } catch (e) { break; } if (!fe) break; const r = fe.getBoundingClientRect(); x += r.left; y += r.top; w = w.parent; }
    return { x, y };
  };
  const rectOf = (el) => { const r = el.getBoundingClientRect(), o = offset(el); return { left: r.left + o.x, top: r.top + o.y, width: r.width, height: r.height, right: r.right + o.x, bottom: r.bottom + o.y }; };
  const styleOf = (el) => el.ownerDocument.defaultView.getComputedStyle(el);
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = styleOf(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.02;
  };
  const textOfIds = (el, ids) => ids.split(/\s+/).map((id) => el.ownerDocument.getElementById(id)).filter(Boolean).map((e) => e.innerText || e.textContent).join(' ');
  const nameOf = (el, n = 80) => {
    const a = el.getAttribute('aria-label'); if (a && a.trim()) return clean(a, n);
    const lb = el.getAttribute('aria-labelledby'); if (lb) { const t = clean(textOfIds(el, lb), n); if (t) return t; }
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      if (el.id) { const l = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && clean(l.innerText, n)) return clean(l.innerText, n); }
      const wrap = el.closest('label'); if (wrap && clean(wrap.innerText, n)) return clean(wrap.innerText, n);
      if (el.placeholder) return clean(el.placeholder, n);
      if (el.type === 'submit' || el.type === 'button') return clean(el.value, n);
    }
    if (el.tagName === 'IMG') return clean(el.alt || el.title, n);
    const t = clean(el.innerText || el.textContent, n); if (t) return t;
    const img = el.querySelector && el.querySelector('img[alt], svg[aria-label], [title]');
    return clean(el.title || (img && (img.getAttribute('alt') || img.getAttribute('aria-label') || img.getAttribute('title'))) || el.getAttribute('data-tooltip') || el.getAttribute('data-dnd-name') || '', n);
  };
  const ROLE_TAG = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button', H1: 'heading', H2: 'heading', H3: 'heading', ARTICLE: 'article', DIALOG: 'dialog', IMG: 'img', LI: 'listitem' };
  const roleOf = (el) => {
    const r = el.getAttribute('role'); if (r) return r.split(/\s+/)[0];
    if (el.tagName === 'INPUT') { const t = (el.type || 'text').toLowerCase(); return { checkbox: 'checkbox', radio: 'radio', submit: 'button', button: 'button', reset: 'button', image: 'button', range: 'slider', search: 'searchbox' }[t] || 'textbox'; }
    if (el.isContentEditable && el.getAttribute('contenteditable') != null) return 'textbox';
    return ROLE_TAG[el.tagName] || el.tagName.toLowerCase();
  };
  const ACT = 'a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=checkbox], [role=radio], [role=switch], [role=treeitem], [role=textbox], [role=combobox], [role=searchbox], [role=slider], [contenteditable=""], [contenteditable=true]';
  const ITEM = 'article, [role=article], [data-list-item-id], [role=listitem]';
  const TEXTY = 'h1, h2, h3, [role=heading], [role=alert], [role=status]';
  const GROUP = 'nav, main, aside, header, footer, form, dialog, [role=navigation], [role=main], [role=complementary], [role=banner], [role=search], [role=dialog], [role=region][aria-label], section[aria-label], [role=list][aria-label], [role=tree][aria-label]';
  const isAct = (el) => el.matches(ACT);
  const disabled = (el) => !!(el.disabled || el.closest('fieldset[disabled]') || el.closest('[aria-disabled="true"]'));
  const states = (el) => {
    const s = [];
    if (disabled(el)) s.push('disabled');
    if (el.checked || el.getAttribute('aria-checked') === 'true') s.push('checked');
    if (el.getAttribute('aria-selected') === 'true' || (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false')) s.push('selected');
    const ex = el.getAttribute('aria-expanded'); if (ex) s.push(ex === 'true' ? 'expanded' : 'collapsed');
    if (el === el.ownerDocument.activeElement) s.push('focused');
    if (/^(INPUT|TEXTAREA)$/.test(el.tagName) && el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'submit' && el.type !== 'button') {
      const v = el.type === 'password' ? (el.value ? '•••' : '') : clean(el.value, 60);
      if (v) s.push(`value "${v}"`);
    }
    if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) s.push(`value "${clean(el.selectedOptions[0].text, 40)}"`);
    if (el.tagName === 'A' && el.href && !/^javascript:/i.test(el.getAttribute('href') || '')) { try { const u = new URL(el.href); if (u.origin !== location.origin) s.push(`to ${u.host}`); } catch (e) { /* odd link */ } }
    return s.length ? ` [${s.join(', ')}]` : '';
  };
  const describe = (el) => `${roleOf(el)} "${nameOf(el, 50)}"`;
  const groupOf = (el) => { const g = el.closest(GROUP); return g ? `${roleOf(g)}${nameOf(g, 40) && (g.getAttribute('aria-label') || g.getAttribute('aria-labelledby')) ? ` "${nameOf(g, 40)}"` : ''}` : ''; };
  const openDialog = () => { for (const d of docs()) { const x = [...d.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal="true"]')].find(shown); if (x) return x; } return null; };

  // ---------- refs: one map per snapshot, the last few kept ----------
  const refs = { n: 0, maps: [] };
  const newMap = () => { const m = { n: ++refs.n, map: new Map(), next: 1, of: new WeakMap() }; refs.maps.push(m); if (refs.maps.length > 4) refs.maps.shift(); return m; };
  const latest = () => refs.maps[refs.maps.length - 1] || newMap();
  const refFor = (m, el) => { let id = m.of.get(el); if (!id) { id = `e${m.next++}`; m.map.set(id, el); m.of.set(el, id); } return id; };
  function resolve(ref) {
    const x = /^\s*(?:s(\d+):)?e(\d+)\s*$/i.exec(String(ref || ''));
    if (!x) return { err: `"${ref}" is not a ref: use one like s${refs.n || 1}:e12 from the latest snapshot` };
    const n = x[1] ? Number(x[1]) : refs.n;
    const m = refs.maps.find((z) => z.n === n);
    if (!m) return { err: `snapshot ${n} is too old (the newest is s${refs.n}): use a ref from the latest snapshot, or take a new one` };
    const el = m.map.get(`e${x[2]}`);
    if (!el) return { err: `there is no e${x[2]} in snapshot ${n}` };
    if (!el.isConnected) return { err: `${ref} is no longer on the page (it changed since snapshot ${n}): take a new snapshot or use find` };
    return { el, stale: n !== refs.n };
  }

  // ---------- ready: loaded, and quiet for a moment ----------
  // Quiet = no added or removed content and no new downloads for `quiet` ms. Attribute changes don't count:
  // spinners and clocks toggle them forever. At most `cap` ms, then it reports that the page is still changing.
  // A page that still shows almost nothing (a "Loading…" shell) has to stay quiet for 2 s instead.
  const thin = () => { const b = document.body; return !b || (b.innerText || '').trim().length < 200 && b.querySelectorAll(ACT).length < 5; };
  async function ready({ quiet = 500, cap = 10000, thinMs = 2000 } = {}) {
    const t0 = performance.now();
    let last = t0, res = performance.getEntriesByType('resource').length;
    const mo = new MutationObserver(() => { last = performance.now(); });
    try { mo.observe(document.documentElement || document, { childList: true, subtree: true, characterData: true }); } catch (e) { /* no document yet */ }
    try {
      while (performance.now() - t0 < cap) {
        await sleep(100);
        const n = performance.getEntriesByType('resource').length;
        if (n !== res) { res = n; last = performance.now(); }
        if (document.readyState !== 'loading' && performance.now() - last >= (thin() ? Math.max(quiet, thinMs) : quiet)) return { ms: Math.round(performance.now() - t0), quiet: true, thin: thin() };
      }
      return { ms: Math.round(performance.now() - t0), quiet: false };
    } finally { mo.disconnect(); }
  }

  // ---------- text on screen ----------
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|TITLE|svg)$/i;
  const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, article, section, div, td, th, dt, dd, blockquote, pre, label, button, a, [role=listitem], [role=article], [role=row]';
  function screenText({ max = 2500, margin = 0 } = {}) {
    const H = innerHeight, W = innerWidth, top = -margin * H, bottom = H + margin * H;
    const out = []; let chars = 0, more = false, lastBlock = null, line = '';
    const seen = new Map();
    const visible = (el) => { if (seen.has(el)) return seen.get(el); const v = shown(el); seen.set(el, v); return v; };
    const flush = () => { const t = clean(line, 600); if (t && out[out.length - 1] !== t) { out.push(t); chars += t.length + 1; } line = ''; };
    for (const d of docs()) {
      if (!d.body) continue;
      const tw = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
      for (let node = tw.nextNode(); node; node = tw.nextNode()) {
        const s = node.nodeValue; if (!s || !s.trim()) continue;
        const el = node.parentElement; if (!el || SKIP.test(el.tagName) || el.closest('svg, [aria-hidden="true"]')) continue;
        if (!visible(el)) continue;
        const r = rectOf(el);
        if (r.bottom < top || r.top > bottom || r.right < 0 || r.left > W) continue;
        const b = el.closest(BLOCK);
        if (b !== lastBlock) { flush(); lastBlock = b; }
        line += (line ? ' ' : '') + s;
        if (chars + line.length > max) { more = true; break; }
      }
      flush();
      if (more) break;
    }
    return { text: out.join('\n').slice(0, max), more };
  }
  function pageText({ offset = 0, max = 25000 } = {}) {
    const all = docs().map((d) => (d.body ? d.body.innerText : '')).join('\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
    const from = Math.max(0, Math.floor(offset) || 0);
    return { text: all.slice(from, from + max), from, to: Math.min(all.length, from + max), total: all.length };
  }

  // ---------- the snapshot ----------
  // seed: the tab's last snapshot number. A new page starts its refs after it, so a ref from the page before
  // (s3:e5) can never land on something else here: it is "too old".
  const seedTo = (seed) => { if (Number(seed) > refs.n) refs.n = Number(seed); };
  function snapshot({ detail = false, all = false, seed = 0 } = {}) {
    seedTo(seed);
    const m = newMap();
    const H = innerHeight, cap = detail ? 40000 : 9000;
    const lines = [];
    const dlg = openDialog();
    if (dlg) lines.push(`A dialog is open: ${describe(dlg)} (it may cover the page; close it or act inside it)`);
    const items = [];
    for (const d of docs()) {
      for (const el of d.querySelectorAll(`${ACT}, ${ITEM}, ${TEXTY}`)) {
        if (!shown(el)) continue;
        const r = rectOf(el);
        if (!all && (r.bottom < -H || r.top > 2 * H)) continue;
        items.push({ el, r });
      }
    }
    // Controls inside a feed item go on one line under it, so ten posts aren't sixty lines of buttons.
    const itemOf = (el) => (el.matches(ITEM) ? null : el.parentElement && el.parentElement.closest(ITEM));
    const under = new Map();
    let group = null, run = { role: '', count: 0, first: '', last: '' }, count = 0, cut = false, chars = 0;
    const push = (s) => { if (cut) return; if (chars + s.length > cap) { cut = true; return; } lines.push(s); chars += s.length + 1; };
    const endRun = () => { if (run.count > 0) push(`  … ${run.count} more ${run.role}s (${run.first}–${run.last}); scroll or use find to see them`); run = { role: '', count: 0, first: '', last: '' }; };
    let streak = { role: '', n: 0 };
    const listed = new Set(items.map((x) => x.el));
    for (const { el, r } of items) {
      const host = itemOf(el);
      if (host && listed.has(host)) { const list = under.get(host) || []; list.push(el); under.set(host, list); continue; }
      if (!isAct(el) && el.closest(ACT) && el.closest(ACT) !== el) continue; // a heading inside a button
      const g = groupOf(el);
      if (g !== group) { endRun(); group = g; if (g) push(`— ${g} —`); streak = { role: '', n: 0 }; }
      const id = refFor(m, el);
      count++;
      const role = roleOf(el);
      streak = streak.role === role ? { role, n: streak.n + 1 } : { role, n: 1 };
      const where = r.bottom < 0 ? ' (above)' : r.top > H ? ' (below)' : '';
      if (!detail && streak.n > 20 && el.matches(ITEM)) { if (!run.count) run.first = id; run.role = role; run.count++; run.last = id; continue; }
      if (run.count) endRun();
      const text = el.matches(ITEM) ? clean(el.innerText, detail ? 600 : 220) : nameOf(el);
      push(`${id} ${role}${text ? ` "${text.replace(/"/g, '\'')}"` : ''}${states(el)}${where}`);
    }
    endRun();
    // Second pass: the controls of each feed item, as one line of refs (refs are given in the order they appear).
    if (under.size) {
      const out = [];
      for (const line of lines) {
        out.push(line);
        const id = /^(e\d+) /.exec(line); if (!id) continue;
        const host = m.map.get(id[1]); const list = host && under.get(host);
        if (list && list.length) out.push(`    controls: ${list.slice(0, detail ? 30 : 8).map((c) => `${refFor(m, c)} ${roleOf(c) === 'link' ? 'link ' : ''}"${nameOf(c, 30).replace(/"/g, '\'')}"`).join(' · ')}${list.length > (detail ? 30 : 8) ? ` · +${list.length - (detail ? 30 : 8)} more` : ''}`);
      }
      lines.length = 0; lines.push(...out);
    }
    if (cut) lines.push(`… snapshot cut at ${cap} characters: scroll, use find, or ask for detail`);
    const frames = docs().length - 1;
    return { n: m.n, text: lines.join('\n'), count, thin: count < 4, frames, canvas: !!document.querySelector('canvas') && count < 12 };
  }

  // ---------- find ----------
  function find({ query = '', limit = 15, seed = 0 } = {}) {
    seedTo(seed);
    const q = clean(query, 120).toLowerCase();
    if (!q) return { lines: [], n: refs.n };
    const m = latest(), H = innerHeight, hits = [];
    for (const d of docs()) {
      for (const el of d.querySelectorAll(`${ACT}, ${ITEM}, ${TEXTY}, [aria-label], [title], [data-dnd-name], label, li, td, span, p`)) {
        const name = nameOf(el, 200).toLowerCase();
        if (!name.includes(q)) continue;
        if (el.children.length && [...el.children].some((c) => nameOf(c, 200).toLowerCase().includes(q) && !isAct(el))) continue; // the innermost match
        hits.push({ el, name, exact: name === q, vis: shown(el), act: isAct(el) || !!el.closest(ACT) });
      }
    }
    hits.sort((a, b) => (b.vis - a.vis) || (b.exact - a.exact) || (b.act - a.act) || (a.name.length - b.name.length));
    const lines = [];
    const used = new Set();
    for (const h of hits) {
      const target = isAct(h.el) ? h.el : h.el.closest(ACT) || h.el;
      if (used.has(target)) continue; used.add(target);
      const r = rectOf(target);
      const where = !h.vis ? 'hidden' : r.bottom < 0 ? `${Math.max(1, Math.round(-r.top / H))} screen(s) up` : r.top > H ? `${Math.max(1, Math.round(r.top / H))} screen(s) down` : 'on screen';
      lines.push(`s${m.n}:${refFor(m, target)} ${describe(target)}${states(target)} · ${where}${groupOf(target) ? ` · in ${groupOf(target)}` : ''}`);
      if (lines.length >= limit) break;
    }
    return { lines, n: m.n, total: hits.length };
  }

  // ---------- pointing: find the element, then check it can take the click ----------
  function locate({ ref, selector, text }) {
    if (ref) return resolve(ref);
    if (selector) { let el = null; try { el = document.querySelector(selector); } catch (e) { return { err: `"${selector}" is not a valid CSS selector` }; } return el ? { el } : { err: `nothing matches selector ${selector}` }; }
    const q = clean(text, 200).toLowerCase();
    if (!q) return { err: 'say what to act on: a ref from the snapshot, a selector, or text' };
    const cand = [];
    for (const d of docs()) for (const el of d.querySelectorAll(`${ACT}, label, li, div, span, [aria-label], [title], [data-dnd-name]`)) {
      const name = nameOf(el, 300).toLowerCase(); if (!name.includes(q)) continue;
      cand.push({ el, exact: name === q, vis: shown(el), act: isAct(el), len: name.length });
    }
    cand.sort((a, b) => (b.vis - a.vis) || (b.exact - a.exact) || (b.act - a.act) || (a.len - b.len));
    return cand.length ? { el: cand[0].el, others: cand.length - 1 } : { err: `nothing shows the text "${text}"` };
  }
  const near = (a, b) => Math.abs(a.left - b.left) < 1.5 && Math.abs(a.top - b.top) < 1.5 && Math.abs(a.width - b.width) < 1.5 && Math.abs(a.height - b.height) < 1.5;
  const topHit = (x, y) => { let d = document, hit = d.elementFromPoint(x, y), depth = 0; while (hit && /^(IFRAME|FRAME)$/.test(hit.tagName) && depth++ < 5) { let inner = null; try { inner = hit.contentDocument; } catch (e) { break; } if (!inner) break; const r = hit.getBoundingClientRect(); x -= r.left; y -= r.top; d = inner; hit = d.elementFromPoint(x, y); } return hit; };
  // Playwright's checks: visible, stable for two looks, the element (or a child) is what's under the point, enabled.
  async function point({ ref, selector, text, wait = 3000, need = 'click' } = {}) {
    const got = locate({ ref, selector, text });
    if (got.err) return { err: got.err };
    let el = got.el, why = '';
    if (!isAct(el) && el.closest(ACT)) el = el.closest(ACT);
    const t0 = performance.now();
    while (true) {
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { /* detached */ }
      const r1 = rectOf(el); await sleep(60); const r2 = rectOf(el);
      if (!el.isConnected) why = 'it left the page';
      else if (!shown(el)) why = 'it is not visible';
      else if (!near(r1, r2)) why = 'it is still moving';
      else if (need !== 'hover' && disabled(el)) why = 'it is disabled';
      else {
        const x = r2.left + r2.width / 2, y = r2.top + r2.height / 2;
        const hit = topHit(x, y);
        const ok = hit && (hit === el || el.contains(hit) || (el.control && el.control === hit) || (hit.tagName === 'LABEL' && hit.control === el));
        if (ok || need === 'type') return { x, y, what: describe(el), others: got.others || 0, stale: !!got.stale };
        why = `it is covered by ${hit ? describe(hit) : 'something'}${openDialog() ? ' (a dialog is open: close it or act inside it)' : ''}`;
      }
      if (performance.now() - t0 > wait) return { err: `can't ${need} ${describe(el)}: ${why}`, what: describe(el) };
      await sleep(120);
    }
  }
  function focus({ ref, selector, text }) {
    const got = locate({ ref, selector, text });
    if (got.err) return { err: got.err };
    const el = got.el;
    try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); el.focus(); } catch (e) { /* not focusable */ }
    return { what: describe(el), focused: el.ownerDocument.activeElement === el };
  }

  // The field a type or Enter would go into, and whether it is a search box (typing there only looks things up).
  function field({ ref, selector } = {}) {
    let el = null;
    if (ref) { const g = resolve(ref); if (g.err) return { err: g.err }; el = g.el; }
    else if (selector) { try { el = document.querySelector(selector); } catch (e) { return { err: `"${selector}" is not a valid CSS selector` }; } }
    else { el = document.activeElement; for (let i = 0; i < 5 && el && /^(IFRAME|FRAME)$/.test(el.tagName); i++) { try { el = el.contentDocument.activeElement; } catch (e) { break; } } }
    if (!el || el === document.body || el === document.documentElement) return { none: true, what: 'the page' };
    const r = roleOf(el), n = nameOf(el, 60);
    const hint = [el.type, r, n, el.name, el.placeholder, el.getAttribute('aria-label'), el.closest('[role=search], search') ? 'search' : ''].join(' ');
    return { what: `${r} "${n}"`, search: r === 'searchbox' || r === 'combobox' || /search|find|filter|jump to|quick ?switch|look ?up/i.test(hint) };
  }

  // ---------- scrolling the part that scrolls ----------
  const scroller = (start) => {
    let el = start;
    while (el && el !== el.ownerDocument.body && el !== el.ownerDocument.documentElement) {
      const s = styleOf(el);
      if (/(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 20) return el;
      el = el.parentElement || (el.ownerDocument.defaultView.frameElement || null);
    }
    return null;
  };
  const docH = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  function scroll({ dy, screens, ref } = {}) {
    let target = null;
    if (ref) { const g = resolve(ref); if (g.err) return { err: g.err }; target = scroller(g.el) || null; }
    const amount = (h) => (screens != null && Number(screens) ? Number(screens) * h * 0.85 : Number(dy) || h * 0.85);
    const winMoves = (d) => (d > 0 ? innerHeight + scrollY < docH() - 2 : scrollY > 0);
    const viaEl = (el) => {
      const b = el.scrollTop, d = amount(el.clientHeight);
      el.scrollBy({ top: d, behavior: 'instant' });
      return { moved: Math.round(el.scrollTop - b), what: describe(el), pos: [Math.round(el.scrollTop), el.scrollHeight, el.clientHeight], container: true };
    };
    if (target) return viaEl(target);
    const d = amount(innerHeight);
    if (winMoves(d)) {
      const b = scrollY; window.scrollBy({ top: d, behavior: 'instant' });
      if (scrollY !== b) return { moved: Math.round(scrollY - b), what: 'page', pos: [Math.round(scrollY), docH(), innerHeight] };
    }
    // The window can't go that way: scroll what sits under the middle of the screen (a chat list, a feed column).
    const mid = topHit(innerWidth / 2, innerHeight / 2);
    const el = mid && scroller(mid);
    if (el) return viaEl(el);
    // Nothing in the middle: the biggest scrollable area on the page.
    let best = null;
    for (const x of document.querySelectorAll('*')) { if (x.scrollHeight > x.clientHeight + 20 && /(auto|scroll|overlay)/.test(styleOf(x).overflowY) && shown(x) && (!best || x.clientHeight * x.clientWidth > best.clientHeight * best.clientWidth)) best = x; }
    if (best) return viaEl(best);
    return { moved: 0, what: 'nothing', pos: [Math.round(scrollY), docH(), innerHeight] };
  }

  // ---------- before/after an action ----------
  const hash = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
  function state() {
    const st = screenText({ max: 1500 }).text;
    const dlg = openDialog();
    const a = document.activeElement;
    return { url: location.href, title: document.title, sy: Math.round(scrollY), h: hash(st), len: st.length, dialog: dlg ? describe(dlg) : '', focus: a && a !== document.body ? describe(a) : '' };
  }

  // ---------- collecting a feed or a channel ----------
  const keyOf = (el) => {
    const id = el.getAttribute('data-list-item-id') || el.id; if (id) return id;
    const t = el.querySelector('time'); const link = t && t.closest('a[href]');
    if (link) return link.href;
    const a = el.querySelector('a[href*="/status/"], a[href*="/comments/"], a[href*="/p/"], a[href*="/watch"]'); if (a) return a.href;
    return `h${hash(clean(el.innerText, 300))}`;
  };
  function pickItems(item) {
    if (item) { try { return { sel: item, els: [...document.querySelectorAll(item)].filter(shown) }; } catch (e) { return { err: `"${item}" is not a valid CSS selector` }; } }
    let best = null;
    for (const sel of ['article', '[role=article]', '[data-list-item-id]', '[role=listitem]', 'li', '[data-testid=cellInnerDiv]']) {
      const els = [...document.querySelectorAll(sel)].filter((e) => shown(e) && clean(e.innerText, 40).length >= 20 && !e.parentElement.closest(sel));
      if (els.length >= 2 && (!best || els.length > best.els.length)) best = { sel, els };
    }
    return best || { sel: '', els: [] };
  }
  function collect({ item } = {}) {
    const p = pickItems(item);
    if (p.err) return { err: p.err };
    return { selector: p.sel, items: p.els.map((el) => {
      const t = el.querySelector('time');
      const a = t && t.closest('a[href]');
      return { key: keyOf(el), time: t ? (t.getAttribute('datetime') || clean(t.innerText, 40)) : '', link: a ? a.href : '', text: clean(el.innerText, 900) };
    }) };
  }
  function scrollItems({ item, up = false } = {}) {
    const p = pickItems(item);
    const edge = p.els && p.els.length ? p.els[up ? 0 : p.els.length - 1] : null;
    const el = edge && scroller(edge);
    if (el) { const b = el.scrollTop; el.scrollBy({ top: (up ? -1 : 1) * el.clientHeight * 0.85, behavior: 'instant' }); return { moved: Math.round(el.scrollTop - b) }; }
    const b = scrollY; window.scrollBy({ top: (up ? -1 : 1) * innerHeight * 0.85, behavior: 'instant' }); return { moved: Math.round(scrollY - b) };
  }

  // ---------- the page report's header: title, address, controls, size, sound ----------
  function summary() {
    const controls = [...document.querySelectorAll('button, a[href], input, textarea, select, [role=button], canvas')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).slice(0, 40)
      .map((e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.type && e.tagName === 'INPUT' ? '[' + e.type + ']' : '') + (nameOf(e, 60) ? ' "' + nameOf(e, 60) + '"' : ''));
    // The sound probe lives in the page's own world; read through the extension (a separate world) it isn't there.
    const q = window.__qxSound, ctxs = q ? q.ctxs : [];
    const sound = q ? { contexts: ctxs.length, running: ctxs.filter((c) => c.state === 'running').length, sources: q.sources, media: q.media + [...document.querySelectorAll('audio, video')].filter((m) => !m.paused && !m.muted && m.volume > 0).length } : null;
    const st = screenText({ max: 2500 });
    return { sound, title: document.title, url: location.href, text: st.text, screen: true, more: st.more, controls,
      size: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], scroll: [Math.round(scrollX), Math.round(scrollY)], view: [innerWidth, innerHeight] };
  }
  const where = () => ({ href: location.href, readyState: document.readyState, title: document.title });

  // ---------- what a step in the user's own tab would do to their account ----------
  // A click, Enter or typing that sends, deletes, buys, posts, signs out or changes the account (null otherwise).
  // Reads only. Refs count too: a click by ref is checked like a click by text.
  const RISK = /\b(send|delete|remove|trash|discard|erase|buy|purchase|pay|payment|order|checkout|check out|subscribe|unsubscribe|transfer|withdraw|donate|post|publish|tweet|reply|forward|share|submit|confirm|sign out|log ?out|deactivate|close account|change password|update password|save changes|settings)\b/i;
  const labels = (e) => (e ? [...new Set([e.innerText, e.value, e.getAttribute('aria-label'), e.title, e.getAttribute('data-tooltip')].map((x) => clean(x, 200)).filter(Boolean))].join(' · ').slice(0, 80) : '');
  function risk(a = {}) {
    if (a.action === 'click') {
      let el = null;
      if (a.ref) { const g = resolve(a.ref); el = g.el || null; }
      else if (a.selector) { try { el = document.querySelector(a.selector); } catch (e) { el = null; } }
      if (!el && a.text) { const g = locate({ text: a.text }); el = g.el || null; }
      if (!el && !a.ref && !a.selector && !a.text && a.x != null) el = topHit(a.x, a.y);
      if (!el) return null;
      el = el.closest('button, a, [role=button], [role=menuitem], input[type=submit], input[type=button]') || el;
      const l = labels(el);
      if (RISK.test(l)) return `click "${l}"`;
      if (el.matches('input[type=submit], button[type=submit], form button:not([type])')) return `submit a form ("${l || 'submit'}")`;
      return null;
    }
    if (a.action === 'press') {
      const key = String(a.key || 'Enter');
      if (!/enter/i.test(key)) return null;
      if (/ctrl|control|meta|cmd/i.test(key)) return `press ${key} (it often sends)`;
      const f = document.activeElement, form = f && f.closest ? f.closest('form') : null;
      if (!form || f.type === 'search' || form.getAttribute('role') === 'search' || f.tagName === 'TEXTAREA') return null;
      const b = form.querySelector('[type=submit], button:not([type])');
      return `submit a form${b && labels(b) ? ` ("${labels(b)}")` : ''} with Enter`;
    }
    if (a.action === 'type') {
      let e = document.activeElement;
      if (a.ref) { const g = resolve(a.ref); e = g.el || e; } else if (a.selector) { try { e = document.querySelector(a.selector) || e; } catch (x) { /* bad selector */ } }
      if (e && e.type === 'password') return 'type into a password field';
      if (e && /one-time-code|cc-number|cc-csc|cc-exp/.test(e.autocomplete || '')) return 'type into a payment or sign-in code field';
    }
    return null;
  }

  // ---------- the mark on the agent's tab: a thin border while it works there ----------
  function mark({ on = true } = {}) {
    const id = 'quorx-agent-mark';
    let el = document.getElementById(id);
    if (!on) { if (el) el.remove(); return { on: false }; }
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.setAttribute('aria-hidden', 'true');
      el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;box-shadow:inset 0 0 0 3px rgba(60,194,201,.9),inset 0 0 18px rgba(60,194,201,.35);border-radius:2px;';
      (document.body || document.documentElement).appendChild(el);
    }
    return { on: true };
  }

  Object.defineProperty(window, KEY, { value: { v: VERSION, ready, screenText, pageText, snapshot, find, point, focus, field, scroll, state, collect, scrollItems, summary, where, risk, mark }, configurable: true });
}

/** A DevTools expression that runs one of the page operations above with these arguments. */
export const pageOp = (name, args = {}) => `(() => { (${qxPage})(); return window[Symbol.for('quorx.ops')].${name}(${JSON.stringify(args)}); })()`;
