// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The settings a recorded reply runs with, both when it is recorded (record-chat.mjs) and when it is played back
// (test-replay.mjs). The loop takes the same steps only when both use the same settings. Checks that call other
// models (gap check, screenshots, reviewer, deciders) are off: they would need recordings of their own.
export const REPLAY_SETTINGS = Object.freeze({
  approval: 'yolo',
  mediaEnabled: false,
  verify: false,
  review: 'off',
  decide: 'off',
  checks: { gap: false, shots: false, click: false },
  tools: { browser: { on: false } },
  retries: 0,
});
