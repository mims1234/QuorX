// Hosting artifacts at a URL (/art/<chat>/<artifact>), always the newest version: while a reply is
// running, the agent's latest copy; otherwise what the chat file holds. Pages are served as they are;
// Markdown documents are served rendered, as a readable page that suits both themes.
import fs from 'node:fs';
import path from 'node:path';
import { getChat } from './store.js';
import { listFiles } from './workspace.js';
import { renderMarkdown } from '../public/markdown.js';

const LIVE = new Map(); // "<chatId>/<artId>" → { kind, text, title, at }
export function setLiveArtifact(chatId, a) {
  if (!chatId || !a?.id) return;
  const text = a.kind === 'md' ? a.md : a.html;
  if (typeof text !== 'string') return;
  LIVE.set(`${chatId}/${a.id}`, { kind: a.kind, text, title: a.title, at: Date.now() });
  if (LIVE.size > 500) LIVE.delete(LIVE.keys().next().value);
}
/** The newest content of a hostable artifact: { kind: 'html' | 'md', text, title }, or null. */
export function artifactContent(chatId, id) {
  const chat = getChat(chatId);
  // Older saves: artifacts with versions, or agents in column layouts.
  const agent = chat?.agent || Object.values(chat?.layouts || {}).flat()[0];
  const raw = agent?.artifacts?.[id];
  const saved = raw?.versions ? { ...raw, ...raw.versions.at(-1), updated: raw.versions.at(-1)?.at || raw.updated } : raw;
  const live = LIVE.get(`${chatId}/${id}`);
  const fromSaved = saved && (saved.kind === 'md' ? typeof saved.md === 'string' && { kind: 'md', text: saved.md, title: saved.title } : typeof saved.html === 'string' && { kind: 'html', text: saved.html, title: saved.title });
  // The chat file wins once it is newer than the live copy (e.g. after an undo or a later edit was saved).
  if (live && (!saved?.updated || saved.updated < live.at)) return live;
  return fromSaved || live || null;
}

// Preview polish added to the served page only (the artifact itself is unchanged): thin scrollbars
// that suit both themes instead of the browser's bright default.
const POLISH = '<style data-harness>html{scrollbar-width:thin;scrollbar-color:rgba(140,150,145,.45) transparent}::-webkit-scrollbar{width:10px;height:10px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:rgba(140,150,145,.4);border-radius:10px;border:2px solid transparent;background-clip:padding-box}::-webkit-scrollbar-thumb:hover{background-color:rgba(160,170,165,.65)}::-webkit-scrollbar-corner{background:transparent}</style>';
export function servedArtifact(content) {
  const html = content.kind === 'md' ? markdownPage(content.title, content.text) : content.text;
  return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${POLISH}</head>`) : POLISH + html;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DOC_CSS = `
:root{--bg:#fbfcfb;--fg:#1d2420;--muted:#5d6b64;--line:#dfe5e1;--panel:#f1f4f2;--accent:#0e8a99;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f0d;--fg:#e7edea;--muted:#8a9a92;--line:#22302a;--panel:#121a16;--accent:#35d8eb}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.65 Inter,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:780px;margin:0 auto;padding:32px 20px 64px}a{color:var(--accent)}img{max-width:100%}
.md-h{line-height:1.3;margin:1.4em 0 .5em}h1.md-h{font-size:1.8em;margin-top:0}h2.md-h{font-size:1.35em;border-bottom:1px solid var(--line);padding-bottom:.25em}h3.md-h{font-size:1.12em}
h4.md-h,h5.md-h,h6.md-h{font-size:.95em;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
p{margin:.6em 0}blockquote{margin:.8em 0;padding:.2em 1em;border-left:3px solid var(--accent);color:var(--muted);background:var(--panel);border-radius:0 6px 6px 0}
.md-ic{font:.88em ui-monospace,Consolas,monospace;padding:1px 5px;border-radius:4px;background:var(--panel);border:1px solid var(--line)}
.md-code{margin:.8em 0;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel)}
.md-code-bar{display:flex;justify-content:space-between;align-items:center;padding:4px 10px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--line)}
.md-copy{font:inherit;font-size:11px;background:none;border:1px solid var(--line);color:var(--muted);border-radius:5px;padding:1px 8px;cursor:pointer}
.md-code pre{margin:0;padding:12px 14px;overflow:auto;font:13px/1.5 ui-monospace,Consolas,monospace}
.md-table{overflow-x:auto;margin:.8em 0;border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%;font-size:.93em}
th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--panel)}tr:last-child td{border-bottom:0}
hr{border:0;border-top:1px solid var(--line);margin:1.6em 0}.md-task{display:inline-block;width:1em;margin-right:.4em}li{margin:.2em 0}`;
function markdownPage(title, md) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title || 'Document')}</title><style>${DOC_CSS}</style></head>
<body><main>${renderMarkdown(md)}</main>
<script>document.addEventListener('click',function(e){var b=e.target.closest('.md-copy');if(!b)return;var c=b.closest('.md-code').querySelector('code');navigator.clipboard&&navigator.clipboard.writeText(c.innerText).then(function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy'},1200)})});</script></body></html>`;
}
/** A full page for a Markdown text (the browser tool opens documents this way too). */
export const markdownHtml = (title, md) => markdownPage(title, md);

// Served with a sandbox policy, so even when opened in its own tab the page runs in an opaque origin
// and cannot call this app's API.
export const ARTIFACT_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Content-Security-Policy': 'sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads',
};

// The newest modification time in a project folder, so previews of sites and apps can reload when files change.
export function folderStamp(root) {
  let latest = 0, n = 0;
  for (const f of listFiles(root, 400)) {
    if (f.path.endsWith('(skipped)')) continue;
    try { const t = fs.statSync(path.join(root, f.path)).mtimeMs; if (t > latest) latest = t; n++; } catch { /* removed meanwhile */ }
  }
  return { stamp: Math.round(latest), files: n };
}
