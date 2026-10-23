import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  __test,
  createWorkflowRuntime,
} from "../../src/workflow-runtime.js";

async function createHarness(t) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-workflow-runtime-"));
  t.after(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  const processManager = {
    start() { throw new Error("not used"); },
    list() { return []; },
    async readLogs() { throw new Error("not used"); },
    async stop() { return null; },
  };

  const manager = await createWorkflowRuntime({
    rootDir,
    processManager,
    probeTcpPort: async () => ({ listening: false }),
  });

  return { manager };
}

test("workflow runtime initializes the internal durable manager without public registrations", async (t) => {
  const { manager } = await createHarness(t);
  assert.equal(manager.summary().total, 0);
});

test("preview npm arguments are fixed by the detected adapter", () => {
  assert.deepEqual(
    __test.buildPreviewNpmArgs(
      { adapter: "host-port", script: "preview" },
      4321,
    ),
    ["run", "preview", "--", "--host", "127.0.0.1", "--port", "4321"],
  );
  assert.deepEqual(
    __test.buildPreviewNpmArgs(
      { adapter: "next-start", script: "start" },
      4322,
    ),
    ["run", "start", "--", "-H", "127.0.0.1", "-p", "4322"],
  );
});

test("preview port selector honors explicit free ports and rejects occupied ports", async () => {
  assert.equal(
    await __test.choosePreviewPort({
      requestedPort: 4444,
      probeTcpPort: async () => ({ listening: false }),
    }),
    4444,
  );

  await assert.rejects(
    () => __test.choosePreviewPort({
      requestedPort: 4444,
      probeTcpPort: async () => ({ listening: true }),
    }),
    /zaten kullanımda/u,
  );
});

test("workflow step executor delegates v3.8 extension steps", async () => {
  const calls = [];
  const executor = __test.createWorkflowStepExecutor({
    processManager: {},
    probeTcpPort: async () => ({ listening: false }),
    extraStepExecutor: async (context) => {
      calls.push(context.step.kind);
      return {
        handled: context.step.kind === "release-readiness",
        result: { verdict: "GREEN" },
      };
    },
  });

  const result = await executor({
    workflow: { projectId: "demo", projectName: "Demo", projectRoot: "/tmp/demo" },
    step: { kind: "release-readiness", label: "Readiness" },
    signal: new AbortController().signal,
    log: async () => {},
  });

  assert.deepEqual(calls, ["release-readiness"]);
  assert.deepEqual(result, { verdict: "GREEN" });
});

test("aborted workflow steps refuse Git/npm/preview/delegation before any process, port or log action", async () => {
  const observed=[];
  const executor=__test.createWorkflowStepExecutor({
    processManager:{
      start:async()=>{observed.push("start");throw Error("unexpected managed start")},
      list:()=>{observed.push("list");return []},
      readLogs:async()=>{observed.push("logs");throw Error("unexpected read")},
      stop:async()=>{observed.push("stop");throw Error("unexpected stop")},
    },
    probeTcpPort:async()=>{observed.push("probe");return {listening:false}},
    extraStepExecutor:async()=>{observed.push("delegate");return {handled:true,result:"bad"}},
  });
  const controller=new AbortController();
  controller.abort();
  for(const kind of ["git-clean","npm-script","preview-smoke","release-readiness"]){
    await assert.rejects(executor({
      workflow:{workflowId:"wf-test",projectId:"fixture",projectName:"Fixture",projectRoot:"/fixture"},
      step:{kind,script:"test",timeoutSeconds:1,adapter:"host-port",port:4321,path:"/"},
      signal:controller.signal,
      log:async()=>{observed.push("log")},
    }),/Workflow durduruldu/u);
  }
  assert.deepEqual(observed,[]);
});

test("preview discovery probes only IPv4 loopback, bounds range, and propagates explicit occupied-port denial",async()=>{
  const calls=[];
  const probeTcpPort=async request=>{
    calls.push(request);
    return {listening:request.port!==43199};
  };
  assert.equal(await __test.choosePreviewPort({requestedPort:null,probeTcpPort}),43199);
  assert.equal(calls.length,100);
  assert.deepEqual(calls[0],{host:"127.0.0.1",port:43100,timeoutMs:100});
  assert.deepEqual(calls.at(-1),{host:"127.0.0.1",port:43199,timeoutMs:100});
  calls.length=0;
  assert.equal(await __test.choosePreviewPort({requestedPort:4501,probeTcpPort:async request=>{
    calls.push(request);return {listening:false};
  }}),4501);
  assert.deepEqual(calls,[{host:"127.0.0.1",port:4501,timeoutMs:250}]);
  const occupied=async request=>{calls.push(request);return {listening:true}};
  await assert.rejects(__test.choosePreviewPort({requestedPort:4502,probeTcpPort:occupied}),/portu zaten kullanımda/u);
  assert.deepEqual(calls.at(-1),{host:"127.0.0.1",port:4502,timeoutMs:250});
  calls.length=0;
  await assert.rejects(__test.choosePreviewPort({requestedPort:null,probeTcpPort:occupied}),/boş preview portu bulunamadı/u);
  assert.equal(calls.length,100);
  assert.ok(calls.every((c,i)=>c.host==="127.0.0.1"&&c.port===43100+i&&c.timeoutMs===100));
});

test("preview argv never substitutes a non-loopback host or silently accepts unknown adapter",()=>{
  for(const port of [43100,43199]){
    assert.deepEqual(__test.buildPreviewNpmArgs({adapter:"host-port",script:"preview"},port),
      ["run","preview","--","--host","127.0.0.1","--port",String(port)]);
    assert.deepEqual(__test.buildPreviewNpmArgs({adapter:"next-start",script:"start"},port),
      ["run","start","--","-H","127.0.0.1","-p",String(port)]);
  }
  for(const adapter of ["shell","",null,"127.0.0.2"]){
    assert.throws(()=>__test.buildPreviewNpmArgs({adapter,script:"preview"},43100),
      /Desteklenmeyen preview adapter/u);
  }
});

test("workflow extension delegates only explicitly handled results, never implicit executes or retries",async()=>{
  const trace=[];
  const executor=__test.createWorkflowStepExecutor({
    processManager:{start:async()=>{throw Error("start forbidden")}},
    probeTcpPort:async()=>{throw Error("probe forbidden")},
    extraStepExecutor:async ctx=>{
      trace.push(ctx.step.kind);
      return ctx.step.kind==="release-readiness"
        ? {handled:true,result:{verdict:"GREEN"}}
        : {handled:false,result:{verdict:"not-authorized"}};
    },
  });
  const context=kind=>({
    workflow:{workflowId:"wf-test",projectId:"fixture",projectName:"Fixture",projectRoot:"/fixture"},
    step:{kind},signal:new AbortController().signal,log:async()=>{throw Error("unexpected log")},
  });
  assert.deepEqual(await executor(context("release-readiness")),{verdict:"GREEN"});
  await assert.rejects(executor(context("unregistered-mutation")),/Desteklenmeyen workflow adım türü/u);
  assert.deepEqual(trace,["release-readiness","unregistered-mutation"]);
});

test("workflow child environment is bounded and excludes configured provider tokens and PATH injection",()=>{
  const env=__test.safeWorkflowEnvironment();
  assert.equal(env.PATH,"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  assert.equal(env.CI,"1");
  assert.equal(env.GIT_TERMINAL_PROMPT,"0");
  for(const field of ["OPENAI_API_KEY","ANTHROPIC_API_KEY","GITHUB_TOKEN","NODE_OPTIONS","LD_PRELOAD","DYLD_INSERT_LIBRARIES","GH_TOKEN"]){
    assert.equal(env[field],undefined,field);
  }
});
