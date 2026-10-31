// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// The tests that open windows and send keystrokes (npm test skips them on a PC, so it doesn't take the screen and the
// keyboard): run them on their own, when a change touches the desktop tool. Leave the mouse and keyboard alone while
// they run; a key pressed meanwhile can land in their windows. CI runs them with every push.
import { spawnSync } from 'node:child_process';

const r = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-name-pattern=^(desktop|stop: a window)', 'scripts/test-computer.mjs'], {
  stdio: 'inherit', env: { ...process.env, QX_DESKTOP_TESTS: '1' },
});
process.exit(r.status ?? 1);
