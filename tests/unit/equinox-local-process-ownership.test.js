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

test("Windows background and PTY ownership use Job Object adapters", () => {
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
  const ptySpec = terminal.spawnSpec("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", ["-NoLogo", "-NoProfile"], { SystemRoot: "C:\\Windows" });
  assert.ok(ptySpec.args.includes("-NoExit"), "PTY gate must stay in the same interactive PowerShell");
  assert.ok(ptySpec.args.includes("-WindowStyle"), "PTY gate must not spawn visible windows");
  assert.ok(ptySpec.args.includes("Hidden"));
  assert.ok(!ptySpec.args.includes("-NonInteractive"));
  assert.equal(ptySpec.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  const requestedPwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  const pwshSpec = terminal.spawnSpec(requestedPwsh, ["-NoLogo", "-NoProfile"], { SystemRoot: "C:\\Windows" });
  assert.equal(pwshSpec.command, requestedPwsh, "interactive PowerShell 7 selection must not silently launch PowerShell 5.1");
  assert.deepEqual(pwshSpec.args, ptySpec.args, "selected shell version preserves the hidden owned ConPTY gate");
  assert.equal(terminal.spawnSpec("powershell.exe", ["-NoLogo"], { SystemRoot: "C:\\Windows" }).command, ptySpec.command);
  assert.throws(() => terminal.spawnSpec("cmd.exe", [], { SystemRoot: "C:\\Windows" }), /absolute PowerShell/u);
  assert.throws(() => terminal.spawnSpec("C:\\Windows\\System32\\cmd.exe", [], { SystemRoot: "C:\\Windows" }), /absolute PowerShell/u);
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

test("Windows background ownership refuses an absent or invalid PID before assigning or releasing the process", async () => {
  const adapter = createBackgroundProcessOwnershipAdapter({ platform: "win32", arch: "x64" });
  const calls = [];
  const lease = {
    assign: async (pid) => calls.push(["assign", pid]),
  };
  const child = {
    pid: 100,
    stdin: {
      write: (value, callback) => { calls.push(["write", value]); callback(null); },
      end: () => { calls.push(["end"]); },
    },
  };
  for (const invalid of [undefined, null, 0, -3, 1.1, "123"]) {
    await assert.rejects(adapter.attachAndRelease(lease, { ...child, pid: invalid }), /could not be attached before gate release/u);
  }
  await assert.rejects(adapter.attachAndRelease(null, child), /could not be attached/u);
  assert.deepEqual(calls, []);
  await adapter.attachAndRelease(lease, child);
  assert.deepEqual(calls, [["assign", 100], ["write", "EQUINOX_GO\n"], ["end"]]);
});

test("Windows background ownership never releases a gate after failed Job Object assignment or failed stdin write", async () => {
  const adapter = createBackgroundProcessOwnershipAdapter({ platform: "win32", arch: "arm64" });
  const calls = [];
  const child = {
    pid: 141,
    stdin: {
      write: (value, callback) => { calls.push(["write", value]); callback(new Error("gate write refused")); },
      end: () => calls.push(["end"]),
    },
  };
  const rejectedLease = { assign: async (pid) => { calls.push(["assign-refused", pid]); throw new Error("assign refused"); } };
  await assert.rejects(adapter.attachAndRelease(rejectedLease, child), /assign refused/u);
  assert.deepEqual(calls, [["assign-refused", 141]]);
  const acceptedLease = { assign: async (pid) => calls.push(["assign", pid]) };
  await assert.rejects(adapter.attachAndRelease(acceptedLease, child), /gate write refused/u);
  assert.deepEqual(calls, [["assign-refused", 141], ["assign", 141], ["write", "EQUINOX_GO\n"]]);
});

test("Windows owned sets refuse unowned signal operations and retain graceful/forced exit codes", async () => {
  const adapters = [
    createBackgroundProcessOwnershipAdapter({ platform: "win32", arch: "x64" }),
    createTerminalProcessOwnershipAdapter({ platform: "win32", arch: "arm64" }),
  ];
  for (const adapter of adapters) {
    await assert.rejects(adapter.signalOwnedSet(null, "SIGTERM"), /ownership handle is missing/u);
    const codes = [];
    const lease = {
      status: async () => ({ activeProcesses: 2 }),
      terminate: async (code) => codes.push(code),
      close: async () => codes.push("closed"),
    };
    assert.equal(await adapter.ownedSetExists(null), false);
    assert.equal(await adapter.ownedSetExists(lease), true);
    await adapter.signalOwnedSet(lease, "SIGTERM");
    await adapter.signalOwnedSet(lease, "SIGKILL");
    await adapter.closeOwnedSet(lease);
    await adapter.closeOwnedSet(null);
    assert.deepEqual(codes, [143, 137, "closed"]);
  }
});

test("Windows interactive terminal gate rejects arbitrary shell paths and assigns verified PID before writing release", async () => {
  const adapter = createTerminalProcessOwnershipAdapter({ platform: "win32", arch: "x64" });
  for (const shell of ["cmd.exe", "C:\\Windows\\System32\\cmd.exe", "/bin/zsh", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\not-powershell.exe"]) {
    assert.throws(() => adapter.spawnSpec(shell, ["-NoProfile"], { SystemRoot: "C:\\Windows" }), /absolute PowerShell executable/u);
  }
  const calls = [];
  const ownedSet = { assign: async (pid) => calls.push(["assign", pid]) };
  const terminal = {
    pid: 942,
    write: (value) => calls.push(["write", value]),
  };
  await assert.rejects(adapter.attachAndRelease(null, terminal), /before gate release/u);
  await assert.rejects(adapter.attachAndRelease(ownedSet, null), /before gate release/u);
  assert.deepEqual(calls, []);
  assert.equal(await adapter.attachAndRelease(ownedSet, terminal), 942);
  assert.deepEqual(calls, [["assign", 942], ["write", "EQUINOX_GO\r"]]);
  calls.length = 0;
  const rejected = { assign: async (pid) => { calls.push(["assign-denied", pid]); throw new Error("assignment refused"); } };
  await assert.rejects(adapter.attachAndRelease(rejected, terminal), /assignment refused/u);
  assert.deepEqual(calls, [["assign-denied", 942]]);
});

test("Darwin and Windows reject unsupported host targets and do not claim absent process ownership", () => {
  for (const options of [{ platform: "linux", arch: "x64" }, { platform: "win32", arch: "unsupported" }, { platform: "darwin", arch: "mips" }]) {
    assert.throws(() => createBackgroundProcessOwnershipAdapter(options), /Unsupported Equinox Local release target/u);
    assert.throws(() => createTerminalProcessOwnershipAdapter(options), /Unsupported Equinox Local release target/u);
  }
  for (const adapter of [null, undefined, {}, { kind: "job-object", implemented: false }]) {
    assert.throws(() => assertProcessOwnershipImplemented(adapter, "background process execution"),
      (error) => error?.code === "EQUINOX_PROCESS_OWNERSHIP_UNIMPLEMENTED");
  }
});
