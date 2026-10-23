import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createWindowsJobObjectLease, resolveWindowsNativeOwnedProcessGatePath } from "../../src/equinox-local-windows-job-object.js";
import { createBackgroundProcessOwnershipAdapter } from "../../src/equinox-local-process-ownership.js";

test("Windows Job Object lease launches the product-owned native helper directly", async () => {
  const expected = "C:\\Equinox\\runtime\\job\\equinox-local-job-object-helper.exe";
  let observed = null;
  await assert.rejects(
    createWindowsJobObjectLease({
      platform: "win32",
      helperPath: expected,
      spawnImpl(command, args, options) {
        observed = { command, args, options };
        throw new Error("spawn sentinel");
      },
    }),
    /spawn sentinel/u,
  );
  assert.equal(observed.command, expected);
  assert.deepEqual(observed.args, []);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsHide, true);
});

test("Windows Job Object lease resolves an explicit product helper override at call time", async () => {
  const previous = process.env.EQUINOX_WINDOWS_JOB_OBJECT_HELPER_PATH;
  process.env.EQUINOX_WINDOWS_JOB_OBJECT_HELPER_PATH = "C:\\Owned\\job-helper.exe";
  let command = null;
  try {
    await assert.rejects(createWindowsJobObjectLease({
      platform: "win32",
      spawnImpl(value) { command = value; throw new Error("spawn sentinel"); },
    }), /spawn sentinel/u);
    assert.equal(command, "C:\\Owned\\job-helper.exe");
  } finally {
    if (previous === undefined) delete process.env.EQUINOX_WINDOWS_JOB_OBJECT_HELPER_PATH;
    else process.env.EQUINOX_WINDOWS_JOB_OBJECT_HELPER_PATH = previous;
  }
});


test("Windows Job Object transport owns stdin pipe failures instead of emitting an unhandled error", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../../src/equinox-local-windows-job-object.js", import.meta.url), "utf8"));
  assert.match(source, /child\.stdin\?\.on\("error"/u);
  assert.match(source, /Windows Job Object helper input failed/u);
  assert.match(source, /const failInput =/u);
  assert.match(source, /child\.stdin\.write[\s\S]*failInput\(error\)/u);
  assert.match(source, /failAll/u);
});


function makeJobHelperFixture() {
  const child = new EventEmitter();
  child.pid = 42421;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let onRequest = null;
  child.stdin.on("data", (data) => {
    for (const raw of String(data).trim().split("\n")) {
      if (raw) onRequest?.(JSON.parse(raw));
    }
  });
  queueMicrotask(() => child.stdout.write('{"ready":true,"ok":true}\n'));
  return {
    child,
    spawnImpl(_command, _args, options) {
      assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
      return child;
    },
    onRequest(handler) { onRequest = handler; },
  };
}

test("Windows Job Object expected exit before final close acknowledgment is not misreported", async () => {
  const fixture = makeJobHelperFixture();
  const lease = await createWindowsJobObjectLease({
    platform: "win32", helperPath: "C:\\Owned\\job-helper.exe", spawnImpl: fixture.spawnImpl,
  });
  fixture.onRequest(({ op, id }) => {
    assert.equal(op, "close");
    fixture.child.emit("exit", 0, null);
    fixture.child.stdout.write(JSON.stringify({ id, ok: true, closed: true }) + "\n");
    fixture.child.emit("close", 0, null);
  });
  await lease.close();
});

test("Windows Job Object clean helper exit without close acknowledgment fails closed", async () => {
  const fixture = makeJobHelperFixture();
  const lease = await createWindowsJobObjectLease({
    platform: "win32", helperPath: "C:\\Owned\\job-helper.exe", spawnImpl: fixture.spawnImpl,
  });
  fixture.onRequest(({ op }) => {
    assert.equal(op, "close");
    fixture.child.emit("exit", 0, null);
    fixture.child.emit("close", 0, null);
  });
  await assert.rejects(lease.close(), /closed before acknowledging its request/u);
});

test("Windows Job Object unexpected helper exit rejects outstanding status requests", async () => {
  const fixture = makeJobHelperFixture();
  const lease = await createWindowsJobObjectLease({
    platform: "win32", helperPath: "C:\\Owned\\job-helper.exe", spawnImpl: fixture.spawnImpl,
  });
  fixture.onRequest(({ op }) => {
    assert.equal(op, "status");
    fixture.child.emit("exit", 9, null);
  });
  await assert.rejects(lease.status(), /exited unexpectedly/u);
});


test("Windows native owned-process gate activates only alongside the matching package marker", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-owned-native-gate-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const helper = path.join(directory, "equinox-local-job-object-helper.exe");
  const marker = path.join(directory, "owned-process-gate-v1.marker");
  await fs.writeFile(helper, "test fixture -- no executable is launched");
  const before = process.env.EQUINOX_WINDOWS_JOB_OBJECT_HELPER_PATH;
  process.env.EQUINOX_WINDOWS_JOB_OBJECT_HELPER_PATH = helper;
  try {
    const adapter = createBackgroundProcessOwnershipAdapter({ platform: "win32", arch: "x64" });
    assert.equal(resolveWindowsNativeOwnedProcessGatePath(), null,
      "existing native helpers without ABI markers must use the legacy gate");
    const legacy = adapter.spawnSpec("C:\\Windows\\System32\\whoami.exe", [], { SystemRoot: "C:\\Windows" });
    assert.match(legacy.command, /powershell\.exe$/iu, "old package must still select Windows PowerShell gate");
    await fs.writeFile(marker, "equinox-owned-process-gate-v1\n");
    assert.equal(resolveWindowsNativeOwnedProcessGatePath(), helper);
    const current = adapter.spawnSpec("C:\\Windows\\System32\\whoami.exe", ["--help"], { SystemRoot: "C:\\Windows" });
    assert.equal(current.command, helper);
    assert.deepEqual([...current.args], [
      "--owned-process-gate", "C:\\Windows\\System32\\whoami.exe", "--help",
    ]);
    assert.equal(current.stdin, "pipe");
    assert.equal(current.env.SystemRoot, "C:\\Windows");
    await fs.rm(marker);
    assert.match(adapter.spawnSpec("whoami.exe", [], { SystemRoot: "C:\\Windows" }).command,
      /powershell\.exe$/iu, "marker removal must restore safe legacy fallback");
  } finally {
    if (before === undefined) delete process.env.EQUINOX_WINDOWS_JOB_OBJECT_HELPER_PATH;
    else process.env.EQUINOX_WINDOWS_JOB_OBJECT_HELPER_PATH = before;
  }
});

test("Windows Job Object rejects unsupported hosts and out-of-range timeouts before helper launch", async () => {
  let launches = 0;
  const spawnImpl = () => { launches++; throw new Error("unexpected helper launch"); };
  for (const options of [
    { platform: "darwin", timeoutMs: 100 },
    { platform: "win32", timeoutMs: 0 },
    { platform: "win32", timeoutMs: 99 },
    { platform: "win32", timeoutMs: 30001 },
    { platform: "win32", timeoutMs: 10.5 },
    { platform: "win32", timeoutMs: "5000" },
  ]) {
    await assert.rejects(createWindowsJobObjectLease({ ...options, spawnImpl }), /only on win32|timeout is invalid/u);
  }
  assert.equal(launches, 0);
});

test("Windows Job Object isolates concurrent request IDs and ignores malformed or unrelated helper replies", async () => {
  const fixture = makeJobHelperFixture();
  const lease = await createWindowsJobObjectLease({
    platform: "win32", helperPath: "C:\\Owned\\job-helper.exe", spawnImpl: fixture.spawnImpl,
  });
  assert.equal(lease.kind, "job-object");
  assert.equal(lease.helperPid, 42421);
  const pending = [];
  fixture.onRequest((message) => {
    pending.push(message);
    if (pending.length < 2) return;
    fixture.child.stdout.write('not-json\n');
    fixture.child.stdout.write('{"id":"not-our-request","ok":true}\n');
    // Explicitly return replies in reverse order, never matching the wrong request.
    const [assign, status] = pending;
    assert.equal(assign.op, "assign");
    assert.equal(status.op, "status");
    assert.equal(assign.pid, 421);
    fixture.child.stdout.write(JSON.stringify({ id: status.id, ok: true, activeProcesses: 2 }) + "\n");
    fixture.child.stdout.write(JSON.stringify({ id: assign.id, ok: true, assigned: true }) + "\n");
  });
  const [assigned, status] = await Promise.all([lease.assign(421), lease.status()]);
  assert.equal(assigned.assigned, true);
  assert.equal(status.activeProcesses, 2);
  assert.equal(pending.length, 2);
});

test("Windows Job Object propagates bounded helper failures, refuses invalid PID and exit codes without IPC", async () => {
  const fixture = makeJobHelperFixture();
  const lease = await createWindowsJobObjectLease({
    platform: "win32", helperPath: "C:\\Owned\\job-helper.exe", spawnImpl: fixture.spawnImpl,
  });
  const requests = [];
  fixture.onRequest((message) => {
    requests.push(message);
    fixture.child.stdout.write(JSON.stringify({ id: message.id, ok: false, error: "helper refused operation" }) + "\n");
  });
  for (const pid of [0, -1, 1.5, "777", undefined]) {
    await assert.rejects(lease.assign(pid), /positive PID/u);
  }
  for (const exitCode of [-1, 0x1_0000_0000, 1.5, "9"]) {
    await assert.rejects(lease.terminate(exitCode), /exit code is invalid/u);
  }
  assert.deepEqual(requests, []);
  await assert.rejects(lease.assign(123), /helper refused operation/u);
  await assert.rejects(lease.terminate(137), /helper refused operation/u);
  assert.deepEqual(requests.map(({ op }) => op), ["assign", "terminate"]);
  assert.deepEqual([requests[0].pid, requests[1].exitCode], [123, 137]);
});

test("Windows Job Object input stream errors reject pending requests and subsequent operations fail closed", async () => {
  const fixture = makeJobHelperFixture();
  const lease = await createWindowsJobObjectLease({
    platform: "win32", helperPath: "C:\\Owned\\job-helper.exe", spawnImpl: fixture.spawnImpl,
  });
  let requests = 0;
  fixture.onRequest(() => {
    requests++;
    fixture.child.stdin.emit("error", new Error("owned pipe broken"));
  });
  await assert.rejects(lease.status(), /helper input failed: owned pipe broken/u);
  await assert.rejects(lease.status(), /helper is not available/u);
  assert.equal(requests, 1, "failed delivery must not be retried");
});
