import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHENTICATED_HTTP_RESPONSE_REFERENCE_LIMITS,
  applyAuthenticatedHttpResponseBindings,
  createAuthenticatedHttpResponseReferenceStore,
  resolveAuthenticatedHttpResponseReferences,
} from "../../src/authenticated-http-response-references.js";

function deterministicRandom() {
  let counter = 0;
  return (size) => {
    counter += 1;
    return Buffer.alloc(size, counter);
  };
}

test("response reference store resolves RFC 6901 object and array paths with fixed trust binding", () => {
  const store = createAuthenticatedHttpResponseReferenceStore({ randomBytesImpl: deterministicRandom() });
  const responseId = store.capture({
    profileId: "moltbook",
    trustIdentity: "https://www.moltbook.com\nbearer\nauthorization",
    body: {
      post: {
        values: [{ "a/b": { "~key": "opaque-123" } }],
      },
    },
  });

  assert.match(responseId, /^http_resp_[a-f0-9]{32}$/u);
  assert.equal(store.resolve({
    responseId,
    profileId: "moltbook",
    trustIdentity: "https://www.moltbook.com\nbearer\nauthorization",
    jsonPointer: "/post/values/0/a~1b/~0key",
  }), "opaque-123");

  assert.throws(() => store.resolve({
    responseId,
    profileId: "moltbook",
    trustIdentity: "https://api.example.com\nbearer\nauthorization",
    jsonPointer: "/post/values/0/a~1b/~0key",
  }), /trust identity/u);

  assert.throws(() => store.resolve({
    responseId,
    profileId: "another-profile",
    trustIdentity: "https://www.moltbook.com\nbearer\nauthorization",
    jsonPointer: "/post/values/0/a~1b/~0key",
  }), /trust identity/u);
});

test("response reference store expires entries without extending TTL on use", () => {
  let now = 1000;
  const store = createAuthenticatedHttpResponseReferenceStore({
    ttlMs: 100,
    now: () => now,
    randomBytesImpl: deterministicRandom(),
  });
  const responseId = store.capture({
    profileId: "moltbook",
    trustIdentity: "trust",
    body: { code: "opaque" },
  });

  now = 1050;
  assert.equal(store.resolve({
    responseId,
    profileId: "moltbook",
    trustIdentity: "trust",
    jsonPointer: "/code",
  }), "opaque");

  now = 1100;
  assert.throws(() => store.resolve({
    responseId,
    profileId: "moltbook",
    trustIdentity: "trust",
    jsonPointer: "/code",
  }), /expired/u);
  assert.equal(store.snapshot().entries, 0);
});

test("response reference store is LRU bounded by entry count and total bytes", () => {
  const store = createAuthenticatedHttpResponseReferenceStore({
    maxEntries: 2,
    maxBytes: 80,
    randomBytesImpl: deterministicRandom(),
  });
  const one = store.capture({ profileId: "p", trustIdentity: "t", body: { code: "one" } });
  const two = store.capture({ profileId: "p", trustIdentity: "t", body: { code: "two" } });
  assert.equal(store.resolve({ responseId: one, profileId: "p", trustIdentity: "t", jsonPointer: "/code" }), "one");
  const three = store.capture({ profileId: "p", trustIdentity: "t", body: { code: "three" } });

  assert.throws(() => store.resolve({ responseId: two, profileId: "p", trustIdentity: "t", jsonPointer: "/code" }), /unknown or expired/u);
  assert.equal(store.resolve({ responseId: one, profileId: "p", trustIdentity: "t", jsonPointer: "/code" }), "one");
  assert.equal(store.resolve({ responseId: three, profileId: "p", trustIdentity: "t", jsonPointer: "/code" }), "three");
  assert.equal(store.snapshot().entries, 2);
  assert.ok(store.snapshot().totalBytes <= 80);
});

test("strict response reference shape resolves only strings and fails closed on malformed pointers", () => {
  const store = createAuthenticatedHttpResponseReferenceStore({ randomBytesImpl: deterministicRandom() });
  const responseId = store.capture({
    profileId: "moltbook",
    trustIdentity: "trust",
    body: { code: "opaque", count: 3, list: ["value"] },
  });

  const resolved = resolveAuthenticatedHttpResponseReferences({
    verification_code: {
      $equinox_response_ref: {
        response_id: responseId,
        json_pointer: "/code",
      },
    },
  }, {
    profileId: "moltbook",
    trustIdentity: "trust",
    responseStore: store,
  });
  assert.deepEqual(resolved.value, { verification_code: "opaque" });
  assert.deepEqual(resolved.redactions, ["opaque"]);
  assert.equal(resolved.refsResolved, 1);

  assert.throws(() => resolveAuthenticatedHttpResponseReferences({
    $equinox_response_ref: { response_id: responseId, json_pointer: "/code" },
    extra: true,
  }, { profileId: "moltbook", trustIdentity: "trust", responseStore: store }), /must not contain extra fields/u);

  assert.throws(() => resolveAuthenticatedHttpResponseReferences({
    $equinox_response_ref: { response_id: responseId, json_pointer: "/count" },
  }, { profileId: "moltbook", trustIdentity: "trust", responseStore: store }), /only to string/u);

  assert.throws(() => resolveAuthenticatedHttpResponseReferences({
    $equinox_response_ref: { response_id: responseId, json_pointer: "/bad~2escape" },
  }, { profileId: "moltbook", trustIdentity: "trust", responseStore: store }), /invalid escaping/u);
});

test("response reference resolver enforces traversal and per-request ref bounds", () => {
  const store = createAuthenticatedHttpResponseReferenceStore({ randomBytesImpl: deterministicRandom() });
  const responseId = store.capture({ profileId: "p", trustIdentity: "t", body: { value: "x" } });
  let deep = "leaf";
  for (let index = 0; index <= AUTHENTICATED_HTTP_RESPONSE_REFERENCE_LIMITS.maxTraversalDepth + 1; index += 1) {
    deep = { nested: deep };
  }
  assert.throws(
    () => resolveAuthenticatedHttpResponseReferences(deep, { profileId: "p", trustIdentity: "t", responseStore: store }),
    /too deeply nested/u,
  );

  const refs = Array.from({ length: AUTHENTICATED_HTTP_RESPONSE_REFERENCE_LIMITS.maxRefsPerRequest + 1 }, () => ({
    $equinox_response_ref: { response_id: responseId, json_pointer: "/value" },
  }));
  assert.throws(
    () => resolveAuthenticatedHttpResponseReferences(refs, { profileId: "p", trustIdentity: "t", responseStore: store }),
    /too many response references/u,
  );
});


test("body-external bindings inject a same-trust response string without overwriting agent body", () => {
  const store = createAuthenticatedHttpResponseReferenceStore({ randomBytesImpl: deterministicRandom() });
  const responseId = store.capture({
    profileId: "moltbook",
    trustIdentity: "trust",
    body: { post: { verification: { verification_code: "opaque-code" } } },
  });
  const result = applyAuthenticatedHttpResponseBindings(
    { answer: "46.00", nested: {} },
    [{
      target_json_pointer: "/verification_code",
      response_id: responseId,
      source_json_pointer: "/post/verification/verification_code",
    }],
    { profileId: "moltbook", trustIdentity: "trust", responseStore: store },
  );
  assert.deepEqual(result.value, { answer: "46.00", nested: {}, verification_code: "opaque-code" });
  assert.deepEqual(result.redactions, ["opaque-code"]);
  assert.equal(result.bindingsResolved, 1);
});

test("body-external bindings fail closed on unsafe, missing, duplicate, array, root and overwrite targets", () => {
  const store = createAuthenticatedHttpResponseReferenceStore({ randomBytesImpl: deterministicRandom() });
  const responseId = store.capture({ profileId: "p", trustIdentity: "t", body: { code: "opaque" } });
  const base = { nested: {}, existing: "agent", array: [{}] };
  const make = (target_json_pointer) => [{
    target_json_pointer,
    response_id: responseId,
    source_json_pointer: "/code",
  }];
  const ctx = { profileId: "p", trustIdentity: "t", responseStore: store };

  assert.throws(() => applyAuthenticatedHttpResponseBindings(base, make(""), ctx), /cannot replace the body root/u);
  assert.throws(() => applyAuthenticatedHttpResponseBindings(base, make("/__proto__/x"), ctx), /forbidden segment/u);
  assert.throws(() => applyAuthenticatedHttpResponseBindings(base, make("/missing/value"), ctx), /parent does not exist/u);
  assert.throws(() => applyAuthenticatedHttpResponseBindings(base, make("/existing"), ctx), /cannot be overwritten/u);
  assert.throws(() => applyAuthenticatedHttpResponseBindings(base, make("/array/0/value"), ctx), /arrays are not supported/u);
  assert.throws(() => applyAuthenticatedHttpResponseBindings(base, [...make("/nested/a"), ...make("/nested/a")], ctx), /same JSON Pointer twice/u);
  assert.throws(() => applyAuthenticatedHttpResponseBindings("text", make("/code"), ctx), /require a JSON object/u);
});

test("response reference store rejects invalid bounds, random IDs and unrepresentable body without exposing data", () => {
  for(const key of ["ttlMs","maxEntries","maxBytes"]){
    for(const value of [-1,0,1.1,"1",null,NaN,Infinity]){
      assert.throws(()=>createAuthenticatedHttpResponseReferenceStore({[key]:value}),/positive integer/u,String(value));
    }
  }
  let attempts=0;
  const sameId=Buffer.alloc(16,0xaa);
  const store=createAuthenticatedHttpResponseReferenceStore({
    randomBytesImpl:()=>{attempts++;return sameId;},
  });
  const first=store.capture({profileId:"p",trustIdentity:"trust",body:{code:"synthetic"}});
  assert.match(first,/^http_resp_[a-f0-9]{32}$/u);
  assert.throws(()=>store.capture({profileId:"p",trustIdentity:"trust",body:{code:"other"}}),/id generation failed/u);
  assert.equal(attempts,9);
  assert.deepEqual(store.snapshot().entries,1);
  for(const body of [undefined,()=>{},BigInt(1),{value:BigInt(1)}]){
    assert.throws(()=>store.capture({profileId:"p",trustIdentity:"trust",body}),/not JSON-compatible/u);
  }
  assert.throws(()=>store.capture({profileId:"",trustIdentity:"trust",body:{}}),/profile is invalid/u);
  assert.throws(()=>store.capture({profileId:"p",trustIdentity:"",body:{}}),/trust identity is invalid/u);
  assert.equal(store.snapshot().entries,1);
});

test("response IDs are profile/trust isolated, expire on exact TTL, and purge affects only its profile",()=>{
  let clock=10_000;
  const store=createAuthenticatedHttpResponseReferenceStore({
    ttlMs:100,maxEntries:3,maxBytes:200,now:()=>clock,randomBytesImpl:deterministicRandom(),
  });
  const id1=store.capture({profileId:"p1",trustIdentity:"signed-a",body:{code:"secret-fixture-1"}});
  const id2=store.capture({profileId:"p2",trustIdentity:"signed-b",body:{code:"secret-fixture-2"}});
  const before=store.snapshot();
  assert.equal(before.entries,2);
  assert.equal(store.resolve({responseId:id1,profileId:"p1",trustIdentity:"signed-a",jsonPointer:"/code"}),"secret-fixture-1");
  for(const input of [
    {responseId:id1,profileId:"p1",trustIdentity:"changed",jsonPointer:"/code"},
    {responseId:id1,profileId:"p2",trustIdentity:"signed-a",jsonPointer:"/code"},
    {responseId:"http_resp_"+'A'.repeat(32),profileId:"p1",trustIdentity:"signed-a",jsonPointer:"/code"},
    {responseId:"../"+id1,profileId:"p1",trustIdentity:"signed-a",jsonPointer:"/code"},
  ]){
    assert.throws(()=>store.resolve(input),/trust identity|id is invalid/u);
  }
  assert.equal(store.purgeProfile("p1"),1);
  assert.equal(store.purgeProfile("p1"),0);
  assert.equal(store.snapshot().entries,1);
  assert.throws(()=>store.resolve({responseId:id1,profileId:"p1",trustIdentity:"signed-a",jsonPointer:"/code"}),/unknown or expired/u);
  clock=10_100;
  assert.throws(()=>store.resolve({responseId:id2,profileId:"p2",trustIdentity:"signed-b",jsonPointer:"/code"}),/expired/u);
  assert.equal(store.snapshot().entries,0);
  assert.doesNotMatch(JSON.stringify(store.snapshot()),/secret-fixture/u);
});

test("response binding validation rejects prototype pollution, duplicates and malicious pointers before touching resolver",()=>{
  const trace=[];
  const responseStore={resolve(input){trace.push(input);return "synthetic-secret"}};
  const ctx={profileId:"p",trustIdentity:"origin/bearer",responseStore};
  const base={safe:{},untouched:"fixture",array:[{}]};
  const bind=(target)=>[{target_json_pointer:target,response_id:"http_resp_"+'a'.repeat(32),source_json_pointer:"/code"}];
  const forbidden=[
    "/__proto__/pollute","/constructor/x","/prototype/x",
    "/safe/__proto__/pollute","/safe/constructor/value","/safe/prototype/value",
    "", "/bad~2escape", "bad", "/".repeat(2050),
  ];
  for(const target of forbidden){
    assert.throws(()=>applyAuthenticatedHttpResponseBindings(base,bind(target),ctx),Error,target);
  }
  assert.throws(()=>applyAuthenticatedHttpResponseBindings(base,[...bind("/safe/code"),...bind("/safe/code")],ctx),/same JSON Pointer twice/u);
  assert.throws(()=>applyAuthenticatedHttpResponseBindings(base,Array.from({length:65},()=>bind("/safe/x")[0]),ctx),/too many response bindings/u);
  assert.equal(trace.length,0,"invalid target validation must not access prior sensitive response values");
  assert.equal(Object.getPrototypeOf(base),Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype,"pollute"),false);
  assert.deepEqual(base,{safe:{},untouched:"fixture",array:[{}]});
});

test("response bindings clone existing body, preserve source, produce unique redactions and reject overwrites",()=>{
  const store=createAuthenticatedHttpResponseReferenceStore({randomBytesImpl:deterministicRandom()});
  const responseId=store.capture({profileId:"p",trustIdentity:"t",body:{code:"synthetic",alt:"synthetic"}});
  const input={safe:{},another:{},unmodified:"keep"};
  const bindings=[
    {target_json_pointer:"/safe/code",response_id:responseId,source_json_pointer:"/code"},
    {target_json_pointer:"/another/code",response_id:responseId,source_json_pointer:"/alt"},
  ];
  const ctx={profileId:"p",trustIdentity:"t",responseStore:store};
  const result=applyAuthenticatedHttpResponseBindings(input,bindings,ctx);
  assert.equal(result.bindingsResolved,2);
  assert.deepEqual(result.redactions,["synthetic"]);
  assert.deepEqual(result.value,{safe:{code:"synthetic"},another:{code:"synthetic"},unmodified:"keep"});
  assert.deepEqual(input,{safe:{},another:{},unmodified:"keep"});
  assert.equal(Object.isFrozen(result),true);
  assert.throws(()=>applyAuthenticatedHttpResponseBindings(result.value,bindings,ctx),/cannot be overwritten/u);
  const pointerErrors=["/array/01","/array/-1","/array/999","/bad~4","array/0",'/'+ 'x'.repeat(2050)];
  for(const jsonPointer of pointerErrors)assert.throws(()=>store.resolve({
    responseId,profileId:"p",trustIdentity:"t",jsonPointer,
  }),Error,jsonPointer);
});
