// Harness checks: fixed questions that QuorX asks the deciders at fixed moments, so a small
// model gets checked even when it doesn't know what to ask.
//   gap   · before a build, about the request: is it a build, and what does it leave out?
//   shot  · after a preview, about one screenshot of what was built
//   click · after clicking the page's main control, about the screenshots before and after
// The questions are written here (and editable in Settings), never by the building model. Every answer
// is logged with its screenshot, so `node scripts/checks.mjs` can score each question, try new wording
// against past screenshots, and find the model's own look checks that are worth making permanent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensemble, aggregate } from './decisions.js';
import { HOME } from './openrouter.js';

// Each question: id (stable, used in logs), v (bump when the wording changes), label (what a "no" means,
// in plain words), ask (a yes/no statement; yes = fine for shot and click, yes = the request says it for gap).
export const CHECKS = {
  gap: [
    { id: 'build', v: 1, gate: true, ask: 'This message asks to build something new or to remake it: an app, site, page, game or tool. It is not a question, an explanation or a small change to something that exists.' },
    { id: 'does', v: 1, label: 'what a person does in it, from opening it to the end', ask: 'The message says what a person does with it, from opening it to the end: the main things they click, type, choose or play.' },
    { id: 'contents', v: 1, label: 'what must be in it', ask: 'The message names the parts it must have: sections, features, screens or data.' },
    { id: 'look', v: 1, taste: true, label: 'how it should look', ask: 'The message says how it should look: a style, a mood, colours, or an example to follow.' },
    { id: 'facts', v: 2, label: 'the real facts it must show (names, prices, text about a real business or person)', ask: 'Nothing real is missing: the message gives the real-world facts the page must show (such as names, prices, or text about a real business or person), or none are needed because the content is made up, generated, or typed in by the person using it.' },
  ],
  shot: [
    { id: 'content', v: 1, label: 'the page shows nothing useful (blank, an error, or stuck loading)', ask: 'The page shows real content. It is not blank, not an error message, and not stuck loading.' },
    { id: 'text', v: 1, label: 'some text is cut off, overlapping or hard to read', ask: 'All visible text is readable: none of it is cut off, overlapping other text, or hard to read against its background.' },
    { id: 'images', v: 1, label: 'there are broken images or empty boxes where pictures should be', ask: 'There are no broken-image icons and no empty grey boxes where a picture should be.' },
    { id: 'fits', v: 1, label: 'something spills past the side of the page', ask: 'Nothing spills past the right edge of the page or is cut off at the side.' },
  ],
  click: [
    { id: 'responds', v: 1, label: 'clicking "{control}" changed nothing visible', ask: 'The second picture shows a visible change from the first after clicking "{control}": a new screen, a started game, an added row, a message, or similar.' },
  ],
  keys: [
    { id: 'responds', v: 1, label: 'pressing {keys} changed nothing visible', ask: 'The second picture shows a visible change from the first after pressing {keys}: a started game, something that moved, a new screen, or similar.' },
  ],
};
export const CHECK_DEFAULTS = {
  gap: true, shots: true, click: true,
  gapBelow: 0.4,   // a gap point counts as missing below this chance that the request says it
  shotBelow: 0.3,  // a screenshot check fails below this chance of "yes, fine"
  edits: {},       // { "shot:text": { ask, on } } — the user's own wording or switches, by kind:id
  custom: [],      // [{ kind: 'shot', id, ask, label }] — the user's own checks
};
// Look and the screenshot checks ask one decider that reads pictures well, and the others only when it is unsure.
export const LOOK_DEFAULTS = { lookVoters: ['openai/gpt-6-luna-decisions'], lookEscalate: true };

export function checkSettings(S) {
  const c = { ...CHECK_DEFAULTS, ...(S.checks || {}), ...(S.deciders === false ? { gap: false, shots: false, click: false } : {}) };
  const list = (kind) => [...CHECKS[kind], ...(Array.isArray(c.custom) ? c.custom.filter((x) => x?.kind === kind && x.id && x.ask).map((x) => ({ v: 1, label: x.label || x.ask, ...x, custom: true })) : [])]
    .map((q) => { const e = c.edits?.[`${kind}:${q.id}`]; const off = !q.gate && (e?.off === true || e?.on === false); return e?.ask && String(e.ask).trim() && !q.gate ? { ...q, ask: String(e.ask).trim(), v: `${q.v}e`, off } : { ...q, off }; })
    .filter((q) => !q.off);
  return { ...c, list };
}

// One round of questions: the look deciders first; the rest of the panel only for answers that came back unsure.
// panel 'quick' (look, the screenshot and gap checks) or 'full' (every decider: answering a question for the user in YOLO).
export async function askDeciders({ S, state, questions, signal, account, onVote, panel = 'quick', ensembleFn = ensemble }) {
  const all = (Array.isArray(S.voters) && S.voters.length ? S.voters : []).slice(0, 5);
  const first = panel === 'quick' ? (Array.isArray(S.lookVoters) && S.lookVoters.length ? S.lookVoters : LOOK_DEFAULTS.lookVoters).slice(0, 3) : all;
  const d = await ensembleFn({ voters: first, state, questions, gate: S.gate, signal, account, onVote });
  const unsure = questions.filter((q) => d.results[q.id].verdict !== 'settled');
  const rest = all.filter((m) => !first.includes(m));
  if (panel !== 'quick' || S.lookEscalate === false || !unsure.length || !rest.length) return { ...d, voters: first, escalated: 0 };
  const more = await ensembleFn({ voters: rest, state, questions: unsure, gate: S.gate, signal, account, onVote: onVote && ((v) => onVote({ ...v, vi: v.vi + first.length })) });
  const results = { ...d.results };
  for (const q of unsure) results[q.id] = aggregate(q, [...d.votes, ...more.votes], S.gate);
  return { results, votes: [...d.votes, ...more.votes], ms: d.ms + more.ms, voters: [...first, ...rest], escalated: unsure.length };
}

// ---------- the log and the screenshot library ----------
export const CHECK_LOG = path.join(HOME, 'logs', 'checks.jsonl');
export const SHOT_DIR = path.join(HOME, 'logs', 'check-shots');
const SHOT_KEEP = 800;
let shotsSincePrune = 0;
export function saveShot(dataUrl) {
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  const name = `${crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const f = path.join(SHOT_DIR, name);
    if (!fs.existsSync(f)) fs.writeFileSync(f, buf);
    if (++shotsSincePrune >= 50) { shotsSincePrune = 0; pruneShots(); }
  } catch { return null; }
  return name;
}
function pruneShots() {
  const files = fs.readdirSync(SHOT_DIR).map((n) => ({ n, t: fs.statSync(path.join(SHOT_DIR, n)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const f of files.slice(SHOT_KEEP)) { try { fs.unlinkSync(path.join(SHOT_DIR, f.n)); } catch { /* in use */ } }
}
export function logCheck(rec) {
  fs.mkdir(path.dirname(CHECK_LOG), { recursive: true }, () => fs.appendFile(CHECK_LOG, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n', () => {}));
}
// What each decider said about each question, for the log (which single decider agrees most with the panel).
export function votesFor(d, q) {
  return d.votes.filter((v) => v?.dists?.[q.id]).map((v) => ({ m: v.model, p: +(v.dists[q.id].yes ?? 0).toFixed(3) }));
}

// The page's main control, for the click check: a start/play/add-style button if there is one, else the first button.
export const MAIN_CONTROL_JS = `(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && r.top < innerHeight && r.bottom > 0; };
  const label = (e) => (e.innerText || e.value || e.getAttribute('aria-label') || e.title || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
  const skip = /\\b(print|pdf|download|export|share|copy|tweet|email|mail|log ?out|sign ?out|delete|remove|clear|reset)\\b/i;
  const selected = (e) => ['aria-pressed', 'aria-selected', 'aria-checked', 'aria-current'].some((a) => { const v = e.getAttribute(a); return v && v !== 'false'; }) || /(^|\\s)(active|selected|is-active|is-selected|current|checked|on)(\\s|$)/i.test(e.className || '');
  const leaves = (e) => e.tagName === 'A' && e.href && !/^(#|javascript:)/i.test(e.getAttribute('href') || '#') && new URL(e.href, location.href).origin !== location.origin;
  const all = [...document.querySelectorAll('button, [role=button], input[type=submit], input[type=button], a.btn, a.button')].filter((e) => vis(e) && !e.disabled && label(e) && !skip.test(label(e)) && !selected(e) && !leaves(e) && !e.closest('form:invalid ~ *'));
  // On a fresh page "New game", "Restart" or "Shuffle" change nothing you can see: only if there is nothing better.
  const fresh = /\\b(new game|restart|shuffle|reshuffle|replay|play again|try again|new round)\\b/i;
  const good = /\\b(start|play|begin|add|create|generate|submit|calculate|go|next|save|roll|draw|deal|search|filter|apply|launch)\\b/i;
  const pick = all.find((e) => good.test(label(e)) && !fresh.test(label(e))) || all.find((e) => !fresh.test(label(e))) || all[0];
  return pick ? label(pick) : null;
})()`;
// A page with no button to click but something to play (a canvas, or nothing clickable): try the keys games start with.
export const KEY_PAGE_JS = `(() => !!document.querySelector('canvas') || ![...document.querySelectorAll('button, [role=button], input, select, textarea, a[href]')].some((e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4; }))()`;
export const KEY_TRIES = [['Enter'], ['Space'], ['ArrowRight', 'ArrowUp']];
