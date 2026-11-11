// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// 🔊 Read aloud (app.js, "read a reply aloud"): how a reply's text splits into the sentences that are read and lit one at
// a time, and which of the system's voices reads them. No DOM here, so both are tested in Node (test-markdown.mjs).

/**
 * The sentences of `text`, each { from, to, text }: from/to are offsets into `text` (the sentence without the spaces
 * around it), for the highlight. Pieces with no letter or digit in them (a lone "—", a list bullet) are left out.
 */
export function sentencePieces(text, lang = 'en') {
  const s = String(text || '');
  let seg = null;
  try { seg = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter(lang || 'en', { granularity: 'sentence' }) : null; } catch { seg = null; }
  const raw = seg ? [...seg.segment(s)].map((x) => ({ i: x.index, s: x.segment })) : [...s.matchAll(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g)].map((x) => ({ i: x.index, s: x[0] }));
  const out = [];
  for (const { i, s: piece } of raw) {
    const words = piece.trim();
    if (!/[\p{L}\p{N}]/u.test(words)) continue;
    const from = i + (piece.length - piece.trimStart().length);
    out.push({ from, to: from + words.length, text: words });
  }
  return out;
}

/**
 * The voice to read with, from speechSynthesis.getVoices(): a voice on this computer (Windows' own voices are) in the
 * language asked for, the default one first; then one in the same language family; then the system default; else null
 * (the browser picks). A voice that would send the text to a server is only used when nothing local fits.
 */
export function pickVoice(voices = [], lang = 'en-US') {
  const want = String(lang || 'en').toLowerCase().replace('_', '-'), base = want.split('-')[0];
  const fit = (v) => String(v?.lang || '').toLowerCase().replace('_', '-');
  const local = voices.filter((v) => v && v.localService !== false);
  return local.find((v) => fit(v) === want && v.default) || local.find((v) => fit(v) === want) || local.find((v) => fit(v).split('-')[0] === base)
    || local.find((v) => v.default) || voices.find((v) => v?.default) || null;
}
