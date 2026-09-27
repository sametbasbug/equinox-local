import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  EQUINOX_LOCAL_WINDOWS_SHELL_PIPE,
  requestWindowsShellRuntimeRestart,
} from "../../src/equinox-local-windows-shell-control.js";

test("Windows update helper signals the current-user shell restart pipe without spawning commands", async () => {
  let options = null;
  let written = null;
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.end = (value, callback) => {
    written = value;
    queueMicrotask(callback);
  };
  const result = await requestWindowsShellRuntimeRestart({
    platform: "win32",
    connectImpl: (value) => {
      options = value;
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  assert.equal(result.requested, true);
  assert.deepEqual(options, { path: EQUINOX_LOCAL_WINDOWS_SHELL_PIPE });
  assert.equal(written, "restart-runtime\n");
});

test("Windows shell restart signaling fails closed off Windows", async () => {
  await assert.rejects(
    requestWindowsShellRuntimeRestart({ platform: "darwin" }),
    /only on Windows/u,
  );
});
