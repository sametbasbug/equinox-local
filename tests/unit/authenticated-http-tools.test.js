import test from "node:test";
import assert from "node:assert/strict";
import * as z from "zod/v4";

import { registerAuthenticatedHttpTools } from "../../src/authenticated-http-tools.js";

function makeHarness(overrides = {}) {
  const registrations = new Map();
  registerAuthenticatedHttpTools({
    registerTextTool(name, config, handler, options = {}) {
      registrations.set(name, { config, handler, options });
    },
    z,
    textResult: (text) => ({ text }),
    errorResult: (error) => ({ error: error instanceof Error ? error.message : String(error) }),
    getProfiles: async () => ({
      agentProfileManagementEnabled: true,
      profiles: [
        {
          id: "moltbook",
          label: "Moltbook",
          origin: "https://example.com",
          basePath: "/api/v1",
          authType: "bearer",
          authHeader: "authorization",
          allowedMethods: ["GET", "POST"],
          allowedPathPrefixes: ["/posts"],
          allowedAgentHeaders: ["x-client-version"],
          timeoutMs: 10_000,
          ready: false,
          needsCredential: true,
        },
      ],
    }),
    upsertProfile: async ({ profile }) => ({ ...profile, ready: false, needsCredential: true }),
    deleteProfile: async ({ profileId, requireAgentManagement }) => ({
      deleted: true,
      profileId,
      requireAgentManagement,
    }),
    request: async (input) => ({ ok: true, status: 200, received: input }),
    ...overrides,
  });
  return registrations;
}

test("authenticated HTTP tools expose four integration operations with conservative mutation routing", () => {
  const registrations = makeHarness();
  assert.deepEqual([...registrations.keys()].sort(), [
    "authenticated_http_request",
    "http_profile_delete",
    "http_profile_upsert",
    "http_profiles",
  ]);

  const list = registrations.get("http_profiles");
  assert.equal(list.config.annotations.readOnlyHint, true);
  assert.deepEqual(list.options.mutationScopes, []);
  assert.equal(list.options.capabilityDomain, "integrations");

  for (const name of ["http_profile_upsert", "http_profile_delete", "authenticated_http_request"]) {
    const registration = registrations.get(name);
    assert.equal(registration.config.annotations.readOnlyHint, false);
    assert.equal(registration.config.annotations.destructiveHint, true);
    assert.deepEqual(registration.options.mutationScopes, ["global"]);
    assert.equal(registration.options.capabilityDomain, "integrations");
  }

  const request = registrations.get("authenticated_http_request");
  assert.equal(request.config.annotations.idempotentHint, false);
  assert.equal(request.config.annotations.openWorldHint, true);
});

test("agent profile upsert schema has no credential-bearing field", () => {
  const upsert = makeHarness().get("http_profile_upsert");
  assert.equal(Object.hasOwn(upsert.config.inputSchema, "credential"), false);
  assert.equal(Object.hasOwn(upsert.config.inputSchema, "secret"), false);
  assert.equal(Object.hasOwn(upsert.config.inputSchema, "token"), false);

  const bearer = {
    id: "moltbook",
    label: "Moltbook",
    origin: "https://example.com",
    base_path: "/api/v1",
    auth: { type: "bearer" },
    allowed_methods: ["GET"],
    allowed_path_prefixes: ["/posts"],
    allowed_agent_headers: [],
    timeout_ms: 10_000,
  };

  for (const [key, schema] of Object.entries(upsert.config.inputSchema)) {
    if (key === "id") assert.equal(schema.safeParse(bearer.id).success, true);
  }
});

test("http_profiles filters safe metadata without credential material", async () => {
  const list = makeHarness().get("http_profiles");
  const result = await list.handler({ profile_id: "moltbook" });
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.agentProfileManagementEnabled, true);
  assert.equal(parsed.profiles.length, 1);
  assert.equal(parsed.profiles[0].id, "moltbook");
  assert.equal(JSON.stringify(parsed).includes("credential"), false);
});

test("profile delete always requires agent-management authorization", async () => {
  let received;
  const registration = makeHarness({
    deleteProfile: async (input) => {
      received = input;
      return { deleted: true, profileId: input.profileId };
    },
  }).get("http_profile_delete");

  const result = await registration.handler({ profile_id: "moltbook" });
  assert.deepEqual(received, { profileId: "moltbook", requireAgentManagement: true });
  assert.equal(JSON.parse(result.text).deleted, true);
});

test("authenticated request maps intent-only arguments to the bounded request engine", async () => {
  let received;
  const registration = makeHarness({
    request: async (input) => {
      received = input;
      return { ok: true, status: 204, headers: {}, body: null, truncated: false, durationMs: 1, responseId: "http_resp_11111111111111111111111111111111" };
    },
  }).get("authenticated_http_request");

  const result = await registration.handler({
    profile_id: "moltbook",
    method: "POST",
    path: "/posts",
    query: { draft: true },
    headers: { "x-client-version": "1" },
    body: { title: "hello" },
    response_bindings: [{
      target_json_pointer: "/verification_code",
      response_id: "http_resp_22222222222222222222222222222222",
      source_json_pointer: "/verification/code",
    }],
    timeout_ms: 5000,
  });

  assert.deepEqual(received, {
    profileId: "moltbook",
    method: "POST",
    path: "/posts",
    query: { draft: true },
    headers: { "x-client-version": "1" },
    body: { title: "hello" },
    response_bindings: [{
      target_json_pointer: "/verification_code",
      response_id: "http_resp_22222222222222222222222222222222",
      source_json_pointer: "/verification/code",
    }],
    timeout_ms: 5000,
  });
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.status, 204);
  assert.equal(parsed.response_id, "http_resp_11111111111111111111111111111111");
  assert.equal(Object.hasOwn(parsed, "responseId"), false);
  assert.match(registration.config.description, /response_bindings/u);
  assert.ok(registration.config.inputSchema.response_bindings);
});

test("authenticated HTTP tool schemas preserve exact profile IDs, method bounds and credential-free profile creation", () => {
  const registrations=makeHarness();
  const schema=name=>z.object(registrations.get(name).config.inputSchema);
  const upsert=schema("http_profile_upsert");
  const sample={
    id:"fixture-1",label:"Safe test",origin:"https://example.invalid",
    auth:{type:"bearer"},allowed_methods:["GET"],
  };
  const parsed=upsert.safeParse(sample);
  assert.equal(parsed.success,true);
  assert.deepEqual(parsed.data,{
    ...sample,base_path:"/",allowed_path_prefixes:["/"],
    allowed_agent_headers:[],timeout_ms:10_000,
  });
  assert.equal(Object.hasOwn(parsed.data,"credential"),false);
  assert.equal(Object.hasOwn(parsed.data,"secret"),false);
  assert.equal(Object.hasOwn(parsed.data,"token"),false);
  // Client attempts to pass a credential do not become part of the parsed
  // upsert data forwarded by the server tool registration.
  const extra=upsert.safeParse({...sample,credential:"fixture-only",secret:"fixture-only",token:"fixture-only"});
  assert.equal(extra.success,true);
  assert.deepEqual(extra.data,parsed.data);
  for(const id of ["", "Uppercase","../escape","-leading","ab/slash","x".repeat(65)]) {
    assert.equal(upsert.safeParse({...sample,id}).success,false,id);
    assert.equal(schema("http_profiles").safeParse({profile_id:id}).success,false,id);
    assert.equal(schema("http_profile_delete").safeParse({profile_id:id}).success,false,id);
    assert.equal(schema("authenticated_http_request").safeParse({profile_id:id,method:"GET",path:"/"}).success,false,id);
  }
  for(const auth of [
    {type:"bearer",token:"fixture-only"},
    {type:"secret_header",header_name:""},
    {type:"secret_header",header_name:"x".repeat(129)},
    {type:"secret_header",header_name:"x-key",credential:"fixture-only"},
    {type:"unsupported"},
  ])assert.equal(upsert.safeParse({...sample,auth}).success,false,JSON.stringify(auth));
  assert.equal(upsert.safeParse({...sample,auth:{type:"secret_header",header_name:"x-api-key"}}).success,true);
  for(const method of ["HEAD","OPTIONS","TRACE","CONNECT","POST x"]) {
    assert.equal(schema("authenticated_http_request").safeParse({profile_id:sample.id,method,path:"/"}).success,false,method);
  }
  const opts=Object.fromEntries([...registrations].map(([name,entry])=>[name,entry.options]));
  assert.deepEqual(opts,{
    http_profiles:{projectAware:false,mutationScopes:[],capabilityDomain:"integrations"},
    http_profile_upsert:{projectAware:false,mutationScopes:["global"],capabilityDomain:"integrations"},
    http_profile_delete:{projectAware:false,mutationScopes:["global"],capabilityDomain:"integrations"},
    authenticated_http_request:{projectAware:false,mutationScopes:["global"],capabilityDomain:"integrations"},
  });
});

test("authenticated HTTP bounded schema rejects oversized paths, response references, headers and query values before engine dispatch", () => {
  const registrations=makeHarness();
  const schema=name=>z.object(registrations.get(name).config.inputSchema);
  const request=schema("authenticated_http_request");
  const input={profile_id:"fixture",method:"POST",path:"/bounded"};
  assert.deepEqual(request.parse(input),{
    ...input,query:{},headers:{},
  });
  for(const bad of [
    {path:""},
    {path:"/".repeat(2049)},
    {timeout_ms:999},
    {timeout_ms:30_001},
    {timeout_ms:4.5},
    {timeout_ms:"5000"},
    {headers:{"x-test":"x".repeat(8193)}},
    {headers:{"": "test"}},
    {query:{"": "test"}},
    {query:{"x":"x".repeat(4097)}},
    {query:{"x":null}},
    {response_bindings:[{target_json_pointer:"/x",response_id:"http_resp_nothex",source_json_pointer:"/value"}]},
    {response_bindings:[{target_json_pointer:"",response_id:"http_resp_"+'a'.repeat(32),source_json_pointer:""}]},
    {response_bindings:Array.from({length:65},()=>({target_json_pointer:"/x",response_id:"http_resp_"+'b'.repeat(32),source_json_pointer:""}))},
  ])assert.equal(request.safeParse({...input,...bad}).success,false,JSON.stringify(Object.keys(bad)));
  assert.equal(request.safeParse({...input,timeout_ms:30_000,response_bindings:[{
    target_json_pointer:"/code",response_id:"http_resp_"+'c'.repeat(32),source_json_pointer:"/data/code",
  }]}).success,true);
  const upsert=schema("http_profile_upsert");
  const profile={id:"p",label:"P",origin:"https://example.invalid",auth:{type:"bearer"},allowed_methods:["GET"]};
  assert.equal(upsert.safeParse({...profile,allowed_methods:[]}).success,false);
  assert.equal(upsert.safeParse({...profile,allowed_methods:["HEAD"]}).success,false);
  assert.equal(upsert.safeParse({...profile,allowed_path_prefixes:Array(33).fill("/")}).success,false);
  assert.equal(upsert.safeParse({...profile,allowed_agent_headers:Array(17).fill("x-header")}).success,false);
  assert.equal(upsert.safeParse({...profile,timeout_ms:30_001}).success,false);
  assert.equal(upsert.safeParse({...profile,timeout_ms:1_000}).success,true);
});

test("authenticated HTTP profile tools forward only bounded intent, use required agent delete flag, and never retry failures", async () => {
  const trace=[];
  const registrations=makeHarness({
    getProfiles:async()=>{trace.push(["list"]);return {agentProfileManagementEnabled:false,profiles:[
      {id:"one",ready:false},{id:"two",ready:true},
    ]}},
    upsertProfile:async input=>{trace.push(["upsert",input]);throw Error("agent management disabled")},
    deleteProfile:async input=>{trace.push(["delete",input]);throw Error("agent management disabled")},
    request:async input=>{trace.push(["request",input]);throw Error("request denied by profile policy")},
  });
  const listed=await registrations.get("http_profiles").handler({profile_id:"two"});
  assert.deepEqual(JSON.parse(listed.text),{
    agentProfileManagementEnabled:false,profiles:[{id:"two",ready:true}],
  });
  const upsertInput={
    id:"two",label:"Demo",origin:"https://example.invalid",base_path:"/",
    auth:{type:"bearer"},allowed_methods:["GET"],allowed_path_prefixes:["/"],
    allowed_agent_headers:[],timeout_ms:10_000,
  };
  const updated=await registrations.get("http_profile_upsert").handler(upsertInput);
  assert.equal(updated.error,"agent management disabled");
  const deleted=await registrations.get("http_profile_delete").handler({profile_id:"two"});
  assert.equal(deleted.error,"agent management disabled");
  const requested=await registrations.get("authenticated_http_request").handler({
    profile_id:"two",method:"GET",path:"/safe",query:{},headers:{},body:undefined,
    response_bindings:undefined,timeout_ms:undefined,
  });
  assert.equal(requested.error,"request denied by profile policy");
  assert.deepEqual(trace,[
    ["list"],
    ["upsert",{profile:upsertInput}],
    ["delete",{profileId:"two",requireAgentManagement:true}],
    ["request",{profileId:"two",method:"GET",path:"/safe",query:{},headers:{},
      body:undefined,response_bindings:undefined,timeout_ms:undefined}],
  ]);
});

test("authenticated HTTP request exposes only response_id alias and refuses to invent credentials or retry formatting errors", async () => {
  let calls=0;
  const responseId="http_resp_"+'d'.repeat(32);
  const registrations=makeHarness({
    request:async()=>{calls++;return {
      ok:true,status:200,responseId,body:"safe-fixture",truncated:false,
    }},
    textResult:()=>{throw Error("controlled serializer refusal")},
  });
  const formatted=await registrations.get("authenticated_http_request").handler({
    profile_id:"fixture",method:"GET",path:"/",query:{},headers:{},
  });
  assert.equal(formatted.error,"controlled serializer refusal");
  assert.equal(calls,1);
  const successful=makeHarness({request:async()=>({
    ok:true,status:204,responseId,body:null,headers:{},
  })});
  const result=await successful.get("authenticated_http_request").handler({
    profile_id:"fixture",method:"GET",path:"/",query:{},headers:{},
  });
  const parsed=JSON.parse(result.text);
  assert.equal(parsed.response_id,responseId);
  assert.equal(Object.hasOwn(parsed,"responseId"),false);
  assert.equal(Object.hasOwn(parsed,"credential"),false);
});
