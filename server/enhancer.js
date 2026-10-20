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
 "includes": ["what a reasonable person expects the result to have even though the request doesn't say it"],
 "assumptions": ["a sensible default you chose for something the request leaves open (style, length, audience, platform)"]}

How to read:
- Implied means: most people asking this would be disappointed without it. A 30-second movie implies moving pictures, spoken dialogue or narration when there are characters or a story, background music and sound effects. A game implies a way to start, controls, a score or goal, and an end state. A landing page implies a headline, a call to action, and working on phones.
- Name the kind of thing each item needs when it matters for making it, e.g. "a voice for the narration (speech)", "background music", "sound effects".
- Work only from the user's words (and the earlier messages, if given). Don't add features they would not expect, and don't repeat what they already said word for word.
- Short items, under 15 words each. At most 8 includes and 5 assumptions.
- If the message is not a request to make or do something (a question, a greeting, feedback on earlier work), return the goal and empty lists.`;

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
  return { goal, includes: list(j.includes, 8), assumptions: list(j.assumptions, 5) };
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
