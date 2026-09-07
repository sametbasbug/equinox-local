import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { launchDetachedHelper } from "../../src/equinox-local-detached-helper.js";

function fakeChild() {
  const child = new EventEmitter();
  child.unrefCount = 0;
  child.unref = () => { child.unrefCount += 1; };
  return child;
}

test("detached helper waits for spawn acknowledgement before reporting success", async () => {
  const child = fakeChild();
  const promise = launchDetachedHelper({
    spawnImpl: () => child,
    command: "/runtime/node",
    args: ["/runtime/helper.js"],
    label: "Fixture helper",
  });

  assert.equal(child.unrefCount, 0);
  queueMicrotask(() => child.emit("spawn"));
  const result = await promise;
  assert.equal(result, child);
  assert.equal(child.unrefCount, 1);
});

test("detached helper rejects asynchronous spawn errors without unhandled error events", async () => {
  const child = fakeChild();
  const promise = launchDetachedHelper({
    spawnImpl: () => child,
    command: "/missing/node",
    label: "Fixture helper",
  });

  queueMicrotask(() => child.emit("error", new Error("ENOENT")));
  await assert.rejects(promise, /Fixture helper failed to start: ENOENT/u);
  assert.equal(child.unrefCount, 0);
});

test("detached helper rejects synchronous spawn failures", async () => {
  await assert.rejects(
    launchDetachedHelper({
      spawnImpl: () => { throw new Error("boom"); },
      command: "/runtime/node",
      label: "Fixture helper",
    }),
    /Fixture helper failed to start: boom/u,
  );
});
