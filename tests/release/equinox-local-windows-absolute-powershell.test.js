import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {equinoxLocalWindowsPowerShellPath,equinoxLocalFiniteShell,equinoxLocalInteractiveShells} from '../../src/equinox-local-platform.js';
import {createBackgroundProcessOwnershipAdapter,createTerminalProcessOwnershipAdapter} from '../../src/equinox-local-process-ownership.js';

const expected=path.win32.join('D:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const env={SystemRoot:'D:\\Windows',PATH:''};
test('Windows trusted PowerShell resolution never depends on ambient PATH',()=>{
 assert.equal(equinoxLocalWindowsPowerShellPath(env),expected);
 assert.equal(equinoxLocalFiniteShell({platform:'win32',arch:'x64',env}).command,expected);
 assert.equal(equinoxLocalInteractiveShells({platform:'win32',arch:'x64',env}).shells.powershell.command,expected);
});
test('Windows background Job Object gate and PTY gate use the exact OS-owned executable',()=>{
 const background=createBackgroundProcessOwnershipAdapter({platform:'win32',arch:'arm64'});
 const terminal=createTerminalProcessOwnershipAdapter({platform:'win32',arch:'x64'});
 const bg=background.spawnSpec('node.exe',[],env);
 const pty=terminal.spawnSpec(expected,[],env);
 assert.equal(bg.command,expected);
 assert.equal(pty.command,expected);
 assert.deepEqual(bg.args.slice(0,5), ['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden']);
 assert.deepEqual(pty.args.slice(0,5), ['-NoLogo','-NoProfile','-NoExit','-WindowStyle','Hidden']);
 assert.ok(!pty.args.includes('-NonInteractive'), 'PTY gate must remain interactive after the release handshake');
});
test('Windows system root must be absolute and must not be resolved through untrusted PATH',()=>{
 for(const value of ['Windows','../Windows','powershell.exe']){
  assert.throws(()=>equinoxLocalWindowsPowerShellPath({SystemRoot:value,PATH:'C:\\Foreign'}),/absolute SystemRoot/u);
 }
});
