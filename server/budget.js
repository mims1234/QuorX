// Project budgets: one dollar limit shared by every chat in a project. What a project has spent is
//   saved chat costs (what the sidebar shows)
// + replies in the cost ledger whose cost never reached a chat file (stopped, page closed, chat deleted)
// + replies running right now, as their cost grows.
// A budget can be raised at any time, or removed, but never set below what is already spent.
import { listProjects, projectChatsSpend, setProjectBudget } from './store.js';
import { ledger } from './runs.js';

export const live = new Map(); // runId → { project, cost } for replies running now

export function projectSpend(projectId) {
  const { cost, runIds } = projectChatsSpend(projectId);
  let unsaved = 0, running = 0;
  for (const [id, r] of ledger) if (r.project === projectId && !runIds.has(id) && !live.has(id)) unsaved += r.cost;
  for (const r of live.values()) if (r.project === projectId) running += r.cost;
  return { spent: cost + unsaved + running, saved: cost, unsaved, running };
}

// A project nobody has set a budget for gets the default ($10). "No limit" is stored as null and respected.
export const DEFAULT_BUDGET = 10;
export const budgetOf = (projectId) => {
  const p = listProjects().find((x) => x.id === projectId);
  if (!p) return null;
  if (!('budget' in p)) return DEFAULT_BUDGET;
  return typeof p.budget === 'number' && p.budget >= 0 ? p.budget : null;
};

/** Where a project stands: its budget (null = none), what is spent, and what is left. */
export function budgetState(projectId) {
  const budget = budgetOf(projectId);
  const { spent } = projectSpend(projectId);
  // running: a reply in this project is working now (the sidebar editor stays locked until it finishes).
  const running = [...live.values()].some((r) => r.project === projectId);
  return { budget, spent, left: budget == null ? null : budget - spent, running };
}

/** What every project together has spent today (local time): replies that ended today, plus replies running now. */
export function spentToday(now = Date.now()) {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  const from = d.getTime();
  let spent = 0;
  for (const [id, r] of ledger) if ((r.at || 0) >= from && !live.has(id)) spent += r.cost;
  for (const r of live.values()) spent += r.cost;
  return spent;
}

/** Sets or removes (null) a project's budget. Refuses an amount below what the project has spent. */
export function setBudget(projectId, value) {
  if (!listProjects().some((p) => p.id === projectId)) throw new Error('no such project');
  if (value === null || value === '') { setProjectBudget(projectId, null); return budgetState(projectId); }
  const budget = Math.round(Number(value) * 100) / 100;
  if (!Number.isFinite(budget) || budget <= 0) throw new Error('the budget must be an amount in dollars, like 5 or 12.50');
  const { spent } = projectSpend(projectId);
  if (budget < spent) throw new Error(`this project has already spent $${spent.toFixed(4)}, so its budget must be at least $${(Math.ceil(spent * 100) / 100).toFixed(2)}`);
  setProjectBudget(projectId, budget);
  return budgetState(projectId);
}
