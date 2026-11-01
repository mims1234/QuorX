// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Tools loaded when needed (⚙ Settings → Agent loop → Load rare tools when needed). Every model call carries the
// schema of every tool it may call; most replies never touch Android, the debugger, desktop apps or QuorX's own
// settings. With 'auto' those are listed by name in load_tools, one line each, and join the reply's tools when the
// agent loads them or simply calls one. MCP tools are deferred too when a chat has many of them.
export const RARE_TOOLS = new Set(['android', 'debug', 'desktop', 'edit_video', 'schedule', 'mcp_setup', 'quorx_settings', 'launch_config', 'request_secret', 'save_skill']);
export const MCP_DEFER_AT = 9; // more MCP tools than this in one chat: they load when needed too

const firstSentence = (s) => String(s || '').replace(/\s+/g, ' ').trim().match(/^.{1,160}?[.!?](\s|$)/)?.[0].trim() || String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);

/** Splits a reply's tools: { active, deferred } (deferred: a Map name → def, in their order). */
export function splitTools(tools, { mode = 'auto', isMcp = () => false, list = RARE_TOOLS } = {}) {
  const rare = new Set([...list].filter((n) => RARE_TOOLS.has(n)));
  if (mode !== 'auto') return { active: tools, deferred: new Map() };
  const mcp = tools.filter((t) => isMcp(t.function?.name));
  const deferMcp = mcp.length >= MCP_DEFER_AT;
  const deferred = new Map(), active = [];
  for (const t of tools) {
    const n = t.function?.name;
    if (n && (rare.has(n) || (deferMcp && isMcp(n)))) deferred.set(n, t);
    else active.push(t);
  }
  return { active, deferred };
}

/** The load_tools definition, listing what can be loaded. */
export function loadToolsDef(deferred) {
  const lines = [...deferred.values()].map((t) => `- ${t.function.name}: ${firstSentence(t.function.description)}`);
  return { type: 'function', function: { name: 'load_tools', description: `Load tools you don't have yet in this reply. They work as soon as they are loaded (calling one of them by name loads it too). Available:\n${lines.join('\n')}`,
    parameters: { type: 'object', required: ['names'], properties: { names: { type: 'array', items: { type: 'string', enum: [...deferred.keys()] }, description: 'The tools to load' } } } } };
}
