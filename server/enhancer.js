// The prompt enhancer: a cheap model reads the user's request (their words only) and spells out what it plainly
// implies, so literal-minded readers don't miss it. "Make a 30-second movie" says nothing about voices, music or
// sound, yet a movie without them disappoints; a decider judging "did the user ask for speech?" from the words alone
// says no. The reading goes to the agent (as a note on the request) and to the approval judge (beside the user's
// own messages), and the user sees it and can correct it.
// It never sees the agent's text, tool output, files or attachments, so nothing but the user's words can shape it.
import { chat } from './openrouter.js';

const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };

export const ENHANCER_SYSTEM = `You read a user's request to an AI agent that makes things (apps, games, web pages, videos, music, pictures, voice-overs, documents) and spell out what the request means in full, so that literal-minded checkers don't miss what it obviously implies.

Answer with JSON only:
{"goal": "one sentence: what the user wants",
 "kind": "what is being made: app, site, game, video, image, audio, document, other, or none (not a request to make something)",
 "includes": ["what a reasonable person expects the result to have even though the request doesn't say it"],
 "assumptions": ["a sensible default you chose for something the request leaves open (style, length, audience, platform)"]}

How to read:
- Implied means: most people asking this would be disappointed without it. A 30-second movie implies moving pictures, spoken dialogue or narration when there are characters or a story, background music and sound effects. A game implies a way to start, controls, a score or goal, and an end state. A landing page implies a headline, a call to action, and working on phones.
- Name the kind of thing each item needs when it matters for making it, e.g. "a voice for the narration (speech)", "background music", "sound effects".
- Work only from the user's words (and the earlier messages, if given). Don't add features they would not expect, and don't repeat what they already said word for word.
- Short items, under 15 words each. At most 8 includes and 5 assumptions.
- kind "video" only when the finished thing is a film to watch (a trailer, a reel, an explainer, a music video); a site or app that plays videos is a site or an app.
- If the message is not a request to make or do something (a question, a greeting, feedback on earlier work), return the goal, kind "none" and empty lists.`;
const KINDS = new Set(['app', 'site', 'game', 'video', 'image', 'audio', 'document', 'other', 'none']);

/** Turns the model's JSON into the reading. null when it gave nothing usable. */
export function parseReading(raw) {
  const s = String(raw || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let j;
  try { j = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  const list = (x, n) => (Array.isArray(x) ? x : []).map((v) => clip(String(v ?? '').trim(), 160)).filter(Boolean).slice(0, n);
  const goal = clip(String(j.goal || '').trim(), 300);
  if (!goal) return null;
  const kind = String(j.kind || '').trim().toLowerCase();
  return { goal, ...(KINDS.has(kind) ? { kind } : {}), includes: list(j.includes, 8), assumptions: list(j.assumptions, 5) };
}

/** The reading as the plain text the user sees and edits, and the agent and judges read. */
export function readingText(r) {
  return [
    `Goal: ${r.goal}`,
    ...(r.includes.length ? ['Implied (part of the request even though unsaid):', ...r.includes.map((x) => `- ${x}`)] : []),
    ...(r.assumptions.length ? ['Assumed (defaults; the user may change them):', ...r.assumptions.map((x) => `- ${x}`)] : []),
  ].join('\n');
}

/**
 * Reads one request. earlier: the user's earlier turns in this chat (strings, oldest first), for context.
 * Resolves to { goal, includes, assumptions, text, model, usage } or null.
 */
export async function enhanceRequest({ text, earlier = [], model, signal, call = chat }) {
  const prior = earlier.filter(Boolean).slice(-3).map((m) => `- ${clip(m, 400)}`).join('\n');
  const r = await call({ model, max_tokens: 900, temperature: 0.2, reasoning: { enabled: false }, messages: [
    { role: 'system', content: ENHANCER_SYSTEM },
    { role: 'user', content: `${prior ? `The user's earlier messages in this chat:\n${prior}\n\n` : ''}The request to read:\n${clip(text, 4000)}` },
  ] }, signal);
  const reading = parseReading(r?.message?.content);
  return reading ? { ...reading, text: readingText(reading), model, usage: r.usage || {} } : null;
}

// ✨ Enhance in the composer: the user's draft, rewritten before they send it. The same cheap model; the user sees
// the result in the box, can press it again or undo, and sends it themselves.
export const REWRITE_SYSTEM = `You improve a user's draft message to an AI agent that builds things and does tasks on their computer, before they send it.

Rewrite it so the agent gets it right the first time:
- Keep the user's intent, voice and language (write in the language they used). Never change what they asked for.
- Put the goal first, then what the request plainly implies and a reasonable person would expect, as short points.
- Keep every detail they gave: names, numbers, files, links, code, constraints.
- Don't invent features, facts, file names or requirements they would not expect. Where something important is open, state a sensible default the agent may use ("Assume ...") instead of asking.
- As short as it can be while complete. No preamble, no explanation, no quotes around it.
- If the draft is a question, a greeting or feedback rather than a request, only fix spelling and make it clear.

Answer with the rewritten message only.`;
/** Rewrites a draft. earlier: the user's earlier turns in this chat (strings, oldest first). Resolves to { text, model, cost } or null. */
export async function rewritePrompt({ text, earlier = [], model, signal, call = chat }) {
  const prior = earlier.filter(Boolean).slice(-3).map((m) => `- ${clip(m, 400)}`).join('\n');
  const r = await call({ model, max_tokens: 1500, temperature: 0.3, reasoning: { enabled: false }, messages: [
    { role: 'system', content: REWRITE_SYSTEM },
    { role: 'user', content: `${prior ? `The user's earlier messages in this chat:\n${prior}\n\n` : ''}The draft to improve:\n${clip(text, 8000)}` },
  ] }, signal);
  const out = String(r?.message?.content || '').trim().replace(/^```\w*\n?/, '').replace(/\n?```$/, '').replace(/^"([\s\S]*)"$/, '$1').trim();
  return out ? { text: out, model, cost: r?.usage?.cost || 0 } : null;
}
