// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Switching models when a source hits its usage limit (a subscription's 5-hour window, a plan's quota, a provider's
// Retry-After). Each source can name a fallback model in ⚙ Settings → Providers; with none set nothing here applies and
// a failed call goes the old way (sourceFallback in agent.js). These are the decisions only, kept apart so they can be
// tested on their own: agent.js shows the card, waits and switches.

/** The seconds the card counts down before it switches by itself (⚡ YOLO, or a free or subscription fallback). */
export const LIMIT_SECS = 15;
// A reset further away than this is not believed: the card says it doesn't know when the limit resets.
const MAX_RESET_MS = 7 * 24 * 3600e3;

/**
 * Whether a failed call is a usage limit (the card's business) rather than an outage: spent plan usage or credit, a free
 * model kept for its app, or a rate limit that says how long to wait.
 */
export function isLimitHit(kind, retryAfterSecs = 0) {
  return kind === 'quota' || kind === 'free' || (kind === 'rate' && Number(retryAfterSecs) > 0);
}

/** When the limit resets (ms since 1970) from a Retry-After in seconds, or 0 when it doesn't say. */
export function resetAt(retryAfterSecs, now = Date.now()) {
  const s = Number(retryAfterSecs) || 0;
  return s > 0 && s * 1000 <= MAX_RESET_MS ? now + Math.round(s * 1000) : 0;
}

/** What a model costs to switch to: 'free', 'plan' (a subscription: nothing per call) or 'paid'. Unknown is paid. */
export function fallbackCost(info) {
  if (!info) return 'paid';
  if (info.plan === 'plan') return 'plan';
  if (info.plan === 'free') return 'free';
  if (info.plan === 'paid' || info.priceFromApp) return 'paid';
  const [pin, pout] = Array.isArray(info.price) ? info.price.map(Number) : [NaN, NaN];
  return pin === 0 && pout === 0 ? 'free' : 'paid';
}

/**
 * How the card behaves. In 🔒 Strict a paid fallback asks first: no countdown, nothing happens until the user picks.
 * In ⚡ YOLO, or when the fallback costs nothing per call, the card counts down and then switches.
 * A scheduled run has nobody watching: a card that would ask waits `schedMs`, then cancels.
 * @returns {{ cost: string, ask: boolean, ms: number, onTimeout: 'switch'|'cancel'|null }}
 */
export function limitPlan({ approval = 'strict', info = null, secs = LIMIT_SECS, scheduled = false, schedMs = 15e3 } = {}) {
  const cost = fallbackCost(info);
  const ask = approval !== 'yolo' && cost === 'paid';
  const s = Math.max(1, Math.min(120, Number(secs) || LIMIT_SECS));
  if (!ask) return { cost, ask, ms: s * 1000, onTimeout: 'switch' };
  return scheduled ? { cost, ask, ms: schedMs, onTimeout: 'cancel' } : { cost, ask, ms: 0, onTimeout: null };
}

/**
 * The fallback the user chose for this source, or null: none set, the same model, or another model of the same
 * (limited) source.
 */
export function limitFallbackFor(source, model, S = {}) {
  const to = String(S.limitFallback?.[source] || '').trim();
  if (!to || to === model) return null;
  const head = to.slice(0, Math.max(0, to.indexOf('/')));
  return head === source ? null : to;
}

/** The card's answer as what to do: 'switch', 'wait' (only with a known reset) or 'cancel'. */
export function limitChoice(ans, { reset = 0, onTimeout = 'switch' } = {}) {
  if (ans?.timedOut) return onTimeout || 'cancel';
  const c = Number.isInteger(ans?.choice) ? ans.choice : -1;
  if (c === 0) return 'switch';
  if (c === 1) return reset ? 'wait' : 'cancel';
  return 'cancel';
}

/** Whether a switched reply goes back to its own model now: the user left "Switch back" ticked and the reset passed. */
export function switchBackDue(sw, now = Date.now()) {
  return !!(sw && sw.back && sw.until && now >= sw.until);
}
