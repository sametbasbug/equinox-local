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

test("Windows process ownership contracts stay fail-closed until Job Objects exist", () => {
  const background = createBackgroundProcessOwnershipAdapter({ platform: "win32", arch: "x64" });
  const terminal = createTerminalProcessOwnershipAdapter({ platform: "win32", arch: "x64" });
  assert.equal(background.kind, "job-object");
  assert.equal(background.implemented, false);
  assert.equal(background.detached, false);
  assert.equal(terminal.kind, "job-object");
  assert.equal(terminal.implemented, false);
  assert.throws(() => assertProcessOwnershipImplemented(background, "background process execution"), /implemented process-ownership adapter/u);
  assert.throws(() => assertProcessOwnershipImplemented(terminal, "PTY terminal execution"), /implemented process-ownership adapter/u);
});

test("Darwin terminal ownership preserves POSIX-session/TTY cleanup signals", () => {
  const adapter = createTerminalProcessOwnershipAdapter({ platform: "darwin", arch: "x64" });
  assert.equal(adapter.kind, "posix-session-or-tty");
  assert.equal(adapter.implemented, true);
  assert.equal(adapter.requiresVerifiedOwnership, true);
  assert.equal(adapter.gracefulSignal, "SIGHUP");
  assert.equal(adapter.forceSignal, "SIGKILL");
});
