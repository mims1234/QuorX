// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The desktop tool's parts that don't depend on the system: SendKeys text turned into key presses, and a window's
// controls written as the numbered text the agent reads. The Windows helper (uiahost.ps1) does both itself; the
// macOS helper (axhost.swift) and the Linux one (atspihost.py) return plain data and these turn it into the same
// text, so the agent sees one format everywhere.

// SendKeys names → key names the helpers know.
const NAMED = { ENTER: 'return', TAB: 'tab', ESC: 'escape', ESCAPE: 'escape', BACKSPACE: 'backspace', BS: 'backspace', BKSP: 'backspace',
  DELETE: 'delete', DEL: 'delete', INSERT: 'insert', INS: 'insert', HOME: 'home', END: 'end', PGUP: 'pageup', PGDN: 'pagedown', UP: 'up', DOWN: 'down',
  LEFT: 'left', RIGHT: 'right', SPACE: 'space', ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `f${i + 1}`])) };
const MODS = { '+': 'shift', '^': 'ctrl', '%': 'alt' };

/**
 * SendKeys text ({ENTER}, ^s, %{F4}, +(ab), {TAB 3}, ~) → [{ text }] and [{ key, mods }]. `primary`: what ^ means;
 * on macOS it is the Command key, so ^s saves and ^c copies as they do on Windows.
 */
export function parseSendKeys(keys, { primary = 'ctrl' } = {}) {
  const s = String(keys ?? ''), out = [];
  const mod = (c) => (c === '^' ? primary : MODS[c]);
  const text = (t) => { const last = out[out.length - 1]; if (last?.text != null) last.text += t; else out.push({ text: t }); };
  const press = (key, mods) => {
    if (!mods.length && key.length === 1) return text(key);
    out.push({ key: key.length === 1 ? key.toLowerCase() : key, mods: [...mods] });
  };
  // One key after its modifiers: a {NAME}, a {NAME n} repeat, a (group) or a single character.
  const unit = (i, mods) => {
    if (s[i] === '{') {
      const close = s.indexOf('}', i + 2); // {}} is a literal }
      if (close < 0) throw new Error(`unclosed { in keys: ${s}`);
      const body = s.slice(i + 1, close);
      const m = body.match(/^(.+?)(?:\s+(\d+))?$/);
      const name = m[1], times = Math.min(100, Number(m[2] || 1));
      const key = NAMED[name.toUpperCase()] || (name.length === 1 ? name : null);
      if (!key) throw new Error(`unknown key {${name}}`);
      for (let n = 0; n < times; n++) press(key, mods);
      return close + 1;
    }
    if (s[i] === '(' && mods.length) {
      const close = s.indexOf(')', i);
      if (close < 0) throw new Error(`unclosed ( in keys: ${s}`);
      for (const ch of s.slice(i + 1, close)) press(ch, mods);
      return close + 1;
    }
    if (s[i] === '~') { press('return', mods); return i + 1; }
    press(s[i], mods);
    return i + 1;
  };
  for (let i = 0; i < s.length;) {
    const mods = [];
    while (MODS[s[i]] && i < s.length - 1) mods.push(mod(s[i++]));
    if (i >= s.length) break;
    i = unit(i, mods);
  }
  return out;
}

// macOS virtual key codes (ANSI layout) for keys pressed with modifiers, and for the named keys.
export const MAC_KEYCODES = { a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, 1: 18, 2: 19,
  3: 20, 4: 21, 6: 22, 5: 23, '=': 24, 9: 25, 7: 26, '-': 27, 8: 28, 0: 29, ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40,
  ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50, return: 36, tab: 48, space: 49, backspace: 51, escape: 53, delete: 117,
  insert: 114, home: 115, end: 119, pageup: 116, pagedown: 121, left: 123, right: 124, down: 125, up: 126, f1: 122, f2: 120, f3: 99, f4: 118, f5: 96,
  f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111 };

/** Key presses for the macOS helper: text stays text; keys get their key code. */
export function macKeyEvents(keys) {
  return parseSendKeys(keys, { primary: 'cmd' }).map((e) => {
    if (e.text != null) return e;
    const code = MAC_KEYCODES[e.key];
    if (code == null) throw new Error(`the key "${e.key}" can't be pressed with modifiers on macOS`);
    return { code, mods: e.mods };
  });
}

// Control kinds, named as on Windows (UI Automation) so the agent reads the same words everywhere.
const ROLE_NAMES = { button: 'Button', textfield: 'Edit', textarea: 'Edit', securetextfield: 'Edit', 'text field': 'Edit', 'password text': 'Edit', entry: 'Edit',
  'push button': 'Button', 'toggle button': 'Button', statictext: 'Text', label: 'Text', checkbox: 'CheckBox', 'check box': 'CheckBox', radiobutton: 'RadioButton',
  'radio button': 'RadioButton', popupbutton: 'ComboBox', combobox: 'ComboBox', 'combo box': 'ComboBox', menuitem: 'MenuItem', 'menu item': 'MenuItem',
  menubutton: 'SplitButton', link: 'Hyperlink', tabgroup: 'Tab', 'page tab list': 'Tab', 'page tab': 'TabItem', radiobuttontab: 'TabItem', slider: 'Slider',
  incrementor: 'Spinner', 'spin button': 'Spinner', row: 'DataItem', 'table row': 'DataItem', cell: 'DataItem', 'table cell': 'DataItem', 'list item': 'ListItem',
  outlinerow: 'TreeItem', 'tree item': 'TreeItem', window: 'Window', frame: 'Window', dialog: 'Window', sheet: 'Window', group: 'Group', panel: 'Pane',
  scrollarea: 'Pane', 'scroll pane': 'Pane', toolbar: 'ToolBar', 'tool bar': 'ToolBar', image: 'Image', icon: 'Image', list: 'List', table: 'Table',
  outline: 'Tree', tree: 'Tree', webarea: 'Document', 'document web': 'Document', 'document frame': 'Document', menu: 'Menu', menubar: 'MenuBar', 'menu bar': 'MenuBar' };
/** AXButton, "push button" → Button; anything unknown keeps its own name. */
export function roleName(role) {
  const r = String(role || '').replace(/^AX/, '');
  return ROLE_NAMES[r.toLowerCase()] || r.replace(/^\w/, (c) => c.toUpperCase()) || 'Unknown';
}

const clip = (s, n) => { const t = String(s ?? '').replace(/[\r\n]+/g, ' '); return t.length > n ? `${t.slice(0, n)}…` : t; };
/**
 * A window's controls as text, from the helpers' nodes: [{ indent, role, name, value, checked, enabled, offscreen, ref, x, y }]
 * (ref: the number of an interactive control; x, y: its centre in the window). The same lines uiahost.ps1 writes.
 */
export function treeText(nodes, { more = false } = {}) {
  const lines = (nodes || []).map((n) => {
    let l = `${'  '.repeat(Math.max(0, n.indent || 0))}${n.ref ? `[${n.ref}] ` : ''}${roleName(n.role)}`;
    const name = clip(n.name, 80), val = clip(n.value, 80);
    if (name) l += ` "${name}"`;
    if (val && val !== name) l += ` value="${val}"`;
    if (n.checked != null) l += n.checked === true ? ' checked' : n.checked === false ? ' unchecked' : ' mixed';
    if (n.enabled === false) l += ' (disabled)';
    if (n.offscreen && n.indent > 0) l += ' (off screen)';
    else if (n.ref && n.x != null && n.y != null) l += ` @${Math.round(n.x)},${Math.round(n.y)}`;
    return l;
  });
  if (more) lines.push('… (more controls not shown)');
  return lines.length ? `${lines.join('\n')}\n` : '';
}
