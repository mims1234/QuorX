// Refreshes the news/ folder that ships with QuorX from the QuorX website's News feed, so a release carries current
// News for the first start and for computers that don't download it. npm run news:snapshot
// It downloads with the same checks QuorX uses (server/newsremote.js) into a throwaway folder, then replaces the
// published articles, reports and updates.json in news/. Drafts (folders starting with _) and news/README.md stay.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEWS = path.join(ROOT, 'news');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quorx-news-snapshot-'));
process.env.OH_HOME = home; // read when server/openrouter.js loads, so the imports below come after it
if (!process.env.QUORX_NEWS_SITE || process.env.QUORX_NEWS_SITE === 'off') process.env.QUORX_NEWS_SITE = 'https://quorx.genxmims.org';

try {
  const { syncNews, newsCacheDir } = await import('../server/newsremote.js');
  const { checkNews } = await import('./news-check.mjs');
  const st = await syncNews({ force: true });
  if (st.error) throw new Error(`the download failed: ${st.error}`);
  const cache = newsCacheDir();
  for (const kind of ['articles', 'reports']) {
    const dest = path.join(NEWS, kind);
    fs.mkdirSync(dest, { recursive: true });
    for (const slug of fs.readdirSync(dest)) if (!slug.startsWith('_')) fs.rmSync(path.join(dest, slug), { recursive: true, force: true });
    const src = path.join(cache, kind);
    for (const slug of fs.existsSync(src) ? fs.readdirSync(src) : []) fs.cpSync(path.join(src, slug), path.join(dest, slug), { recursive: true });
  }
  // updates.json only when its content changed, so an unchanged file keeps its own layout
  const fresh = JSON.parse(fs.readFileSync(path.join(cache, 'updates.json'), 'utf8'));
  let current = null; try { current = JSON.parse(fs.readFileSync(path.join(NEWS, 'updates.json'), 'utf8')); } catch { /* none yet */ }
  if (JSON.stringify(fresh.versions) !== JSON.stringify(current?.versions)) fs.writeFileSync(path.join(NEWS, 'updates.json'), `${JSON.stringify(fresh, null, 2)}\n`);
  const problems = checkNews(NEWS);
  for (const p of problems) console.log(`✗ ${p.where}: ${p.problem}`);
  console.log(problems.length ? `news/ refreshed, but ${problems.length} problem(s) need fixing` : `news/ refreshed from ${process.env.QUORX_NEWS_SITE} (${st.files} files, feed ${st.generated || 'undated'})`);
  process.exitCode = problems.length ? 1 : 0;
} catch (e) {
  console.error(`News snapshot not made: ${e.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
