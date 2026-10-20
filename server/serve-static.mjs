// QuorX copies this into a project as .quorx/serve.mjs to host a static site (HTML, CSS, JS, assets)
// from the project folder, so it runs like any other server: from the launch file, listed under 🖥, opened in
// the Browser tab. It has no dependencies. Usage: node .quorx/serve.mjs [entry.html]   (port from PORT)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const entry = (process.argv[2] || 'index.html').replace(/^[/\\]+/, '');
const port = Number(process.env.PORT) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
};

http.createServer((req, res) => {
  // Only this computer's own names (a web page can't reach it by DNS tricks), and never dot files (.env, .git).
  const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) { res.writeHead(403).end('Not allowed'); return; }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end('Bad address'); return; }
  // The entry in a subfolder: send the browser there, so the page's relative links (js/main.js) resolve next to it.
  if (rel === '/' && entry.includes('/')) { res.writeHead(302, { Location: `/${entry.split('/').map(encodeURIComponent).join('/')}`, 'Cache-Control': 'no-store' }).end(); return; }
  if (rel === '/') rel = `/${entry}`;
  const fwd = rel.split('\\').join('/');
  if (/(^|\/)\.(?!well-known\/)/.test(fwd) && !/^\/\.quorx\/scratch\//.test(fwd)) { res.writeHead(404).end('Not found'); return; }
  const file = path.resolve(root, `.${rel}`);
  // Only files inside the project folder; of the harness's .quorx folder, only the agent's scratch (its test pages).
  const inside = file.slice(root.length);
  if (!file.startsWith(root + path.sep) || (/[/\\]\.quorx([/\\]|$)/.test(inside) && !/^[/\\]\.quorx[/\\]scratch([/\\]|$)/.test(inside))) { res.writeHead(403).end('Not allowed'); return; }
  let target = file;
  try { if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html'); } catch { /* checked below */ }
  fs.readFile(target, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Not found: ${rel}`); return; }
    // No caching: edits show on the next reload.
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`Serving ${root} at http://localhost:${port}/ (entry ${entry})`));
