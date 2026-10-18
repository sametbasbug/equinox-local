import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { createWindowsJobObjectLease } from "../../src/equinox-local-windows-job-object.js";

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
