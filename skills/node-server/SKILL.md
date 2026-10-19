---
name: node-server
description: Build and run a Node.js web server or API in the project folder (http module or express), started with start_server.
---

# Node server

1. **Template:** `scaffold` with `node-http` gives `server.cjs` and `public/index.html` with no dependencies.
2. **Port:** always `const PORT = process.env.PORT || 3000;`. The harness gives every server a free port in `PORT`. Never hard-code a port.
3. **Modules:** use `.cjs` files with `require(...)`, or add a `package.json` with `"type": "module"` before using `import`. Mixing them causes "require is not defined" or "Cannot use import".
4. **Dependencies:** `run_command` with `npm` and args `["init", "-y"]`, then `["install", "express"]`. Prefer the built-in `http` module for small things.
5. **Static files:** serve `public/` with correct content types (`.html`, `.css`, `.js`, `.png`, `.svg`).
6. **Run:** `start_server` with name `web`, command `node`, args `["server.cjs"]`. Starting the same name again restarts it.
7. **Check:** `browser open app:web`, exercise the API or page, read the console errors, then `look`.
8. **Logs:** if the server isn't listening, read the output that `start_server` returns. The usual causes are a syntax error, the wrong module type, or listening on a fixed port.
9. **Record:** in `AGENT.md`, how to run it, the routes, and the files.
