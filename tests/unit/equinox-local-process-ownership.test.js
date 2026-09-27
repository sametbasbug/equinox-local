import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProcessOwnershipImplemented,
  createBackgroundProcessOwnershipAdapter,
  createTerminalProcessOwnershipAdapter,
} from "../../src/equinox-local-process-ownership.js";

test("Darwin background ownership delegates exact group probe/signal semantics", () => {
  const probes = [];
  const signals = [];
  const adapter = createBackgroundProcessOwnershipAdapter({
    platform: "darwin",
    arch: "arm64",
    groupExists: (pid) => { probes.push(pid); return pid === 42; },
    signalGroup: (pid, signal) => { signals.push([pid, signal]); },
  });
  assert.equal(adapter.kind, "posix-process-group");
  assert.equal(adapter.implemented, true);
  assert.equal(adapter.detached, true);
  assert.equal(adapter.ownedSetExists(42), true);
  adapter.signalOwnedSet(42, "SIGTERM");
  assert.deepEqual(probes, [42]);
  assert.deepEqual(signals, [[42, "SIGTERM"]]);
});

test("Windows background ownership is implemented while PTY ownership remains fail-closed", () => {
  const background = createBackgroundProcessOwnershipAdapter({ platform: "win32", arch: "x64" });
  const terminal = createTerminalProcessOwnershipAdapter({ platform: "win32", arch: "x64" });
  assert.equal(background.kind, "job-object");
  assert.equal(background.implemented, true);
  assert.equal(background.detached, false);
  assert.equal(typeof background.createOwnedSet, "function");
  assert.equal(typeof background.spawnSpec, "function");
  assert.equal(typeof background.attachAndRelease, "function");
  assert.doesNotThrow(() => assertProcessOwnershipImplemented(background, "background process execution"));
  assert.equal(terminal.kind, "job-object");
  assert.equal(terminal.implemented, true);
  assert.equal(typeof terminal.createOwnedSet, "function");
  assert.equal(typeof terminal.spawnSpec, "function");
  assert.equal(typeof terminal.attachAndRelease, "function");
  assert.doesNotThrow(() => assertProcessOwnershipImplemented(terminal, "PTY terminal execution"));
});

test("Darwin terminal ownership preserves POSIX-session/TTY cleanup signals", () => {
  const adapter = createTerminalProcessOwnershipAdapter({ platform: "darwin", arch: "x64" });
  assert.equal(adapter.kind, "posix-session-or-tty");
  assert.equal(adapter.implemented, true);
  assert.equal(adapter.requiresVerifiedOwnership, true);
  assert.equal(adapter.gracefulSignal, "SIGHUP");
  assert.equal(adapter.forceSignal, "SIGKILL");
});
