// Skills: playbooks the agent loads only when they're relevant.
// Built-in skills live in skills/<name>/SKILL.md; each project can add its own in
// <project>/.quorx/skills/<name>/SKILL.md (the agent can save new ones there with save_skill).
// A SKILL.md starts with front matter (name, description); the body holds the instructions.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './openrouter.js';

const BUILTIN = path.join(ROOT, 'skills');
const TEMPLATES = path.join(ROOT, 'templates');
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function parse(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split(/\r?\n/)) { const kv = line.match(/^(\w+):\s*(.*)$/); if (kv) meta[kv[1]] = kv[2].trim(); }
  return { meta, body: (m ? m[2] : text).trim() };
}
function scan(dir, source) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))).map((e) => {
    const { meta } = parse(path.join(dir, e.name, 'SKILL.md'));
    return { name: meta.name || e.name, description: meta.description || '', source, dir: path.join(dir, e.name) };
  });
}

/** Every skill available to a project; project skills override built-ins with the same name. */
export function listSkills(projectDir, disabled = []) {
  const off = new Set(disabled);
  const byName = new Map();
  for (const s of [...scan(BUILTIN, 'built-in'), ...(projectDir ? scan(path.join(projectDir, '.quorx', 'skills'), 'project') : [])]) byName.set(s.name, s);
  return [...byName.values()].filter((s) => !off.has(s.name)).sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(projectDir, name, disabled = []) {
  const s = listSkills(projectDir, disabled).find((x) => x.name === name || slug(x.name) === slug(name));
  if (!s) return null;
  const { body } = parse(path.join(s.dir, 'SKILL.md'));
  const extras = fs.readdirSync(s.dir).filter((f) => f !== 'SKILL.md');
  return { ...s, body, extras };
}

export function saveSkill(projectDir, { name, description, instructions }) {
  const id = slug(name);
  if (!id) throw new Error('the skill needs a name');
  if (!String(instructions || '').trim()) throw new Error('the skill needs instructions');
  const dir = path.join(projectDir, '.quorx', 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  const desc = String(description || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: ${desc}\nsource: saved by the agent ${new Date().toISOString().slice(0, 10)}\n---\n\n${String(instructions).trim()}\n`);
  return id;
}

// ---------- starter templates: templates/<name>/ plus template.json ----------
export function listTemplates() {
  if (!fs.existsSync(TEMPLATES)) return [];
  return fs.readdirSync(TEMPLATES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(TEMPLATES, e.name, 'template.json'), 'utf8')); } catch { /* no metadata */ }
    return { name: e.name, description: meta.description || '', start: meta.start || null, dir: path.join(TEMPLATES, e.name) };
  });
}

/**
 * A routine you recorded in Chrome (the QuorX extension) as a skill: steps a person would describe, never screen
 * positions. Typed text was kept only for search boxes; anything else says where the text should come from.
 * Returns { name, description, instructions, steps } for saveSkill, or throws when there is nothing to save.
 */
export function routineSkill(name, steps, day = new Date()) {
  const list = (Array.isArray(steps) ? steps : []).slice(0, 120);
  const q = (x) => `"${String(x || '').replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, 80)}"`;
  const line = (x) => (x?.kind === 'go' ? `Open ${String(x.url || '').slice(0, 300)}`
    : x?.kind === 'click' ? `Click the ${x.role || 'control'} ${q(x.name)}`
    : x?.kind === 'type' ? `Type into the ${x.role || 'field'} ${q(x.field)}: ${x.value ? q(x.value) : '(your text: not recorded; use what the request says, or ask)'}`
    : x?.kind === 'choose' ? `In ${q(x.field)}, choose ${q(x.value)}`
    : x?.kind === 'press' ? `Press ${x.key || 'Enter'}${x.field ? ` in ${q(x.field)}` : ''}` : '').trim();
  const lines = list.map(line).filter(Boolean).filter((l, i, a) => l !== a[i - 1]);
  if (lines.length < 2) throw new Error('nothing was recorded yet: do the task in the tab first');
  const hosts = [...new Set(list.filter((x) => x?.kind === 'go').map((x) => { try { return new URL(x.url).hostname.replace(/^www\./, ''); } catch { return ''; } }).filter(Boolean))];
  const title = String(name || 'routine').replace(/\s+/g, ' ').trim().slice(0, 60) || 'routine';
  return {
    name: title, steps: lines.length,
    description: `Routine shown in Chrome: ${lines.length} steps on ${hosts.join(', ') || 'the web'}`,
    instructions: `A routine the user showed QuorX in their own Chrome (${day.toISOString().slice(0, 10)}). Do it in the user's Chrome: start with browser open chrome:<the first address>.\nThe steps are a guide, not a script: names can change a little, so find each thing by its name (browser find), check the page after each step, and stop and tell the user if a step no longer fits.\n\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
  };
}
