// The decider ensemble (adapted from the Synapse workshop): one Decisions request per decider
// carrying every question, averaged into a soft vote. Choice options are shuffled per decider
// (some deciders lean toward the first option) and confidence uses TypeSafe's per-type formulas.
import { decisions } from './openrouter.js';

export const GATE = { act: 0.8, confirm: 0.5 }; // ≥ act: settled · ≥ confirm: lean · below: uncertain

export function keysOf(q) {
  if (q.type === 'noul') return ['yes', 'no'];
  if (q.type === 'score') return q.levels.map((_, i) => String(i));
  return Object.keys(q.options);
}

function shuffled(entries) {
  const a = [...entries];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function toWire(q) {
  if (q.type === 'noul') return { type: 'noul', instructions: q.ask };
  if (q.type === 'score') return { type: 'score', instructions: q.ask, criteria: q.levels };
  return { type: 'choice', instructions: q.ask, criteria: Object.fromEntries(shuffled(Object.entries(q.options))) };
}

export function confidenceOf(type, dist, keys) {
  const p = keys.map((k) => dist[k] || 0), n = p.length;
  if (type === 'noul') return Math.abs(2 * (dist.yes || 0) - 1);
  if (type === 'choice') return Math.max(0, (Math.max(...p) - 1 / n) / (1 - 1 / n));
  const m = p.indexOf(Math.max(...p));
  const spread = p.reduce((s, v, i) => s + v * Math.abs(i - m), 0);
  const even = p.reduce((s, _, i) => s + Math.abs(i - (n - 1) / 2), 0) / n;
  return Math.max(0, 1 - spread / even);
}

function distOf(q, a) {
  if (!a) return null;
  if (q.type === 'noul' && typeof a.noul === 'number') return { yes: a.noul, no: 1 - a.noul };
  if (a.probabilities) return Object.fromEntries(keysOf(q).map((k) => [k, Number(a.probabilities[k] ?? 0)]));
  return null;
}

const verdictOf = (c, gate) => (c >= gate.act ? 'settled' : c >= gate.confirm ? 'lean' : 'uncertain');

export function aggregate(q, votes, gate) {
  const keys = keysOf(q);
  const ok = votes.filter((v) => v?.dists?.[q.id]);
  const dist = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const v of ok) for (const k of keys) dist[k] += v.dists[q.id][k] / ok.length;
  const top = keys.reduce((a, b) => (dist[b] > dist[a] ? b : a), keys[0]);
  const confidence = ok.length ? confidenceOf(q.type, dist, keys) : 0;
  const ev = q.type === 'score' ? keys.reduce((s, k) => s + Number(k) * dist[k], 0) : null;
  // `pick` is the key the deciders landed on, comparable with the agent's guess.
  const pick = q.type === 'noul' ? (dist.yes >= 0.5 ? 'yes' : 'no') : q.type === 'score' ? String(Math.round(ev)) : top;
  const answer = !ok.length ? null
    : q.type === 'noul' ? `${pick} (P(yes)=${dist.yes.toFixed(2)})`
    : q.type === 'score' ? `${q.levels[Math.round(ev)]} (level ${ev.toFixed(2)} of ${keys.length - 1})`
    : top;
  return {
    dist, pick, answer, confidence, ev,
    agree: ok.filter((v) => v.tops[q.id] === (q.type === 'noul' ? pick : q.type === 'score' ? pick : top)).length,
    n: ok.length,
    verdict: ok.length ? verdictOf(confidence, gate) : 'failed',
  };
}

/** Asks every decider all questions at once. onVote fires as each decider returns. */
export async function ensemble({ voters, state, questions, gate = GATE, signal, onVote, account }) {
  const t0 = Date.now();
  const votes = await Promise.all(voters.map(async (model, vi) => {
    const wire = Object.fromEntries(questions.map((q) => [q.id, toWire(q)]));
    try {
      const r = await decisions(model, state, wire, signal);
      account?.(r.usage, model, 'decider');
      const dists = {}, tops = {};
      for (const q of questions) {
        const d = distOf(q, r.answers[q.id]);
        if (!d) continue;
        dists[q.id] = d;
        tops[q.id] = q.type === 'score'
          ? String(Math.round(keysOf(q).reduce((s, k) => s + Number(k) * d[k], 0)))
          : keysOf(q).reduce((a, b) => (d[b] > d[a] ? b : a));
      }
      onVote?.({ vi, model, ms: r.ms, cost: r.usage.cost, tops });
      return { model, dists, tops };
    } catch (e) {
      if (signal?.aborted) throw e;
      onVote?.({ vi, model, error: e.message });
      return null;
    }
  }));
  const results = Object.fromEntries(questions.map((q) => [q.id, aggregate(q, votes, gate)]));
  return { results, votes, ms: Date.now() - t0 };
}
