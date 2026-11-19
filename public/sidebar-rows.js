// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The sidebar's rows for chats open in this page that the server's list doesn't have yet. The list comes from the
// server (refreshSidebar), so a chat shows there once its first save went through and a refresh came back after it.
// Until then the page lists it itself: a blank chat only while it is on screen, but one with a message sent or a reply
// running wherever it is, so going to another chat while its first save is still on the way, or after that save failed,
// doesn't make it vanish until the reply ends.

/**
 * open: the page's open chats ({ id, title, projectId, created, running, agent: { setup, messages } }),
 * known: ids the server's list has, onScreen: ids shown in a pane → rows shaped like the server's summaries.
 */
export function openRows(open, known, onScreen) {
  const rows = [];
  for (const c of open) {
    if (!c || known.has(c.id)) continue;
    const msgs = c.agent?.messages || [];
    const asked = msgs.filter((m) => m.role === 'user').length;
    if (!onScreen.includes(c.id) && !asked && !c.running) continue;
    const lastAt = Math.max(0, ...msgs.map((m) => m.doneAt || m.at || 0)) || c.created;
    rows.push({ id: c.id, title: c.title, projectId: c.projectId, messages: asked, cost: 0, lastAt, model: c.agent?.setup?.model, preview: '' });
  }
  return rows;
}

/** Only the newest of overlapping refreshes may draw: one that comes back after a newer one started is dropped. */
export function latestOnly() {
  let n = 0;
  return { start: () => ++n, current: (t) => t === n };
}
