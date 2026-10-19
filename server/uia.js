// The agent's view of desktop apps it started (Windows): their windows, their controls as numbered text (UI Automation),
// clicking, typing, keys, a picture of a window, closing. Every call is limited to the processes of one of the agent's
// background jobs (server/bgjobs.js), so the user's own windows are never read or touched. See uiahost.ps1.
import { psHost, jobCount } from './jobhost.js';
import { getBackground } from './bgjobs.js';

const U = psHost('./uiahost.ps1', { label: 'desktop helper', readyMs: 30000 });
export const desktopAvailable = U.available;
export const desktopStatus = U.status;

// The processes a job may show windows for: everything still alive in its Windows job.
async function pidsOf(jobId) {
  const j = getBackground(jobId);
  if (!j) throw new Error(`no background job ${jobId}: start the app with shell and background: true first`);
  if (j.status !== 'running') throw new Error(`job ${jobId} has ${j.status}${j.code != null ? ` (exit code ${j.code})` : ''}; start the app again`);
  if (!j.proc?.qxJob) throw new Error('desktop apps can only be reached when the job host is running (⚙ Safety & commands → Stop)');
  const c = await jobCount(j.proc.qxJob);
  if (!c.pids.length) throw new Error(`job ${jobId} has no running processes`);
  return c.pids.map(Number);
}

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** The job's top-level windows: [{ handle, pid, title }]. Waits up to `wait` ms for the first one to appear. */
export async function appWindows(jobId, wait = 0) {
  const t0 = Date.now();
  for (;;) {
    const r = await U.call('windows', { pids: await pidsOf(jobId) }, 20000);
    const w = arr(r.windows);
    if (w.length || Date.now() - t0 >= wait) return w;
    await new Promise((x) => setTimeout(x, 500));
  }
}
const pick = async (jobId, handle) => {
  const pids = await pidsOf(jobId);
  let h = Number(handle);
  if (!h) { const w = await appWindows(jobId, 8000); if (!w.length) throw new Error(`job ${jobId} has no window yet`); h = w[0].handle; }
  return { pids, handle: h };
};
export async function readWindow(jobId, handle, { depth = 25, max = 250 } = {}) { const p = await pick(jobId, handle); return { ...p, text: (await U.call('tree', { ...p, depth, max }, 30000)).text }; }
export async function clickControl(jobId, handle, ref) { const p = await pick(jobId, handle); return (await U.call('click', { ...p, ref: Number(ref) }, 15000)).did; }
export async function clickAt(jobId, handle, x, y) { const p = await pick(jobId, handle); return (await U.call('clickxy', { ...p, x: Math.round(Number(x)), y: Math.round(Number(y)) }, 15000)).did; }
export async function setControl(jobId, handle, ref, text) { const p = await pick(jobId, handle); return (await U.call('set', { ...p, ref: Number(ref), text: String(text ?? '') }, 15000)).did; }
export async function sendKeys(jobId, handle, keys) { const p = await pick(jobId, handle); return (await U.call('keys', { ...p, keys: String(keys ?? '') }, 15000)).did; }
export async function windowShot(jobId, handle) { const p = await pick(jobId, handle); return `data:image/png;base64,${(await U.call('shot', p, 20000)).png}`; }
export async function closeWindow(jobId, handle) { const p = await pick(jobId, handle); return (await U.call('close', p, 15000)).did; }
