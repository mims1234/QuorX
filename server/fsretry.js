// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// On Windows a rename can fail for a moment while another program has the file open (antivirus, the search indexer,
// a backup tool, a test reading it): EPERM, EBUSY or EACCES. Saves that write a temp file and rename it over the
// real one try the rename again a few times, about half a second in all, before giving up.
import fs from 'node:fs';

const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function renameSoon(from, to) {
  for (let i = 0; ; i++) {
    try { return fs.renameSync(from, to); } catch (e) {
      if (!BUSY.has(e.code) || i >= 8) throw e;
      pause(20 + i * 10);
    }
  }
}
