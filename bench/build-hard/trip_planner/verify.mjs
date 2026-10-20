// Hidden checks for trip_planner: the parts of the request any build must have, however it is laid out.
import fs from 'node:fs';
import path from 'node:path';
import { openTab } from '../../../server/browser.js';

const PAGES = ['index.html', 'trip.html', 'budget.html'];
// Types a trip name into the first visible text box on the page and submits it (its form, or an Add/Create button).
const ADD_TRIP = (name) => `(() => {
  const inp = [...document.querySelectorAll('input[type=text], input:not([type])')].find((i) => i.offsetParent !== null);
  if (!inp) return false;
  inp.focus(); inp.value = ${JSON.stringify(name)}; inp.dispatchEvent(new Event('input', { bubbles: true }));
  const form = inp.closest('form');
  if (form) { form.requestSubmit(); return true; }
  const btn = [...document.querySelectorAll('button')].find((b) => /add|create|new|save/i.test(b.textContent));
  if (btn) { btn.click(); return true; }
  return false;
})()`;
const errors = (tab) => tab.console.filter((c) => !/favicon/i.test(c)); // a missing favicon is not the build's error

export default async function verify({ dir, tab, url }) {
  const out = [];
  const check = async (name, fn) => { try { const note = await fn(); out.push({ name, ok: note === true, note: note === true ? '' : String(note) }); } catch (e) { out.push({ name, ok: false, note: e.message }); } };
  const page = (p) => url.replace(/index\.html$/, '') + p;

  await check('the three pages and state.js exist', async () => {
    const missing = [...PAGES, 'state.js'].filter((f) => !fs.existsSync(path.join(dir, f)));
    return !missing.length || `missing ${missing.join(', ')}`;
  });
  await check('every page loads state.js', async () => {
    // Directly, or through a script of its own that imports it.
    const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
    const loads = (f) => {
      const html = read(f), srcs = [...html.matchAll(/<script[^>]+src=["']?([^"' >]+)/gi)].map((m) => m[1].replace(/^\.?\//, ''));
      return srcs.some((x) => x.split('/').pop() === 'state.js' || /state\.js/.test(read(x))) || /import[^;]*state\.js/.test(html);
    };
    const without = PAGES.filter((f) => !loads(f));
    return !without.length || `no state.js in ${without.join(', ')}`;
  });
  for (const p of PAGES) {
    await check(`${p} opens without errors and links to the other pages`, async () => {
      await tab.open(page(p));
      // The shared nav: every page links to the trips list and the budget (trip.html is reached from a trip).
      const links = (await tab.eval(`[...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'))`))
        .map((h) => h.replace(/[?#].*$/, '').split('/').pop() || 'index.html');
      const missing = ['index.html', 'budget.html'].filter((x) => x !== p && !links.includes(x));
      if (errors(tab).length) return errors(tab).slice(-2).join(' | ');
      return !missing.length || `no link to ${missing.join(', ')}`;
    });
  }
  await check('a made-up trip id shows a message instead of breaking', async () => {
    await tab.open(page('trip.html?id=no-such-trip-42'));
    const text = await tab.eval('document.body.innerText.trim()');
    if (errors(tab).length) return errors(tab).slice(-2).join(' | ');
    return /not found|doesn.t exist|does not exist|no (such )?trip|couldn.t find|could not find|unknown/i.test(text) || 'no message about the missing trip';
  });
  await check('a trip made on index.html is listed on budget.html', async () => {
    await tab.open(page('index.html'));
    await tab.eval('localStorage.clear()');
    await tab.open(page('index.html'));
    const typed = await tab.eval(ADD_TRIP('Zanzibar Hidden Check'));
    if (!typed) return 'no visible text box with a form or an Add button on index.html';
    await new Promise((r) => setTimeout(r, 300));
    await tab.open(page('budget.html'));
    const text = await tab.eval('document.body.innerText');
    return text.includes('Zanzibar Hidden Check') || 'the new trip is not on budget.html';
  });
  await check('budget.html already open in another tab shows a new trip without a reload', async () => {
    const other = await openTab();
    try {
      await other.open(page('budget.html'));
      await tab.open(page('index.html'));
      if (!(await tab.eval(ADD_TRIP('Kyoto Live Check')))) return 'could not add a trip on index.html';
      for (let i = 0; i < 10; i++) { await new Promise((r) => setTimeout(r, 300)); if ((await other.eval('document.body.innerText')).includes('Kyoto Live Check')) return true; }
      return 'the open budget.html did not update';
    } finally { await other.close().catch(() => {}); }
  });
  return out;
}
