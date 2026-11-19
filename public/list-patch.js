// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// Redraws a list made of keyed blocks (the sidebar's projects) by refilling only the blocks whose HTML changed.
// Rebuilding the whole sidebar while chats work (every 1.5 s, and on each run start, stop or question) made the page
// restyle and lay out hundreds of chat rows each time: with a few hundred chats that took a quarter of a second per
// redraw, long enough to swallow keystrokes in the message box. Now a chat that is working redraws its own project.
// A changed block keeps its element and gets new contents and attributes: swapping the element itself makes the
// browser restyle every block after it as well.
// No page state here, so the rules are tested on their own (scripts/test-listpatch.mjs).

// What to do, from what is shown now (prev: { keys, html, tail } or null) and what should be shown (next: the same
// shape). full: draw everything (the first time, or the projects, their order or the end of the list changed);
// otherwise `changed` lists the positions of the blocks to refill (none when nothing changed).
export function listPlan(prev, next) {
  const same = prev && prev.keys.length === next.keys.length && prev.tail === next.tail && prev.keys.every((k, i) => k === next.keys[i]);
  if (!same) return { full: true, changed: [] };
  const changed = [];
  next.html.forEach((h, i) => { if (h !== prev.html[i]) changed.push(i); });
  return { full: false, changed };
}

// Draws `next` into `box` (blocks first, then the tail) and returns the block elements whose contents are new, so the
// caller binds handlers on those only. Each block's HTML must be exactly one element. The drawn state is kept on the
// box; a box that was rewritten some other way is noticed and drawn again in full.
export function patchList(box, next, make = defaultMake) {
  let prev = box._listState || null;
  if (prev && (box.children.length !== prev.count || prev.keys.some((k, i) => box.children[i]?.dataset?.key !== k))) prev = null;
  const plan = listPlan(prev, next);
  let fresh;
  if (plan.full) {
    box.innerHTML = next.html.join('') + next.tail;
    fresh = [...box.children].slice(0, next.keys.length);
    fresh.forEach((el, i) => { el.dataset.key = next.keys[i]; });
  } else {
    fresh = plan.changed.map((i) => { const el = box.children[i]; refill(el, make(next.html[i], box)); return el; });
  }
  box._listState = { keys: [...next.keys], html: [...next.html], tail: next.tail, count: box.children.length };
  return { full: plan.full, fresh };
}

// el takes nu's attributes (its data-key stays) and children.
export function refill(el, nu) {
  for (const { name } of [...el.attributes]) if (name !== 'data-key' && !nu.hasAttribute(name)) el.removeAttribute(name);
  for (const { name, value } of [...nu.attributes]) if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  el.replaceChildren(...nu.childNodes);
}

function defaultMake(html, box) {
  const t = box.ownerDocument.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}
