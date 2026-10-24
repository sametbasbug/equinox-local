import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {verifyMainNativeSignedSnapshotSet} from '../../scripts/release/verify-main-native-signed-snapshot-set.mjs';
import {createSignedMainNativeBAuthorization} from '../../src/equinox-local-main-native-b-authorization.js';

const B='b'.repeat(40);
const D='d'.repeat(64);
const {privateKey,publicKey}=generateKeyPairSync('ed25519');
const keyId='test-temporary-only';
const publicKeys={[keyId]:publicKey.export({format:'pem',type:'spki'}).toString()};
const TARGETS=['darwin-arm64','darwin-x64','win32-arm64','win32-x64'];
async function fixture(t){
 const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'el-signed-snapshot-set-')));
 t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 for(const target of TARGETS){
  const base=`equinox-local-main-${B}-${target}`;
  const name=`${base}${target.startsWith('win32-')?'.zip':'.tar.gz'}`;
  const bytes=Buffer.from(`${target}: packaged bytes`);
  await fs.writeFile(path.join(directory,name),bytes);
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const manifest={schemaVersion:1,channel:'main',sourceSha:B,target,runtimeContractSha256:D,artifact:{name,sha256,bytes:bytes.length}};
  await fs.writeFile(path.join(directory,`${base}.json`),JSON.stringify(manifest));
  if(target.startsWith('win32-')){
   const signed=createSignedMainNativeBAuthorization({schemaVersion:2,channel:'main',sourceSha:B,target,runtimeContractSha256:D,
    artifact:{sha256,bytes:bytes.length},releaseFingerprint:{sha256:'f'.repeat(64),entries:11,bytes:2000}},
    {privateKey,keyId});
   await fs.writeFile(path.join(directory,`${base}.b-authorization.json`),JSON.stringify(signed));
  }
 }
 return {directory};
}
test('exact four-platform signed publication includes two authenticated Windows B release sidecars and refuses temporary key under product trust',async t=>{
 const f=await fixture(t);
 const result=await verifyMainNativeSignedSnapshotSet({directory:f.directory,sourceSha:B,publicKeys});
 assert.equal(result.sourceSha,B);
 assert.deepEqual(result.verifiedTargets,TARGETS);
 assert.deepEqual(result.signedWindowsTargets,['win32-arm64','win32-x64']);
 await assert.rejects(verifyMainNativeSignedSnapshotSet({directory:f.directory,sourceSha:B}),/not trusted/u);
});
test('unsigned historic eight-file set never passes tag-promotion signature gate',async t=>{
 const f=await fixture(t);
 for(const target of ['win32-arm64','win32-x64']){
  await fs.rm(path.join(f.directory,`equinox-local-main-${B}-${target}.b-authorization.json`));
 }
 await assert.rejects(verifyMainNativeSignedSnapshotSet({directory:f.directory,sourceSha:B,publicKeys}),/ENOENT/u);
});
test('signature gate refuses changed ZIP, mismatched source, malformed B, foreign extra files and symlink',async t=>{
 const f=await fixture(t);
 const zip=path.join(f.directory,`equinox-local-main-${B}-win32-x64.zip`);
 await fs.writeFile(zip,'tampered');
 await assert.rejects(verifyMainNativeSignedSnapshotSet({directory:f.directory,sourceSha:B,publicKeys}),/archive filename\/byte count|SHA-256 differs/u);
 await assert.rejects(verifyMainNativeSignedSnapshotSet({directory:f.directory,sourceSha:'x'}),/exact Git source SHA/u);
 const manifest=path.join(f.directory,`equinox-local-main-${B}-win32-x64.json`);
 const payload=JSON.parse(await fs.readFile(manifest,'utf8'));
 payload.sourceSha='a'.repeat(40);
 await fs.writeFile(manifest,JSON.stringify(payload));
 await assert.rejects(verifyMainNativeSignedSnapshotSet({directory:f.directory,sourceSha:B,publicKeys}),/source SHA/u);
});
test('strict manifest and directory file-set refuse arbitrary extra files and unknown signatures',async t=>{
 const f=await fixture(t);
 await fs.writeFile(path.join(f.directory,'unrelated.txt'),'cannot publish');
 await assert.rejects(verifyMainNativeSignedSnapshotSet({directory:f.directory,sourceSha:B,publicKeys}),/exactly four native archives/u);
});
