import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { removeWindowsShellRegistration } from '../../src/equinox-local-uninstall-helper.js';

const windowsShell = new URL('../../native/windows/EquinoxLocal.WindowsShell/', import.meta.url);

test('native Windows shell registers per-user Start Menu and Installed Apps without privilege elevation', async () => {
  const [registration, app, coordinator] = await Promise.all([
    fs.readFile(new URL('WindowsShellRegistration.cs', windowsShell), 'utf8'),
    fs.readFile(new URL('App.xaml.cs', windowsShell), 'utf8'),
    fs.readFile(new URL('SingleInstanceCoordinator.cs', windowsShell), 'utf8'),
  ]);
  assert.match(registration, /Registry\.CurrentUser/u);
  assert.match(registration, /Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Equinox Local/u);
  assert.match(registration, /UninstallString/u);
  assert.match(registration, /--uninstall/u);
  assert.match(registration, /Environment\.SpecialFolder\.Programs/u);
  assert.match(registration, /Equinox Local\.lnk/u);
  assert.match(registration, /EquinoxLocalManagedInstall/u);
  assert.match(registration, /reparse point/u);
  assert.match(app, /WindowsShellRegistration\.EnsureForActiveManagedShell/u);
  assert.match(app, /RequestManagedUninstallAsync/u);
  assert.match(app, /ManagedUninstallHandoff\.Launch\("preserve-user-data"\)/u);
  assert.match(coordinator, /PipeOptions\.CurrentUserOnly/u);
  assert.match(coordinator, /uninstall:preserve-user-data/u);
});

test('uninstaller validates product-owned shell integration and never accepts nonprogram paths', async () => {
  let call;
  await removeWindowsShellRegistration({
    programRoot: 'C:\\Users\\Example\\AppData\\Local\\Programs\\Equinox Local',
    env: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Example' },
    execFileImpl: async (command, args, options) => { call = {command,args,options}; },
  });
  assert.equal(call.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(call.args.includes('-EncodedCommand'));
  assert.match(Buffer.from(call.args.at(-1), 'base64').toString('utf16le'), /EquinoxLocalManagedInstall/u);
  assert.match(Buffer.from(call.args.at(-1), 'base64').toString('utf16le'), /Foreign Windows app uninstall registration/u);
  assert.match(Buffer.from(call.args.at(-1), 'base64').toString('utf16le'), /Start Menu shortcut is foreign/u);
  assert.equal(call.options.env.EQUINOX_LOCAL_EXPECTED_PROGRAM_ROOT, 'C:\\Users\\Example\\AppData\\Local\\Programs\\Equinox Local');
  await assert.rejects(removeWindowsShellRegistration({programRoot:'C:\\Other\\NotOurApp'}), /validated program root/u);
});
