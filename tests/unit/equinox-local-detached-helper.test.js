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

test("detached helper refuses malformed command, arguments and timeout before invoking a child",async()=>{
  let launches=0;
  const invalid=[
    {command:""}, {command:null}, {command:0},
    {command:"/runtime/node",args:"--uninstall"},
    {command:"/runtime/node",args:["ok",42]},
    {command:"/runtime/node",args:[null]},
    {command:"/runtime/node",spawnTimeoutMs:0},
    {command:"/runtime/node",spawnTimeoutMs:10_001},
    {command:"/runtime/node",spawnTimeoutMs:NaN},
    {command:"/runtime/node",spawnTimeoutMs:1.1},
  ];
  for(const options of invalid){
    await assert.rejects(launchDetachedHelper({
      spawnImpl:()=>{launches++;return fakeChild()},label:"Verified helper",...options,
    }),/command|required|arguments|timeout/u);
  }
  assert.equal(launches,0);
});

test("detached helper times out without spawn acknowledgement and late success cannot unref the child",async()=>{
  const child=fakeChild();
  const attempts=[];
  await assert.rejects(launchDetachedHelper({
    spawnImpl:()=>{attempts.push("spawn-request");return child},
    command:"/runtime/node",
    spawnTimeoutMs:10,
    label:"Delayed helper",
  }),/Delayed helper spawn acknowledgement timed out/u);
  assert.deepEqual(attempts,["spawn-request"]);
  assert.equal(child.unrefCount,0);
  child.emit("spawn");
  assert.equal(child.unrefCount,0);
});

test("detached helper treats only the first successful spawn acknowledgement as success",async()=>{
  const child=fakeChild();
  const attempt=launchDetachedHelper({spawnImpl:()=>child,command:"/runtime/node"});
  child.emit("spawn");
  child.emit("spawn");
  assert.equal(await attempt,child);
  assert.equal(child.unrefCount,1);
});
