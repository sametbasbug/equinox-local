import assert from 'node:assert/strict';
import test from 'node:test';

import { runEquinoxLocalWindowsGuardianOwnedSlot } from '../../src/equinox-local-windows-native-ab-owner-client.js';

test('native Guardian A/B slot worker cannot operate on another platform or with foreign transaction identifiers', async () => {
  await assert.rejects(runEquinoxLocalWindowsGuardianOwnedSlot({
    platform: 'darwin', transactionId: `main-${'3'.repeat(32)}`,
    transactionRoot: '/tmp/foreign', workerToken: 'e'.repeat(64),
  }), /requires exact native transaction/u);
  await assert.rejects(runEquinoxLocalWindowsGuardianOwnedSlot({
    platform: 'win32', transactionId: 'main-invalid',
    transactionRoot: 'C:\\Users\\test\\AppData\\Local\\Equinox Local\\state\\main-update',
    workerToken: 'e'.repeat(64), env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
  }), /requires exact native transaction/u);
  await assert.rejects(runEquinoxLocalWindowsGuardianOwnedSlot({
    platform: 'win32', transactionId: `main-${'3'.repeat(32)}`,
    transactionRoot: 'C:\\arbitrary\\main-update',
    workerToken: 'e'.repeat(64), env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
  }), /escapes the current installed profile/u);
});
