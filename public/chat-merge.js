// When a chat's save is refused because its file moved on (another window, or another QuorX on the same data
// folder), the page merges its copy with the server's instead of saving over it. Three copies take part: base (what
// this page last saved), mine (the page now) and theirs (the server now). No DOM here, so the tests load it in node.

// JSON with its keys sorted, so two copies of one thing compare equal however their keys were put in.
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : stable(x))).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return v === undefined ? undefined : JSON.stringify(v);
}
// A message compared without its steps and thinking: the server keeps a finished reply's steps apart (traceRef), so
// those differ between copies of the same message.
const canon = (m) => (m == null ? undefined : stable({ ...m, trace: undefined, traceRef: undefined, thinking: undefined }));
// Messages have no id of their own: a reply has its run id; anything else is known by its kind and when it was made.
export const msgKey = (m) => m?.id ? `id:${m.id}` : m?.runId ? `run:${m.runId}` : m?.at ? `${m.role}:${m.at}` : `${m?.role}:${stable(m)}`;
const keyed = (list) => { const seen = new Map(); return (list || []).map((m) => { const k = msgKey(m), n = seen.get(k) || 0; seen.set(k, n + 1); return n ? `${k}#${n}` : k; }); };

// One part three ways: mine when only this page changed it (or both made it the same), theirs when only they did,
// gone when one side removed it and the other left it as it was. null when both changed it differently.
function pick(b, m, t, live) {
  if (m !== undefined && t !== undefined) {
    if (m === t || live) return 'mine';
    if (m === b) return 'theirs';
    if (t === b) return 'mine';
    return null;
  }
  if (m !== undefined) return b === undefined ? 'mine' : m === b ? 'gone' : live ? 'mine' : null;
  if (t !== undefined) return b === undefined ? 'theirs' : t === b ? 'gone' : null;
  return 'gone';
}

/**
 * Merges three copies of a chat (each shaped like the page's saved chat: head fields, and agent with its messages and
 * artifacts). live(i): mine's message i is a reply running in this page, which always stays this page's.
 * → { ok: true, doc, from: [['mine' | 'theirs', index]] for each message of doc, changed: doc isn't mine as it was }
 *   or { ok: false, why } when the same thing was changed on both sides.
 */
export function mergeChat(base, mine, theirs, { live = () => false } = {}) {
  let changed = false;
  // ----- messages: a union in order -----
  const bm = base?.agent?.messages || [], mm = mine.agent?.messages || [], tm = theirs.agent?.messages || [];
  const bk = keyed(bm), mk = keyed(mm), tk = keyed(tm);
  const bAt = new Map(bk.map((k, i) => [k, canon(bm[i])])), mAt = new Map(mk.map((k, i) => [k, i])), tAt = new Map(tk.map((k, i) => [k, i]));
  const out = []; // { key, side, i, at }
  for (const [j, k] of tk.entries()) {
    const i = mAt.get(k), side = pick(bAt.get(k), i == null ? undefined : canon(mm[i]), canon(tm[j]), i != null && live(i));
    if (side === null) return { ok: false, why: `message ${k} changed here and in another window` };
    if (side === 'gone') { if (i != null) changed = true; continue; }
    if (side === 'theirs') changed = true;
    out.push(side === 'mine' ? { key: k, side, i, at: mm[i]?.at } : { key: k, side, i: j, at: tm[j]?.at });
  }
  let pos = -1;
  for (const [i, k] of mk.entries()) {
    const at = out.findIndex((x) => x.key === k);
    if (at >= 0) { pos = at; continue; }
    if (tAt.has(k)) continue; // weighed above and left out
    const side = pick(bAt.get(k), canon(mm[i]), undefined, live(i));
    if (side === null) return { ok: false, why: `message ${k} changed here and was removed in another window` };
    if (side === 'gone') { changed = true; continue; }
    // New in this page: after the message it follows here, and after what the other window added before it.
    let p = pos + 1;
    while (p < out.length && !mAt.has(out[p].key) && (out[p].at ?? 0) <= (mm[i]?.at ?? Infinity)) p++;
    out.splice(p, 0, { key: k, side: 'mine', i, at: mm[i]?.at });
    pos = p;
  }
  // ----- artifacts: each one three ways -----
  const ba = base?.agent?.artifacts || {}, ma = mine.agent?.artifacts || {}, ta = theirs.agent?.artifacts || {};
  const artifacts = {};
  for (const id of new Set([...Object.keys(ta), ...Object.keys(ma)])) {
    const side = pick(stable(ba[id]), stable(ma[id]), stable(ta[id]), false);
    if (side === null) return { ok: false, why: `artifact ${id} changed here and in another window` };
    if (side === 'gone') { if (id in ma) changed = true; continue; }
    if (side === 'theirs' && stable(ma[id]) !== stable(ta[id])) changed = true;
    artifacts[id] = side === 'mine' ? ma[id] : ta[id];
  }
  // ----- the head (title, tools, approval, the agent's setup…): this page's change wins, else theirs -----
  const field = (b, m, t, k) => {
    // Spending is added to by both sides: what this page added since its save goes onto theirs.
    if (k === 'extraUsage' && (Array.isArray(m) || Array.isArray(t))) {
      const had = new Set([...(b || []), ...(t || [])].map(stable));
      const add = (m || []).filter((x) => !had.has(stable(x)));
      return [...(t || []), ...add];
    }
    return stable(m) !== stable(b) ? m : t;
  };
  const headOf = (d) => { const { agent, ...top } = d || {}; return top; };
  const agentOf = (d) => { const { messages, artifacts: _a, ...rest } = d?.agent || {}; return rest; };
  const merge = (b, m, t) => {
    const o = {};
    for (const k of new Set([...Object.keys(t), ...Object.keys(m)])) {
      const v = field(b[k], m[k], t[k], k);
      if (stable(v) !== stable(m[k])) changed = true;
      if (v !== undefined) o[k] = v;
    }
    return o;
  };
  const top = merge(headOf(base), headOf(mine), headOf(theirs));
  const agent = merge(agentOf(base), agentOf(mine), agentOf(theirs));
  const messages = out.map((x) => (x.side === 'mine' ? mm[x.i] : tm[x.i]));
  return { ok: true, doc: { ...top, agent: { ...agent, messages, artifacts } }, from: out.map((x) => [x.side, x.i]), changed };
}
