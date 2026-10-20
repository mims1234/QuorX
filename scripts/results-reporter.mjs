// A node --test reporter that prints nothing: when the run ends it saves the totals (and the names of failed tests) to
// logs/test-results.json for News. npm test runs it next to the usual spec reporter.
import { saveTestResult } from './test-results.mjs';

export default async function* resultsReporter(source) {
  const totals = {};
  const failed = [];
  for await (const e of source) {
    if (e.type === 'test:fail' && e.data.details?.type !== 'suite' && !e.data.nesting && failed.length < 20) failed.push(String(e.data.name).split(/[\\/]/).pop()); // a file that fails to load is named by its path: keep the file name
    // The run's totals arrive as top-level diagnostics ("tests 176", "pass 175", …), duration_ms last. They are saved
    // as soon as that one arrives: --test-force-exit ends the process right after it, before this stream closes.
    if (e.type !== 'test:diagnostic' || e.data.nesting) continue;
    const m = /^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$/.exec(String(e.data.message));
    if (!m) continue;
    totals[m[1]] = Number(m[2]);
    if (m[1] === 'duration_ms' && totals.tests != null) {
      saveTestResult('test', { total: totals.tests, pass: totals.pass ?? 0, fail: totals.fail ?? 0, skipped: (totals.skipped ?? 0) + (totals.todo ?? 0),
        cancelled: totals.cancelled ?? 0, seconds: +(totals.duration_ms / 1000).toFixed(1), failed });
    }
  }
}
