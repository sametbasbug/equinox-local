import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { startRuntimeLifecycle } from "../../src/equinox-local-runtime-lifecycle.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for lifecycle state.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("runtime lifecycle connects once and shuts down once on stdin end", async () => {
  const stdin = new EventEmitter();
  const processLike = new EventEmitter();
  let connectCount = 0;
  let shutdownCount = 0;
  let exitCount = 0;
  const reasons = [];

  await startRuntimeLifecycle({
    stdin,
    processLike,
    connect: async () => {
      connectCount += 1;
    },
    shutdown: async ({ reason }) => {
      reasons.push(reason);
      shutdownCount += 1;
    },
    exit: () => {
      exitCount += 1;
    },
  });

  assert.equal(connectCount, 1);
  stdin.emit("end");
  await waitFor(() => shutdownCount === 1);
  assert.equal(exitCount, 0);
  assert.deepEqual(reasons, ["stdin_end"]);
  assert.equal(stdin.listenerCount("end"), 0);
  assert.equal(processLike.listenerCount("SIGINT"), 0);
  assert.equal(processLike.listenerCount("SIGTERM"), 0);
  assert.equal(processLike.listenerCount("SIGHUP"), 0);
});

test("runtime lifecycle waits for shutdown before signal exit and deduplicates shutdown", async () => {
  const stdin = new EventEmitter();
  const processLike = new EventEmitter();
  const shutdownGate = deferred();
  const exited = deferred();
  let shutdownCount = 0;
  const exits = [];
  const reasons = [];

  const lifecycle = await startRuntimeLifecycle({
    stdin,
    processLike,
    connect: async () => {},
    shutdown: async ({ reason }) => {
      reasons.push(reason);
      shutdownCount += 1;
      await shutdownGate.promise;
    },
    exit: (code) => {
      exits.push(code);
      exited.resolve();
    },
  });

  processLike.emit("SIGTERM");
  await waitFor(() => shutdownCount === 1);
  const manualShutdown = lifecycle.shutdown();
  assert.equal(shutdownCount, 1);
  assert.deepEqual(exits, []);

  shutdownGate.resolve();
  await Promise.all([manualShutdown, exited.promise]);
  assert.equal(shutdownCount, 1);
  assert.deepEqual(exits, [0]);
  assert.deepEqual(reasons, ["SIGTERM"]);
});

test("runtime lifecycle detaches listeners when connect fails", async () => {
  const stdin = new EventEmitter();
  const processLike = new EventEmitter();
  let shutdownCount = 0;

  await assert.rejects(
    () => startRuntimeLifecycle({
      stdin,
      processLike,
      connect: async () => {
        throw new Error("connect failed");
      },
      shutdown: async () => {
        shutdownCount += 1;
      },
      exit: () => {},
    }),
    /connect failed/u,
  );

  assert.equal(shutdownCount, 0);
  assert.equal(stdin.listenerCount("end"), 0);
  assert.equal(processLike.listenerCount("SIGINT"), 0);
  assert.equal(processLike.listenerCount("SIGTERM"), 0);
  assert.equal(processLike.listenerCount("SIGHUP"), 0);
});
