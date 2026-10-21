import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";

import { registerRuntimeObservabilityTools } from "../../src/runtime-observability-tools.js";

test("runtime observability module registers the v4.0.0 read-only tool set", () => {
  const names = [];
  const observability = {
    query: async () => [],
    metrics: async () => ({ totalEvents: 0 }),
    health: async () => ({ state: "HEALTHY" }),
  };

  registerRuntimeObservabilityTools({
    registerTextTool: (name) => names.push(name),
    z,
    observability,
    getRuntimeSnapshot: async () => ({}),
    processJsonResult: (value) => value,
    errorResult: (error) => ({ error: String(error) }),
  });

  assert.deepEqual(names, [
    "runtime_events",
    "runtime_metrics",
    "runtime_health",
  ]);
});

test("runtime observability tools preserve read-only registration and bounded schema rejection", () => {
  const tools = new Map();
  const observability = {
    query: async () => [],
    metrics: async () => ({}),
    health: async () => ({}),
  };
  registerRuntimeObservabilityTools({
    registerTextTool: (name, definition, handler, options) => tools.set(name, {definition, handler, options}),
    z, observability,
    getRuntimeSnapshot: null,
    processJsonResult: (value) => value,
    errorResult: (error) => ({error: error.message}),
  });

  assert.deepEqual([...tools.keys()], ["runtime_events", "runtime_metrics", "runtime_health"]);
  for (const [name, tool] of tools) {
    assert.deepEqual(tool.options, {projectAware:false}, name);
    assert.equal(Object.hasOwn(tool.options, "mutationScopes"), false, name);
    assert.equal(tool.definition.annotations.readOnlyHint, true, name);
    assert.equal(tool.definition.annotations.destructiveHint, false, name);
    assert.equal(tool.definition.annotations.idempotentHint, true, name);
    assert.equal(tool.definition.annotations.openWorldHint, false, name);
  }
  const parse = (name, input) => z.object(tools.get(name).definition.inputSchema).safeParse(input);
  assert.deepEqual(parse("runtime_events", {}).data, {
    since_minutes:60,limit:100,newest_first:true,
  });
  assert.deepEqual(parse("runtime_metrics", {}).data, {window_minutes:1440});
  assert.deepEqual(parse("runtime_health", {}).data, {window_minutes:15});
  assert.equal(parse("runtime_events", {
    since_minutes:1,limit:1,component:"runtime",severity:"critical",type:"health.changed",newest_first:false,
  }).success,true);
  assert.equal(parse("runtime_events", {since_minutes:10080,limit:500}).success,true);
  assert.equal(parse("runtime_metrics", {window_minutes:10080}).success,true);
  assert.equal(parse("runtime_health", {window_minutes:1440}).success,true);
  for (const bad of [
    {since_minutes:0},{since_minutes:10081},{since_minutes:2.5},{since_minutes:"60"},
    {limit:0},{limit:501},{limit:-1},{limit:3.5},{limit:"100"},
    {component:""},{component:"c".repeat(81)},
    {severity:"debug"},{severity:"CRITICAL"},{type:""},{type:"t".repeat(121)},
    {newest_first:"false"},
  ]) {
    assert.equal(parse("runtime_events",bad).success,false,JSON.stringify(bad));
  }
  for (const name of ["runtime_metrics","runtime_health"]) {
    for (const bad of [{window_minutes:0},{window_minutes:2.5},{window_minutes:"5"}]) {
      assert.equal(parse(name,bad).success,false,name+" "+JSON.stringify(bad));
    }
  }
  assert.equal(parse("runtime_metrics",{window_minutes:10081}).success,false);
  assert.equal(parse("runtime_health",{window_minutes:1441}).success,false);
});

test("runtime event query uses one bounded clock window, exact nullable filters and read-only dispatch", async () => {
  const tools = new Map();
  const trace = [];
  const events = [{type:"runtime.start",severity:"info"}];
  const time = Date.parse("2026-10-20T00:10:00.000Z");
  const originalNow = Date.now;
  const observability = {
    query: async (options) => {trace.push(["query",options]);return events;},
    metrics: async () => {throw Error("metrics must not run");},
    health: async () => {throw Error("health must not run");},
    cleanup: () => {throw Error("no deletion authority");},
  };
  try {
    Date.now = () => time;
    registerRuntimeObservabilityTools({
      registerTextTool: (name, definition, handler) => tools.set(name,handler),
      z,observability,
      getRuntimeSnapshot: async () => {throw Error("snapshot not part of event query");},
      processJsonResult: (value) => {trace.push(["format",value]);return {result:value};},
      errorResult: (error) => ({error:error.message}),
    });
    const result = await tools.get("runtime_events")({
      since_minutes:15,limit:8,newest_first:false,
      component:"terminal",severity:"warn",type:"command.failed",
    });
    assert.deepEqual(trace[0],["query",{
      sinceMs:time-900_000,untilMs:time,limit:8,
      component:"terminal",severity:"warn",type:"command.failed",newestFirst:false,
    }]);
    assert.deepEqual(result,{result:{
      ok:true,query:{sinceMinutes:15,limit:8,component:"terminal",severity:"warn",type:"command.failed",newestFirst:false},
      count:1,events,
    }});
    assert.equal(trace.length,2);
    await tools.get("runtime_events")({since_minutes:10080,limit:100,newest_first:true});
    assert.deepEqual(trace[2],["query",{
      sinceMs:time-10_080*60_000,untilMs:time,limit:100,component:null,severity:null,type:null,newestFirst:true,
    }]);
    Date.now = () => 50_000;
    await tools.get("runtime_events")({since_minutes:1,limit:1,newest_first:true});
    assert.deepEqual(trace[4],["query",{
      sinceMs:0,untilMs:50_000,limit:1,component:null,severity:null,type:null,newestFirst:true,
    }]);
  } finally {
    Date.now = originalNow;
  }
});

test("runtime metrics and health preserve response merge, optional live snapshot and exact window bounds", async () => {
  const tools = new Map();
  const calls=[];
  const observability={
    query:async()=>{throw Error("query must not run");},
    metrics:async(options)=>{calls.push(["metrics",options]);return {totalEvents:3,status:"DEGRADED"};},
    health:async(options)=>{calls.push(["health",options]);return {state:"HEALTHY",ok:false};},
    repair:()=>{throw Error("no repairs authorized");},
  };
  registerRuntimeObservabilityTools({
    registerTextTool:(name,definition,handler)=>tools.set(name,handler),
    z,observability,
    getRuntimeSnapshot:async()=>{calls.push(["snapshot"]);return {agentReady:true};},
    processJsonResult:(value)=>{calls.push(["format",value]);return value;},
    errorResult:(error)=>({error:error.message}),
  });
  assert.deepEqual(await tools.get("runtime_metrics")({window_minutes:1440}),{
    ok:true,totalEvents:3,status:"DEGRADED",
  });
  assert.deepEqual(await tools.get("runtime_health")({window_minutes:15}),{
    ok:false,state:"HEALTHY",current:{agentReady:true},
  });
  assert.deepEqual(calls,[
    ["metrics",{windowMs:86_400_000}],
    ["format",{ok:true,totalEvents:3,status:"DEGRADED"}],
    ["health",{windowMs:900_000}],
    ["snapshot"],
    ["format",{ok:false,state:"HEALTHY",current:{agentReady:true}}],
  ]);
  const noSnapshot = new Map();
  registerRuntimeObservabilityTools({
    registerTextTool:(name,definition,handler)=>noSnapshot.set(name,handler),
    z,observability,
    getRuntimeSnapshot:{notCallable:true},
    processJsonResult:(value)=>value,
    errorResult:(error)=>({error:error.message}),
  });
  assert.deepEqual(await noSnapshot.get("runtime_health")({window_minutes:1}),{
    ok:false,state:"HEALTHY",current:null,
  });
});

test("runtime observability owner and serialization errors return one formatted error without retries or other tools", async () => {
  const tools = new Map();
  const calls = [];
  const observability = {
    query:async()=>{calls.push("query");throw Error("event read failed");},
    metrics:async()=>{calls.push("metrics");return {totalEvents:0};},
    health:async()=>{calls.push("health");return {state:"DEGRADED"};},
    clear:()=>{throw Error("unauthorized mutation");},
  };
  registerRuntimeObservabilityTools({
    registerTextTool:(name,definition,handler)=>tools.set(name,handler),
    z,observability,
    getRuntimeSnapshot:async()=>{calls.push("snapshot");throw Error("current status unavailable");},
    processJsonResult:()=>{calls.push("format");throw Error("serializer unavailable");},
    errorResult:(error)=>{calls.push("error");return {status:"error",reason:error.message};},
  });
  assert.deepEqual(await tools.get("runtime_events")({since_minutes:1,limit:1,newest_first:true}),{
    status:"error",reason:"event read failed",
  });
  assert.deepEqual(await tools.get("runtime_metrics")({window_minutes:1}),{
    status:"error",reason:"serializer unavailable",
  });
  assert.deepEqual(await tools.get("runtime_health")({window_minutes:1}),{
    status:"error",reason:"current status unavailable",
  });
  assert.deepEqual(calls,[
    "query","error","metrics","format","error","health","snapshot","error",
  ]);
});

test("observability registration refuses missing tool registry or runtime before registering partial tools", () => {
  const registerTextTool=()=>{throw Error("registration should not happen");};
  const valid={
    z,
    observability:{query:async()=>[],metrics:async()=>({}),health:async()=>({})},
    registerTextTool,
    getRuntimeSnapshot:null,
    processJsonResult:value=>value,
    errorResult:error=>error,
  };
  assert.throws(()=>registerRuntimeObservabilityTools({...valid,registerTextTool:null}), /registerTextTool gerekli/u);
  assert.throws(()=>registerRuntimeObservabilityTools({...valid,observability:null}), /runtime gerekli/u);
});
