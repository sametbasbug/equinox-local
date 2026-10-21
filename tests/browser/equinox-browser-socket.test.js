import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  equinoxBrowserIpcEndpoint,
  equinoxBrowserSocketDirectory,
  equinoxBrowserSocketPath,
  prepareEquinoxBrowserSocketDirectory,
} from "../../src/equinox-browser-socket.js";

test("browser socket path stays short, user-specific and supports isolated smoke namespaces", () => {
  const uid = 501;
  assert.equal(equinoxBrowserSocketDirectory({ uid }), "/tmp/equinox-local-501");
  assert.equal(equinoxBrowserSocketPath({ uid }), "/tmp/equinox-local-501/browser.sock");
  assert.equal(equinoxBrowserSocketPath({ uid, namespace: "smoke-123" }), "/tmp/equinox-local-501-smoke-123/browser.sock");
  assert.equal(Buffer.byteLength(equinoxBrowserSocketPath({ uid, namespace: "smoke-123" }), "utf8") < 100, true);
  assert.throws(() => equinoxBrowserSocketPath({ uid, namespace: "../unsafe" }), /namespace is invalid/u);
});

test("browser socket directory is private and owned by the current user in an isolated test namespace", async (t) => {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || uid < 1) return;
  const namespace = `test-${process.pid}`;
  const directory = equinoxBrowserSocketDirectory({ uid, namespace });
  assert.notEqual(directory, equinoxBrowserSocketDirectory({ uid }));
  await fs.rm(directory, { recursive: true, force: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.equal(await prepareEquinoxBrowserSocketDirectory({ uid, namespace }), directory);
  const stat = await fs.lstat(directory);
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.uid, uid);
  assert.equal(stat.mode & 0o077, 0);
});

test("root or missing uid is rejected", async () => {
  assert.throws(() => equinoxBrowserSocketPath({ uid: 0 }), /non-root user id/u);
  await assert.rejects(
    prepareEquinoxBrowserSocketDirectory({ uid: 0 }),
    /non-root user id/u,
  );
});


test("browser IPC contract exposes the implemented Windows named pipe", () => {
  assert.deepEqual(equinoxBrowserIpcEndpoint({ platform: "darwin", uid: 501, namespace: "smoke" }), {
    kind: "unix",
    endpoint: "/tmp/equinox-local-501-smoke/browser.sock",
    implemented: true,
  });
  assert.deepEqual(equinoxBrowserIpcEndpoint({ platform: "win32", namespace: "smoke" }), {
    kind: "named-pipe",
    endpoint: "\\\\.\\pipe\\equinox-local-browser-smoke",
    implemented: true,
  });
  assert.throws(() => equinoxBrowserIpcEndpoint({ platform: "linux" }), /unsupported/u);
});

test("browser IPC namespaces reject traversal, separators, shell metacharacters and invalid lengths on both platforms", () => {
  const invalid = [
    "../outside", "/tmp/private", "a/b", "a\\b", "a..b", "a_b",
    "A", "-prefix", "a;echo", "a$(cmd)", "a\nnewline",
    "a".repeat(33),
  ];
  for (const namespace of invalid) {
    assert.throws(
      () => equinoxBrowserIpcEndpoint({platform:"darwin",uid:501,namespace}),
      /namespace is invalid/u,
      `Darwin ${String(namespace)}`,
    );
    assert.throws(
      () => equinoxBrowserIpcEndpoint({platform:"win32",namespace}),
      /namespace is invalid/u,
      `Windows ${String(namespace)}`,
    );
    assert.throws(
      () => equinoxBrowserSocketPath({uid:501,namespace}),
      /namespace is invalid/u,
    );
  }
  assert.equal(equinoxBrowserSocketDirectory({uid:501,namespace:5}),"/tmp/equinox-local-501-5");
  assert.equal(equinoxBrowserSocketDirectory({uid:501,namespace:"trailing-"}),"/tmp/equinox-local-501-trailing-");
  assert.equal(equinoxBrowserSocketDirectory({uid:501,namespace:"a".repeat(32)}),
    `/tmp/equinox-local-501-${"a".repeat(32)}`);
  assert.deepEqual(equinoxBrowserIpcEndpoint({platform:"win32",namespace:"smoke-123"}),{
    kind:"named-pipe",endpoint:"\\\\.\\pipe\\equinox-local-browser-smoke-123",implemented:true,
  });
  assert.equal(Object.isFrozen(equinoxBrowserIpcEndpoint({platform:"win32",namespace:"smoke"})),true);
});

test("browser socket preparation refuses symlink/replaced/non-directory and different-owner directories without chmod", async () => {
  const uid=501,namespace="fixture-private";
  for (const stat of [
    {isDirectory:()=>true,isSymbolicLink:()=>true,uid,mode:0o700},
    {isDirectory:()=>false,isSymbolicLink:()=>false,uid,mode:0o700},
    {isDirectory:()=>true,isSymbolicLink:()=>false,uid:502,mode:0o700},
  ]) {
    const events=[];
    const fsImpl={
      mkdir:async (directory,options)=>{
        events.push(["mkdir",directory,options]);
        throw Object.assign(Error("already exists"),{code:"EEXIST"});
      },
      lstat:async (directory)=>{events.push(["lstat",directory]);return stat;},
      chmod:async()=>{throw Error("must not chmod an unowned or replaced directory");},
    };
    await assert.rejects(
      prepareEquinoxBrowserSocketDirectory({uid,namespace,fsImpl}),
      /not a normal directory|owned by a different user/u,
    );
    assert.deepEqual(events,[
      ["mkdir","/tmp/equinox-local-501-fixture-private",{mode:0o700}],
      ["lstat","/tmp/equinox-local-501-fixture-private"],
    ]);
  }
});

test("browser socket preparation refuses permissive directories when chmod cannot actually secure them", async () => {
  const events=[];
  const unsafe={isDirectory:()=>true,isSymbolicLink:()=>false,uid:501,mode:0o777};
  const fsImpl={
    mkdir:async (directory,opts)=>{events.push(["mkdir",directory,opts]);},
    lstat:async (directory)=>{events.push(["lstat",directory]);return unsafe;},
    chmod:async (directory,mode)=>{events.push(["chmod",directory,mode]);},
  };
  await assert.rejects(
    prepareEquinoxBrowserSocketDirectory({uid:501,namespace:"fixture-insecure",fsImpl}),
    /permissions could not be secured/u,
  );
  assert.deepEqual(events,[
    ["mkdir","/tmp/equinox-local-501-fixture-insecure",{mode:0o700}],
    ["lstat","/tmp/equinox-local-501-fixture-insecure"],
    ["chmod","/tmp/equinox-local-501-fixture-insecure",0o700],
    ["lstat","/tmp/equinox-local-501-fixture-insecure"],
  ]);
});

test("browser socket permission correction rechecks and accepts a secured owned directory", async () => {
  const events=[];
  let mode=0o755;
  const fsImpl={
    mkdir:async () => {throw Object.assign(Error("existing"),{code:"EEXIST"});},
    lstat:async () => ({isDirectory:()=>true,isSymbolicLink:()=>false,uid:501,mode}),
    chmod:async(directory,next)=>{events.push([directory,next]);mode=next;},
  };
  assert.equal(
    await prepareEquinoxBrowserSocketDirectory({uid:501,namespace:"fixture-correct",fsImpl}),
    "/tmp/equinox-local-501-fixture-correct",
  );
  assert.deepEqual(events,[["/tmp/equinox-local-501-fixture-correct",0o700]]);
});

test("browser socket preparation propagates mkdir and lstat errors without fallback directory creation", async () => {
  for (const operation of ["mkdir","lstat"]) {
    const events=[];
    const denied=Object.assign(Error("controlled OS permission refusal"),{code:"EACCES"});
    const fsImpl={
      mkdir:async()=>{events.push("mkdir");if(operation==="mkdir")throw denied;},
      lstat:async()=>{events.push("lstat");throw denied;},
      chmod:async()=>{throw Error("must never chmod after owner/probe failure");},
    };
    await assert.rejects(
      prepareEquinoxBrowserSocketDirectory({uid:501,namespace:"fixture-no-fallback",fsImpl}),
      error=>error===denied,
    );
    assert.deepEqual(events,operation==="mkdir"?["mkdir"]:["mkdir","lstat"]);
  }
  await assert.rejects(
    prepareEquinoxBrowserSocketDirectory({uid:0,namespace:"fixture-nonroot",fsImpl:{
      mkdir:async()=>{throw Error("root guard bypass")},
    }}),
    /non-root user id/u,
  );
});
