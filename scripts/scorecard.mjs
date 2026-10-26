// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Per-model results from logs/runs.jsonl (one row per reply): how replies ended, how often the
// checks before the final answer passed, steps, cost and time.  npm run scorecard -- --days 30
import { scorecard } from '../server/runs.js';

const i = process.argv.indexOf('--days');
const days = i > 0 ? Number(process.argv[i + 1]) || 14 : 14;
const rows = scorecard(days);
if (!rows.length) { console.log(`No replies recorded in the last ${days} days.`); process.exit(0); }
console.log(`Replies in the last ${days} days, per model:\n`);
console.table(rows.map((r) => ({
  model: r.model, replies: r.replies,
  ended: Object.entries(r.stops).map(([k, v]) => `${k} ${v}`).join(', '),
  'checks passed': r.checked ? `${r.passed}/${r.checked}` : '–',
  'avg steps': r.avgSteps, 'looks first': r.avgLooksFirst ?? '–', 'avg $': r.avgCost, 'avg s': r.avgSecs, retries: r.retries, 'trimmed replies': r.trimmed,
})));
