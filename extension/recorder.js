// Teach by showing: while you record a routine from the QuorX popup, this notes what you do in the tab as steps a
// person would describe ("click the button Meow", "type into Search"), never screen positions. What you type is kept
// only for search boxes; anything typed elsewhere is noted as "(your text)", and password or payment fields are never
// read. Injected again after every page load while the recording runs.
(() => {
  if (window.__quorxRecorder) return;
  window.__quorxRecorder = true;
  const clean = (s, n = 80) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const ACT = 'a[href], button, input, textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=option], [role=checkbox], [role=radio], [role=switch], [role=treeitem], [role=combobox], [role=searchbox], [contenteditable=""], [contenteditable=true]';
  const roleOf = (el) => el.getAttribute('role') || ({ A: 'link', BUTTON: 'button', SELECT: 'dropdown', TEXTAREA: 'text box', SUMMARY: 'button' }[el.tagName]) || (el.tagName === 'INPUT' ? ({ checkbox: 'checkbox', radio: 'option', submit: 'button', button: 'button', search: 'search box' }[el.type] || 'text box') : el.isContentEditable ? 'text box' : el.tagName.toLowerCase());
  const nameOf = (el) => clean(el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.innerText) || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) || el.placeholder || el.innerText || el.value || el.title || el.getAttribute('data-dnd-name') || el.querySelector?.('img[alt]')?.alt || '');
  const secret = (el) => el.type === 'password' || /one-time-code|cc-|current-password|new-password/.test(el.autocomplete || '');
  const searchy = (el) => el.type === 'search' || /searchbox|combobox/.test(el.getAttribute('role') || '') || /search|find|filter|jump to|quick ?switch/i.test(`${el.placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.name || ''}`) || !!el.closest('[role=search], form[role=search], search');
  const note = (step) => { try { chrome.runtime.sendMessage({ q: 'rec-step', step: { ...step, at: Date.now() } }); } catch (e) { /* the extension reloaded */ } };
  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest(ACT) || e.target : null;
    if (!el || /^(INPUT|TEXTAREA)$/.test(el.tagName) && !/checkbox|radio|submit|button/.test(el.type)) return;
    const name = nameOf(el);
    if (!name && !el.matches(ACT)) return;
    note({ kind: 'click', role: roleOf(el), name });
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (el.tagName === 'SELECT') note({ kind: 'choose', field: nameOf(el), value: clean(el.selectedOptions?.[0]?.text, 60) });
    else if (/^(INPUT|TEXTAREA)$/.test(el.tagName) && !/checkbox|radio|submit|button/.test(el.type) && !secret(el)) note({ kind: 'type', field: nameOf(el), role: roleOf(el), value: searchy(el) ? clean(el.value, 120) : '' });
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const el = document.activeElement;
    if (!el || el === document.body) return;
    if (/^(INPUT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable) {
      if (!secret(el)) note({ kind: 'type', field: nameOf(el), role: roleOf(el), value: searchy(el) ? clean(el.value || el.innerText, 120) : '' });
      note({ kind: 'press', key: 'Enter', field: nameOf(el) });
    }
  }, true);
})();
