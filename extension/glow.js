// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// While a QuorX chat's agent works in this tab: a glowing QuorX edge round the page and a Stop button at the top.
// They sit in a closed shadow root, so the agent's page reading (pageops.js) never sees them, and the edge lets every
// click through. Stop asks QuorX to stop that chat's reply. Run by the extension (background.js) with
// chrome.scripting, in the extension's own world; calling it again only switches it on or off.
(() => {
  const KEY = Symbol.for('quorx.glow');
  if (window[KEY]) return;
  let host = null, pill = null;
  const on = (text) => {
    if (!host) {
      host = document.createElement('quorx-glow');
      host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>
        .edge { position: fixed; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 2px rgba(60,194,201,.95), inset 0 0 26px 6px rgba(60,194,201,.45); animation: qx 2.4s ease-in-out infinite; }
        @keyframes qx { 50% { box-shadow: inset 0 0 0 2px rgba(60,194,201,.7), inset 0 0 14px 3px rgba(60,194,201,.25); } }
        @media (prefers-reduced-motion: reduce) { .edge { animation: none; } }
        button { position: fixed; top: 8px; left: 50%; transform: translateX(-50%); pointer-events: auto; display: flex; align-items: center; gap: 8px;
          font: 600 12px/1 system-ui, "Segoe UI", sans-serif; color: #ebf5f6; background: rgba(14,22,24,.94); border: 1.5px solid rgb(60,194,201);
          border-radius: 999px; padding: 7px 14px 7px 11px; cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,.35); }
        button:hover, button:focus-visible { background: rgba(30,40,42,.98); outline: none; }
        i { width: 9px; height: 9px; border-radius: 2px; background: #e84848; }
      </style><div class="edge"></div><button type="button"><i></i><span></span></button>`;
      pill = root.querySelector('button');
      pill.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        pill.querySelector('span').textContent = 'Stopping…';
        chrome.runtime.sendMessage({ q: 'stopTab' }).catch(() => {});
      }, true);
    }
    pill.querySelector('span').textContent = text || 'QuorX is working in this tab · Stop';
    if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
    return true;
  };
  const off = () => { host?.remove(); return true; };
  Object.defineProperty(window, KEY, { value: { on, off }, configurable: true });
})();
