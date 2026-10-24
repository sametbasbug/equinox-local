import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {prepareMainNativeBAuthorizationPayload} from '../../scripts/release/prepare-main-native-b-authorization.mjs';
import {canonicalMainNativeBAuthorizationPayload} from '../../src/equinox-local-main-native-b-authorization.js';
import {fingerprintEquinoxLocalNativeState} from '../../src/equinox-local-native-state-fingerprint.js';

const B='b'.repeat(40);
const C='c'.repeat(64);
async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'el-b-preparer-')));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const releaseDir=path.join(root,'release');await fs.mkdir(releaseDir);
 await fs.writeFile(path.join(releaseDir,'service.js'),'real candidate B bytes');
 const archiveBytes=Buffer.from('archive contains release bytes in offline rehearsal');
 const artifactPath=path.join(root,`equinox-local-main-${B}-win32-x64.zip`);
 await fs.writeFile(artifactPath,archiveBytes);
 const manifestPath=path.join(root,'manifest.json');
 const manifest={schemaVersion:1,channel:'main',sourceSha:B,target:'win32-x64',runtimeContractSha256:C,
 artifact:{name:path.basename(artifactPath),sha256:createHash('sha256').update(archiveBytes).digest('hex'),bytes:archiveBytes.length}};
 await fs.writeFile(manifestPath,JSON.stringify(manifest));
 const validateRelease=async(dir,{target})=>({target,releaseDir:dir,version:'6.2.0',metadata:{sourceSha:B}});
 return {root,releaseDir,artifactPath,manifestPath,manifest,validateRelease};
}

test('offline producer constructs deterministic target-only unsigned v2 from actual validated ZIP and actual release tree',async(t)=>{
 const f=await fixture(t);
 const input={sourceSha:B,target:'win32-x64',artifactPath:f.artifactPath,manifestPath:f.manifestPath,releaseDir:f.releaseDir,validateRelease:f.validateRelease};
 const payload=await prepareMainNativeBAuthorizationPayload(input);
 const fingerprint=await fingerprintEquinoxLocalNativeState(f.releaseDir);
 assert.deepEqual(payload,{schemaVersion:2,channel:'main',sourceSha:B,target:'win32-x64',runtimeContractSha256:C,
  artifact:{sha256:f.manifest.artifact.sha256,bytes:f.manifest.artifact.bytes},releaseFingerprint:{sha256:fingerprint.sha256,entries:fingerprint.entries,bytes:fingerprint.bytes}});
 assert.equal('previousSourceSha' in payload,false);
 assert.ok(canonicalMainNativeBAuthorizationPayload(payload).startsWith('equinox-local-main-native-b-authorization-v2\n'));
});

test('offline producer refuses tampered artifact or manifest even if release folder still looks valid',async(t)=>{
 const f=await fixture(t);
 const input={sourceSha:B,target:'win32-x64',artifactPath:f.artifactPath,manifestPath:f.manifestPath,releaseDir:f.releaseDir,validateRelease:f.validateRelease};
 await fs.writeFile(f.artifactPath,'changed');
 await assert.rejects(prepareMainNativeBAuthorizationPayload(input),/differs from exact source-bound transport manifest/u);
 await fs.writeFile(f.artifactPath,Buffer.from('archive contains release bytes in offline rehearsal'));
 const bad={...f.manifest,sourceSha:'a'.repeat(40)};
 await fs.writeFile(f.manifestPath,JSON.stringify(bad));
 await assert.rejects(prepareMainNativeBAuthorizationPayload(input),/source SHA/u);
});

test('offline producer refuses mismatched release metadata, link, wrong arch and untrusted output roots',async(t)=>{
 const f=await fixture(t);
 const input={sourceSha:B,target:'win32-x64',artifactPath:f.artifactPath,manifestPath:f.manifestPath,releaseDir:f.releaseDir,validateRelease:f.validateRelease};
 await assert.rejects(prepareMainNativeBAuthorizationPayload({...input,validateRelease:async(dir,{target})=>({target,releaseDir:dir,metadata:{sourceSha:'f'.repeat(40)}})}),/identity differs/u);
 await assert.rejects(prepareMainNativeBAuthorizationPayload({...input,target:'linux-x64'}),/supported architecture/u);
 await assert.rejects(prepareMainNativeBAuthorizationPayload({...input,sourceSha:'bad'}),/exact full target SHA/u);
 const link=path.join(f.root,'link.zip');await fs.symlink(f.artifactPath,link);
 await assert.rejects(prepareMainNativeBAuthorizationPayload({...input,artifactPath:link}),/exact manifest artifact/u);
 const symlink=path.join(f.root,'link-release');await fs.symlink(f.releaseDir,symlink,'dir');
 await assert.rejects(prepareMainNativeBAuthorizationPayload({...input,releaseDir:symlink}),/canonical normal directory/u);
});
