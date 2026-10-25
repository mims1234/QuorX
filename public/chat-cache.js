// Which opened chats the page can let go of. Every chat you open stays in the page (its messages, steps and
// artifacts) so switching back is instant; past KEEP_OPEN idle ones, the least recently shown go, and opening one
// again loads it from the server as the first time. A chat on screen, or one that is busy (a reply running or
// waiting for you, a save not yet through, attachments for the next message), is never let go of and doesn't count.
export const KEEP_OPEN = 12;

/** chats: [{ id, shownAt, visible, busy }] → the ids to let go of, least recently shown first. */
export function chatsToRelease(chats, keep = KEEP_OPEN) {
  const idle = chats.filter((c) => !c.visible && !c.busy);
  if (idle.length <= keep) return [];
  return idle.map((c, i) => ({ id: c.id, at: c.shownAt || 0, i }))
    .sort((a, b) => a.at - b.at || a.i - b.i) // never shown (loaded for a reply in the background): first
    .slice(0, idle.length - Math.max(0, keep))
    .map((c) => c.id);
}
