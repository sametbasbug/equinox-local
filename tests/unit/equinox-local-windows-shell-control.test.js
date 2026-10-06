import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  EQUINOX_LOCAL_WINDOWS_SHELL_PIPE,
  requestWindowsShellMainUpdateHandoff,
  requestWindowsShellManagedActivation,
  requestWindowsShellManagedUninstall,
  requestWindowsShellRuntimeRestart,
  requestWindowsShellUpdateShutdown,
} from "../../src/equinox-local-windows-shell-control.js";

async function captureTimeouts(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const delays = [];
  globalThis.setTimeout = (_callback, delay) => {
    delays.push(delay);
    return { delay };
  };
  globalThis.clearTimeout = () => {};
  try {
    await run();
    return delays;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

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

test("one-way Windows shell requests retain the 3-second default and timeout bounds", async () => {
  const delays = await captureTimeouts(async () => {
    for (const [request, command] of [
      [requestWindowsShellRuntimeRestart, "restart-runtime\n"],
      [requestWindowsShellUpdateShutdown, "shutdown-for-update\n"],
    ]) {
      let written = null;
      const socket = new EventEmitter();
      socket.end = (value, callback) => { written = value; queueMicrotask(callback); };
      const result = await request({
        platform: "win32",
        connectImpl: () => { queueMicrotask(() => socket.emit("connect")); return socket; },
      });
      assert.deepEqual(result, { requested: true });
      assert.equal(written, command);
    }
  });
  assert.deepEqual(delays, [3_000, 3_000]);
  await assert.rejects(requestWindowsShellRuntimeRestart({ platform: "win32", timeoutMs: 249 }), /out of bounds/u);
  await assert.rejects(requestWindowsShellUpdateShutdown({ platform: "win32", timeoutMs: 15_001 }), /out of bounds/u);
});


test("Windows update helper can request bounded shell shutdown through the same current-user pipe", async () => {
  let options = null;
  let written = null;
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.end = (value, callback) => {
    written = value;
    queueMicrotask(callback);
  };
  const result = await requestWindowsShellUpdateShutdown({
    platform: "win32",
    connectImpl: (value) => {
      options = value;
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  assert.equal(result.requested, true);
  assert.deepEqual(options, { path: EQUINOX_LOCAL_WINDOWS_SHELL_PIPE });
  assert.equal(written, "shutdown-for-update\n");
});

test("Windows update shutdown signaling fails closed off Windows", async () => {
  await assert.rejects(
    requestWindowsShellUpdateShutdown({ platform: "darwin" }),
    /only on Windows/u,
  );
});


test("Windows Main update handoff is acknowledged and carries only the exact transaction id", async () => {
  const transactionId = "main-" + "a".repeat(32);
  let written = null;
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.setEncoding = () => {};
  socket.write = (value) => {
    written = value;
    queueMicrotask(() => socket.emit("data", "ok\n"));
    return true;
  };
  const result = await requestWindowsShellMainUpdateHandoff(transactionId, {
    platform: "win32",
    connectImpl: () => {
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  });
  assert.deepEqual(result, { requested: true, transactionId });
  assert.equal(written, "main-update:" + transactionId + "\n");
  assert.equal(written.includes("\\"), false);
  assert.equal(written.includes("/"), false);
});

test("Windows Main update handoff rejects malformed identity and bounded shell refusal", async () => {
  await assert.rejects(
    requestWindowsShellMainUpdateHandoff("main-bad", { platform: "win32" }),
    /exact transaction id/u,
  );
  await assert.rejects(
    requestWindowsShellMainUpdateHandoff("main-" + "a".repeat(32), { platform: "darwin" }),
    /only on Windows/u,
  );

  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.setEncoding = () => {};
  socket.write = () => {
    queueMicrotask(() => socket.emit("data", "error:receipt identity mismatch\n"));
    return true;
  };
  await assert.rejects(
    requestWindowsShellMainUpdateHandoff("main-" + "a".repeat(32), {
      platform: "win32",
      connectImpl: () => {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    }),
    /receipt identity mismatch/u,
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

test("acknowledged Windows requests retain the 5-second default and acknowledgements", async () => {
  const delays = await captureTimeouts(async () => {
    const makeAckSocket = (expectedCommand) => {
      const socket = new EventEmitter();
      socket.destroy = () => {};
      socket.setEncoding = () => {};
      socket.write = (command) => {
        assert.equal(command, expectedCommand);
        queueMicrotask(() => socket.emit("data", `ok${String.fromCharCode(10)}`));
        return true;
      };
      return socket;
    };
    const connectTo = (socket) => () => {
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    };

    const activationSocket = makeAckSocket(`activate-release:5.3.0${String.fromCharCode(10)}`);
    assert.deepEqual(await requestWindowsShellManagedActivation("5.3.0", {
      platform: "win32",
      connectImpl: connectTo(activationSocket),
    }), { requested: true, version: "5.3.0" });

    const uninstallSocket = makeAckSocket(`uninstall:remove-user-data${String.fromCharCode(10)}`);
    assert.deepEqual(await requestWindowsShellManagedUninstall(true, {
      platform: "win32",
      connectImpl: connectTo(uninstallSocket),
    }), { requested: true, removeUserData: true });
  });
  assert.deepEqual(delays, [5_000, 5_000]);
});

test("acknowledged Windows requests retain bounded replies and refusal text", async () => {
  const makeAckSocket = (reply) => {
    const socket = new EventEmitter();
    socket.destroy = () => {};
    socket.setEncoding = () => {};
    socket.write = () => { queueMicrotask(() => socket.emit("data", reply)); return true; };
    return socket;
  };
  const connectTo = (socket) => () => {
    queueMicrotask(() => socket.emit("connect"));
    return socket;
  };

  const oversized = makeAckSocket("x".repeat(513));
  await assert.rejects(requestWindowsShellManagedActivation("5.3.0", {
    platform: "win32",
    connectImpl: connectTo(oversized),
  }), /reply exceeded the bound/u);

  const refusal = makeAckSocket(`error:${"x".repeat(400)}\n`);
  await assert.rejects(requestWindowsShellManagedActivation("5.3.0", {
    platform: "win32",
    connectImpl: connectTo(refusal),
  }), (error) => {
    assert.equal(error.message.length, "Equinox Local Windows activation handoff was refused: ".length + 300);
    return true;
  });

  const invalid = makeAckSocket("nope\n");
  await assert.rejects(requestWindowsShellManagedActivation("5.3.0", {
    platform: "win32",
    connectImpl: connectTo(invalid),
  }), /returned an invalid reply/u);
});

async function withManualTimeout(run) {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  let timer = null;
  const cleared = [];
  globalThis.setTimeout = (callback, delay) => {
    assert.equal(timer, null, "the request schedules exactly one timeout");
    timer = { callback, delay };
    return timer;
  };
  globalThis.clearTimeout = (handle) => cleared.push(handle);
  try {
    await run(() => timer, cleared);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

test("one-way Windows shell timeouts destroy the socket and ignore late write completion", async () => {
  for (const request of [requestWindowsShellRuntimeRestart, requestWindowsShellUpdateShutdown]) {
    await withManualTimeout(async (getTimer, cleared) => {
      const socket = new EventEmitter();
      let destroyed = 0;
      let lateCompletion = null;
      socket.destroy = () => { destroyed += 1; };
      socket.end = (_command, callback) => { lateCompletion = callback; };
      const pending = request({ platform: "win32", connectImpl: () => socket });
      const rejected = assert.rejects(pending, /did not accept.*in time/u);
      socket.emit("connect");
      assert.equal(typeof lateCompletion, "function");
      assert.equal(getTimer().delay, 3_000);
      getTimer().callback();
      await rejected;
      assert.equal(destroyed, 1);
      assert.deepEqual(cleared, [getTimer()]);
      assert.equal(socket.listenerCount("connect"), 0);
      assert.equal(socket.listenerCount("error"), 0);
      lateCompletion();
      socket.emit("connect");
      assert.equal(destroyed, 1, "late events do not settle or destroy a second time");
    });
  }
});

test("acknowledged Windows shell timeouts destroy the socket and retire late replies", async () => {
  for (const request of [
    (options) => requestWindowsShellManagedActivation("5.3.0", options),
    (options) => requestWindowsShellManagedUninstall(false, options),
  ]) {
    await withManualTimeout(async (getTimer, cleared) => {
      const socket = new EventEmitter();
      let destroyed = 0;
      let writes = 0;
      socket.destroy = () => { destroyed += 1; };
      socket.setEncoding = () => {};
      socket.write = () => { writes += 1; return true; };
      const pending = request({ platform: "win32", connectImpl: () => socket });
      const rejected = assert.rejects(pending, /did not acknowledge.*in time/u);
      socket.emit("connect");
      assert.equal(writes, 1);
      assert.equal(getTimer().delay, 5_000);
      getTimer().callback();
      await rejected;
      assert.equal(destroyed, 1);
      assert.deepEqual(cleared, [getTimer()]);
      assert.deepEqual(socket.eventNames(), []);
      socket.emit("data", "ok\n");
      socket.emit("connect");
      assert.equal(writes, 1);
      assert.equal(destroyed, 1);
    });
  }
});

test("Windows managed uninstall handoff is acknowledged with an exact data policy", async () => {
  let written = null;
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.setEncoding = () => {};
  socket.write = (value) => { written = value; queueMicrotask(() => socket.emit("data", "ok\n")); return true; };
  const result = await requestWindowsShellManagedUninstall(true, {
    platform: "win32",
    connectImpl: () => { queueMicrotask(() => socket.emit("connect")); return socket; },
  });
  assert.deepEqual(result, { requested: true, removeUserData: true });
  assert.equal(written, "uninstall:remove-user-data\n");
  await assert.rejects(requestWindowsShellManagedUninstall(true, { platform: "darwin" }), /only on Windows/u);
  await assert.rejects(requestWindowsShellManagedUninstall("yes", { platform: "win32" }), /explicit data policy/u);
});
