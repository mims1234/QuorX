// ⚙ Settings → Data & storage → Backup: "Export my QuorX" writes one .zip into a folder the user picks; "Import"
// reads one back on this or another computer. Both go through /api/backup/* (server/backup.js).
// app.js hands in its helpers, so this file stays on its own.
let H = null; // { postJ, esc, uiConfirm, uiAlert, store }
const IMP = { dir: '', look: null, folders: {}, overwrite: false, keys: false };

/** The card's markup (the rest is drawn into #stBackup). */
export const backupCard = () => '<div id="stBackup"></div>';

export function drawBackup(helpers) {
  H = helpers;
  const box = document.getElementById('stBackup');
  if (box) box.innerHTML = view();
  wire(box);
}

const pl = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const kb = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const row = (label, help, ctrl) => `<div class="st-row"><div class="st-row-info"><div class="st-row-label-wrap"><span class="st-row-label">${label}</span></div>${help ? `<div class="st-row-help">${help}</div>` : ''}</div><div class="st-row-ctrl">${ctrl}</div></div>`;
const check = (id, label, on = false) => `<label class="sq-check"><input type="checkbox" id="${id}"${on ? ' checked' : ''}><span>${label}</span></label>`;

function view() {
  const { esc } = H;
  const exp = `<section class="st-card"><div class="st-card-head"><div class="st-card-title">Backup</div><div class="st-card-subtitle">One .zip file with your chats, projects (their folders and settings, not the files in them), these settings, your command rules and schedules. Use it as a backup, or to move to another computer.</div></div>
    ${row('Also include', 'Logs: what QuorX recorded while you worked (runs, approvals, checks).', check('bkLogs', 'My logs'))}
    ${row('API keys', 'Left out unless you tick both boxes.', `${check('bkKeys', 'Include my API keys')}`)}
    <div class="bk-warn" id="bkKeysWarn" hidden><strong>Anyone with this file can spend on your OpenRouter account.</strong> Keep it somewhere private, and don't share or upload it. ${check('bkKeysOk', 'I understand')}</div>
    ${row('', '', '<button type="button" class="st-btn primary sm" id="bkExport">⬇ Export my QuorX…</button>')}
    <div class="st-row-help bk-out" id="bkOut" role="status"></div></section>`;
  return exp + importView(esc);
}

function importView(esc) {
  const L = IMP.look;
  let body = row('Restore a backup', 'Choose the folder that holds it. Nothing changes until you press Import.', '<button type="button" class="st-btn secondary sm" id="bkPick">📂 Choose a folder…</button>');
  if (IMP.list) body += IMP.list.length
    ? `<div class="bk-list">${IMP.list.map((b) => `<button type="button" class="bk-file ${L?.file === b.file ? 'on' : ''}" data-file="${esc(b.file)}"><span>${esc(b.name)}</span><small>${kb(b.bytes)} · ${new Date(b.at).toLocaleString()}</small></button>`).join('')}</div>`
    : `<div class="st-row-help">No QuorX backups (quorx-backup-….zip) in <code>${esc(IMP.dir)}</code>.</div>`;
  if (L) {
    const c = L.manifest?.counts || {};
    body += `<div class="bk-look"><div class="st-row-help">From ${esc(L.manifest?.created?.slice(0, 10) || '?')}${L.manifest?.app ? ` (QuorX ${esc(L.manifest.app)})` : ''}: ${pl(L.chats, 'chat')}, ${pl(L.projects.length, 'project')}${c.files ? `, ${pl(c.files, 'attached file')}` : ''}${L.settings ? ', settings' : ''}${L.schedules ? ', schedules' : ''}${L.logs ? `, ${pl(L.logs, 'log')}` : ''}${L.keys ? `, ${pl(L.keys, 'API key')}` : ''}.</div>`;
    if (L.projects.length) body += `<div class="bk-projects">${L.projects.map((p) => {
      const to = IMP.folders[p.id];
      const state = to ? `<span class="bk-tag ok">→ ${esc(to)}</span>` : p.found ? '<span class="bk-tag ok">folder found</span>' : '<span class="bk-tag miss">folder not on this computer</span>';
      return `<div class="bk-proj"><div><strong>${esc(p.name)}</strong> <code>${esc(p.path || '')}</code>${p.clash ? ' <span class="bk-tag">already here</span>' : ''}</div><div>${state} <button type="button" class="st-btn ghost sm" data-repoint="${esc(p.id)}">${to || !p.found ? 'Choose its folder…' : 'Use another folder…'}</button></div></div>`;
    }).join('')}</div>`;
    const clashes = L.chatClashes + L.projects.filter((p) => p.clash).length;
    if (clashes) body += row(`${clashes} already here`, 'Chats and projects with the same id as ones on this computer.', `<div class="st-segmented" role="radiogroup" id="bkClash"><button type="button" class="st-seg-btn ${IMP.overwrite ? '' : 'active'}" data-v="keep" role="radio" aria-checked="${!IMP.overwrite}">Keep mine</button><button type="button" class="st-seg-btn ${IMP.overwrite ? 'active' : ''}" data-v="replace" role="radio" aria-checked="${IMP.overwrite}">Replace with the backup</button></div>`);
    if (L.keys) body += row('API keys', `This backup holds ${pl(L.keys, 'API key')}.`, check('bkImpKeys', 'Add them here', IMP.keys));
    body += row('', L.settings ? 'Settings from the backup replace the ones in this browser; the page reloads after.' : '', '<button type="button" class="st-btn primary sm" id="bkImport">Import</button>');
  }
  body += '<div class="st-row-help bk-out" id="bkImpOut" role="status"></div>';
  return `<section class="st-card"><div class="st-card-head"><div class="st-card-title">Import</div><div class="st-card-subtitle">Restore a backup made with Export my QuorX, on this or another computer. It asks before replacing anything, and lets you point projects at their folders on this computer.</div></div>${body}</section>`;
}

function wire(box) {
  if (!box) return;
  const $ = (s) => box.querySelector(s);
  const { postJ, esc, uiConfirm } = H;
  const keys = $('#bkKeys'), warn = $('#bkKeysWarn');
  keys.onchange = () => { warn.hidden = !keys.checked; if (!keys.checked) $('#bkKeysOk').checked = false; };
  $('#bkExport').onclick = async (e) => {
    const out = $('#bkOut'), btn = e.currentTarget;
    if (keys.checked && !$('#bkKeysOk').checked) { out.textContent = 'Tick "I understand" to include your API keys, or untick "Include my API keys".'; return; }
    const pick = await postJ('/api/pick-folder', { start: '' });
    if (pick.error || !pick.path) { out.textContent = pick.error || ''; return; }
    btn.disabled = true; out.textContent = 'Exporting…';
    let settings = null; try { settings = JSON.parse(localStorage.getItem(H.store) || 'null'); } catch { /* none saved */ }
    const r = await postJ('/api/backup/export', { dir: pick.path, settings, logs: $('#bkLogs').checked, keys: keys.checked, keysWarned: $('#bkKeysOk').checked });
    btn.disabled = false;
    if (r.error) { out.textContent = `Not exported: ${r.error}`; return; }
    const c = r.counts;
    out.innerHTML = `Saved <code>${esc(r.file)}</code> (${kb(r.bytes)}): ${pl(c.chats, 'chat')}, ${pl(c.projects, 'project')}${c.logs ? `, ${pl(c.logs, 'log')}` : ''}${c.keys ? `, <strong>${pl(c.keys, 'API key')}</strong>` : ''}.`;
  };
  const redraw = () => drawBackup(H);
  $('#bkPick').onclick = async () => {
    const pick = await postJ('/api/pick-folder', { start: IMP.dir });
    if (pick.error || !pick.path) { if (pick.error) $('#bkImpOut').textContent = pick.error; return; }
    IMP.dir = pick.path; IMP.look = null; IMP.folders = {};
    IMP.list = (await postJ('/api/backup/find', { dir: pick.path })).backups || [];
    if (IMP.list.length === 1) IMP.look = await postJ('/api/backup/inspect', { file: IMP.list[0].file });
    if (IMP.look?.error) { const err = IMP.look.error; IMP.look = null; redraw(); $('#bkImpOut').textContent = err; return; }
    redraw();
  };
  for (const b of box.querySelectorAll('.bk-file')) b.onclick = async () => {
    const r = await postJ('/api/backup/inspect', { file: b.dataset.file });
    if (r.error) { $('#bkImpOut').textContent = r.error; return; }
    IMP.look = r; IMP.folders = {}; redraw();
  };
  for (const b of box.querySelectorAll('[data-repoint]')) b.onclick = async () => {
    const p = IMP.look.projects.find((x) => x.id === b.dataset.repoint);
    const pick = await postJ('/api/pick-folder', { start: IMP.folders[p.id] || '' });
    if (pick.path) { IMP.folders[p.id] = pick.path; redraw(); }
  };
  for (const b of box.querySelectorAll('#bkClash .st-seg-btn')) b.onclick = () => { IMP.overwrite = b.dataset.v === 'replace'; redraw(); };
  const ik = $('#bkImpKeys'); if (ik) ik.onchange = () => { IMP.keys = ik.checked; };
  const go = $('#bkImport');
  if (go) go.onclick = async () => {
    const L = IMP.look, out = $('#bkImpOut');
    const missing = L.projects.filter((p) => !p.found && !IMP.folders[p.id]);
    const clashes = L.chatClashes + L.projects.filter((p) => p.clash).length;
    const lines = [
      ...(IMP.overwrite && clashes ? [`• ${clashes} chats and projects that are here already will be replaced by the backup's.`] : []),
      ...(missing.length ? [`• ${missing.length} project${missing.length === 1 ? '' : 's'} without a folder here (${missing.map((p) => p.name).join(', ')}): they show as missing until you choose their folders.`] : []),
      ...(L.settings ? ['• This browser\'s settings are replaced by the backup\'s, and the page reloads.'] : []),
    ];
    if (lines.length && !(await uiConfirm(`Import this backup?\n${lines.join('\n')}`, { ok: 'Import', danger: IMP.overwrite && clashes > 0 }))) return;
    go.disabled = true; out.textContent = 'Importing…';
    const r = await postJ('/api/backup/import', { file: L.file, overwrite: IMP.overwrite, folders: IMP.folders, keys: IMP.keys });
    go.disabled = false;
    if (r.error) { out.textContent = `Not imported: ${r.error}`; return; }
    out.textContent = `Imported ${pl(r.chats, 'chat')}, ${pl(r.projects, 'project')}${r.rules ? `, ${pl(r.rules, 'rule')}` : ''}${r.schedules ? `, ${pl(r.schedules, 'schedule')}` : ''}${r.keys ? `, ${pl(r.keys, 'API key')}` : ''}${r.logs ? `, ${pl(r.logs, 'log')}` : ''}${r.kept ? `; kept ${r.kept} of yours` : ''}.`;
    if (r.settings) { try { localStorage.setItem(H.store, JSON.stringify(r.settings)); } catch { /* storage off */ } }
    setTimeout(() => location.reload(), r.settings ? 1500 : 2500);
  };
}
