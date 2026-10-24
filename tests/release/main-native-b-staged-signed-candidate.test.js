import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {inspectSignedEquinoxLocalMainNativeCandidate} from '../../src/equinox-local-main-native-candidate.js';
import {createSignedMainNativeBAuthorization} from '../../src/equinox-local-main-native-b-authorization.js';
import {fingerprintEquinoxLocalNativeState} from '../../src/equinox-local-native-state-fingerprint.js';

const oldA = 'a'.repeat(40);
const bSha = 'b'.repeat(40);
const contract = 'c'.repeat(64);
const digest = 'd'.repeat(64);
const {privateKey,publicKey} = generateKeyPairSync('ed25519');
const testKeyId = 'cp338-ephemeral-only';
const publicKeys = {[testKeyId]: publicKey.export({format:'pem',type:'spki'}).toString()};

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'el-main-signed-b-')));
  t.after(async()=>fs.rm(root,{recursive:true,force:true}));
  const releaseDir = path.join(root,'native-release');
  await fs.mkdir(path.join(releaseDir,'runtime','node','bin'),{recursive:true});
  await fs.mkdir(path.join(releaseDir,'runtime','shell'),{recursive:true});
  await fs.writeFile(path.join(releaseDir,'release.json'),'{}');
  await fs.writeFile(path.join(releaseDir,'runtime','node','bin','node.exe'),'native B node bytes');
  await fs.writeFile(path.join(releaseDir,'runtime','shell','EquinoxLocal.exe'),'native B WPF bytes');
  const tree = await fingerprintEquinoxLocalNativeState(releaseDir);
  const candidate = Object.freeze({
    sourceSha:bSha,target:'win32-x64',transactionId:'main-'+'a'.repeat(32),
    runtimeContractSha256:contract, artifactSha256:digest,artifactBytes:2048,
    releaseDir,reused:false,payloadVersion:'6.2.0',tree:{},metadata:{},
  });
  const payload = Object.freeze({
    schemaVersion:2,channel:'main',sourceSha:bSha,
    target:'win32-x64',runtimeContractSha256:contract,
    artifact:{sha256:digest,bytes:2048},
    releaseFingerprint:{sha256:tree.sha256,entries:tree.entries,bytes:tree.bytes},
  });
  const signed=createSignedMainNativeBAuthorization(payload,{keyId:testKeyId,privateKey});
  return {root,releaseDir,tree,candidate,signed};
}

test('prepared B is accepted ONLY with matching original A, signed B, actual archive identity and measured native bytes',async(t)=>{
  const f=await fixture(t);
  const result=await inspectSignedEquinoxLocalMainNativeCandidate({
    previousSourceSha:oldA,candidate:f.candidate,authorization:f.signed,publicKeys,
  });
  assert.equal(result.signedKeyId,testKeyId);
  assert.equal(result.artifactSha256,digest);
  assert.deepEqual(result.fingerprint,f.tree);
  // A test-only signature must NEVER pass the product's shipped public root.
  await assert.rejects(inspectSignedEquinoxLocalMainNativeCandidate({
    previousSourceSha:oldA,candidate:f.candidate,authorization:f.signed,
  }),/not trusted/u);
});

test('read-only signed B admission rejects no envelope, altered old A, source, architecture, contract or ZIP identity',async(t)=>{
  const f=await fixture(t);
  for(const [name,options] of [
    ['missing',{authorization:null}],
    ['identical predecessor',{previousSourceSha:bSha}],
    ['wrong B',{candidate:{...f.candidate,sourceSha:'1'.repeat(40)}}],
    ['wrong arch',{candidate:{...f.candidate,target:'win32-arm64'}}],
    ['wrong contract',{candidate:{...f.candidate,runtimeContractSha256:'2'.repeat(64)}}],
    ['wrong archive digest',{candidate:{...f.candidate,artifactSha256:'3'.repeat(64)}}],
    ['wrong archive bytes',{candidate:{...f.candidate,artifactBytes:2049}}],
    ['foreign target',{candidate:{...f.candidate,target:'darwin-arm64'}}],
  ]){
    await assert.rejects(inspectSignedEquinoxLocalMainNativeCandidate({
      previousSourceSha:oldA,candidate:f.candidate,authorization:f.signed,publicKeys,...options,
    }),undefined,name);
  }
  assert.equal(await fs.readFile(path.join(f.releaseDir,'runtime','node','bin','node.exe'),'utf8'),'native B node bytes');
});

test('native tree tamper after signing is rejected even when the ZIP digest and JSON remain unchanged',async(t)=>{
  const f=await fixture(t);
  await fs.writeFile(path.join(f.releaseDir,'runtime','shell','EquinoxLocal.exe'),'tampered native B WPF');
  await assert.rejects(inspectSignedEquinoxLocalMainNativeCandidate({
    previousSourceSha:oldA,candidate:f.candidate,authorization:f.signed,publicKeys,
  }),/differs from the independently expected transaction/u);
});

test('symlinked staged native B release is rejected before any signature/identity acceptance',async(t)=>{
  const f=await fixture(t);
  const link=path.join(f.root,'release-link');
  await fs.symlink(f.releaseDir,link,'dir');
  await assert.rejects(inspectSignedEquinoxLocalMainNativeCandidate({
    previousSourceSha:oldA,candidate:{...f.candidate,releaseDir:link},authorization:f.signed,publicKeys,
  }),/canonical normal directory/u);
});


test('a single signed B artifact admits multiple distinct original A commits at this read-only step',async(t)=>{
 const f=await fixture(t);
 for(const previousSourceSha of [oldA,'0'.repeat(40),'f'.repeat(40)]){
  const result=await inspectSignedEquinoxLocalMainNativeCandidate({previousSourceSha,candidate:f.candidate,authorization:f.signed,publicKeys});
  assert.equal(result.previousSourceSha,previousSourceSha);
  assert.equal(result.sourceSha,bSha);
 }
 // Actual history verification is a separate product-owned Git check in the native OS Guardian.
});
