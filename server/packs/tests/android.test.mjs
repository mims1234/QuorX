// Android pack self-test: adb answers, and QuorX lists the devices it can use (emulators unless phones are allowed).
import { skipUnless } from './_kit.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { devices } from '../../android.js';

test('android: adb lists devices', async (t) => {
  const skip = await skipUnless('adb'); if (skip) return t.skip(skip);
  const list = await devices();
  assert.ok(Array.isArray(list), 'a device list came back (it may be empty)');
  for (const d of list) assert.ok(d.serial, 'each device has a serial');
});
