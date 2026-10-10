import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
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

test("runtime lifecycle consumes an owned stdin EOF for graceful Windows transport handoff", async () => {
  const stdin = new EventEmitter();
  const processLike = new EventEmitter();
  let resumes = 0;
  let shutsDown = 0;
  stdin.resume = () => { resumes++; };
  let pauses = 0;
  stdin.pause = () => { pauses++; };
  await startRuntimeLifecycle({
    stdin, consumeOwnedStdin: true, processLike, connect: async () => {},
    shutdown: async () => { shutsDown++; },
    exit: () => { throw new Error("Owned stdin shutdown must not hard-exit"); },
  });
  assert.equal(resumes, 1);
  stdin.emit("end");
  await waitFor(() => shutsDown === 1);
  await waitFor(() => pauses === 1);
});

test("real Node managed runtime consumes owned stdin EOF and exits after graceful shutdown", async (t) => {
  const moduleUrl = new URL("../../src/equinox-local-runtime-lifecycle.js", import.meta.url);
  const source = `import { startRuntimeLifecycle } from ${JSON.stringify(moduleUrl.href)}; ` +
    `const interval = setInterval(() => {}, 100); ` +
    `await startRuntimeLifecycle({ consumeOwnedStdin: true, connect: async () => { process.stdout.write("READY\\n"); }, ` +
    `shutdown: async () => { clearInterval(interval); process.stdout.write("STOPPED\\n"); } });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (!child.killed) child.kill(); });
  let output = "";
  let stderr = "";
  const ready = new Promise((resolve) => child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    if (output.includes("READY")) resolve();
  }));
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exit = new Promise((resolve, reject) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", reject);
  });
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error("Managed child did not start")), 4000))]);
  child.stdin.end();
  const code = await Promise.race([exit, new Promise((_, reject) => setTimeout(() => reject(new Error("Owned EOF did not terminate runtime")), 4000))]);
  assert.equal(code, 0, stderr);
  assert.match(output, /STOPPED/u);
});
