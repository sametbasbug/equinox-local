import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {EQUINOX_LOCAL_UPDATE_KEYS} from '../../src/equinox-local-update-keys.js';
import {verifyMainInstallerPointer,downloadVerifiedMainArchive} from '../../scripts/install-main-verify.mjs';

const sha='a'.repeat(40);
const targets=['darwin-arm64','darwin-x64','win32-arm64','win32-x64'];
const prototypePointer={
 schemaVersion:1,channel:'main',sourceSha:sha,version:'6.2.1',
 publishedAt:'2026-10-27T14:00:00.000Z',
 targets:targets.map((target,i)=>({
  target,runtimeContractSha256:(i+1).toString().repeat(64),
  artifact:{
   url:'https://main.local.sametbasbug.dev/snapshots/'+sha+'/equinox-local-main-'+sha+'-'+target+(target.startsWith('win32-')?'.zip':'.tar.gz'),
   sha256:(i+5).toString().repeat(64),bytes:100+i,
  },
 })),
 signature:{algorithm:'ed25519',keyId:'stable-2026-01',value:Buffer.alloc(64).toString('base64')},
};
const clone=()=>structuredClone(prototypePointer);

test('standalone Main bootstrap verifier never accepts untrusted or structurally foreign selectors',()=>{
 for(const target of targets){
  assert.throws(()=>verifyMainInstallerPointer(clone(),{target}),/production signature/u);
 }
 const changes=[
  v=>{v.channel='stable';},
  v=>{v.sourceSha='b'.repeat(40);},
  v=>{v.version='6.2.1-release';},
  v=>{v.publishedAt='2026-99-99T14:00:00.000Z';},
  v=>{v.targets.pop();},
  v=>{v.targets.reverse();},
  v=>{v.targets[0].target='win32-x64';},
  v=>{v.targets[0].runtimeContractSha256='x';},
  v=>{v.targets[0].artifact.url='https://attacker.invalid/archive';},
  v=>{v.targets[0].artifact.url+='?download=1';},
  v=>{v.targets[0].artifact.bytes=Number.MAX_SAFE_INTEGER;},
  v=>{v.targets[0].artifact.sha256='A'.repeat(64);},
  v=>{v.targets[0].artifact.extra=true;},
  v=>{v.signature.keyId='attacker-root';},
  v=>{v.signature.value='!!!';},
  v=>{v.extra='unsafe';},
 ];
 for(const update of changes){
  const candidate=clone();update(candidate);
  assert.throws(()=>verifyMainInstallerPointer(candidate,{target:targets[0]}),undefined,update.toString());
 }
 assert.throws(()=>verifyMainInstallerPointer(clone(),{target:'linux-x64'}),/Unsupported/u);
});

test('common Main downloader refuses an unsigned latest pointer before fetching an executable archive',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'equinox-main-download-test-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dest=path.join(root,'download.tar.gz');
 const original=globalThis.fetch;
 const requests=[];
 globalThis.fetch=async url=>{
  requests.push(url);
  return new Response(JSON.stringify(clone()),{status:200,headers:{'cache-control':'no-store','content-length':String(Buffer.byteLength(JSON.stringify(clone()))) }});
 };
 t.after(()=>{globalThis.fetch=original;});
 await assert.rejects(downloadVerifiedMainArchive({target:'darwin-arm64',destination:dest}),/production signature/u);
 assert.deepEqual(requests,['https://main.local.sametbasbug.dev/latest/main.json']);
 await assert.rejects(fs.stat(dest),/ENOENT/u);
});

test('common Main downloader bounds selector bytes and rejects remote redirects',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'equinox-main-download-limits-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dest=path.join(root,'new.zip');
 const original=globalThis.fetch;
 let iteration=0;
 globalThis.fetch=async()=>{
  iteration++;
  return iteration===1
   ?new Response('a'.repeat(16385),{status:200,headers:{'cache-control':'no-store'}})
   :new Response('',{status:302,headers:{'cache-control':'no-store',location:'https://attacker.invalid/' }});
 };
 t.after(()=>{globalThis.fetch=original;});
 await assert.rejects(downloadVerifiedMainArchive({target:'win32-x64',destination:dest}),/bounded size/u);
 await assert.rejects(downloadVerifiedMainArchive({target:'win32-x64',destination:dest}),/HTTPS request failed/u);
 await assert.rejects(fs.stat(dest),/ENOENT/u);
});

test('common Main downloader requires new absolute output and never discovers ambient node/git',async()=>{
 await assert.rejects(downloadVerifiedMainArchive({target:'linux-arm64',destination:'/tmp/file'}),/supported target/u);
 await assert.rejects(downloadVerifiedMainArchive({target:'darwin-arm64',destination:'relative.bin'}),/absolute new file/u);
 const source=await fs.readFile(new URL('../../scripts/install-main-verify.mjs',import.meta.url),'utf8');
 assert.ok(!/\b(?:execFile|spawn|which|npm|git)\s*\(/u.test(source));
 assert.match(source,/--target/u);
 assert.match(source,/--output/u);
 assert.match(source,/fs\.open\(destination,'wx',0o600\)/u);
 assert.match(source,/--/u);
 assert.match(source,/sha\.digest\('hex'\)!==artifact\.sha256/u);
 assert.match(source,/if\(!verified\)await fs\.rm\(destination,\{force:true\}\)/u);
 assert.equal(createHash('sha256').update(source).digest('hex').length,64);
});


test('portable Main verifier embeds only the existing public production trust root',async()=>{
 const source=await fs.readFile(new URL('../../scripts/install-main-verify.mjs',import.meta.url),'utf8');
 const root=EQUINOX_LOCAL_UPDATE_KEYS['stable-2026-01'];
 const rootMaterial=root.split(String.fromCharCode(10))[1];
 assert.ok(rootMaterial.length>40);
 assert.ok(source.includes(rootMaterial));
 assert.match(source,/const TRUSTED_KEY_ID='stable-2026-01'/u);
 assert.doesNotMatch(source,/privateKey|createPrivateKey|--public-key|--url/u);
});

test('mutable latest Main selector HTTP cache must be no-store before any signature processing',async t=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify(clone()),{status:200,headers:{'cache-control':'public,max-age=31536000,immutable'}});
 t.after(()=>{globalThis.fetch=original;});
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'equinox-main-cache-test-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dest=path.join(root,'archive.zip');
 await assert.rejects(downloadVerifiedMainArchive({target:'win32-x64',destination:dest}),/no-store/u);
 await assert.rejects(fs.stat(dest),/ENOENT/u);
});
