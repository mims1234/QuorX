# news/

What QuorX's News section shows: `updates.json` (What's new), `articles/` (research) and `reports/` (models, tests,
platforms). It ships with QuorX, so News updates when QuorX does. The format is in
[docs/news-format.md](../docs/news-format.md); check your changes with `npm run news:check`.

Open a page in QuorX at `#news/articles/<slug>` or `#news/reports/<slug>` (drafts, whose folder starts with `_`,
open only this way); `news/articles/_sample` uses every block once.

The reports' data files (`reports/*/*.json`) come from benchmark results, test results, the pack registry and the git
history: rebuild them with `node scripts/news-data.mjs` (it names its sources at the top). It never reads chats or
projects, and the "Your numbers" blocks are filled on each computer from its own logs, never from files in here.
