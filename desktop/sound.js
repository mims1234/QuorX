// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Runs in every page of QuorX's browser (your tabs and the agent's) and gets nothing from QuorX but the volume.
// The page's audio, video and Web Audio play at that volume: the page still sets and reads its own, and what you
// hear is its volume times the browser's. Mute is done by Chromium itself (main.js), not here.
const { contextBridge, ipcRenderer } = require('electron');

function install(key, v0) {
  if (window[key]) return;
  let master = v0;
  const P = HTMLMediaElement.prototype, vol = Object.getOwnPropertyDescriptor(P, 'volume');
  const own = new WeakMap(), known = new WeakSet(), media = new Set(), gains = new Set();
  const apply = (el) => { try { vol.set.call(el, (own.has(el) ? own.get(el) : 1) * master); } catch { /* not ready */ } };
  const meet = (el) => { if (!known.has(el)) { known.add(el); media.add(new WeakRef(el)); } apply(el); };
  Object.defineProperty(P, 'volume', {
    configurable: true, enumerable: vol.enumerable,
    get() { return own.has(this) ? own.get(this) : 1; },
    set(x) { const n = Number(x); if (!(n >= 0 && n <= 1)) return vol.set.call(this, x); own.set(this, n); meet(this); },
  });
  // Elements outside the page (new Audio()) through play(); ones in it as they start loading or playing.
  const play = P.play;
  P.play = function (...a) { meet(this); return play.apply(this, a); };
  for (const ev of ['loadstart', 'play']) document.addEventListener(ev, (e) => { if (e.target instanceof HTMLMediaElement) meet(e.target); }, true);
  // Web Audio: each context's destination is a gain at the browser's volume in front of the real one.
  const AC = window.AudioContext, dest = window.BaseAudioContext && Object.getOwnPropertyDescriptor(BaseAudioContext.prototype, 'destination');
  if (AC && dest) {
    const of = new WeakMap();
    Object.defineProperty(BaseAudioContext.prototype, 'destination', {
      configurable: true, enumerable: dest.enumerable,
      get() {
        if (!(this instanceof AC)) return dest.get.call(this);
        let g = of.get(this);
        if (!g) {
          const real = dest.get.call(this);
          g = this.createGain(); g.gain.value = master; g.connect(real);
          Object.defineProperty(g, 'maxChannelCount', { get: () => real.maxChannelCount });
          of.set(this, g); gains.add(new WeakRef(g));
        }
        return g;
      },
    });
  }
  Object.defineProperty(window, key, {
    value: (v) => {
      master = v;
      for (const r of media) { const el = r.deref(); if (el) apply(el); else media.delete(r); }
      for (const el of document.querySelectorAll('audio, video')) meet(el);
      for (const r of gains) { const g = r.deref(); if (g) g.gain.value = v; else gains.delete(r); }
    },
  });
}

let v = 1;
try { v = Number(ipcRenderer.sendSync('oh-sound-get')); if (!(v >= 0 && v <= 1)) v = 1; } catch { /* the full volume */ }
const key = `__qxs${Math.random().toString(36).slice(2)}`;
try {
  contextBridge.executeInMainWorld({ func: install, args: [key, v] });
  ipcRenderer.on('oh-sound', (_e, nv) => { try { contextBridge.executeInMainWorld({ func: (k, x) => window[k]?.(x), args: [key, Number(nv)] }); } catch { /* page gone */ } });
} catch { /* no main world (an error page): nothing to play */ }
