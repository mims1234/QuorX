# Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
# QuorX desktop helper for Linux: reads and drives the windows of programs the agent started, through AT-SPI (the
# structure Orca reads). GTK apps take part by default; Qt apps when started with QT_ACCESSIBILITY=1, Electron apps
# with --force-renderer-accessibility. Keys and clicks use AT-SPI's synthetic events, which work on X11 (and
# XWayland); on a pure Wayland session only reading and pressing controls work.
# Every request names the process ids it may touch (QuorX passes the agent job's processes); a window owned by any
# other process is refused, and keys are sent only while one of the agent's windows has the focus.
# JSON lines on stdin/stdout, the same requests as uiahost.ps1 on Windows (and axhost.swift on macOS):
#   windows {pids}                       -> {windows: [{handle, pid, title}]}    handle = pid * 1000 + its place
#   tree    {pids, handle, depth, max}   -> {nodes: [...], more}   (server/deskkit.js writes the text)
#   click / clickxy / set / keys / close  -> {did}                  (keys: events from deskkit.js parseSendKeys)
import json
import sys
import time

try:
    import pyatspi
    from gi.repository import Atspi
except Exception as e:  # noqa: BLE001
    sys.stderr.write('the desktop tool on Linux needs AT-SPI for Python: install python3-pyatspi (apt, dnf) or python-atspi (pacman) yourself (%s)\n' % e)
    sys.exit(1)

WINDOW_ROLES = {'frame', 'dialog', 'window', 'alert', 'file chooser'}
INTERACTIVE = {'push button', 'toggle button', 'text', 'entry', 'password text', 'check box', 'radio button', 'combo box', 'menu item',
               'check menu item', 'radio menu item', 'link', 'page tab', 'slider', 'spin button', 'list item', 'table cell', 'tree item',
               'table row', 'menu'}
KEYSYMS = {'return': 0xff0d, 'tab': 0xff09, 'escape': 0xff1b, 'backspace': 0xff08, 'delete': 0xffff, 'insert': 0xff63, 'home': 0xff50,
           'end': 0xff57, 'pageup': 0xff55, 'pagedown': 0xff56, 'left': 0xff51, 'up': 0xff52, 'right': 0xff53, 'down': 0xff54, 'space': 0x20}
KEYSYMS.update({'f%d' % (i + 1): 0xffbe + i for i in range(12)})
MODMASK = {'shift': 1, 'ctrl': 4, 'alt': 8, 'cmd': 64}  # X11 modifier masks
SYNTH = Atspi.KeySynthType
REFS = {}


class Fail(Exception):
    pass


def apps(pids):
    out = []
    for app in pyatspi.Registry.getDesktop(0):
        try:
            if app is not None and app.get_process_id() in pids:
                out.append(app)
        except Exception:  # noqa: BLE001  (an app that went away)
            pass
    return out


def windows_of(pids):
    out = []
    for app in apps(pids):
        pid = app.get_process_id()
        n = 0
        for w in app:
            try:
                if w is not None and w.getRoleName() in WINDOW_ROLES:
                    out.append((pid * 1000 + n, pid, w))
                    n += 1
            except Exception:  # noqa: BLE001
                pass
    return out


def window(handle, pids):
    if handle // 1000 not in pids:
        raise Fail('that window belongs to a program the agent did not start, so it is off limits')
    for h, _, w in windows_of(pids):
        if h == handle:
            return w
    raise Fail('that window is gone: list the windows again')


def extents(acc):
    try:
        e = acc.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
        return e.x, e.y, e.width, e.height
    except Exception:  # noqa: BLE001
        return None


def walk(acc, indent, level, depth, maxn, origin, nodes, refs):
    if len(nodes) >= maxn or level > depth or acc is None:
        return
    try:
        role = acc.getRoleName()
        name = acc.name or ''
        states = acc.getState()
    except Exception:  # noqa: BLE001
        return
    enabled = states.contains(pyatspi.STATE_ENABLED) or states.contains(pyatspi.STATE_SENSITIVE)
    value, checked = None, None
    if role in ('check box', 'radio button', 'toggle button', 'check menu item', 'radio menu item'):
        checked = states.contains(pyatspi.STATE_CHECKED)
    elif role != 'password text':
        try:
            t = acc.queryText()
            value = t.getText(0, min(t.characterCount, 200))
        except Exception:  # noqa: BLE001
            try:
                value = str(acc.queryValue().currentValue)
            except Exception:  # noqa: BLE001
                value = None
    if role == 'label' and not name:
        name, value = value or '', None
    try:
        has_action = acc.queryAction().nActions > 0
    except Exception:  # noqa: BLE001
        has_action = False
    inter = enabled and (role in INTERACTIVE or (has_action and role not in WINDOW_ROLES))
    show = inter or bool(name) or level == 0 or bool(value)
    if show:
        node = {'indent': indent, 'role': role, 'name': name[:200], 'enabled': bool(enabled)}
        if value:
            node['value'] = value[:200]
        if checked is not None:
            node['checked'] = bool(checked)
        if not states.contains(pyatspi.STATE_SHOWING):
            node['offscreen'] = True
        if inter:
            refs.append(acc)
            node['ref'] = len(refs)
            e = extents(acc)
            if e and origin:
                node['x'] = e[0] - origin[0] + e[2] // 2
                node['y'] = e[1] - origin[1] + e[3] // 2
        nodes.append(node)
    for i in range(acc.childCount):
        if len(nodes) >= maxn:
            break
        try:
            child = acc[i]
        except Exception:  # noqa: BLE001
            continue
        walk(child, indent + 1 if show else indent, level + 1, depth, maxn, origin, nodes, refs)


def control(handle, ref):
    lst = REFS.get(handle) or []
    if ref < 1 or ref > len(lst):
        raise Fail('no control [%d] in this window: read it again (the numbers change when the window changes)' % ref)
    return lst[ref - 1]


def do_action(acc, names):
    a = acc.queryAction()
    for i in range(a.nActions):
        if a.getName(i).lower() in names:
            a.doAction(i)
            return True
    return False


def focused(w):
    w.queryComponent().grabFocus()
    time.sleep(0.2)
    if not w.getState().contains(pyatspi.STATE_ACTIVE):
        raise Fail('the window could not be brought to the front, so nothing was sent (on Wayland keys and clicks need XWayland)')


def press(sym, mods):
    mask = 0
    for m in mods:
        mask |= MODMASK.get(m, 0)
    if mask and not hasattr(SYNTH, 'LOCKMODIFIERS'):
        raise Fail('this AT-SPI is too old to hold Ctrl, Alt or Shift (it needs at-spi2-core 2.32 or newer)')
    if mask:
        Atspi.generate_keyboard_event(mask, None, SYNTH.LOCKMODIFIERS)
    try:
        Atspi.generate_keyboard_event(sym, None, SYNTH.SYM)
    finally:
        if mask:
            Atspi.generate_keyboard_event(mask, None, SYNTH.UNLOCKMODIFIERS)
    time.sleep(0.02)


def handle(m):
    op = m.get('op')
    pids = set(int(p) for p in (m.get('pids') or []))
    h = int(m.get('handle') or 0)
    if op == 'windows':
        return {'windows': [{'handle': hh, 'pid': pid, 'title': w.name or ''} for hh, pid, w in windows_of(pids)]}
    w = window(h, pids)
    if op == 'tree':
        nodes, refs = [], []
        maxn = int(m.get('max') or 250)
        e = extents(w)
        walk(w, 0, 0, int(m.get('depth') or 25), maxn, e[:2] if e else None, nodes, refs)
        REFS[h] = refs
        return {'nodes': nodes, 'more': len(nodes) >= maxn}
    if op == 'click':
        acc = control(h, int(m.get('ref') or 0))
        if do_action(acc, ('click', 'press', 'activate', 'toggle', 'jump', 'open')):
            return {'did': 'pressed'}
        e = extents(acc)
        if not e or e[2] <= 0:
            raise Fail('that control has no place on screen to click')
        focused(w)
        Atspi.generate_mouse_event(e[0] + e[2] // 2, e[1] + e[3] // 2, 'b1c')
        return {'did': 'clicked with the mouse (it has no button behaviour of its own)'}
    if op == 'clickxy':
        e = extents(w)
        x, y = int(m.get('x', -1)), int(m.get('y', -1))
        if not e or x < 0 or y < 0 or x >= e[2] or y >= e[3]:
            raise Fail('that point is outside the window')
        focused(w)
        Atspi.generate_mouse_event(e[0] + x, e[1] + y, 'b1c')
        return {'did': 'clicked at %d,%d' % (x, y)}
    if op == 'set':
        acc = control(h, int(m.get('ref') or 0))
        try:
            acc.queryEditableText().setTextContents(str(m.get('text') or ''))
            return {'did': 'set its text'}
        except Exception:  # noqa: BLE001
            raise Fail('that control does not take text')
    if op == 'keys':
        focused(w)
        for ev in m.get('events') or []:
            if 'text' in ev:
                for i, part in enumerate(ev['text'].split('\n')):
                    if i:
                        press(KEYSYMS['return'], [])
                    if part:
                        Atspi.generate_keyboard_event(0, part, SYNTH.STRING)
            else:
                key = ev.get('key', '')
                sym = KEYSYMS.get(key) or (ord(key) if len(key) == 1 else None)
                if sym is None:
                    raise Fail('unknown key %s' % key)
                press(sym, ev.get('mods') or [])
        return {'did': 'sent the keys'}
    if op == 'shot':
        raise Fail('pictures of windows are not available on Linux yet: read the window instead')
    if op == 'close':
        focused(w)
        press(KEYSYMS['f4'], ['alt'])
        return {'did': 'asked it to close (Alt+F4)'}
    raise Fail('unknown op %s' % op)


def main():
    print(json.dumps({'ready': True}), flush=True)
    for line in sys.stdin:
        if not line.strip():
            continue
        mid = None
        try:
            m = json.loads(line)
            mid = m.get('id')
            out = {'id': mid, 'ok': True}
            out.update(handle(m))
        except Fail as e:
            out = {'id': mid, 'ok': False, 'error': str(e)}
        except Exception as e:  # noqa: BLE001
            out = {'id': mid, 'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}
        print(json.dumps(out), flush=True)


if __name__ == '__main__':
    main()
