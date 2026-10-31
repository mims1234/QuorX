// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The bridge the app's own page gets in the desktop app (browse tabs get nothing). With it, the pane's
// Browser tab uses real Chromium tabs; without it (other browsers) it streams pictures as before.
const { contextBridge, ipcRenderer } = require('electron');

const call = (name, ...a) => ipcRenderer.invoke(`oh:${name}`, ...a);
const listeners = new Set();
ipcRenderer.on('oh-desktop', (_e, ev) => { for (const fn of listeners) { try { fn(ev); } catch { /* a listener's own problem */ } } });

contextBridge.exposeInMainWorld('ohDesktop', {
  available: true,
  open: (sid, url) => call('open', sid, url),
  bounds: (sid, rect) => call('bounds', sid, rect),
  show: (sid) => call('show', sid),
  hideAll: () => call('hideAll'),
  nav: (sid, op) => call('nav', sid, op),
  close: (sid) => call('close', sid),
  snapshot: (sid) => call('snapshot', sid),
  sound: (op, arg) => call('sound', op, arg),
  tabs: (op, sid) => call('tabs', op, sid),
  loginItem: (on) => call('loginItem', on),
  closeAction: (v) => call('closeAction', v),
  quit: () => call('quit'),
  update: (op, arg) => call('update', op, arg),
  info: () => call('info'),
  restartHarness: () => call('restartHarness'),
  storage: (op, arg) => call('storage', op, arg),
  openHome: () => call('openHome'),
  focusWindow: () => call('focusWindow'),
  notify: (n) => call('notify', n),
  zoom: (dir) => call('zoom', dir),
  openExternal: (url) => call('openExternal', url),
  showFile: (file) => call('showFile', file),
  on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
});
