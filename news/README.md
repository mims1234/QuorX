# news/

What QuorX's News section shows: `updates.json` (What's new), `articles/` (research) and `reports/` (models, tests,
platforms). It ships with QuorX, so News updates when QuorX does. The format is in
[docs/news-format.md](../docs/news-format.md); check your changes with `npm run news:check`.

Open a page in QuorX at `#news/articles/<slug>` or `#news/reports/<slug>` (drafts, whose folder starts with `_`,
open only this way); `news/articles/_sample` uses every block once.
