// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// What a model and the providers serving it accept, so a request is built to fit instead of failing and being sent
// again. Two sources, both public OpenRouter data: the model list (reasoning that can't be turned off, the reasoning
// levels it accepts) and each model's endpoint list (per provider: context, output cap, which tool_choice values it
// takes). What a route refuses at run time is remembered on top. The functions here are pure apart from the small
// in-memory caches; openrouter.js applies them to every call it makes.

const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** A model list entry's reasoning facts: { mandatory, efforts, maxTokens }, or null when it has none. */
export function reasoningFacts(m) {
  const r = m?.reasoning;
  if (!r || typeof r !== 'object') return null;
  return {
    mandatory: !!r.mandatory,
    efforts: Array.isArray(r.supported_efforts) ? r.supported_efforts.filter((e) => LEVELS.includes(e)) : null,
    ...(r.supports_max_tokens != null ? { maxTokens: !!r.supports_max_tokens } : {}),
  };
}

/** The accepted level nearest to `want` (a lower one wins a tie), or `want` when nothing is known. */
export function nearestEffort(want, efforts) {
  if (!efforts?.length || efforts.includes(want)) return want;
  const w = LEVELS.indexOf(want);
  if (w < 0) return want;
  let best = null, dist = Infinity;
  for (const e of efforts) {
    const d = Math.abs(LEVELS.indexOf(e) - w);
    if (d < dist || (d === dist && LEVELS.indexOf(e) < LEVELS.indexOf(best))) { best = e; dist = d; }
  }
  return best ?? want;
}

/**
 * The request's `reasoning` made to fit the model: never "off" for a model that can't turn it off (its lightest
 * level instead, thinking hidden), and an effort it lists rather than one it doesn't. Returns the body unchanged when
 * nothing needs changing, else a copy.
 */
export function fitReasoning(body, facts) {
  const r = body?.reasoning;
  if (!r || !facts) return body;
  if (r.enabled === false || r.effort === 'none') {
    if (!facts.mandatory) return body;
    const lightest = facts.efforts?.length ? LEVELS.find((l) => l !== 'none' && facts.efforts.includes(l)) || 'low' : 'low';
    return { ...body, reasoning: { effort: lightest, exclude: true } };
  }
  if (r.effort && facts.efforts?.length) {
    const e = nearestEffort(r.effort, facts.efforts);
    if (e !== r.effort) return { ...body, reasoning: { ...r, effort: e } };
  }
  return body;
}

// ---------- providers: one summary per model, from /api/v1/models/<id>/endpoints ----------

/** The slug OpenRouter's provider filters use for an endpoint ("relace/fp4" → "relace"). */
export const endpointSlug = (e) => String(e?.tag || e?.provider_name || '').split('/')[0].toLowerCase();

/**
 * One model's endpoints summed up for the providers a request may use (`ignore`: slugs it blocks): the smallest
 * context and output cap among them, and which tool_choice values every one of them takes. An unknown value counts
 * as taken. Null when no endpoint is left.
 */
export function summariseEndpoints(endpoints, { ignore = [] } = {}) {
  const skip = new Set(ignore.map((s) => String(s).toLowerCase()));
  const eps = (endpoints || []).filter((e) => !skip.has(endpointSlug(e)) && (!e.supported_parameters || e.supported_parameters.includes('tools')));
  if (!eps.length) return null;
  const min = (k) => { const v = eps.map((e) => Number(e[k]) || 0).filter((n) => n > 0); return v.length ? Math.min(...v) : null; };
  const all = (k) => eps.every((e) => e.supports_tool_choice?.[k] !== false);
  return { providers: eps.length, context: min('context_length'), maxOut: min('max_completion_tokens'), toolChoice: { none: all('none'), required: all('required'), function: all('function') } };
}

const kindOf = (tc) => (tc == null || tc === 'auto' ? null : typeof tc === 'string' ? tc : tc.type === 'function' || tc.function ? 'function' : null);

/**
 * A tool_choice every allowed provider takes: the one asked for when it fits, else "auto". `refused` holds kinds this
 * model's route refused at run time. Returns { tool_choice, was } where `was` is the kind replaced, if any, so the
 * caller can keep the answer within what was asked (no calls for "none", only the named tool for a forced one).
 */
export function fitToolChoice(toolChoice, summary, refused) {
  const kind = kindOf(toolChoice);
  if (!kind) return { tool_choice: toolChoice };
  const ok = !(refused?.has(kind)) && (!summary || summary.toolChoice[kind] !== false);
  return ok ? { tool_choice: toolChoice } : { tool_choice: 'auto', was: kind };
}

/** Keeps an answer within the tool_choice that was asked for after it had to go out as "auto". */
export function keepWithinChoice(calls, asked, was) {
  if (!was || !Array.isArray(calls)) return calls;
  if (was === 'none') return [];
  const name = asked?.function?.name || asked?.name;
  return was === 'function' && name ? calls.filter((c) => c?.function?.name === name) : calls;
}

// ---------- caches ----------

const endpointCache = new Map(); // model id → { at, endpoints }
const refusedChoices = new Map(); // model id → Set of tool_choice kinds its route refused
export const ENDPOINT_TTL = 24 * 3600e3;

/** A model's endpoint list, fetched once a day with `fetcher(id)`; never waits longer than `waitMs`, never throws. */
export async function endpointsOf(id, fetcher, { waitMs = 2500, now = Date.now() } = {}) {
  const hit = endpointCache.get(id);
  if (hit && now - hit.at < ENDPOINT_TTL) return hit.endpoints;
  const got = await Promise.race([Promise.resolve().then(() => fetcher(id)).catch(() => null), new Promise((r) => setTimeout(() => r(undefined), waitMs))]);
  if (Array.isArray(got)) { endpointCache.set(id, { at: now, endpoints: got }); return got; }
  return hit?.endpoints || null;
}
export const noteRefusedChoice = (id, kind) => { if (!kind) return; if (!refusedChoices.has(id)) refusedChoices.set(id, new Set()); refusedChoices.get(id).add(kind); };
export const refusedChoicesOf = (id) => refusedChoices.get(id) || null;
/** Tests start clean. */
export const forgetModelFacts = () => { endpointCache.clear(); refusedChoices.clear(); };
export { kindOf as toolChoiceKind };
