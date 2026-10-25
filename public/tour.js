// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The first-run tour: five short steps over the real page (projects and Scratch, 🔒 Strict / ⚡ YOLO, the deciders
// and the reviewer, where costs show, the Terminal and Running tabs), then a first build to try. It shows once per
// browser, can be skipped at any step, and comes back from ⚙ Settings → About → Show the tour.
const SEEN = 'qx-tour-seen';
export const FIRST_BUILD = 'Make a one-page focus timer: 25-minute work and 5-minute break rounds, start, pause and reset, a soft sound when a round ends, and a short list of today\'s tasks to tick off, kept across reloads.';

// Each step points at the first of `at` that is on screen; with none, the card sits in the middle of the page.
const STEPS = [
  {
    at: ['#projectList', '#railList'], title: 'Projects and Scratch',
    html: `<p>A <b>project</b> is one folder on your computer. Every chat in it works in that folder, so its files, notes and servers stay together.</p>
      <p><b>Scratch</b> is for quick questions and throwaway things. Give each project its own folder: don't make a project inside another project's folder.</p>`,
  },
  {
    at: ['.chatpane.focus .cq-perm', '#ldStart'], title: '🔒 Strict or ⚡ YOLO',
    html: `<div class="tr-seg" aria-hidden="true"><span>🔒 Strict</span><span>⚡ YOLO</span></div>
      <p>Each chat has one or the other, in the row of switches above its message box. <b>Strict</b> asks you before every tool it uses. <b>YOLO</b> works on its own: the deciders answer its questions, and the safety rules and your budget cap still apply.</p>`,
  },
  {
    at: ['#settingsBtn', '#railSettings'], title: 'The deciders and the reviewer',
    html: `<p><b>Deciders</b> are small, fast models that vote when a judgment matters (which option, is this right, does the page look right) in about half a second, for a fraction of a cent.</p>
      <p>The <b>reviewer</b> is a separate model that tests what was built, like a demanding user, and sends it back with the bugs it found. Choose both in ⚙ Settings → Deciders and Agent loop.</p>`,
  },
  {
    at: ['.chatpane.focus .ch-cost', '#costsBtn', '#railCosts'], title: 'Where costs show',
    html: `<p>Money is always shown in amber: what a chat cost in its header, each project's spend (and its limit) on its card, and everything in <b>Spending</b>.</p>
      <p>Each project has a budget in its ⚙: a reply that reaches it pauses and asks whether to raise it or stop.</p>`,
  },
  {
    at: ['#paneTabs [data-tab="term"]', '#pane'], title: 'Terminal and Running',
    html: `<p>Once a chat is open, the side panel has a <b>Terminal</b> (your own terminals, plus every command and server the agent starts, live) and <b>Running</b>: everything still running in the project, with a Stop for each.</p>`,
  },
  {
    at: ['#ldStartText', '.chatpane.focus .input'], title: 'Try a first build', last: true,
    html: `<p>Start with something small you can check in a minute. For example:</p>
      <blockquote class="tr-prompt">${FIRST_BUILD.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</blockquote>`,
  },
];

let T = null; // { i, el, spot, fill, back }

const visible = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth ? r : null; };
const anchor = (step) => { for (const s of step.at) { const el = document.querySelector(s), r = visible(el); if (r) return r; } return null; };

/** Starts the tour. fill(text) puts the sample prompt in the message box. */
export function startTour({ fill } = {}) {
  endTour(false);
  const spot = document.createElement('div');
  spot.className = 'tr-spot';
  const el = document.createElement('div');
  el.className = 'tr-card'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'trTitle'); el.tabIndex = -1;
  const shade = document.createElement('div');
  shade.className = 'tr-shade';
  document.body.append(shade, spot, el);
  T = { i: 0, el, spot, shade, fill, back: document.activeElement };
  el.addEventListener('keydown', onKey);
  addEventListener('resize', place);
  draw();
}

/** First run only: once per browser, when nothing else (Settings, a dialog) is in the way. */
export function maybeStartTour(opts) {
  try { if (localStorage.getItem(SEEN)) return; } catch { return; }
  const blocker = () => document.querySelector('dialog[open]');
  const go = () => { const d = blocker(); if (d) d.addEventListener('close', () => setTimeout(go, 300), { once: true }); else startTour(opts); };
  setTimeout(go, 800);
}

export function endTour(seen = true) {
  if (!T) return;
  if (seen) { try { localStorage.setItem(SEEN, String(Date.now())); } catch { /* this session only */ } }
  removeEventListener('resize', place);
  T.el.remove(); T.spot.remove(); T.shade.remove();
  const back = T.back; T = null;
  back?.focus?.();
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); endTour(); }
  else if (e.key === 'ArrowRight' && T.i < STEPS.length - 1) { T.i++; draw(); }
  else if (e.key === 'ArrowLeft' && T.i > 0) { T.i--; draw(); }
  else if (e.key === 'Tab') { // keep focus inside the card
    const f = [...T.el.querySelectorAll('button')]; if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  }
}

function draw() {
  const s = STEPS[T.i], n = STEPS.length - 1; // the first build at the end is not a step
  T.el.innerHTML = `<div class="tr-top"><span class="tr-step">${s.last ? 'Ready' : `${T.i + 1} of ${n}`}</span><button type="button" class="tr-skip" data-tr="skip">Skip tour</button></div>
    <h3 id="trTitle">${s.title}</h3><div class="tr-body">${s.html}</div>
    ${s.last ? '' : `<div class="tr-dots" aria-hidden="true">${STEPS.slice(0, n).map((_, k) => `<i class="${k === T.i ? 'on' : ''}"></i>`).join('')}</div>`}
    <div class="tr-foot">${T.i ? '<button type="button" class="tr-btn ghost" data-tr="back">Back</button>' : '<span></span>'}
      <span class="tr-right">${s.last ? `${T.fill ? '<button type="button" class="tr-btn ghost" data-tr="fill">Put it in the box</button>' : ''}<button type="button" class="tr-btn primary" data-tr="done">Done</button>` : '<button type="button" class="tr-btn primary" data-tr="next">Next</button>'}</span></div>`;
  for (const b of T.el.querySelectorAll('[data-tr]')) b.onclick = () => {
    const a = b.dataset.tr;
    if (a === 'skip' || a === 'done') return endTour();
    if (a === 'fill') { const fill = T.fill; endTour(); fill?.(FIRST_BUILD); return; }
    T.i += a === 'next' ? 1 : -1; draw();
  };
  place();
  (T.el.querySelector('[data-tr="next"], [data-tr="done"]') || T.el).focus();
}

// The spotlight around the step's element, and the card beside it (below, above, right or left: where it fits).
function place() {
  if (!T) return;
  const r = anchor(STEPS[T.i]), card = T.el, pad = 6, gap = 12;
  T.spot.classList.toggle('jump', T.spot.hidden); // a spotlight coming back appears in place, without gliding from its old spot
  T.spot.hidden = !r; T.shade.classList.toggle('dim', !r); // the shade always catches stray clicks; it darkens only without a spotlight
  card.style.left = card.style.top = '';
  const cw = Math.min(380, innerWidth - 24), ch = card.offsetHeight;
  card.style.width = `${cw}px`;
  if (!r) { card.style.left = `${(innerWidth - cw) / 2}px`; card.style.top = `${Math.max(12, (innerHeight - ch) / 2)}px`; return; }
  const box = { left: Math.max(4, r.left - pad), top: Math.max(4, r.top - pad), right: Math.min(innerWidth - 4, r.right + pad), bottom: Math.min(innerHeight - 4, r.bottom + pad) };
  Object.assign(T.spot.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px` });
  const fits = { right: innerWidth - box.right - gap >= cw, left: box.left - gap >= cw, below: innerHeight - box.bottom - gap >= ch, above: box.top - gap >= ch };
  const clampX = (x) => Math.max(12, Math.min(innerWidth - cw - 12, x)), clampY = (y) => Math.max(12, Math.min(innerHeight - ch - 12, y));
  let x, y;
  if (fits.right) { x = box.right + gap; y = clampY(box.top); }
  else if (fits.below) { x = clampX(box.left); y = box.bottom + gap; }
  else if (fits.above) { x = clampX(box.left); y = box.top - gap - ch; }
  else if (fits.left) { x = box.left - gap - cw; y = clampY(box.top); }
  else { x = clampX((innerWidth - cw) / 2); y = clampY(innerHeight - ch - 12); }
  card.style.left = `${x}px`; card.style.top = `${y}px`;
  requestAnimationFrame(() => T?.spot.classList.remove('jump'));
}
