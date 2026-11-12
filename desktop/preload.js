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
  showSet: (sids) => call('showSet', sids),
  hideAll: () => call('hideAll'),
  nav: (sid, op) => call('nav', sid, op),
  close: (sid) => call('close', sid),
  find: (sid, op, text, opts) => call('find', sid, op, text, opts),
  device: (sid, d) => call('device', sid, d),
  // Pop-out windows: open one, list them, a pop-out's state and Dock back, and a pop-out asking the main window.
  popout: (op, a, b) => call('popout', op, a, b),
  snapshot: (sid) => call('snapshot', sid),
  sound: (op, arg) => call('sound', op, arg),
  tabs: (op, sid) => call('tabs', op, sid),
  loginItem: (on) => call('loginItem', on),
  closeAction: (v) => call('closeAction', v),
  keepAwake: (on) => call('keepAwake', on),
  summon: (v) => call('summon', v),
  quit: () => call('quit'),
  update: (op, arg) => call('update', op, arg),
  info: () => call('info'),
  restartHarness: () => call('restartHarness'),
  storage: (op, arg) => call('storage', op, arg),
  openHome: () => call('openHome'),
  focusWindow: () => call('focusWindow'),
  notify: (n) => call('notify', n),
  zoom: (dir) => call('zoom', dir),
  // The window frame: the native − □ × colours, full screen, and the Edit menu's commands.
  frame: (op, arg) => call('frame', op, arg),
  openExternal: (url) => call('openExternal', url),
  showFile: (file) => call('showFile', file),
  perf: () => call('perf'),
  // The taskbar badge: how many chats need you, and the picture the page drew for it.
  badge: (n, png) => call('badge', n, png),
  // The mouse's side buttons come from the window (see 'app-command' in main.js), not from the page's own events.
  navButtons: true,
  on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
});
