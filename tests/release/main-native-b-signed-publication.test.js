import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import test from 'node:test';

import {
  fetchEquinoxLocalSignedMainBPublication,
  equinoxLocalMainSnapshotBAuthorizationUrl,
} from '../../src/equinox-local-main-snapshot.js';
import {createSignedMainNativeBAuthorization} from '../../src/equinox-local-main-native-b-authorization.js';

const a='a'.repeat(40);
const b='b'.repeat(40);
const contract='c'.repeat(64);
const digest='d'.repeat(64);
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const keyId='test-source-not-prod';
const keys={[keyId]:publicKey.export({format:'pem',type:'spki'}).toString()};
const nativeManifest={schemaVersion:1,channel:'main',sourceSha:b,target:'win32-x64',runtimeContractSha256:contract,
 artifact:{name:`equinox-local-main-${b}-win32-x64.zip`,sha256:digest,bytes:2048}};
const signed=createSignedMainNativeBAuthorization({schemaVersion:1,channel:'main',previousSourceSha:a,sourceSha:b,target:'win32-x64',runtimeContractSha256:contract,
 artifact:{sha256:digest,bytes:2048},releaseFingerprint:{sha256:'e'.repeat(64),entries:20,bytes:9204}},
 {privateKey,keyId});
function response(value,status=200){const data=Buffer.from(JSON.stringify(value));return {ok:status===200,status,headers:{get:(key)=>key.toLowerCase()==='content-length'?String(data.length):null},body:(async function*(){yield data;})()};}
function fetchFixture(manifest=nativeManifest,auth=signed,requests=[]){return async(url,opts)=>{requests.push({url,opts});return response(url.endsWith('.b-authorization.json')?auth:manifest);};}

test('signed B publication fetch is exact SHA/target and separately verifies domain-specific signature before admission',async()=>{
 const requests=[];
 const result=await fetchEquinoxLocalSignedMainBPublication({previousSourceSha:a,sourceSha:b,target:'win32-x64',expectedRuntimeContractSha256:contract,
  fetchImpl:fetchFixture(nativeManifest,signed,requests),publicKeys:keys});
 assert.equal(result.authorization.sourceSha,b);
 assert.equal(result.authorization.previousSourceSha,a);
 assert.equal(result.manifest.artifact.sha256,digest);
 assert.equal(result.authorizationUrl,equinoxLocalMainSnapshotBAuthorizationUrl(b,'win32-x64'));
 assert.equal(requests.length,2);
 for(const entry of requests){assert.equal(entry.opts.method,'GET');assert.equal(entry.opts.redirect,'error');assert.equal(entry.opts.credentials,'omit');assert.equal(entry.opts.cache,'no-store');}
 await assert.rejects(fetchEquinoxLocalSignedMainBPublication({previousSourceSha:a,sourceSha:b,target:'win32-x64',expectedRuntimeContractSha256:contract,
   fetchImpl:fetchFixture()}),/not trusted/u);
});

test('signed B publication refuses an unsigned Main snapshot, forged artifact, old A or modified signed B',async()=>{
 for(const [name,options] of [
  ['missing',{auth:{...signed,signature:undefined}}],
  ['oldA',{previousSourceSha:'f'.repeat(40)}],
  ['source',{auth:{...signed,sourceSha:'0'.repeat(40)}}],
  ['archive sha',{manifest:{...nativeManifest,artifact:{...nativeManifest.artifact,sha256:'0'.repeat(64)}}}],
  ['archive bytes',{manifest:{...nativeManifest,artifact:{...nativeManifest.artifact,bytes:3000}}}],
  ['target',{auth:{...signed,target:'win32-arm64'}}],
  ['contract',{auth:{...signed,runtimeContractSha256:'0'.repeat(64)}}],
 ]){
   await assert.rejects(fetchEquinoxLocalSignedMainBPublication({previousSourceSha:a,sourceSha:b,target:'win32-x64',expectedRuntimeContractSha256:contract,
    fetchImpl:fetchFixture(options.manifest??nativeManifest,options.auth??signed),publicKeys:keys,...('previousSourceSha' in options?{previousSourceSha:options.previousSourceSha}:{})}),undefined,name);
 }
});

test('signed B publication refuses stale/no-B response, invalid old SHA and non-Windows B target',async()=>{
 await assert.rejects(fetchEquinoxLocalSignedMainBPublication({previousSourceSha:b,sourceSha:b,target:'win32-x64',expectedRuntimeContractSha256:contract,
  fetchImpl:fetchFixture(),publicKeys:keys}),/distinct exact previous/u);
 assert.throws(()=>equinoxLocalMainSnapshotBAuthorizationUrl(b,'darwin-arm64'),/Windows-only/u);
 await assert.rejects(fetchEquinoxLocalSignedMainBPublication({previousSourceSha:a,sourceSha:b,target:'win32-x64',expectedRuntimeContractSha256:contract,
  fetchImpl:async(url)=>url.endsWith('.b-authorization.json')?response({error:'not found'},404):response(nativeManifest),publicKeys:keys}),/HTTP 404/u);
});

test('signed B staging refuses an untrusted envelope before fetching bytes and stages only exact signed ZIP',async(t)=>{
  const fs=(await import('node:fs/promises')).default;
  const path=(await import('node:path')).default;
  const os=(await import('node:os')).default;
  const {createHash}=await import('node:crypto');
  const {stageSignedEquinoxLocalMainBArtifact}=await import('../../src/equinox-local-main-snapshot.js');
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'el-signed-snapshot-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const transactionId=`main-${'1'.repeat(32)}`;
  const directory=path.join(root,'staging',transactionId);
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const bytes=Buffer.from('immutable signed B zipped package bytes');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const manifest={...nativeManifest,artifact:{...nativeManifest.artifact,sha256,bytes:bytes.length}};
  const {signature: _notPartOfPayload, ...unsigned}=signed;
  const authorized=createSignedMainNativeBAuthorization({...unsigned,artifact:{sha256,bytes:bytes.length}},
   {privateKey,keyId});
  const requests=[];
  const fetchImpl=async(url)=>{
    requests.push(url);
    if(url.endsWith('.b-authorization.json'))return response(authorized);
    if(url.endsWith('.json'))return response(manifest);
    return {ok:true,status:200,headers:{get:()=>String(bytes.length)},body:(async function*(){yield bytes;})()};
  };
  await assert.rejects(stageSignedEquinoxLocalMainBArtifact({previousSourceSha:a,sourceSha:b,target:'win32-x64',
    expectedRuntimeContractSha256:contract,transactionRoot:root,transactionId,fetchImpl}),/not trusted/u);
  assert.equal(requests.length,2,'untrusted signature cannot trigger an artifact ZIP download');
  await assert.rejects(fs.lstat(path.join(directory,'native')),{code:'ENOENT'});
  requests.length=0;
  const staged=await stageSignedEquinoxLocalMainBArtifact({previousSourceSha:a,sourceSha:b,target:'win32-x64',
    expectedRuntimeContractSha256:contract,transactionRoot:root,transactionId,fetchImpl,publicKeys:keys});
  assert.equal(staged.sha256,sha256);
  assert.equal(staged.signedAuthorization.previousSourceSha,a);
  assert.equal(staged.signedAuthorization.signature.keyId,keyId);
  assert.deepEqual(await fs.readFile(staged.artifactPath),bytes);
  assert.equal(requests.length,4);
});
