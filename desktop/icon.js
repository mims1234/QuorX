// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The app icon: the QuorX logo, kept as PNGs in assets/ (16, 32, 64 and 256 px, transparent).
// Used for the window, tray and notifications (main.js) and copied to build/icon.png for the installer (make-icon.js).
const fs = require('node:fs');
const path = require('node:path');

const SIZES = [16, 32, 64, 256];
// the smallest drawn size that is at least `size`, so the system only ever scales down
function pngIcon(size = 256) {
  const n = SIZES.find((s) => s >= size) || SIZES[SIZES.length - 1];
  return fs.readFileSync(path.join(__dirname, 'assets', `icon-${n}.png`));
}
module.exports = { pngIcon };
