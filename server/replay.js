// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Recorded model replies for tests. A recording holds every model call of one reply: a short summary of what the loop
// asked (tool names, tool_choice, message roles) and the answer exactly as the loop received it (text, tool calls,
// reasoning, finish reason). Played back as the model, it makes the loop take the same steps with no key, no network
// and no money, so tests see what real models send instead of hand-written replies.
// scripts/record-chat.mjs makes recordings; scripts/test-replay.mjs plays back the ones in scripts/fixtures/replay.

export const RECORDING_VERSION = 1;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Keys and tokens that could appear in a request or an answer, whatever their source.
const SECRETS = [/sk-or-v1-[A-Za-z0-9]{20,}/g, /sk-(?:ant|proj|live)?-?[A-Za-z0-9_-]{24,}/g, /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g, /\bgh[pousr]_[A-Za-z0-9]{30,}/g, /\bAIza[0-9A-Za-z_-]{30,}/g];

/** A copy of `value` with folder paths named by placeholders and anything that looks like a key removed. */
export function scrub(value, folders = {}) {
  const swaps = [];
  for (const [name, dir] of Object.entries(folders)) {
    if (!dir) continue;
    const d = String(dir).replace(/[\\/]+$/, '');
    // A path can appear with either slash, and doubled backslashes inside JSON text.
    for (const form of new Set([d, d.replace(/\\/g, '/'), d.replace(/\//g, '\\'), d.replace(/\\/g, '\\\\')])) swaps.push([new RegExp(esc(form), 'gi'), `<${name}>`]);
  }
  swaps.sort((a, b) => b[0].source.length - a[0].source.length); // the project folder before the temp folder it sits in
  const text = (s) => {
    let out = s;
    for (const [re, to] of swaps) out = out.replace(re, to);
    for (const re of SECRETS) out = out.replace(re, '<secret>');
    return out;
  };
  const walk = (v) => (typeof v === 'string' ? text(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(value);
}

/** What replay checks about a request: the tools on offer, the tool_choice and the roles of the messages. */
export const requestSummary = (body) => ({
  tools: (body.tools || []).map((t) => t.function?.name || t.type).filter(Boolean),
  ...(body.tool_choice != null ? { tool_choice: typeof body.tool_choice === 'string' ? body.tool_choice : body.tool_choice.function?.name || body.tool_choice.type } : {}),
  roles: (body.messages || []).map((m) => m.role),
});

/** The parts of a model answer the loop reads, with timings fixed so replays are stable. */
export const answerOf = (r) => ({
  text: r.text || '',
  ...(r.thinking ? { thinking: r.thinking } : {}),
  ...(r.reasoningDetails?.length ? { reasoningDetails: r.reasoningDetails } : {}),
  toolCalls: (r.toolCalls || []).map((c) => ({ id: c.id, type: c.type || 'function', function: { name: c.function?.name || '', arguments: c.function?.arguments ?? '' } })),
  finishReason: r.finishReason ?? null,
  usage: { cost: Number(r.usage?.cost) || 0, prompt_tokens: Number(r.usage?.prompt_tokens) || 0, completion_tokens: Number(r.usage?.completion_tokens) || 0 },
  ms: 1, firstMs: 1,
});

/** What a reply did, from its events: the tools it ran in order, how it stopped and its final text. */
export function outcomeOf(events) {
  const done = events.find((e) => e.t === 'done');
  return { tools: events.filter((e) => e.t === 'tool' && !e.by).map((e) => e.name), stop: done?.stats?.stop ?? null, reply: done?.reply ?? null };
}

/**
 * Wraps a model stream so each call is recorded. `model` replaces the request's model id on the way out (tests run
 * the loop with a placeholder id); `onCall({ request, answer })` gets every finished call.
 */
export function recorder(stream, { model, onCall } = {}) {
  return async (body, signal, onText, onThink) => {
    const r = await stream(model ? { ...body, model } : body, signal, onText, onThink);
    onCall?.({ request: requestSummary(body), answer: answerOf(r) });
    return r;
  };
}

/**
 * A scripted model that plays a recording back: call i gets the i-th recorded answer. It refuses when the loop asks
 * for more calls than were recorded, or when a recorded answer calls a tool the loop no longer offers, so a change
 * that alters the loop's steps shows up as a clear failure instead of a confusing one later.
 */
export function replayer(recording) {
  const calls = recording?.calls || [];
  return (body, i) => {
    const c = calls[i];
    if (!c) throw new Error(`Replay: the loop asked for model call ${i + 1}, but the recording "${recording?.name || '?'}" has ${calls.length}.`);
    // A tool offered when the call was recorded must still be offered. (One that wasn't, such as a rare tool loaded by
    // calling it, is the loop's business either way.)
    const offered = new Set(requestSummary(body).tools), then = new Set(c.request?.tools || []);
    for (const tc of c.answer.toolCalls) {
      const n = tc.function.name;
      if (n && then.has(n) && !offered.has(n)) throw new Error(`Replay: recorded call ${i + 1} uses the tool ${n}, which the loop no longer offers.`);
    }
    return structuredClone(c.answer);
  };
}
