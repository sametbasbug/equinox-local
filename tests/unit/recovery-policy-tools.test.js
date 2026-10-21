import assert from "node:assert/strict";
import test from "node:test";
import { registerRecoveryPolicyTools } from "../../src/recovery-policy-tools.js";

function fakeController() {
  return {
    status: async () => ({ enabled: true, policyCount: 1, activeJobCount: 0, openCircuitCount: 0, circuits: [] }),
  };
}

test("recovery policy module registers the v4.0.3 read-only tool set", async () => {
  const tools = [];
  const result = await registerRecoveryPolicyTools({
    registerTextTool: (name, definition, handler, options) => {
      tools.push({ name, definition, handler, options });
    },
    recoveryPolicyController: fakeController(),
    processJsonResult: (value) => value,
    errorResult: (error) => ({ error: error.message }),
  });

  assert.equal(result.toolCount, 1);
  assert.deepEqual(tools.map((tool) => tool.name), [
    "recovery_status",
  ]);
  assert.equal(tools.every((tool) => tool.definition.annotations.readOnlyHint === true), true);
  assert.equal(tools.every((tool) => tool.definition.annotations.destructiveHint === false), true);
  assert.equal(tools.every((tool) => tool.options.projectAware === false), true);
});

test("recovery status exposes only read-only, project-independent registration and no mutation scopes", async () => {
  const registered = [];
  const returned = await registerRecoveryPolicyTools({
    registerTextTool: (name, definition, handler, options) =>
      registered.push({ name, definition, handler, options }),
    recoveryPolicyController: {
      status: async () => ({enabled:true,circuits:[],activeJobCount:0}),
      repair: () => { throw Error("repair must never be accessible"); },
      restart: () => { throw Error("restart must never be accessible"); },
    },
    processJsonResult: (result) => ({wrapped:result}),
    errorResult: (error) => ({error:error.message}),
  });
  assert.deepEqual(returned, {toolCount:1});
  assert.equal(Object.isFrozen(returned),true);
  assert.equal(registered.length,1);
  const [tool] = registered;
  assert.equal(tool.name,"recovery_status");
  assert.deepEqual(tool.definition.inputSchema,{});
  assert.deepEqual(tool.definition.annotations,{
    title:"Automatic recovery durumunu göster",
    readOnlyHint:true,
    destructiveHint:false,
    idempotentHint:true,
    openWorldHint:false,
  });
  assert.match(tool.definition.description,/salt okunur/u);
  assert.deepEqual(tool.options,{projectAware:false});
  assert.equal(Object.hasOwn(tool.options,"mutationScopes"),false);
  assert.deepEqual(await tool.handler(),{
    wrapped:{enabled:true,circuits:[],activeJobCount:0},
  });
});

test("recovery status controller failures return the existing error result without retrying or mutating", async () => {
  const tools = [];
  let statusCalls=0;
  const error=new Error("recovery status unavailable");
  await registerRecoveryPolicyTools({
    registerTextTool: (_name,_definition,handler) => tools.push(handler),
    recoveryPolicyController:{
      status: async()=>{statusCalls++;throw error},
      repairIssue:()=>{throw Error("forbidden recovery mutation")},
    },
    processJsonResult:()=>{throw Error("unexpected serialization")},
    errorResult:(received)=>({status:"unavailable",message:received.message,identity:received===error}),
  });
  assert.deepEqual(await tools[0](),{
    status:"unavailable",message:"recovery status unavailable",identity:true,
  });
  assert.equal(statusCalls,1);
});

test("recovery status formatter failures route once through the injected error handler", async () => {
  const tools = [];
  let reads=0,formats=0,errors=0;
  const output={enabled:false,openCircuitCount:3};
  await registerRecoveryPolicyTools({
    registerTextTool:(_name,_definition,handler)=>tools.push(handler),
    recoveryPolicyController:{status:async()=>{reads++;return output}},
    processJsonResult:(value)=>{
      formats++;
      assert.equal(value,output);
      throw Error("serialization refused");
    },
    errorResult:(error)=>{errors++;return {status:"error",message:error.message}},
  });
  assert.deepEqual(await tools[0](),{status:"error",message:"serialization refused"});
  assert.deepEqual({reads,formats,errors},{reads:1,formats:1,errors:1});
});
