# news/

What QuorX's News section shows: `updates.json` (What's new), `articles/` (research) and `reports/` (models, tests,
platforms). The format is in [docs/news-format.md](../docs/news-format.md); `npm run news:check` checks changes.

**This folder is the snapshot that ships with QuorX.** News itself is published on the QuorX website
(https://quorx.genxmims.org/news/), and QuorX downloads new articles, reports and What's new from there between
versions. It shows this folder before the first download, when downloads are off, or when this folder is newer.
Refresh it from the website before a release with `npm run news:snapshot`.

Open a page in QuorX at `#news/articles/<slug>` or `#news/reports/<slug>` (drafts, whose folder starts with `_`,
open only this way); `news/articles/_sample` uses every block once.

The reports' data files (`reports/*/*.json`) come from benchmark results, test results, the pack registry and the git
history: rebuild them with `node scripts/news-data.mjs` (it names its sources at the top), then publish them with the
rest of News on the website. It never reads chats or projects, and the "On this computer" blocks are filled on each
computer from its own logs, never from files in here.
