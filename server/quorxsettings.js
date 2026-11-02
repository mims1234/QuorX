// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// quorx_settings: what the agent may read and change of QuorX's own settings, and of the current project's.
//   - ⚙ Settings live in the page (savePrefs); a reply gets them with its request. A change the user approves goes
//     back to the page as a setting_changed event, and the page saves it as its own Save would.
//   - Project settings live with the server: they change through the same functions as their routes in server.js.
// Every entry says what it is, what it may be set to and where it is in the page. Keys and secrets are never in here:
// the agent sees their names at most, and the user adds them in ⚙ Settings → Providers.
import fs from 'node:fs';
import { listProjects, setProjectColor, setProjectAlias, setProjectFlags } from './store.js';
import { setBudget, budgetState } from './budget.js';
import { listDesignSystems, projectDesign, applyDesignSystem, saveProjectDesign } from './design.js';
import { loadHooks, saveHooks, cleanHook, HOOK_EVENTS, HOOK_MAX } from './hooks.js';
import { loadRules, saveRules, ruleProblem } from './cmdpolicy.js';
import { SAFETY_DEFAULTS } from './safety.js';
import { safePath, trashFile } from './workspace.js';

// The page's own defaults for Appearance (public/app.js UI_DEFAULTS).
export const UI_DEFAULTS = { density: 'comfortable', fontSize: 14, reduceMotion: 'system', timestamps: 'time', paneMode: 'auto', sidebarStart: 'remember',
  showBalance: false, maskAmounts: true, blurPaths: false, usageBtn: true, notify: 'all', searchEngine: 'google', searchCustom: '' };
const NEW_CHAT_TOOLS = { image: false, video: false, music: false, speech: false, enhancer: false, reviewer: true, freshEyes: true, deciders: true, helpers: true };

// ⚙ Settings categories, as the page names them.
export const CATS = {
  appearance: '🎨 Appearance', notifications: '🔔 Notifications', privacy: '🕶 Privacy & display', providers: '🔌 Providers (defaults)',
  newchats: '✨ New chats', loop: '🔁 Agent loop', deciders: '⚖️ Deciders', tools: '🧰 Tools & media', safety: '🛡 Approvals & safety',
  budget: '💵 Budget', video: '🎬 Video', code: '💻 Code & servers', mcp: '🧲 MCP servers', schedules: '⏰ Schedules', keys: '🔑 API keys',
};

// type: bool · enum (values: [value, words]) · int / num (min, max) · money ($, min, max) · model (a model id) · models (up to 3) · text
// guard: always waits for the user's click, in ⚡ YOLO too (approvals, safety, budgets, what Chrome may do, MCP servers).
const E = (key, cat, label, type, extra = {}) => ({ key, cat, label, type, ...extra });
const ONOFF = [[true, 'On'], [false, 'Off']];
export const SETTINGS = [
  E('theme', 'appearance', 'Theme', 'enum', { values: [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']], help: 'System follows Windows.' }),
  E('ui.density', 'appearance', 'Density', 'enum', { values: [['comfortable', 'Comfortable'], ['compact', 'Compact']], help: 'Compact fits more messages and chats on screen.' }),
  E('ui.fontSize', 'appearance', 'Message text size', 'int', { min: 12, max: 18, unit: 'px', help: 'Replies, your posts and the message box.' }),
  E('ui.reduceMotion', 'appearance', 'Motion', 'enum', { values: [['system', 'Follow system'], ['full', 'On'], ['reduce', 'Reduced']], help: 'Animations and transitions.' }),
  E('ui.timestamps', 'appearance', 'Message timestamps', 'enum', { values: [['time', 'Time'], ['relative', 'Relative'], ['off', 'Off']] }),
  E('ui.sidebarStart', 'appearance', 'Sidebar when QuorX opens', 'enum', { values: [['remember', 'Remember'], ['expanded', 'Expanded'], ['rail', 'Rail']] }),
  E('ui.paneMode', 'appearance', 'Artifact pane', 'enum', { values: [['auto', 'Auto'], ['always', 'Always'], ['never', 'Only when asked']], help: 'Auto shows it only when the chat has built something.' }),
  E('ui.notify', 'notifications', 'Tell me when a reply…', 'enum', { values: [['all', 'Needs me or ends'], ['needs', 'Needs me'], ['off', 'Off']], help: 'Desktop notifications, only while QuorX is in the background. Off turns them off.' }),
  E('ui.showBalance', 'privacy', 'Show the 💲 balance button in the top bar', 'bool', { help: 'Off by default, so your OpenRouter spend never shows on a stream.' }),
  E('ui.maskAmounts', 'privacy', 'Hide amounts until I click 👁', 'bool', { help: 'All-time spend, key limits and account credits stay masked until revealed.' }),
  E('ui.blurPaths', 'privacy', 'Blur folder paths', 'bool', { help: 'Project folders are blurred until you hover them.' }),
  E('ui.usageBtn', 'privacy', 'Show the cost badge in chat headers', 'bool'),
  E('ui.searchEngine', 'privacy', 'Browser search with', 'enum', { values: [['google', 'Google'], ['bing', 'Bing'], ['duckduckgo', 'DuckDuckGo'], ['brave', 'Brave'], ['startpage', 'Startpage'], ['custom', 'Custom']], help: 'Words typed in the Browser tab\'s address bar are searched here.' }),
  E('model', 'providers', 'Default chat model', 'model', { def: 'chatModel', help: 'What a new chat starts with. Each chat can still pick any model in its message box.' }),
  E('reasoning', 'providers', 'Default reasoning', 'enum', { values: [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] }),
  E('providerSort', 'providers', 'Provider order (OpenRouter)', 'enum', { values: [['auto', 'Auto'], ['price', 'Cheapest'], ['throughput', 'Fastest']], help: 'Auto favours providers with reliable tool calling.' }),
  E('requireParams', 'providers', 'Only providers that support every feature', 'bool'),
  E('zdrOnly', 'providers', 'Zero data retention only', 'bool', { help: 'Only providers that keep no copy of your prompts. Fewer models qualify.' }),
  E('fallbackModel', 'providers', 'Fallback model on OpenRouter', 'model', { empty: 'None', help: 'OpenRouter switches to it when a chat\'s model fails. Empty: none.' }),
  E('sourceFallback', 'providers', 'When a call fails, fall back to', 'enum', { values: [['off', 'Stop and tell me'], ['same', 'Same model on OpenRouter'], ['model', 'Always the fallback model']] }),
  E('sourceFallbackModel', 'providers', 'Fallback model (other providers)', 'model', { empty: 'Default chat model' }),
  E('approval', 'newchats', 'Permission mode for new chats', 'enum', { values: [['strict', '🔒 Strict'], ['yolo', '⚡ YOLO']], guard: true, help: 'What a new chat starts in; each chat can switch in its message box. Strict asks you before paid media; YOLO lets the deciders answer.' }),
  ...['enhancer', 'reviewer', 'freshEyes', 'deciders', 'helpers', 'image', 'video', 'music', 'speech'].map((k) => E(`newChatTools.${k}`, 'newchats', `New chats start with ${{ enhancer: 'the prompt enhancer', reviewer: 'the reviewer', freshEyes: 'fresh eyes', deciders: 'the deciders', helpers: 'helpers', image: '🖼 pictures (paid)', video: '🎬 video (paid)', music: '🎵 music (paid)', speech: '🗣 voice (paid)' }[k]}`, 'bool', { dflt: NEW_CHAT_TOOLS[k] })),
  E('maxSteps', 'loop', 'Max model calls per reply', 'int', { min: 2, max: 1000 }),
  E('planFirst', 'loop', 'Plan first', 'enum', { values: [['off', 'Off'], ['big', 'Big tasks'], ['always', 'Always']], help: 'Big tasks: the agent shows its plan and waits for Go ahead.' }),
  E('planSteps', 'loop', 'Steps when the reply has a plan', 'int', { min: 0, max: 1000, help: '0 = the same as max model calls.' }),
  E('continueRounds', 'loop', 'Keep going while the plan is open', 'int', { min: 0, max: 20 }),
  E('maxOutput', 'loop', 'Output tokens per model call', 'int', { min: 1000, max: 256000 }),
  E('thinkShare', 'loop', 'Thinking share of that output', 'int', { min: 0, max: 90, unit: '%' }),
  E('buildThinking', 'loop', 'Thinking for builds', 'enum', { values: [['off', 'Off'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] }),
  E('retries', 'loop', 'Retries on model errors', 'int', { min: 0, max: 10 }),
  E('parallel', 'loop', 'Run look-ups together', 'bool'),
  E('askLimit', 'loop', 'Questions per reply', 'int', { min: 0, max: 20, help: 'How often the agent may stop to ask you a question with options. 0 = never.' }),
  E('verify', 'loop', 'Check the work', 'bool', { help: 'Re-checks changed files and opens what was built before the final reply.' }),
  E('designLint', 'loop', 'Design lint', 'bool'),
  E('verifyRounds', 'loop', 'Rounds to fix problems', 'int', { min: 0, max: 10 }),
  E('review', 'loop', 'When to review', 'enum', { values: [['off', 'Off'], ['builds', 'Builds'], ['always', 'Always']] }),
  E('reviewTier', 'loop', 'Reviewer strength', 'enum', { values: [['cheap', 'Cheap'], ['strong', 'Strong']] }),
  E('codeReview', 'loop', 'Review code changes', 'enum', { values: [['off', 'Off'], ['auto', 'After replies']] }),
  E('reviewSendBack', 'loop', 'Send a build back for', 'enum', { values: [['annoying', 'Breaks or annoying'], ['breaks', 'Only breaks']] }),
  E('reviewRounds', 'loop', 'Rounds to fix the reviewer\'s bugs', 'int', { min: 0, max: 5 }),
  E('reviewBar', 'loop', 'Review pass bar', 'int', { min: 1, max: 5 }),
  E('reviewModel', 'loop', 'Reviewer model', 'model', { empty: 'Default reviewer' }),
  E('helpers', 'loop', 'Let the agent use helpers', 'bool'),
  E('helperModel', 'loop', 'Helper model', 'model', { empty: 'Default helper' }),
  E('helperSteps', 'loop', 'Steps per helper', 'int', { min: 1, max: 100 }),
  E('compact', 'loop', 'Summarise older turns', 'bool'),
  E('lazyTools', 'loop', 'Load rare tools when needed', 'enum', { values: [['auto', 'Auto'], ['off', 'Off']], help: 'Auto: Android, the debugger, desktop apps, QuorX settings and other rarely used tools are listed by name and load when the agent asks for one, so every call is smaller. Off: every tool on every call.' }),
  E('statusEvery', 'loop', 'Ask for a short status line every', 'int', { min: 0, max: 50, unit: ' steps', help: 'Steps of tool calls without a word to you before the agent is asked to say what it is doing. 0 = never.' }),
  E('guardEdits', 'loop', 'Protect files that changed', 'bool', { help: 'A file you or another chat changed since the agent read it must be read again before the agent changes it.' }),
  E('wrapUp', 'loop', 'End each reply with a wrap-up', 'bool', { help: 'After a reply that did work: a short recap, what wasn\'t checked, and up to two next steps to send with a click.' }),
  E('otherNotes', 'loop', 'Read other agents\' notes', 'bool', { help: 'AGENTS.md, CLAUDE.md and similar files in the project are read with AGENT.md.' }),
  E('otherNotesFiles', 'loop', 'Other agents\' note files', 'text', { help: 'File names in the project, separated by commas.' }),
  E('otherNotesKB', 'loop', 'Other agents\' notes, at most', 'int', { min: 1, max: 64, unit: ' KB' }),
  E('voters', 'deciders', 'Decider models', 'models', { help: 'The fast judges the agent asks when it is unsure (up to 3).' }),
  E('lookVoters', 'deciders', 'Decider that reads pictures', 'models'),
  E('lookEscalate', 'deciders', 'Ask the other deciders when it is unsure', 'bool'),
  E('gate.act', 'deciders', 'Settled at', 'num', { min: 0.5, max: 1 }),
  E('gate.confirm', 'deciders', 'Lean at', 'num', { min: 0.3, max: 1 }),
  E('checks.gap', 'deciders', 'Gap check before a build', 'bool'),
  E('checks.shots', 'deciders', 'Screenshot checks', 'bool'),
  E('checks.click', 'deciders', 'Click and key check', 'bool'),
  ...['image', 'video', 'music', 'speech', 'listen', 'browser', 'artifacts'].flatMap((k) => [
    E(`tools.${k}.on`, 'tools', `${{ image: '🖼 Pictures', video: '🎬 Video', music: '🎵 Music', speech: '🗣 Voice', listen: '👂 Listening', browser: '🌐 Browser', artifacts: '🗺 Artifacts' }[k]}: on in QuorX`, 'bool', { help: 'Each chat still turns paid tools on in its 🧰 menu.' }),
    ...(['browser', 'artifacts'].includes(k) ? [] : [E(`tools.${k}.models`, 'tools', `${{ image: '🖼 Pictures', video: '🎬 Video', music: '🎵 Music', speech: '🗣 Voice', listen: '👂 Listening' }[k]}: models`, 'models', { help: 'Up to 3; the first is used unless the agent picks.' })]),
    ...(['image', 'video', 'music', 'speech'].includes(k) ? [E(`tools.${k}.pick`, 'tools', `${{ image: '🖼 Pictures', video: '🎬 Video', music: '🎵 Music', speech: '🗣 Voice' }[k]}: who picks the model`, 'enum', { values: [['fixed', 'Always the first'], ['agent', 'The agent']] })] : []),
  ]),
  E('strictAsk', 'safety', 'In 🔒 Strict, ask before', 'enum', { values: [['paid', 'Paid media'], ['every', 'Every tool']], guard: true }),
  E('strictAskHelpers', 'safety', 'In Strict, also ask before helpers', 'bool', { guard: true }),
  E('strictAskDeciders', 'safety', 'In Strict, also ask before decider checks', 'bool', { guard: true }),
  E('yoloCheck', 'safety', 'Deciders check paid calls in ⚡ YOLO', 'bool', { guard: true }),
  E('yoloWaitSecs', 'safety', '⚡ YOLO waits for you', 'int', { min: 0, max: 120, unit: 's', guard: true, help: 'How long a question or an unsettled approval waits for you in YOLO. 0 = no wait.' }),
  E('decidersOff.commands', 'safety', 'YOLO with the deciders off: commands', 'enum', { values: [['ask', 'Wait for me'], ['run', 'Run without a check']], guard: true }),
  E('decidersOff.media', 'safety', 'YOLO with the deciders off: paid media', 'enum', { values: [['ask', 'Wait for me'], ['run', 'Run without a check']], guard: true }),
  ...[['files', 'Change files'], ['commands', 'Run commands'], ['servers', 'Start and stop servers'], ['browser', 'Use the browser'], ['web', 'Read web pages'], ['media', 'Paid media'], ['artifacts', 'Write plans'], ['helpers', 'Ask helpers'], ['deciders', 'Ask the deciders'], ['skills', 'Save skills']]
    .map(([k, l]) => E(`yoloAuto.${k}`, 'safety', `⚡ YOLO does on its own: ${l}`, 'bool', { dflt: true, guard: true })),
  E('safety.shell', 'safety', 'The agent\'s shell', 'enum', { values: process.platform === 'win32' ? [['powershell', 'PowerShell'], ['pwsh', 'pwsh'], ['cmd', 'cmd'], ['bash', 'Git Bash']] : [['bash', 'bash'], ['zsh', 'zsh']], guard: true }),
  E('safety.snapshots', 'safety', 'Undo for commands (snapshots)', 'bool', { guard: true }),
  E('safety.timeout', 'safety', 'Wait for a command', 'int', { min: 5, max: 900, unit: 's', guard: true }),
  E('safety.tripwire', 'safety', 'Watch for mass deletes', 'bool', { guard: true }),
  ...[['yoloCheckWeb', 'Deciders check web reads first'], ['yoloCheckInline', 'Deciders check one-liners first'], ['yoloCheckBuild', 'Deciders check builds, tests and scripts first'], ['yoloCheckInstall', 'Deciders check package installs first'], ['yoloCheckUnknown', 'Deciders check unknown commands first'], ['yoloCheckReads', 'Deciders check reading files outside the project first'],
    ['yoloExternal', 'Deciders may approve pushes, publishes and deploys'], ['yoloOutside', 'Deciders may approve writes outside the project'], ['yoloGlobal', 'Deciders may approve installs for the whole computer'], ['yoloOpaque', 'Deciders may approve commands QuorX can\'t read'], ['androidPhones', 'The android tool may use a physical phone']]
    .map(([k, l]) => E(`safety.${k}`, 'safety', l, 'bool', { guard: true })),
  E('safety.quorum', 'safety', 'Valid decider votes needed', 'int', { min: 1, max: 10, guard: true }),
  E('safety.neededMin', 'safety', '"The user asked for it" at least', 'num', { min: 0, max: 1, guard: true }),
  E('safety.harmMax', 'safety', '"It could do harm" at most', 'num', { min: 0, max: 1, guard: true }),
  E('browseReadOnly', 'safety', '🧩 Chrome: read-only for reading requests', 'bool', { guard: true }),
  E('chromeCheck', 'safety', '🧩 Chrome: deciders check typing in your tabs', 'bool', { guard: true }),
  E('chromeYoloActs', 'safety', '🧩 Chrome in YOLO: act in your tabs without asking', 'bool', { guard: true }),
  E('chromeNetwork', 'safety', '🧩 Chrome: network reading in your tabs', 'bool', { guard: true }),
  E('chromeCloseTabs', 'safety', '🧩 Chrome: close the tabs a reply opened when it ends', 'bool'),
  E('chromeSitesNever', 'safety', '🧩 Chrome: sites never to open', 'text', { guard: true, help: 'Separated by commas.' }),
  E('chromeSitesAlways', 'safety', '🧩 Chrome: sites always allowed', 'text', { guard: true }),
  E('chromeSitesRead', 'safety', '🧩 Chrome: read-only sites', 'text', { guard: true }),
  E('replyBudget', 'budget', 'Cap per reply', 'money', { min: 0, max: 100, guard: true, help: '0 = no cap. At the cap Strict asks you; YOLO stops.' }),
  E('dailyBudget', 'budget', 'Cap per day (all projects)', 'money', { min: 0, max: 1000, guard: true, help: '0 = off.' }),
  E('budget', 'budget', 'Paid media per reply', 'money', { min: 0, max: 20, guard: true }),
  E('budgetGrace', 'budget', 'Allowance to finish a reply past a project budget', 'int', { min: 0, max: 100, unit: '%', guard: true }),
  E('videoMode', 'video', 'Video Mode', 'enum', { values: [['auto', 'On for films'], ['off', 'Off']] }),
  E('videoStoryboard', 'video', 'Storyboard before paid media', 'bool'),
  E('videoReview', 'video', 'Review the film', 'bool'),
  E('debugger', 'code', 'Debugger for Node and Python', 'enum', { values: [['earned', 'After failed tries'], ['always', 'Always'], ['off', 'Off']] }),
];
export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

const getPath = (o, p) => p.split('.').reduce((x, k) => x?.[k], o);
/** A setting's value now: the page's, else the default the page would show. */
export function pageValue(prefs, s, defaults) {
  if (s.key === 'theme') return prefs.theme || 'system';
  const v = getPath(prefs, s.key);
  if (v != null) return v;
  if (s.dflt !== undefined) return s.dflt;
  if (s.key.startsWith('ui.')) return UI_DEFAULTS[s.key.slice(3)];
  if (s.key.startsWith('safety.')) return SAFETY_DEFAULTS[s.key.slice(7)];
  if (s.def) return defaults[s.def];
  const d = getPath(defaults, s.key);
  return d ?? (s.type === 'bool' ? false : s.type === 'enum' ? s.values[0][0] : s.type === 'models' ? [] : '');
}
/** How a value reads to the user. */
export function show(s, v) {
  if (s.type === 'bool') return v ? 'On' : 'Off';
  if (s.type === 'enum') return (s.values.find(([k]) => String(k) === String(v)) || [v, String(v)])[1];
  if (s.type === 'money') return `$${Number(v || 0).toFixed(2)}`;
  if (s.type === 'models') return (Array.isArray(v) ? v : []).join(', ') || '(none)';
  if (s.type === 'model' || s.type === 'text') return v ? String(v) : s.empty || '(empty)';
  return `${v}${s.unit || ''}`;
}
const MODEL_ID = /^[\w.@:~-]+(\/[\w.@:~+-]+)+$/;
/** The value a change would save, checked the way the page's controls hold it; throws a plain-words error. */
export function checkValue(s, raw) {
  const words = (v) => String(v ?? '').trim().toLowerCase();
  if (s.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    if (['on', 'true', 'yes', '1', 'enabled'].includes(words(raw))) return true;
    if (['off', 'false', 'no', '0', 'disabled'].includes(words(raw))) return false;
    throw new Error(`${s.label} is on or off`);
  }
  if (s.type === 'enum') {
    const hit = s.values.find(([k, l]) => words(k) === words(raw) || words(l).replace(/^\W+\s*/, '') === words(raw).replace(/^\W+\s*/, ''));
    if (!hit) throw new Error(`${s.label} is one of: ${s.values.map(([k, l]) => `${k} (${l})`).join(', ')}`);
    return hit[0];
  }
  if (['int', 'num', 'money'].includes(s.type)) {
    const n = Number(String(raw ?? '').replace(/[$%s,\s]|px/g, ''));
    if (!Number.isFinite(n) || String(raw ?? '').trim() === '') throw new Error(`${s.label} is a number from ${s.min} to ${s.max}`);
    if (n < s.min || n > s.max) throw new Error(`${s.label} must be from ${s.min} to ${s.max}${s.unit || ''}`);
    return s.type === 'int' ? Math.round(n) : s.type === 'money' ? Math.round(n * 100) / 100 : n;
  }
  if (s.type === 'model') {
    const v = String(raw ?? '').trim();
    if (v && !MODEL_ID.test(v)) throw new Error(`${s.label} is a model id like "deepseek/deepseek-v4.1-flash" (empty: ${s.empty || 'the default'})`);
    return v;
  }
  if (s.type === 'models') {
    const list = (Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean);
    if (!list.length || list.length > 3 || list.some((m) => !MODEL_ID.test(m))) throw new Error(`${s.label} is 1 to 3 model ids, like ["openai/gpt-6-luna-decisions"]`);
    return list;
  }
  return String(raw ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 2000);
}

// Anything that names a key, token or password is never read or set here.
export const SECRET_KEY = /(^|[._-])(api[._-]?key|keys?|token|secret|password|passwd|credential)s?($|[._-])/i;
export const KEYS_POINTER = 'API keys and secrets are never shown to the agent or set by it: the user adds or changes them in ⚙ Settings → Providers (model keys) or in a project\'s secrets. Tell them where to go instead of asking for a key in the chat.';

// ---------- the current project ----------
// key → what it is. Hooks and rules are lists: change them with op add / remove / on / off.
export const PROJECT_KEYS = {
  'project.folder': { label: 'Folder', readOnly: true, help: 'Where the project\'s files are, its chats and what it spent. Change the folder in Project settings → Folder.' },
  'project.name': { label: 'Name in QuorX', user: 'The folder keeps its own name.', help: 'A name of its own in the sidebar; the folder keeps its name. Empty: the folder\'s name again.' },
  'project.color': { label: 'Name colour', user: 'The sidebar, start screen and chat headers follow.', help: 'A colour like #2f7de1, or auto (from the name).' },
  'project.budget': { label: 'Budget', guard: true, user: 'One limit shared by every chat in this project. A new reply can’t start once it is used up.', help: 'One dollar limit shared by every chat in the project, like 20; "none" removes it. It can\'t be set below what is already spent.' },
  'project.design': { label: 'Design system', user: 'Pages and apps built in this project follow it. DESIGN.md and tokens.css go into the project root; any old ones go to the project’s trash.', help: 'How pages and apps built here look: a system id from list (a preset or one of the user\'s own), or "none" to remove it. Its DESIGN.md and tokens.css go into the project root; the old ones go to the project\'s trash.' },
  'project.hooks': { label: 'Hooks', guard: true, list: true, user: 'QuorX runs it itself around the agent’s work; the agent can’t run or change it on its own.', help: `Commands QuorX runs around the agent's work. op add with value {event: ${HOOK_EVENTS.join(' | ')}, command, match, timeout, feedback}. match: file patterns for the write events, a command pattern for the command events, tool names (* allowed) for the tool events; reply events have none. {file} in the command is the written file, {tool} the tool's name. With feedback on, a failing before_* hook stops what comes next, and a failing reply_end hook sends the reply back; reply_start's output reaches the agent. op remove / on / off with value = the hook's id.` },
  'project.rules': { label: 'Command rules', guard: true, list: true, user: 'It decides which of the agent’s commands run without asking you in this project.', help: 'Rules for the agent\'s commands in this project. op add with value {match: "npm test*", effect: allow | ask | deny}; op remove / on / off with value = the rule\'s id.' },
  'project.archived': { label: 'Archived', user: 'Archived projects leave the sidebar and the start screen; their chats stay.', help: 'Archived projects leave the sidebar and the start screen.' },
  'project.pinned': { label: 'Pinned to the top of the sidebar', user: 'Up to 3 projects can be pinned.', help: 'Up to 3 projects.' },
};

const projectOf = (id) => listProjects().find((p) => p.id === id) || null;
const hookText = (h, id = true) => `${id ? `${h.id}: ` : ''}${h.on ? '' : '[off] '}${h.event}${h.match ? ` (${h.match})` : ''} → ${h.command}${h.timeout !== 60 ? `, ${h.timeout}s` : ''}${h.feedback ? '' : ', no feedback'}`;
const ruleText = (r) => `${r.id}: ${r.on === false ? '[off] ' : ''}${r.effect} "${r.match}"${r.hits ? `, used ${r.hits}×` : ''}`;

/** What one project setting holds now, as text. */
export function projectRead(projectId, root, key, { secrets = [] } = {}) {
  const p = projectOf(projectId);
  if (!p) return 'This chat has no project.';
  const b = budgetState(projectId);
  switch (key) {
    case 'project.folder': return `${p.name} (${p.id})\nfolder: ${root || p.dir || '(none)'}${p.missing ? ' (missing)' : ''}\nspent: $${b.spent.toFixed(4)} of ${b.budget == null ? 'no limit' : `$${b.budget.toFixed(2)}`}\nsecrets: ${secrets.length ? `${secrets.join(', ')} (names only; values are never shown)` : 'none'}`;
    case 'project.name': return p.name;
    case 'project.color': return p.color || 'auto';
    case 'project.budget': return b.budget == null ? `none (spent $${b.spent.toFixed(4)})` : `$${b.budget.toFixed(2)} (spent $${b.spent.toFixed(4)}, left $${b.left.toFixed(4)})`;
    case 'project.design': { const d = root ? projectDesign(root) : null; return d ? `${d.name}${d.id ? ` (${d.id})` : ' (written by hand)'}` : 'none'; }
    case 'project.hooks': { const h = root ? loadHooks(root) : []; return h.length ? h.map(hookText).join('\n') : 'none'; }
    case 'project.rules': { const r = root ? loadRules(root).filter((x) => x.scope === 'project') : []; return r.length ? r.map(ruleText).join('\n') : 'none (rules for every project are in ⚙ Settings → Code & servers)'; }
    case 'project.archived': return p.archived ? 'yes' : 'no';
    case 'project.pinned': return p.pinned ? 'yes' : 'no';
    default: return null;
  }
}

/** Design systems to pick from, in short lines (filtered by words in their name, family or id). */
export function designList(query = '') {
  const q = String(query || '').toLowerCase().trim();
  const all = listDesignSystems();
  const hits = q ? all.filter((s) => `${s.id} ${s.name} ${s.family} ${s.description}`.toLowerCase().includes(q)) : all;
  return `${hits.length} of ${all.length} design systems${q ? ` matching "${q}"` : ''}:\n${hits.slice(0, 60).map((s) => `- ${s.id}: ${s.name} (${s.family}${s.dark ? ', dark' : ''}${s.source === 'custom' ? ', the user\'s own' : ''})${s.description ? ` · ${String(s.description).slice(0, 90)}` : ''}`).join('\n')}`;
}

/**
 * A change to one project setting, checked but not made: { what, from, to, guard, apply(), undo() }.
 * apply() and undo() call the same functions as the project routes. Throws a plain-words error.
 */
export function projectChange(projectId, root, key, value, op) {
  const p = projectOf(projectId), K = PROJECT_KEYS[key];
  if (!p) throw new Error('this chat has no project');
  if (!K) throw new Error(`no project setting ${key}; they are ${Object.keys(PROJECT_KEYS).join(', ')}`);
  if (K.readOnly) throw new Error(`${K.label} can't be changed here. ${K.help}`);
  const from = projectRead(projectId, root, key);
  const words = String(value ?? '').trim();
  if (key === 'project.name') {
    return { what: `Rename the project "${p.name}" to "${words || '(its folder\'s name)'}"`, from: p.name, to: words || '(folder name)', apply: () => setProjectAlias(projectId, words), undo: () => setProjectAlias(projectId, p.name === p.folderName ? '' : p.name) };
  }
  if (key === 'project.color') {
    const c = /^auto$|^none$|^$/i.test(words) ? null : words;
    if (c && !/^#[0-9a-f]{6}$/i.test(c)) throw new Error('a colour looks like #2f7de1, or auto');
    return { what: `Colour the project's name ${c || 'automatically'}`, from, to: c || 'auto', apply: () => setProjectColor(projectId, c), undo: () => setProjectColor(projectId, p.color || null) };
  }
  if (key === 'project.budget') {
    const none = /^(none|no limit|off|null|unlimited)$/i.test(words);
    const n = none ? null : Math.round(Number(words.replace(/[$,\s]/g, '')) * 100) / 100;
    if (!none && !(n > 0)) throw new Error('the budget is an amount in dollars, like 20 or 12.50, or none');
    const was = budgetState(projectId);
    if (n != null && n < was.spent) throw new Error(`this project has already spent $${was.spent.toFixed(4)}, so its budget must be at least $${(Math.ceil(was.spent * 100) / 100).toFixed(2)}`);
    return { what: `Set the project budget of "${p.name}" to ${n == null ? 'no limit' : `$${n.toFixed(2)}`}`, from: was.budget == null ? 'no limit' : `$${was.budget.toFixed(2)}`, to: n == null ? 'no limit' : `$${n.toFixed(2)}`, guard: true,
      apply: () => setBudget(projectId, n), undo: () => setBudget(projectId, was.budget) };
  }
  if (key === 'project.archived' || key === 'project.pinned') {
    const on = /^(true|yes|on|1|archive|archived|pin|pinned)$/i.test(words) || value === true;
    if (!on && !/^(false|no|off|0|unarchive|unpin)$/i.test(words) && value !== false) throw new Error(`${K.label} is yes or no`);
    const k = key.slice(8), was = !!p[k];
    return { what: `${on ? (k === 'archived' ? 'Archive' : 'Pin') : (k === 'archived' ? 'Unarchive' : 'Unpin')} the project "${p.name}"`, from: was ? 'yes' : 'no', to: on ? 'yes' : 'no',
      apply: () => setProjectFlags(projectId, { [k]: on }), undo: () => setProjectFlags(projectId, { [k]: was }) };
  }
  if (!root) throw new Error('this project has no folder yet: the user picks one in Project settings');
  if (key === 'project.design') {
    const old = projectDesign(root);
    const restore = () => restoreDesign(root, old);
    if (/^(none|remove|off)$/i.test(words)) {
      if (!old) throw new Error('this project has no design system to remove');
      return { what: `Remove the design system "${old.name}" from "${p.name}" (DESIGN.md and tokens.css go to the project's trash)`, from, to: 'none', apply: () => saveProjectDesign(root, null), undo: restore };
    }
    const all = listDesignSystems(), w = words.toLowerCase();
    // By id or name; else the one system whose id, name or family has the words ("brutalist" → the brutalist one).
    const near = w ? all.filter((s) => `${s.id} ${s.name} ${s.family}`.toLowerCase().includes(w)) : [];
    const sys = all.find((s) => s.id === words) || all.find((s) => s.name.toLowerCase() === w) || (near.length === 1 ? near[0] : null);
    if (!sys) throw new Error(near.length ? `"${words}" matches several design systems: ${near.slice(0, 8).map((s) => `${s.id} (${s.name}, ${s.family})`).join(', ')}. Use one id` : `no design system "${words}". Call list with category design to see them`);
    return { what: `Use the design system "${sys.name}" in "${p.name}"${old ? ` (the current ${old.name} goes to the project's trash)` : ''}`, from, to: `${sys.name} (${sys.id})`,
      apply: () => applyDesignSystem(root, sys.id, { overwrite: true }), undo: restore };
  }
  if (key === 'project.hooks') {
    const cur = loadHooks(root);
    const byId = (id) => cur.find((h) => h.id === String(id ?? '').trim());
    if (op === 'add') {
      const h = cleanHook(typeof value === 'object' && value ? value : { command: words });
      if (!h.command) throw new Error('a hook needs a command, like "npx prettier --write {file}"');
      if (cur.length >= HOOK_MAX) throw new Error(`at most ${HOOK_MAX} hooks per project`);
      return { what: `Add a hook to "${p.name}": ${h.event.replace('_', ' ')}${h.match ? ` (${h.match})` : ''}, run ${h.command}`, from: `${cur.length} hook${cur.length === 1 ? '' : 's'}`, to: hookText(h, false), guard: true, runs: h.command,
        apply: () => saveHooks(root, [...loadHooks(root), h]), undo: () => saveHooks(root, loadHooks(root).filter((x) => x.id !== h.id)) };
    }
    const h = byId(value?.id ?? value);
    if (!h) throw new Error(`give op add, or op remove / on / off with a hook id: ${cur.map((x) => x.id).join(', ') || 'this project has none'}`);
    if (op === 'remove') return { what: `Delete the hook ${hookText(h)}`, from: hookText(h), to: 'deleted', guard: true, apply: () => saveHooks(root, loadHooks(root).filter((x) => x.id !== h.id)), undo: () => saveHooks(root, [...loadHooks(root), h]) };
    if (op === 'on' || op === 'off') return { what: `Turn ${op} the hook ${hookText(h)}`, from: h.on ? 'on' : 'off', to: op, guard: true,
      apply: () => saveHooks(root, loadHooks(root).map((x) => (x.id === h.id ? { ...x, on: op === 'on' } : x))), undo: () => saveHooks(root, loadHooks(root).map((x) => (x.id === h.id ? { ...x, on: h.on } : x))) };
    throw new Error('op is add, remove, on or off');
  }
  if (key === 'project.rules') {
    const cur = loadRules(root).filter((x) => x.scope === 'project').map(({ scope, ...r }) => r);
    const put = (list) => saveRules('project', list, root);
    if (op === 'add') {
      const r = typeof value === 'object' && value ? value : { match: words, effect: 'allow' };
      const match = String(r.match || '').trim(), effect = ['allow', 'ask', 'deny'].includes(r.effect) ? r.effect : null;
      if (!match || !effect) throw new Error('a rule needs match (like "npm test*") and effect: allow, ask or deny');
      const why = ruleProblem(match); if (why) throw new Error(`that rule can't work: ${why}`);
      const rule = { match, effect, by: 'user', note: 'added from a chat' };
      return { what: `Add a command rule to "${p.name}": ${effect} "${match}"`, from: `${cur.length} rule${cur.length === 1 ? '' : 's'}`, to: `${effect} "${match}"`, guard: true,
        apply: () => put([...cur, rule]), undo: () => put(loadRules(root).filter((x) => x.scope === 'project' && !(x.match === match && x.effect === effect)).map(({ scope, ...x }) => x)) };
    }
    const r = cur.find((x) => x.id === String(value?.id ?? value ?? '').trim());
    if (!r) throw new Error(`give op add, or op remove / on / off with a rule id: ${cur.map((x) => x.id).join(', ') || 'this project has none'}`);
    if (op === 'remove') return { what: `Delete the command rule ${ruleText(r)}`, from: ruleText(r), to: 'deleted', guard: true, apply: () => put(cur.filter((x) => x.id !== r.id)), undo: () => put([...loadRules(root).filter((x) => x.scope === 'project').map(({ scope, ...x }) => x), r]) };
    if (op === 'on' || op === 'off') return { what: `Turn ${op} the command rule ${ruleText(r)}`, from: r.on === false ? 'off' : 'on', to: op, guard: true,
      apply: () => put(cur.map((x) => (x.id === r.id ? { ...x, on: op === 'on' } : x))), undo: () => put(loadRules(root).filter((x) => x.scope === 'project').map(({ scope, ...x }) => (x.id === r.id ? { ...x, on: r.on !== false } : x))) };
    throw new Error('op is add, remove, on or off');
  }
  throw new Error(`${K.label} can't be changed here`);
}
// Undo of a design change: the old DESIGN.md and tokens.css back (what replaced them goes to the trash).
function restoreDesign(root, old) {
  if (!old) return saveProjectDesign(root, null);
  saveProjectDesign(root, old.md);
  const t = safePath(root, 'tokens.css');
  if (old.tokens) fs.writeFileSync(t, old.tokens); else if (fs.existsSync(t)) trashFile(root, 'tokens.css');
}
