// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The worker behind snapshotAsync/changesSinceAsync/pruneObjectsAsync (snapshot.js): it runs the same functions the
// sync path runs, off the main thread, so a walk of a big project never freezes streams, Stop or approvals.
import { parentPort } from 'node:worker_threads';
import { snapshot, changesSince, pruneObjects } from './snapshot.js';

const OPS = { snapshot, changesSince, pruneObjects };
parentPort.on('message', ({ id, op, args }) => {
  try { parentPort.postMessage({ id, ok: true, value: OPS[op](...args) }); }
  catch (e) { parentPort.postMessage({ id, ok: false, error: e?.message || String(e) }); }
});
