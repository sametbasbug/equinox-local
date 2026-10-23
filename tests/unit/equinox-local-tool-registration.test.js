import assert from "node:assert/strict";
import test from "node:test";

import { createEquinoxLocalToolRegistrar } from "../../src/equinox-local-tool-registration.js";

function makeRegistrar(overrides = {}) {
  const calls = {
    registrations: [],
    capabilities: [],
    replay: [],
    locks: [],
    contexts: [],
    notes: 0,
    mutationChecks: [],
  };
  const server = {
    registerTool(name, config, handler) {
      const registration = { name, config, handler };
      calls.registrations.push(registration);
      return registration;
    },
  };
  const capabilityRegistry = {
    register(capability) {
      calls.capabilities.push(capability);
    },
  };
  const dependencies = {
    server,
    capabilityRegistry,
    runtimeRestartGuardError: () => null,
    errorResult: (error) => ({ isError: true, error: error.message }),
    agentControl: {
      assertMutationAllowed(name) {
        calls.mutationChecks.push(name);
      },
    },
    noteManagedAgentCommand: async () => { calls.notes += 1; },
    mcpToolReplayGuard: {
      run(request) {
        calls.replay.push(request);
        return request.invoke();
      },
    },
    getToolMutationScopes: (...args) => args,
    getMutationLockPlan: (scopes, context) => ({ scopes, context }),
    withMutationLockPlan: async (plan, invoke) => {
      calls.locks.push(plan);
      return invoke();
    },
    projectContextStorage: {
      run(context, invoke) {
        calls.contexts.push(context);
        return invoke();
      },
    },
    defaultProject: "default-project",
    projectIdSchema: { type: "project-id" },
    resolveProjectContext: async (project) => ({ project, resolved: true }),
    z: { string: () => ({ type: "string" }) },
    extractTextContent: (result) => result.content
      .filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n"),
    ...overrides,
  };
  return { registrar: createEquinoxLocalToolRegistrar(dependencies), calls };
}

test("text registration adds project/default output schemas and preserves context, locks, result adaptation, and MCP extra", async () => {
  const { registrar, calls } = makeRegistrar();
  const config = {
    description: "Preserve tool metadata",
    inputSchema: { value: { type: "string" } },
    annotations: { title: "Text tool", readOnlyHint: false },
    customMetadata: { retained: true },
  };
  let handlerArgs;
  const registration = registrar.registerTextTool(
    "text_tool",
    config,
    async (...args) => {
      handlerArgs = args;
      return { content: [{ type: "text", text: "primary" }, { type: "image", data: "opaque" }] };
    },
    { mcpExposed: true, capabilityDomain: "fixture" },
  );
  const extra = { requestId: "mcp-extra" };
  const result = await registration.handler({ project: "chosen", value: "input" }, extra);

  assert.equal(registration, calls.registrations[0]);
  assert.equal(registration.config.description, config.description);
  assert.equal(registration.config.customMetadata, config.customMetadata);
  assert.equal(registration.config.annotations, config.annotations);
  assert.deepEqual(registration.config.inputSchema, {
    project: { type: "project-id" },
    value: { type: "string" },
  });
  assert.deepEqual(registration.config.outputSchema, { text: { type: "string" } });
  assert.deepEqual(handlerArgs, [{ value: "input" }, extra]);
  assert.deepEqual(calls.contexts, [{ project: "chosen", resolved: true }]);
  assert.equal(calls.locks.length, 1);
  assert.equal(calls.locks[0].context.project, "chosen");
  assert.equal(calls.replay[0].toolName, "text_tool");
  assert.deepEqual(calls.replay[0].input, { project: "chosen", value: "input" });
  assert.equal(calls.replay[0].extra, extra);
  assert.deepEqual(result, {
    content: [{ type: "text", text: "primary" }, { type: "image", data: "opaque" }],
    structuredContent: { text: "primary" },
  });
  assert.equal(calls.capabilities[0].domain, "fixture");
  assert.equal(calls.capabilities[0].config, registration.config);
  assert.equal(registrar.registeredToolCount, 1);

  await registration.handler({ value: "defaulted" });
  assert.deepEqual(handlerArgs, [{ value: "defaulted" }]);
  assert.equal(calls.contexts[1].project, "default-project");
  assert.equal(calls.locks.length, 2);
});

test("raw registration preserves multimodal results and config without project injection or automatic locks", async () => {
  const { registrar, calls } = makeRegistrar();
  const config = {
    inputSchema: { payload: { type: "image" } },
    outputSchema: { content: { type: "array" } },
    annotations: { title: "Raw tool", readOnlyHint: false },
    extra: "unchanged",
  };
  const multimodal = {
    content: [
      { type: "image", data: "raw-image-data", mimeType: "image/png" },
      { type: "text", text: "raw result" },
    ],
    structuredContent: { opaque: true },
  };
  const registration = registrar.registerRawTool(
    "raw_tool",
    config,
    async (input, extra) => {
      assert.deepEqual(input, { payload: "image" });
      assert.equal(extra.requestId, "raw-extra");
      return multimodal;
    },
    { mcpExposed: true },
  );
  const extra = { requestId: "raw-extra" };
  const result = await registration.handler({ payload: "image" }, extra);

  assert.equal(registration.config, config);
  assert.equal(result, multimodal);
  assert.equal(calls.contexts.length, 0);
  assert.equal(calls.locks.length, 0);
  assert.deepEqual(calls.capabilities[0].inputSchema, config.inputSchema);
  assert.equal(calls.capabilities[0].config, config);
  assert.equal(calls.replay[0].input.payload, "image");
  assert.equal(calls.replay[0].extra, extra);
});

test("non-MCP registrations skip replay, command milestones, and MCP registration", async () => {
  const { registrar, calls } = makeRegistrar();
  registrar.registerRawTool("internal_tool", {}, async () => ({ ok: true }));
  assert.deepEqual(await calls.capabilities[0].invoke({}), { ok: true });

  assert.equal(calls.registrations.length, 0);
  assert.equal(calls.replay.length, 0);
  assert.equal(calls.notes, 0);
  assert.equal(registrar.registeredToolCount, 0);
  assert.equal(calls.capabilities.length, 1);
});

test("shared restart and pause guards return error results before invoking handlers", async () => {
  let restartPending = true;
  let pauseBlocked = false;
  const { registrar, calls } = makeRegistrar({
    runtimeRestartGuardError: (name) => restartPending ? new Error(`${name} restarting`) : null,
    agentControl: {
      assertMutationAllowed(name) {
        calls.mutationChecks.push(name);
        if (pauseBlocked) throw new Error(`${name} paused`);
      },
    },
  });
  let invoked = 0;
  const raw = registrar.registerRawTool("guarded", {}, async () => {
    invoked += 1;
    return { ok: true };
  }, { mcpExposed: true });

  assert.deepEqual(await raw.handler({}), { isError: true, error: "guarded restarting" });
  restartPending = false;
  pauseBlocked = true;
  assert.deepEqual(await raw.handler({}), { isError: true, error: "guarded paused" });
  assert.equal(invoked, 0);
  assert.equal(calls.notes, 0);
});

test("text handler awaits async failures and adapts them through errorResult", async () => {
  const { registrar, calls } = makeRegistrar();
  const registration = registrar.registerTextTool(
    "text_failure",
    { annotations: { title: "Read-only", readOnlyHint: true } },
    async () => {
      await Promise.resolve();
      throw new Error("handler failed");
    },
    { projectAware: false, mcpExposed: true },
  );
  const extra = { requestId: "failure-extra" };

  assert.deepEqual(await registration.handler({ value: 1 }, extra), {
    isError: true,
    error: "handler failed",
  });
  assert.equal(calls.locks.length, 1);
  assert.equal(calls.locks[0].context, undefined);
  assert.equal(calls.mutationChecks.length, 0);
  assert.equal(calls.notes, 1);
  assert.equal(calls.replay[0].extra, extra);
});

test("tool registrar applies restart first, then mutation pause, before command milestone and handler", async () => {
  const trace=[];
  let restarting=true,paused=true;
  const {registrar,calls}=makeRegistrar({
    runtimeRestartGuardError:name=>{
      trace.push(["restartGuard",name]);
      return restarting?Error("runtime is restarting"):null;
    },
    agentControl:{assertMutationAllowed:name=>{
      trace.push(["pauseGuard",name]);
      if(paused)throw Error("agent is paused");
    }},
    noteManagedAgentCommand:async()=>trace.push(["milestone"]),
  });
  let executions=0;
  const raw=registrar.registerRawTool("do_mutation",{annotations:{readOnlyHint:false}},async()=>{
    executions++;trace.push(["handler"]);return {ok:true};
  },{mcpExposed:true});
  assert.equal((await raw.handler({})).error,"runtime is restarting");
  assert.deepEqual(trace,[["restartGuard","do_mutation"]]);
  restarting=false;
  assert.equal((await raw.handler({})).error,"agent is paused");
  assert.deepEqual(trace.slice(1),[["restartGuard","do_mutation"],["pauseGuard","do_mutation"]]);
  paused=false;
  assert.deepEqual(await raw.handler({}),{ok:true});
  assert.deepEqual(trace.slice(3),[
    ["restartGuard","do_mutation"],["pauseGuard","do_mutation"],["milestone"],["handler"],
  ]);
  assert.equal(executions,1);
  assert.equal(calls.notes,0,"custom test milestone supersedes default counting");
  assert.equal(calls.replay.length,3,"MCP boundary remains the replay owner's sole responsibility");

  trace.length=0;
  const readOnly=registrar.registerRawTool("read_only",{annotations:{readOnlyHint:true}},async()=>{
    trace.push(["readOnlyHandler"]);return {ok:true};
  },{mcpExposed:false});
  assert.deepEqual(await calls.capabilities.find(x=>x.name==="read_only").invoke({}),{ok:true});
  assert.deepEqual(trace,[["restartGuard","read_only"],["readOnlyHandler"]]);
  assert.equal(readOnly,null);

  trace.length=0;
  const rawBypass=registrar.registerRawTool("externally_guarded",{annotations:{readOnlyHint:false}},async()=>{
    trace.push(["bypassHandler"]);return {ok:true};
  },{pauseGuard:false});
  assert.deepEqual(await calls.capabilities.find(x=>x.name==="externally_guarded").invoke({}),{ok:true});
  assert.deepEqual(trace,[["restartGuard","externally_guarded"],["bypassHandler"]]);
  assert.equal(rawBypass,null);
});

test("project-aware registrar refuses resolver access and lock failures without executing handler or leaking project in payload", async () => {
  const trace=[];
  let allow=false,failLock=false;
  const {registrar,calls}=makeRegistrar({
    resolveProjectContext:async project=>{
      trace.push(["resolve",project]);
      if(!allow)throw Error("Agent Access denied project");
      return {project};
    },
    getToolMutationScopes:(name,config,opts,aware)=>{
      trace.push(["scopes",name,aware]);
      return ["project"];
    },
    getMutationLockPlan:(scopes,context)=>{
      trace.push(["lockPlan",scopes,context]);
      return {scopes,context};
    },
    withMutationLockPlan:async(plan,handler)=>{
      trace.push(["lock",plan.context?.project]);
      if(failLock)throw Error("mutation lock unavailable");
      return handler();
    },
    projectContextStorage:{run:(context,handler)=>{
      trace.push(["projectContext",context.project]);
      return handler();
    }},
  });
  let actualCalls=0;
  const handler=async(...args)=>{
    actualCalls++;
    trace.push(["handler",args]);
    return {content:[{type:"text",text:"visible"}]};
  };
  registrar.registerTextTool("project_mutation",{
    inputSchema:{project:{from:"caller-override"},value:{type:"string"}},
    annotations:{readOnlyHint:false},
  },handler);
  const invoke=calls.capabilities[0].invoke;
  assert.deepEqual(await invoke({project:"not-allowed",value:7}),{
    isError:true,error:"Agent Access denied project",
  });
  assert.equal(actualCalls,0);
  assert.equal(trace.some(([event])=>event==="lock"),false);
  assert.equal(trace.some(([event])=>event==="projectContext"),false);
  allow=true;
  failLock=true;
  await assert.rejects(
    invoke({project:"selected",value:7}),
    /mutation lock unavailable/u,
    "legacy projectContextStorage.run promise rejections propagate outside the synchronous catch",
  );
  assert.equal(actualCalls,0);
  failLock=false;
  const result=await invoke({project:"selected",value:7});
  assert.deepEqual(result,{
    content:[{type:"text",text:"visible"}],structuredContent:{text:"visible"},
  });
  assert.equal(actualCalls,1);
  assert.deepEqual(trace.at(-2),["lock","selected"]);
  assert.deepEqual(trace.at(-1),["handler",[{value:7}]]);
  assert.deepEqual(calls.capabilities[0].config.inputSchema,{
    project:{from:"caller-override"},value:{type:"string"},
  },"project schema key supplied in config retains original override behavior");
  assert.equal(registrar.registeredToolCount,0);
});

test("MCP registrar delegates replay key and extra unchanged so same delivery cannot repeat a mutation", async () => {
  const events=[];
  const seen=new Map();
  const {registrar,calls}=makeRegistrar({
    mcpToolReplayGuard:{run:request=>{
      events.push(["replay",request.toolName,request.input,request.extra]);
      const key=JSON.stringify([request.toolName,request.input,request.extra]);
      if(seen.has(key))return seen.get(key);
      const result=Promise.resolve(request.invoke());
      seen.set(key,result);
      return result;
    }},
    noteManagedAgentCommand:async()=>events.push(["milestone"]),
  });
  let performed=0;
  const registered=registrar.registerRawTool("mutation",{annotations:{readOnlyHint:false}},async(input,extra)=>{
    performed++;
    events.push(["mutated",input,extra]);
    return {performed};
  },{mcpExposed:true,capability:false});
  const input={item:"fixture"},extra={requestId:"delivery-1"};
  const first=await registered.handler(input,extra);
  const repeated=await registered.handler(input,extra);
  const fresh=await registered.handler(input,{requestId:"delivery-2"});
  assert.deepEqual(first,{performed:1});
  assert.deepEqual(repeated,{performed:1});
  assert.deepEqual(fresh,{performed:2});
  assert.equal(performed,2);
  assert.equal(events.filter(([kind])=>kind==="milestone").length,2);
  assert.equal(events.filter(([kind])=>kind==="replay").length,3);
  assert.equal(events.filter(([kind])=>kind==="mutated").length,2);
  assert.equal(calls.capabilities.length,0);
  assert.equal(registrar.registeredToolCount,1);
});

test("registrar preserves raw image bytes, structured result, and exact text error/output adaptation", async () => {
  const {registrar,calls}=makeRegistrar();
  const image={type:"image",data:"fixture-only-b64",mimeType:"image/png"};
  const structured={content:[image,{type:"text",text:"original"}],structuredContent:{raw:true}};
  const bare={content:[image,{type:"text",text:"original"}]};
  const invalid={isError:true,content:[{type:"text",text:"denied"}]};
  const handlers=[async()=>structured,async()=>bare,async()=>invalid,async()=>null];
  for(let i=0;i<handlers.length;i++){
    registrar.registerTextTool("text_case_"+i,{
      annotations:{readOnlyHint:true},
      inputSchema:{},
    },handlers[i],{projectAware:false,capability:true});
  }
  assert.deepEqual(await calls.capabilities[0].invoke({}),structured);
  assert.deepEqual(await calls.capabilities[1].invoke({}),{
    ...bare,structuredContent:{text:"original"},
  });
  assert.deepEqual(await calls.capabilities[2].invoke({}),invalid);
  assert.equal(await calls.capabilities[3].invoke({}),null);
  assert.equal(calls.contexts.length,0);
  assert.equal(calls.locks.length,4,"nonproject text capabilities retain original lock planner");
  assert.equal(calls.mutationChecks.length,0);
  assert.equal(registrar.registeredToolCount,0);
});
