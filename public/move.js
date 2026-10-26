// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The page at the old address (localhost:<port>): QuorX opens at quorx.localhost now (server/access.js). What this
// browser kept for QuorX here goes with it once, sent to the handoff the app link made, then QuorX opens there.
(async () => {
  const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.content || '';
  const id = meta('qx-move'), next = new URL(meta('qx-next'));
  const MOVED = 'oh-moved-host';
  let items = null;
  try {
    if (!localStorage.getItem(MOVED) && localStorage.length) {
      items = {};
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); items[k] = localStorage.getItem(k); }
    }
  } catch { /* storage off: nothing to carry */ }
  if (id) {
    if (items) {
      const r = await fetch(`/api/prefs/handoff/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }).catch(() => null);
      if (r?.ok) try { localStorage.setItem(MOVED, String(Date.now())); } catch { /* sent anyway */ }
    }
    next.searchParams.set('moved', id);
  } else if (items) {
    // Without the app link this page can't show it's yours, so the settings wait for the link.
    const msg = document.getElementById('moveMsg');
    msg.textContent = 'QuorX now opens at its own address. To bring this browser\'s QuorX settings along, open the link QuorX printed when it started (the desktop app does this by itself). ';
    const go = document.createElement('a');
    go.href = next.href; go.textContent = 'Open QuorX without them'; go.style.color = '#7fd1a8';
    msg.append(go);
    return;
  }
  location.replace(next.href);
})();
