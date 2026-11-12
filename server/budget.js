// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Chat budgets: one dollar limit per chat, the only money limit there is. Every call counts at a price: money paid, and
// a plan's sub value (at list price). What a chat has spent is
//   its saved cost (what the chat file holds)
// + replies in the cost ledger whose cost never reached the chat file (stopped, page closed, rewound)
// + its reply running right now, as its cost grows.
// A budget can be raised at any time, or removed, but never set below what is already spent. A chat nobody set one for
// gets the default (data/chat-budgets.json holds both, so the page saving a chat can't overwrite them).
// A project's spend (all its chats) is still worked out here, for the sidebar and project settings.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './openrouter.js';
import { projectChatsSpend, chatSavedSpend } from './store.js';
import { ledger } from './runs.js';
import { renameSoon } from './fsretry.js';

export const live = new Map(); // runId → { project, chat, cost } for replies running now

export function projectSpend(projectId) {
  const { cost, runIds } = projectChatsSpend(projectId);
  let unsaved = 0, running = 0;
  for (const [id, r] of ledger) if (r.project === projectId && !runIds.has(id) && !live.has(id)) unsaved += r.cost;
  for (const r of live.values()) if (r.project === projectId) running += r.cost;
  return { spent: cost + unsaved + running, saved: cost, unsaved, running };
}

// A chat's spend for its budget counts every call at a price: money paid, and the sub value of calls on a plan
// (OpenCode Go, Command Code, a Claude or Grok subscription, at list price; see sources.js "reference prices").
// `plan` says how much of `spent` is sub value, so the page can say so.
export function chatSpend(chatId) {
  const { cost, plan: savedPlan, runIds } = chatSavedSpend(chatId);
  let unsaved = 0, running = 0, runningPlan = 0, plan = savedPlan || 0;
  for (const [id, r] of ledger) if (r.chat === chatId && !runIds.has(id) && !live.has(id)) { unsaved += r.cost + (r.plan || 0); plan += r.plan || 0; }
  for (const r of live.values()) if (r.chat === chatId) { running += r.cost + (r.plan || 0); runningPlan += r.plan || 0; }
  plan += runningPlan;
  return { spent: cost + (savedPlan || 0) + unsaved + running, saved: cost + (savedPlan || 0), unsaved, running, runningPlan, plan };
}

// ---------- the budgets file ----------
export const DEFAULT_BUDGET = 10;
const FILE = path.join(HOME, 'data', 'chat-budgets.json');
let cache = null;
function read() {
  if (cache) return cache;
  try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); cache = { default: j.default === null || (typeof j.default === 'number' && j.default > 0) ? j.default : DEFAULT_BUDGET, chats: j.chats && typeof j.chats === 'object' ? j.chats : {} }; } catch { cache = { default: DEFAULT_BUDGET, chats: {} }; }
  return cache;
}
function write(next) {
  cache = next;
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE + '.tmp', JSON.stringify(next, null, 2)); renameSoon(FILE + '.tmp', FILE); } catch { /* kept in memory until the next save */ }
}
/** For tests: forget what was read, so the file is read again. */
export const resetBudgets = () => { cache = null; };

/** The budget a new chat starts with (null = no limit). */
export const defaultBudget = () => read().default;
export function setDefaultBudget(value) {
  const b = value === null || value === '' || value === 'none' ? null : Math.round(Number(value) * 100) / 100;
  if (b !== null && !(Number.isFinite(b) && b > 0)) throw new Error('the budget must be an amount in dollars, like 5 or 12.50, or none');
  write({ ...read(), default: b });
  return b;
}
/** A chat's budget in dollars, or null for none. A chat nobody set one for has the default. */
export const budgetOf = (chatId) => {
  const s = read();
  if (!chatId || !(chatId in s.chats)) return s.default;
  const b = s.chats[chatId];
  return typeof b === 'number' && b >= 0 ? b : null;
};

/** Where a chat stands: its budget (null = none), what is spent, and what is left. */
export function budgetState(chatId) {
  const budget = budgetOf(chatId);
  const { spent, running: runningCost, runningPlan, unsaved, plan } = chatSpend(chatId);
  // running: a reply in this chat is working now; runningCost: what it has spent so far (part of spent), so a page
  // showing its own live figure can swap it in. unsavedCost: spent by replies the chat file doesn't hold (rewound,
  // stopped before saving).
  const running = [...live.values()].some((r) => r.chat === chatId);
  // planValue: the part of spent that is sub value (calls on a plan, at list price), not money paid.
  return { budget, spent, left: budget == null ? null : budget - spent, running, runningCost, unsavedCost: unsaved, planValue: plan, runningPlan, isDefault: !(chatId in read().chats) };
}

/** Sets or removes (null) a chat's budget. Refuses an amount below what the chat has spent. */
export function setBudget(chatId, value) {
  if (!chatId) throw new Error('no such chat');
  const s = read();
  if (value === null || value === '' || value === 'none') { write({ ...s, chats: { ...s.chats, [chatId]: null } }); return budgetState(chatId); }
  const budget = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('the budget must be an amount in dollars, like 5 or 12.50');
  const { spent } = chatSpend(chatId);
  if (budget < spent) throw new Error(`this chat has already spent $${spent.toFixed(4)}, so its budget must be at least $${(Math.ceil(spent * 100) / 100).toFixed(2)}`);
  write({ ...s, chats: { ...s.chats, [chatId]: budget } });
  return budgetState(chatId);
}
