// ⚙ Settings → Storage: how much room QuorX takes on this computer, part by part, and clearing what it doesn't need.
// The harness measures its data folder and every project's .quorx folder (/api/storage, server/storage.js); the
// desktop app adds its own caches (desktop/storage.js). Each part has its own button; "Clear safe caches" clears the
// ones that come back by themselves, after a list where each can be unticked. app.js hands in its helpers.
let H = null; // { getJ, postJ, esc, ask, uiAlert, keep () → undo replies kept, desk (op, arg) → Promise | null, openCat (id) }
const V = { items: null, at: 0, home: '', busy: false, open: new Set(), status: '', recent: [] };

const GROUPS = {
  cache: ['Caches & leftovers', 'Made again when needed, or used by nothing any more.'],
  logs: ['Logs', 'What QuorX records while you work.'],
  trash: ['QuorX\'s trash', 'Things you deleted, kept so you can bring them back.'],
  projects: ['Projects', 'The agent\'s own folder (.quorx) inside each project. Git ignores it.'],
};
// What clearing a part loses, in a sentence for its question.
const LOST = {
  blobs: 'Nothing refers to them any more.',
  runs: 'Those replies can no longer carry on after a crash. Their chats keep everything.',
  shots: 'The pictures behind older page checks. The check results stay in the log.',
  oldlogs: 'The older parts of the logs. Current logs stay.',
  trash: 'They go to the Windows Recycle Bin: restore them from there if you need one. The space is freed when the Recycle Bin is emptied.',
  'desk:app': 'Nothing: QuorX makes them again as it runs. The window may be a little slower the first time.',
  'desk:agent': 'Nothing the agent needs: sites send the files again. Its sign-ins stay.',
  'desk:tabs': 'Nothing you need: sites send the files again. Your sign-ins and site settings stay.',
  'desk:legacy': 'The folder goes to the Windows Recycle Bin. QuorX copied what it needed from it the first time it started.',
  'desk:updates': 'Nothing: these versions are already installed.',
  scratch: 'They go to the Windows Recycle Bin.',
  trashPart: 'The agent\'s backup copies go to the Windows Recycle Bin. After that, ↶ Undo for one file can\'t bring them back.',
  checkpoints: 'Those replies can no longer be undone with ↶ Undo. The undo copies go to the Windows Recycle Bin.',
  objects: 'The last command can no longer be undone. The next command takes a fresh snapshot.',
  collected: 'They go to the Windows Recycle Bin.',
  edits: 'They go to the Windows Recycle Bin.',
};
const lostOf = (it) => LOST[it.part === 'trash' ? 'trashPart' : it.part || it.id] || (it.how === 'recycle' ? 'They go to the Windows Recycle Bin.' : 'They are deleted.');

export const storageCard = () => '<div id="stStorage" class="sto"><section class="st-card"><div class="st-row-help">Measuring…</div></section></div>';

export function drawStorage(helpers) {
  H = helpers;
  if (!document.getElementById('stStorage')) return;
  if (V.items && Date.now() - V.at < 60e3) paint(); else measure();
}

export const fmtBytes = (b) => {
  b = Number(b) || 0;
  if (b >= 1e9) return `${(b / 1e9).toFixed(b >= 1e10 ? 0 : 1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(b >= 1e8 ? 0 : 1)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} KB`;
  return b ? `${b} B` : '0 B';
};
const pl = (n, w) => `${(n || 0).toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
const clearable = (it) => it.how && it.bytes > 0 && !it.busy && !it.missing;
/** The parts "Clear safe caches" offers, and whether each starts ticked. */
export const safeParts = (items) => (items || []).filter((it) => it.safe && clearable(it)).map((it) => ({ ...it, on: !it.offInBulk }));

async function measure() {
  V.busy = true; paint();
  const [srv, desk, recent] = await Promise.all([
    H.getJ(`/api/storage?keep=${H.keep()}`),
    H.desk ? H.desk('measure').catch(() => []) : [],
    H.getJ('/api/storage/log'),
  ]);
  V.busy = false;
  if (!srv || srv.error) { V.items = null; V.status = `Couldn't measure: ${srv?.error || 'no answer from QuorX'}`; return paint(); }
  V.items = [...(desk || []), ...srv.items]; V.home = srv.home; V.at = Date.now();
  V.recent = Array.isArray(recent) ? recent.slice(0, 5) : [];
  paint();
}

function paint() {
  const box = document.getElementById('stStorage');
  if (!box) return;
  const { esc } = H;
  if (!V.items) { box.innerHTML = `<section class="st-card"><div class="st-row-help">${V.busy ? 'Measuring…' : esc(V.status || '')}</div>${V.busy ? '' : '<button type="button" class="st-btn secondary sm" data-sto="measure">↻ Measure again</button>'}</section>`; return wire(box); }
  const items = V.items, total = items.reduce((a, x) => a + (x.bytes || 0), 0);
  const safe = safeParts(items).filter((x) => x.on).reduce((a, x) => a + x.bytes, 0);
  const byGroup = Object.keys(GROUPS).map((g) => [g, items.filter((x) => x.group === g).reduce((a, x) => a + (x.bytes || 0), 0)]);
  const bar = byGroup.filter(([, b]) => b).map(([g, b]) => `<span class="sto-seg g-${g}" style="flex-grow:${Math.max(b / (total || 1), 0.004)}" title="${esc(GROUPS[g][0])}: ${fmtBytes(b)}"></span>`).join('');
  const legend = byGroup.map(([g, b]) => `<span class="sto-key"><i class="sto-dot g-${g}"></i>${esc(GROUPS[g][0])} <b class="sto-size">${fmtBytes(b)}</b></span>`).join('');
  const recent = V.recent.length ? `<div class="sto-recent"><span>Recently cleared:</span> ${V.recent.map((r) => `${esc(labelOf(r.id))} <b class="sto-size">${fmtBytes(r.bytes)}</b>${r.auto ? ' (automatic)' : ''} · ${esc(new Date(r.ts).toLocaleDateString())}`).join(' · ')}</div>` : '';
  let html = `<section class="st-card sto-summary">
    <div class="sto-total"><div><div class="sto-total-num">${fmtBytes(total)}</div><div class="st-row-help">QuorX uses this much on this computer${V.home ? `, data in <code class="blurable">${esc(V.home)}</code>` : ''}. Measured ${new Date(V.at).toLocaleTimeString()}.</div></div>
      <div class="sto-total-acts"><button type="button" class="st-btn primary sm" data-sto="safe" ${safe ? '' : 'disabled'}>🧹 Clear safe caches${safe ? ` · ${fmtBytes(safe)}` : ''}</button><button type="button" class="st-btn secondary sm" data-sto="measure" ${V.busy ? 'disabled' : ''}>${V.busy ? 'Measuring…' : '↻ Measure again'}</button></div></div>
    <div class="sto-bar" role="img" aria-label="Room used by each kind">${bar}</div><div class="sto-legend">${legend}</div>
    ${V.status ? `<div class="sto-status" role="status">${esc(V.status)}</div>` : ''}${recent}</section>`;
  for (const g of ['cache', 'logs', 'trash']) {
    const list = items.filter((x) => x.group === g && (x.bytes || x.how || x.id === 'trash'));
    if (list.length) html += `<section class="st-card"><div class="st-card-head"><div class="st-card-title">${esc(GROUPS[g][0])}</div><div class="st-card-subtitle">${esc(GROUPS[g][1])}</div></div>${list.map(row).join('')}</section>`;
  }
  html += projectsCard(items.filter((x) => x.group === 'projects'));
  box.innerHTML = html;
  wire(box);
}
const labelOf = (id) => V.items?.find((x) => x.id === id)?.label || { 'trash-retention': 'Trash past its days' }[id] || id;

function sizeCell(it) {
  return `<span class="sto-size">${fmtBytes(it.bytes)}${it.partial ? '+' : ''}</span>${it.files ? `<span class="sto-files">${pl(it.files, 'file')}</span>` : ''}`;
}
function button(it) {
  const { esc } = H;
  if (it.missing) return '<span class="sto-tag warn">folder not found</span>';
  if (!it.how) return '<span class="sto-tag">kept</span>';
  if (it.busy) return '<span class="sto-tag warn" title="A reply is running in this project; clear it when the reply has ended">reply running</span>';
  if (!it.bytes) return '<span class="sto-tag ok">empty</span>';
  const name = it.id === 'trash' || it.part === 'trash' ? 'Empty…' : it.part === 'checkpoints' ? 'Trim…' : 'Clear…';
  return `<button type="button" class="st-btn ${it.how === 'recycle' || it.safe ? 'secondary' : 'danger'} sm" data-clear="${esc(it.id)}" title="${it.how === 'recycle' ? 'Moves them to the Windows Recycle Bin' : 'Deletes them'}">${name}</button>`;
}
function row(it) {
  const { esc } = H;
  let help = it.help || '';
  if (it.id === 'trash') help += V.rulesText ? ` ${V.rulesText}` : '';
  return `<div class="st-row sto-row"><div class="st-row-info"><div class="st-row-label-wrap"><span class="st-row-label">${esc(it.label)}</span>${it.how === 'recycle' ? '<span class="sto-tag" title="Clearing moves them to the Windows Recycle Bin">↩ Recycle Bin</span>' : ''}</div>${help ? `<div class="st-row-help">${esc(help)}</div>` : ''}</div><div class="st-row-ctrl sto-ctrl">${sizeCell(it)}${button(it)}</div></div>`;
}
function projectsCard(parts) {
  const { esc } = H;
  const by = new Map();
  for (const it of parts) { const k = it.project.id; if (!by.has(k)) by.set(k, { project: it.project, missing: !!it.missing, parts: [] }); if (!it.missing) by.get(k).parts.push(it); }
  const list = [...by.values()].map((p) => ({ ...p, bytes: p.parts.reduce((a, x) => a + x.bytes, 0), busy: p.parts.some((x) => x.busy) })).sort((a, b) => b.bytes - a.bytes);
  if (!list.length) return '';
  const rows = list.map((p) => {
    const open = V.open.has(p.project.id);
    const fold = p.missing ? '' : `data-fold="${esc(p.project.id)}"`;
    const head = `<div class="st-row sto-row sto-proj ${p.missing ? '' : 'can-open'}" ${fold}><div class="st-row-info"><div class="st-row-label-wrap"><button type="button" class="sto-fold" ${fold} aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} the parts of ${esc(p.project.name)}" ${p.missing ? 'disabled' : ''}>${p.missing ? '–' : open ? '▾' : '▸'}</button><span class="st-row-label">${esc(p.project.name)}</span>${p.busy ? '<span class="sto-tag warn">reply running</span>' : ''}</div><div class="st-row-help"><code class="blurable sto-path" title="${esc(p.project.dir || '')}">${esc(p.project.dir || '')}</code></div></div><div class="st-row-ctrl sto-ctrl">${p.missing ? '<span class="sto-tag warn">folder not found</span>' : `<span class="sto-size">${fmtBytes(p.bytes)}</span>`}</div></div>`;
    return head + (open && !p.missing ? `<div class="sto-parts">${p.parts.filter((x) => x.bytes || x.how).map(row).join('')}</div>` : '');
  }).join('');
  return `<section class="st-card"><div class="st-card-head"><div class="st-card-title">${esc(GROUPS.projects[0])}</div><div class="st-card-subtitle">${esc(GROUPS.projects[1])} Open a project to clear its parts.</div></div>${rows}</section>`;
}

function wire(box) {
  box.onclick = async (e) => {
    const t = e.target.closest('[data-sto],[data-clear],[data-fold]');
    if (!t || t.disabled) return;
    if (t.dataset.fold) { const id = t.dataset.fold; if (V.open.has(id)) V.open.delete(id); else V.open.add(id); return paint(); }
    if (t.dataset.sto === 'measure') { V.status = ''; return measure(); }
    if (t.dataset.sto === 'safe') return clearSafe();
    if (t.dataset.clear) return clearOne(V.items.find((x) => x.id === t.dataset.clear));
  };
}

async function clearOne(it) {
  if (!it) return;
  const where = it.project ? ` in “${it.project.name}”` : '';
  const head = it.how === 'recycle' ? `Move ${it.label.toLowerCase()}${where} to the Recycle Bin?` : `Clear ${it.label.toLowerCase()}${where}?`;
  const body = [`• ${fmtBytes(it.bytes)} in ${pl(it.files, 'file')}`, `• ${lostOf(it)}`];
  if (it.bytes > 1e9) body.push(`• This is large: ${fmtBytes(it.bytes)}.`);
  const backup = it.id === 'trash';
  const a = await H.ask(`${head}\n${body.join('\n')}${backup ? '\n\nTo keep a copy elsewhere first, use Back up first (Data & storage → Export my QuorX).' : ''}`,
    { ok: it.how === 'recycle' ? 'Move to Recycle Bin' : 'Clear', danger: it.how !== 'recycle', ...(backup ? { alt: 'Back up first' } : {}) });
  if (a === 'alt') return H.openCat('data');
  if (a !== true) return;
  await run([it]);
}

async function clearSafe() {
  const parts = safeParts(V.items);
  if (!parts.length) return;
  const picked = await pickList(parts);
  if (!picked?.length) return;
  await run(picked);
}

// Clears the parts (the desktop app's own and the harness's), then says what was freed and measures again.
async function run(list) {
  V.status = 'Clearing…'; paint();
  const desk = list.filter((x) => x.desktop), srv = list.filter((x) => !x.desktop);
  const out = [];
  if (desk.length && H.desk) { const r = await H.desk('clear', desk.map((x) => ({ id: x.id, expect: x.bytes }))).catch((e) => ({ results: desk.map((x) => ({ id: x.id, error: String(e?.message || e) })) })); out.push(...(r?.results || [])); }
  if (srv.length) { const r = await H.postJ('/api/storage/clear', { items: srv.map((x) => ({ id: x.id, expect: x.bytes })), keep: H.keep() }); if (r?.error) out.push(...srv.map((x) => ({ id: x.id, error: r.error }))); else out.push(...(r?.results || [])); }
  V.status = summary(out);
  V.at = 0;
  await measure();
  const grew = out.filter((r) => r.changed);
  if (grew.length) H.uiAlert(`Not cleared: it grew since it was measured\n${grew.map((r) => `• ${labelOf(r.id)}: now ${fmtBytes(r.bytes)}`).join('\n')}\n\nThe sizes are measured again: look at them and clear again if it is still what you want.`);
}
export function summary(results) {
  const freed = results.reduce((a, r) => a + (r.changed || r.error ? 0 : r.bytes || 0), 0);
  const binned = results.filter((r) => r.wentTo === 'recycle' && !r.error && !r.changed).reduce((a, r) => a + (r.bytes || 0), 0);
  const left = results.reduce((a, r) => a + (r.skipped?.length || 0), 0);
  const later = results.reduce((a, r) => a + (r.atNextStart || 0), 0);
  const errs = results.filter((r) => r.error);
  const parts = [`Freed ${fmtBytes(freed)}${binned ? ` (${fmtBytes(binned)} of it moved to the Recycle Bin)` : ''}.`];
  if (left) parts.push(`${pl(left, 'item')} ${left === 1 ? 'was' : 'were'} in use and stayed; ${left === 1 ? 'it goes' : 'they go'} next time.`);
  if (later) parts.push(`${fmtBytes(later)} more of GPU caches goes the next time QuorX starts.`);
  if (errs.length) parts.push(`Not cleared: ${errs.map((r) => `${labelOf(r.id)} (${r.error})`).join('; ')}.`);
  return parts.join(' ');
}

// "Clear safe caches": every part with its size and a ✓ to keep or untick; resolves to the ticked parts or null.
function pickList(parts) {
  const { esc } = H;
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.className = 'ask-dlg sto-pick-dlg';
    const total = () => parts.filter((p, i) => d.querySelector(`[data-i="${i}"]`)?.checked).reduce((a, p) => a + p.bytes, 0);
    d.innerHTML = `<form class="ask" method="dialog"><h3>Clear safe caches?</h3><div class="ask-body"><p>These come back by themselves, or nothing uses them. Untick any you want to keep.</p>
      <div class="sto-pick">${parts.map((p, i) => `<label class="sto-pick-row"><span class="sq-check"><input type="checkbox" data-i="${i}" ${p.on ? 'checked' : ''}></span><span class="sto-pick-text"><b>${esc(p.label)}</b><small>${esc(lostOf(p))}</small></span><span class="sto-size">${fmtBytes(p.bytes)}</span></label>`).join('')}</div></div>
      <footer><button type="button" class="ask-cancel">Cancel</button><button type="submit" class="ask-ok danger"></button></footer></form>`;
    document.body.appendChild(d);
    const ok = d.querySelector('.ask-ok');
    const upd = () => { const t = total(); ok.textContent = t ? `Clear ${fmtBytes(t)}` : 'Clear'; ok.disabled = !t; };
    d.querySelectorAll('input[data-i]').forEach((x) => { x.onchange = upd; });
    upd();
    let settled = false;
    const done = (v) => { if (settled) return; settled = true; d.close(); d.remove(); resolve(v); };
    d.querySelector('.ask-cancel').onclick = () => done(null);
    d.addEventListener('cancel', (e) => { e.preventDefault(); done(null); });
    d.querySelector('form').onsubmit = (e) => { e.preventDefault(); done(parts.filter((p, i) => d.querySelector(`[data-i="${i}"]`).checked)); };
    d.showModal();
    ok.focus();
  });
}

/** A line for the trash row: when it empties by itself. */
export function setRulesText(rules) {
  V.rulesText = rules?.autoClean ? `Each one goes to the Recycle Bin ${rules.trashDays} days after it was deleted.` : 'Kept until you empty it (automatic cleanup is off).';
}
