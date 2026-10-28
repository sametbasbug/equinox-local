import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createEquinoxLocalMainChannelNotice, createEquinoxLocalSignedMainNativeNotice } from "../../src/equinox-local-update-awareness.js";
import { createSignedMainInstallPointer, validateSignedMainInstallPointer } from "../../src/equinox-local-main-install-pointer.js";
const SHA = "a".repeat(40);
const makeResponse = (value) => new Response(JSON.stringify(value), { status: 200 });

test("Stable Main information accepts only the public admitted commit-tag target and caches checks", async () => {
  let calls = 0;
  let clock = Date.parse("2026-10-08T12:00:00.000Z");
  const notice = createEquinoxLocalMainChannelNotice({
    now: () => new Date(clock),
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, "https://api.github.com/repos/sametbasbug/equinox-local/git/ref/tags/main-snapshot");
      assert.equal(options.credentials, "omit");
      return makeResponse({ ref: "refs/tags/main-snapshot", object: { type: "commit", sha: SHA } });
    },
  });
  assert.equal(notice.snapshot().targetSha, null);
  assert.equal((await notice.check()).targetSha, SHA);
  await notice.check();
  assert.equal(calls, 1);
  clock += 6 * 60 * 60_000 + 1;
  await notice.check();
  assert.equal(calls, 2);
});

test("Main informational check fails closed on invalid tags and network errors", async () => {
  let count = 0;
  const notice = createEquinoxLocalMainChannelNotice({
    fetchImpl: async () => ++count === 1
      ? makeResponse({ ref: "refs/tags/main-snapshot", object: { type: "tag", sha: SHA } })
      : Promise.reject(new Error("offline")),
  });
  assert.equal((await notice.check()).targetSha, null);
  assert.match(notice.snapshot().lastError, /unavailable/u);
  assert.equal((await notice.check({ force: true })).targetSha, null);
  assert.equal(count, 2);
});

test("Parallel Main notice checks share one in-flight request", async () => {
  let calls = 0;
  const notice = createEquinoxLocalMainChannelNotice({ fetchImpl: async () => { calls++; return makeResponse({ ref: "refs/tags/main-snapshot", object: { type: "commit", sha: SHA } }); } });
  const [a, b] = await Promise.all([notice.check(), notice.check()]);
  assert.equal(calls, 1);
  assert.equal(a.targetSha, b.targetSha);
});

test("informational Main notice rejects oversized streamed payloads and malformed JSON without exposing stale SHA",async()=>{
  let requests=0;
  const notice=createEquinoxLocalMainChannelNotice({
    fetchImpl:async()=>{
      requests++;
      if(requests===1) return makeResponse({ref:"refs/tags/main-snapshot",object:{type:"commit",sha:SHA}});
      return requests===2
        ? new Response("x".repeat(8193),{status:200})
        : new Response("{not-json",{status:200});
    }
  });
  assert.equal((await notice.check()).targetSha,SHA);
  const oversized=await notice.check({force:true});
  assert.equal(oversized.targetSha,null);
  assert.equal(oversized.lastError,"Main channel check unavailable.");
  const malformed=await notice.check({force:true});
  assert.equal(malformed.targetSha,null);
  assert.equal(requests,3);
});

test("informational Main notice denies noncommit, malformed and noncanonical snapshot identities",async()=>{
  const unsafe=[
    null,[],
    {ref:"refs/heads/main",object:{type:"commit",sha:SHA}},
    {ref:"refs/tags/main-snapshot",object:{type:"tag",sha:SHA}},
    {ref:"refs/tags/main-snapshot",object:{type:"commit",sha:SHA.toUpperCase().replaceAll("A","F")}},
    {ref:"refs/tags/main-snapshot",object:{type:"commit",sha:"a".repeat(39)}},
    {ref:"refs/tags/main-snapshot",object:{type:"commit",sha:1}},
    {ref:"refs/tags/main-snapshot",object:null},
  ];
  let calls=0;
  const notice=createEquinoxLocalMainChannelNotice({
    fetchImpl:async()=>makeResponse(unsafe[calls++]),
  });
  for(const _case of unsafe){
    const state=await notice.check({force:true});
    assert.equal(state.targetSha,null);
    assert.equal(state.lastError,"Main channel check unavailable.");
  }
  assert.equal(calls,unsafe.length);
});

test("informational Main notice refreshes a cached SHA only after expiry or explicit force, and clears it on failure",async()=>{
  let clock=Date.parse("2026-10-19T16:00:00.000Z"),calls=0;
  const notice=createEquinoxLocalMainChannelNotice({
    now:()=>new Date(clock),
    fetchImpl:async()=>{
      calls++;
      if(calls===1) return makeResponse({ref:"refs/tags/main-snapshot",object:{type:"commit",sha:SHA}});
      throw Error("private network credentials must not appear in notice");
    }
  });
  assert.equal((await notice.check()).targetSha,SHA);
  clock+=6*60*60_000-1;
  assert.equal((await notice.check()).targetSha,SHA);
  assert.equal(calls,1);
  clock+=2;
  const expired=await notice.check();
  assert.equal(expired.targetSha,null);
  assert.equal(expired.lastError,"Main channel check unavailable.");
  assert.doesNotMatch(JSON.stringify(expired),/private network credentials/u);
  assert.equal(calls,2);
});


function ephemeralSignedMain(sha=SHA,version="6.2.1"){
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 const keyId="test-notice-original-ed25519";
 const pointer=createSignedMainInstallPointer({
  sourceSha:sha,version,keyId,privateKey,publishedAt:"2026-10-28T00:00:00.000Z",
  nativeManifests:["darwin-arm64","darwin-x64","win32-arm64","win32-x64"].map(target=>({
   schemaVersion:1,channel:"main",sourceSha:sha,target,
   runtimeContractSha256:"c".repeat(64),
   artifact:{name:"equinox-local-main-"+sha+"-"+target+
    (target.startsWith("win32-")?".zip":".tar.gz"),sha256:"d".repeat(64),bytes:42},
  })),
 });
 return {pointer,verify:(raw)=>validateSignedMainInstallPointer(raw,{
  publicKeys:{[keyId]:publicKey.export({type:"spki",format:"pem"})},
 })};
}

test("managed-native Main notice uses production signed full SHA, not same displayed semver or GitHub tag",async()=>{
 const {pointer,verify}=ephemeralSignedMain("b".repeat(40),"6.2.1");
 let calls=0;
 const notice=createEquinoxLocalSignedMainNativeNotice({
  installedSha:SHA,target:"darwin-arm64",verifyPointerImpl:verify,
  fetchImpl:async(url,opts)=>{
   calls++;
   assert.equal(url,"https://main.local.sametbasbug.dev/latest/main.json");
   assert.equal(opts.redirect,"error");
   assert.equal(opts.credentials,"omit");
   return makeResponse(pointer);
  },
 });
 assert.equal(notice.snapshot().status,"unknown");
 const result=await notice.check();
 assert.equal(result.status,"available");
 assert.equal(result.installedSha,SHA);
 assert.equal(result.targetSha,"b".repeat(40));
 assert.equal(result.version,"6.2.1");
 assert.equal(result.lastError,null);
 await notice.check();
 assert.equal(calls,1);
});

test("managed-native Main notice treats EXACT same source SHA as up to date",async()=>{
 const {pointer,verify}=ephemeralSignedMain();
 const notice=createEquinoxLocalSignedMainNativeNotice({
  installedSha:SHA,target:"darwin-x64",verifyPointerImpl:verify,
  fetchImpl:async()=>makeResponse(pointer),
 });
 assert.equal((await notice.check()).status,"up_to_date");
 assert.equal(notice.snapshot().targetSha,SHA);
});

test("managed-native Main notice fails closed for tampered signature, wrong target, oversized selector and network failure",async()=>{
 const {pointer,verify}=ephemeralSignedMain("b".repeat(40));
 const forged={...pointer,sourceSha:"f".repeat(40)};
 let count=0;
 const notice=createEquinoxLocalSignedMainNativeNotice({
  installedSha:SHA,target:"darwin-arm64",verifyPointerImpl:verify,
  fetchImpl:async()=>{
   count++;
   if(count===1)return makeResponse(pointer);
   if(count===2)return makeResponse(forged);
   if(count===3)return new Response("x".repeat(16385),{status:200});
   throw Error("network inaccessible");
  },
 });
 assert.equal((await notice.check()).status,"available");
 for(let i=0;i<3;i++){
  const result=await notice.check({force:true});
  assert.equal(result.status,"unavailable");
  assert.equal(result.targetSha,null);
  assert.equal(result.version,null);
  assert.match(result.lastError,/unavailable/u);
 }
 assert.equal(count,4);
 assert.throws(()=>createEquinoxLocalSignedMainNativeNotice({
  installedSha:"bad",target:"darwin-arm64",
 }),/requires an exact installed SHA/u);
 assert.throws(()=>createEquinoxLocalSignedMainNativeNotice({
  installedSha:SHA,target:"darwin-ia32",
 }),/requires an exact installed SHA/u);
});

test("parallel native Main checks share a single bounded immutable signed-pointer request",async()=>{
 const {pointer,verify}=ephemeralSignedMain("b".repeat(40));
 let calls=0;
 const notice=createEquinoxLocalSignedMainNativeNotice({
  installedSha:SHA,target:"win32-arm64",verifyPointerImpl:verify,
  fetchImpl:async()=>{calls++;return makeResponse(pointer)},
 });
 const [a,b]=await Promise.all([notice.check(),notice.check()]);
 assert.equal(calls,1);
 assert.deepEqual(a,b);
});
