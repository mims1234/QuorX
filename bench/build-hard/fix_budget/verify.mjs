// Hidden checks for fix_budget: one per bug planted in seed/ (the builder never sees this file). They drive the page
// through its own form and element ids, so a fix counts wherever in the code it was made. Each check shows one
// category with the filter, so one bug left in (the All filter, say) doesn't fail the others.
const ADD = (e) => `(() => {
  const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  set('desc', ${JSON.stringify(e.desc)}); set('amount', ${JSON.stringify(e.amount)}); set('type', ${JSON.stringify(e.type)});
  set('category', ${JSON.stringify(e.category)}); set('date', ${JSON.stringify(e.date)});
  document.getElementById('entry-form').requestSubmit();
})()`;
const ROWS = `[...document.querySelectorAll('#entries li')].filter((li) => li.offsetParent !== null).map((li) => (li.querySelector('.desc') || li).textContent.trim())`;
const SHOW = (cat) => `(() => { const f = document.getElementById('filter'); f.value = ${JSON.stringify(cat)}; f.dispatchEvent(new Event('change', { bubbles: true })); })()`;
const BALANCE = `Number(document.getElementById('balance').textContent.replace(/[^0-9.\\-−]/g, '').replace('−', '-'))`;

export default async function verify({ tab, url }) {
  const out = [];
  const check = async (name, fn) => { try { const note = await fn(); out.push({ name, ok: note === true, note: note === true ? '' : String(note) }); } catch (e) { out.push({ name, ok: false, note: e.message }); } };
  const fresh = async (entries = [], show) => {
    await tab.open(url);
    await tab.eval('localStorage.clear(); sessionStorage.clear()');
    await tab.open(url);
    for (const e of entries) { await tab.eval(ADD(e)); await new Promise((r) => setTimeout(r, 60)); }
    if (show) await tab.eval(SHOW(show));
  };
  const e = (desc, amount, type, category, date) => ({ desc, amount, type, category, date });

  await check('balance adds and subtracts amounts as numbers', async () => {
    await fresh([e('Pay', '100', 'income', 'salary', '2026-10-01'), e('Gift', '50', 'income', 'other', '2026-10-02'), e('Food', '30', 'expense', 'food', '2026-10-03')]);
    const b = await tab.eval(BALANCE);
    return Math.abs(b - 120) < 0.001 || `balance shows ${b}, expected 120`;
  });
  await check('delete removes the entry that was clicked', async () => {
    await fresh([e('Alpha', '1', 'expense', 'food', '2026-10-01'), e('Bravo', '2', 'expense', 'food', '2026-10-02'), e('Charlie', '3', 'expense', 'food', '2026-10-03')], 'food');
    const ok = await tab.eval(`(() => { const li = [...document.querySelectorAll('#entries li')].find((x) => x.textContent.includes('Bravo')); const b = li && li.querySelector('button'); if (!b) return false; b.click(); return true; })()`);
    if (!ok) return 'no delete button in the Bravo row';
    await new Promise((r) => setTimeout(r, 200));
    const rows = await tab.eval(ROWS);
    return (rows.length === 2 && !rows.some((r) => r.includes('Bravo'))) || `left: ${rows.join(', ')}`;
  });
  await check('entries survive a reload', async () => {
    await fresh([e('Keepme', '12', 'expense', 'fun', '2026-10-05')]);
    await tab.open(url);
    await tab.eval(SHOW('fun'));
    const rows = await tab.eval(ROWS);
    return rows.some((r) => r.includes('Keepme')) || 'the list is empty after a reload';
  });
  await check('the list is newest first across months and years', async () => {
    await fresh([e('Oct21', '1', 'expense', 'food', '2026-10-21'), e('Nov05', '1', 'expense', 'food', '2026-11-05'), e('Dec30', '1', 'expense', 'food', '2025-12-30')], 'food');
    const rows = await tab.eval(ROWS);
    const order = ['Nov05', 'Oct21', 'Dec30'].map((d) => rows.findIndex((r) => r.includes(d)));
    return (order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2]) || `order: ${rows.join(', ')}`;
  });
  await check('the All filter shows every entry', async () => {
    await fresh([e('One', '1', 'expense', 'food', '2026-10-01'), e('Two', '1', 'expense', 'rent', '2026-10-02')]);
    await tab.eval(`(() => { const f = document.getElementById('filter'); f.value = 'food'; f.dispatchEvent(new Event('change', { bubbles: true })); f.value = 'all'; f.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const rows = await tab.eval(ROWS);
    return rows.length === 2 || `All shows ${rows.length} of 2`;
  });
  await check('a description with < and > shows as text', async () => {
    await fresh([e('<b>bold</b> & <i>co</i>', '5', 'expense', 'other', '2026-10-01')], 'other');
    const r = await tab.eval(`(() => { const li = document.querySelector('#entries li'); return li ? { html: !!li.querySelector('b, i'), text: li.textContent } : null; })()`);
    return (r && !r.html && r.text.includes('<b>bold</b>')) || (r ? 'the description was read as HTML' : 'nothing listed');
  });
  await check('no errors in the console', async () => {
    const errs = tab.console.filter((c) => !/favicon/i.test(c)); // a missing favicon is not the build's error
    return errs.length ? errs.slice(-3).join(' | ') : true;
  });
  return out;
}
