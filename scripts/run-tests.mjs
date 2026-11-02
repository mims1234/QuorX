// Copyright 2026 The QuorX authors. SPDX-License-Identifier: Apache-2.0
// npm test starts the test runner through here. On Windows, node --test runs each test file in a node process of its
// own; when the tests start without a console (from an app, an editor or a background task) each of those, and each
// program a test starts, opens a terminal window. The runner here gets a hidden console instead, which everything
// under it shares. Elsewhere this only passes the arguments on.
import { spawnSync } from 'node:child_process';

const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
process.exit(r.status ?? 1);
