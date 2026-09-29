import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  EQUINOX_LOCAL_WINDOWS_SHELL_PIPE,
  requestWindowsShellManagedActivation,
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


test("Windows managed activation handoff is acknowledged by the current-user shell pipe", async () => {
  let options = null;
  let written = null;
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.setEncoding = () => {};
  socket.write = (value) => {
    written = value;
    queueMicrotask(() => socket.emit("data", "ok\n"));
    return true;
  };
  const result = await requestWindowsShellManagedActivation("5.3.0", {
    platform: "win32",
    connectImpl: (value) => {
      options = value;
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  assert.deepEqual(result, { requested: true, version: "5.3.0" });
  assert.deepEqual(options, { path: EQUINOX_LOCAL_WINDOWS_SHELL_PIPE });
  assert.equal(written, "activate-release:5.3.0\n");
});

test("Windows managed activation handoff rejects shell refusal and malformed versions", async () => {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.setEncoding = () => {};
  socket.write = () => {
    queueMicrotask(() => socket.emit("data", "error:target release missing\n"));
    return true;
  };
  await assert.rejects(
    requestWindowsShellManagedActivation("5.3.0", {
      platform: "win32",
      connectImpl: () => {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    }),
    /target release missing/u,
  );
  await assert.rejects(
    requestWindowsShellManagedActivation("5.3", { platform: "win32" }),
    /exact semantic version/u,
  );
});
