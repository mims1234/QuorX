// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// While a QuorX chat's agent works in this tab: a glowing QuorX edge round the page and, at the top, the same banner as
// on the desktop (what is happening, the shortcut under it, a red Stop button), in Chrome's purple. They sit in a closed
// shadow root, so the agent's page reading (pageops.js) never sees them, and the edge lets every click through. Stop
// asks QuorX to stop that chat's reply. Run by the extension (background.js) with chrome.scripting, in the extension's
// own world; calling it again only switches it on or off.
(() => {
  const KEY = Symbol.for('quorx.glow');
  if (window[KEY]) return;
  let host = null, card = null;
  const on = (text, keys) => {
    if (!host) {
      host = document.createElement('quorx-glow');
      host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>
        .edge { position: fixed; inset: 0; pointer-events: none; box-shadow: inset 0 0 0 2px rgba(155,123,255,.95), inset 0 0 26px 6px rgba(155,123,255,.45); animation: qx 2.4s ease-in-out infinite; }
        @keyframes qx { 50% { box-shadow: inset 0 0 0 2px rgba(155,123,255,.7), inset 0 0 14px 3px rgba(155,123,255,.25); } }
        @media (prefers-reduced-motion: reduce) { .edge { animation: none; } }
        .card { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); pointer-events: auto; display: flex; align-items: center; gap: 12px;
          padding: 10px 10px 10px 14px; border-radius: 10px; background: rgba(14,22,24,.95); border: 1.5px solid rgb(155,123,255);
          box-shadow: 0 4px 16px rgba(0,0,0,.4); font-family: "Segoe UI", system-ui, sans-serif; }
        .dot { width: 10px; height: 10px; border-radius: 50%; background: rgb(155,123,255); flex: none; }
        .txt { display: flex; flex-direction: column; gap: 1px; }
        b { font: 600 14px/1.25 "Segoe UI Semibold", "Segoe UI", system-ui, sans-serif; color: #ebf5f6; white-space: nowrap; }
        small { font: 400 12px/1.25 "Segoe UI", system-ui, sans-serif; color: #a0b8ba; white-space: nowrap; }
        button { display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 14px 0 12px; border: 0; border-radius: 7px; cursor: pointer;
          background: #d6363a; color: #fff; font: 600 13px/1 "Segoe UI Semibold", "Segoe UI", system-ui, sans-serif; }
        button:hover, button:focus-visible { background: #e84848; outline: none; }
        button i { width: 9px; height: 9px; background: #fff; border-radius: 1px; }
      </style><div class="edge"></div><div class="card" role="status"><span class="dot"></span><span class="txt"><b></b><small></small></span><button type="button"><i></i><span>Stop</span></button></div>`;
      card = root.querySelector('.card');
      const stop = card.querySelector('button');
      stop.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        stop.querySelector('span').textContent = 'Stopping…';
        chrome.runtime.sendMessage({ q: 'stopTab' }).catch(() => {});
      }, true);
    }
    card.querySelector('b').textContent = text || 'QuorX is using Chrome';
    card.querySelector('small').textContent = keys || '';
    card.querySelector('small').hidden = !keys;
    card.querySelector('button span').textContent = 'Stop';
    if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
    return true;
  };
  const off = () => { host?.remove(); return true; };
  Object.defineProperty(window, KEY, { value: { on, off }, configurable: true });
})();
