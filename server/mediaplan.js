// A production plan for paid media. Work like a movie trailer needs pieces the user never names (stills, clips, a
// voice-over, music); judged one call at a time, literal deciders turn the in-between steps down. So the agent lists
// the paid calls it intends first (media_plan), the harness prices them with the same estimates the single-call
// cards use, and the user (🔒 Strict) or the deciders (⚡ YOLO) approve the whole plan once.
// Later calls that match it (same kind and model, within its count, and not dearer than planned) run without another
// vote. Anything off the plan, or over its estimate, is judged on its own as before. Budget caps apply either way.

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };

export const PLAN_SLACK = 0.2;  // a call may cost this much more than its planned estimate (prices move a little)
export const PLAN_MAX_ITEMS = 12, PLAN_MAX_COUNT = 20;
const NOUN = { image: 'picture', video: 'video clip', music: 'music track', speech: 'voice-over' };

/**
 * The agent's list as plan items: [{ kind, count, model, seconds, chars, what }]. kinds: the media kinds switched on.
 * Returns { items } or { error } (a message for the agent).
 */
export function normalizePlan(raw, kinds) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length) return { error: 'give items: one entry per kind of paid call, e.g. [{"kind":"image","count":4,"what":"key frames"},{"kind":"video","count":4,"seconds":5,"what":"one clip per key frame"}].' };
  if (list.length > PLAN_MAX_ITEMS) return { error: `a plan has at most ${PLAN_MAX_ITEMS} items; group calls of the same kind and model into one item with a count.` };
  const items = [];
  for (const [i, x] of list.entries()) {
    const kind = String(x?.kind || '').trim().toLowerCase();
    if (!kinds.includes(kind)) return { error: `item ${i + 1}: kind "${clip(kind, 20)}" is not one of the paid tools switched on (${kinds.join(', ') || 'none'}).` };
    const count = Math.round(Number(x.count) || 0);
    if (count < 1 || count > PLAN_MAX_COUNT) return { error: `item ${i + 1}: count must be 1 to ${PLAN_MAX_COUNT}.` };
    items.push({ kind, count, model: x.model ? String(x.model).trim() : '', ...(kind === 'video' && x.seconds ? { seconds: Math.max(1, Math.round(Number(x.seconds) || 0)) } : {}),
      ...(kind === 'speech' ? { chars: Math.max(50, Math.min(1500, Math.round(Number(x.chars) || 400))) } : {}), what: clip(String(x.what || '').trim(), 160) });
  }
  return { items };
}

/** Plan items, priced: `price(item)` resolves to { model, est, detail, basis } for one call of that item. */
export async function pricePlan(items, price) {
  const out = [];
  for (const it of items) {
    const p = await price(it);
    out.push({ ...it, model: p.model, each: p.est, detail: p.detail || '', basis: p.basis || 'estimated', used: 0 });
  }
  return { items: out, total: out.reduce((s, x) => s + x.each * x.count, 0) };
}

/** One line per item, for the card, the tool result and the judge. */
export const itemLine = (x) => `${x.count} × ${NOUN[x.kind] || x.kind} with ${x.model}${x.detail ? ` (${x.detail})` : ''}, about $${(x.each * x.count).toFixed(3)}${x.what ? `: ${x.what}` : ''}`;

/** What the deciders see of a plan: the harness's prices and the agent's short description of each part (data, not reasons). */
export const planFacts = (plan, budget) => ({
  production_plan: plan.items.map((x) => ({ kind: x.kind, count: x.count, model: x.model, estimated_each_usd: +x.each.toFixed(4), ...(x.detail ? { detail: x.detail } : {}), ...(x.what ? { part_described_by_agent: x.what } : {}) })),
  estimated_total_usd: +plan.total.toFixed(4),
  media_budget_for_this_reply_usd: budget,
});

/**
 * Does one paid call fit the approved plan? { ok: true, item } or { ok: false, why }.
 * call: { cat, model, est }. A call fits an item of the same kind and model that has calls left, when it costs no more
 * than that item's estimate (plus PLAN_SLACK) and the plan's spending stays within its total (plus PLAN_SLACK).
 */
export function matchPlan(plan, call) {
  if (!plan) return { ok: false, why: 'no plan' };
  const same = plan.items.filter((x) => x.kind === call.cat && x.model === call.model);
  if (!same.length) return { ok: false, why: plan.items.some((x) => x.kind === call.cat) ? `the plan uses another model for ${NOUN[call.cat] || call.cat}s` : `the plan has no ${NOUN[call.cat] || call.cat}s` };
  const left = same.filter((x) => x.used < x.count);
  if (!left.length) return { ok: false, why: `the plan's ${same.reduce((s, x) => s + x.count, 0)} ${NOUN[call.cat] || call.cat}${same.length > 1 || same[0].count > 1 ? 's are' : ' is'} used up` };
  const item = left.find((x) => call.est <= x.each * (1 + PLAN_SLACK) + 1e-9);
  if (!item) return { ok: false, why: `this call (about $${call.est.toFixed(3)}) costs more than the plan's estimate for it ($${left[0].each.toFixed(3)})` };
  if ((plan.spent || 0) + call.est > plan.total * (1 + PLAN_SLACK) + 1e-9) return { ok: false, why: `it would take the plan past its estimated total ($${plan.total.toFixed(3)})` };
  return { ok: true, item };
}

/** Counts an approved call against the plan. */
export function usePlan(plan, item, est) {
  item.used++;
  plan.spent = (plan.spent || 0) + est;
}

/** What is left of a plan, for the agent. */
export const planLeft = (plan) => plan.items.filter((x) => x.used < x.count).map((x) => `${x.count - x.used} × ${NOUN[x.kind] || x.kind} (${x.model})`).join(', ') || 'nothing';
