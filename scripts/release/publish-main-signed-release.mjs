// Exact main-push, twelve immutable objects, production Ed25519 verification,
// and a conditional latest/main.json move LAST. This is a keyless publisher.
import { createHash, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile as callback } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createMainSignedR2Store } from './main-signed-r2-store.mjs';
import { validateTrustedMainInstallPointer } from '../../src/equinox-local-main-install-pointer.js';
import { validateEquinoxLocalMainNativeArtifactManifest } from '../../src/equinox-local-main-native-admission.js';
import { EQUINOX_LOCAL_UPDATE_KEYS } from '../../src/equinox-local-update-keys.js';
import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from '../../src/equinox-local-platform.js';

const exec=promisify(callback);
const SHA=/^[a-f0-9]{40}$/u;
const DOMAIN='equinox-local-main-native-b-authorization-v2\n';
const CACHE='public,max-age=31536000,immutable';
const ORIGIN='https://main.local.sametbasbug.dev';
const TARGETS=EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS;
const digest=body=>createHash('sha256').update(body).digest('hex');
const expected=sourceSha=>TARGETS.flatMap(target=>{
  const base=`equinox-local-main-${sourceSha}-${target}`;
  return [base+(target.startsWith('darwin-')?'.tar.gz':'.zip'),base+'.json',base+'.b-authorization.json'];
});

async function hashFile(file,max=1024*1024*1024){
 const st=await fs.lstat(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<1||st.size>max)throw Error('Immutable Main source must be a bounded normal file.');
 const handle=await fs.open(file,'r');
 try{
  const a=await handle.stat();if(a.dev!==st.dev||a.ino!==st.ino||a.size!==st.size)throw Error('Immutable source identity changed.');
  const hash=createHash('sha256');for await(const data of handle.createReadStream({autoClose:false}))hash.update(data);
  const b=await handle.stat();if(a.dev!==b.dev||a.ino!==b.ino||a.mtimeMs!==b.mtimeMs||a.size!==b.size)throw Error('Immutable source changed.');
  return {sha256:hash.digest('hex'),bytes:a.size};
 }finally{await handle.close().catch(()=>{});}
}

export async function inspectMainSignedRelease({sourceSha,archiveDir,signedDir}){
 if(!SHA.test(sourceSha)||!path.isAbsolute(archiveDir)||!path.isAbsolute(signedDir))throw Error('Exact signed Main SHA and absolute paths required.');
 const names=expected(sourceSha);
 const pointerName=`equinox-local-main-${sourceSha}.install-pointer.json`;
 const signedFiles=(await fs.readdir(signedDir)).sort();
 const expectedSigned=[...names.filter(n=>n.endsWith('.b-authorization.json')),pointerName].sort();
 if(JSON.stringify(signedFiles)!==JSON.stringify(expectedSigned))throw Error('Signed Main set must contain exactly four B sidecars and one pointer.');
 const pointerBytes=await fs.readFile(path.join(signedDir,pointerName));
 if(pointerBytes.length<200||pointerBytes.length>16384)throw Error('Signed Main pointer size invalid.');
 const pointer=validateTrustedMainInstallPointer(JSON.parse(pointerBytes.toString('utf8')),{expectedSourceSha:sourceSha});
 const files=[];
 for(const target of TARGETS){
  const base=`equinox-local-main-${sourceSha}-${target}`;
  const manifestName=base+'.json',archiveName=base+(target.startsWith('darwin-')?'.tar.gz':'.zip'),authName=base+'.b-authorization.json';
  const manifestBytes=await fs.readFile(path.join(archiveDir,manifestName));
  if(manifestBytes.length<1||manifestBytes.length>16384)throw Error('Native Main manifest size invalid.');
  const manifest=validateEquinoxLocalMainNativeArtifactManifest(JSON.parse(manifestBytes),{expectedSourceSha:sourceSha,expectedTarget:target});
  const entry=pointer.targets.find(t=>t.target===target);
  if(!entry||entry.runtimeContractSha256!==manifest.runtimeContractSha256||entry.artifact.sha256!==manifest.artifact.sha256||entry.artifact.bytes!==manifest.artifact.bytes||entry.artifact.url!==ORIGIN+'/snapshots/'+sourceSha+'/'+archiveName)throw Error('Signed Main pointer/native manifest mismatch.');
  const authBytes=await fs.readFile(path.join(signedDir,authName));
  if(authBytes.length<100||authBytes.length>16384)throw Error('Signed B authorization size invalid.');
  const signed=JSON.parse(authBytes);
  const {signature,...payload}=signed;
  if(Object.keys(payload).sort().join(',')!==['artifact','channel','releaseFingerprint','runtimeContractSha256','schemaVersion','sourceSha','target'].sort().join(',')||
     payload.schemaVersion!==2||payload.channel!=='main'||payload.sourceSha!==sourceSha||payload.target!==target||
     payload.runtimeContractSha256!==manifest.runtimeContractSha256||payload.artifact?.sha256!==manifest.artifact.sha256||payload.artifact?.bytes!==manifest.artifact.bytes||
     !/^[a-f0-9]{64}$/u.test(payload.releaseFingerprint?.sha256||'')||!Number.isInteger(payload.releaseFingerprint?.entries)||!Number.isInteger(payload.releaseFingerprint?.bytes)||payload.releaseFingerprint.entries<1||payload.releaseFingerprint.bytes<1||
     signature?.algorithm!=='ed25519'||signature?.keyId!=='stable-2026-01')throw Error('Native B authorization payload malformed or does not bind to immutable artifact.');
  const bytes=Buffer.from(signature.value||'','base64');
  if(bytes.length!==64||bytes.toString('base64')!==signature.value||!verify(null,Buffer.from(DOMAIN+JSON.stringify(payload)),EQUINOX_LOCAL_UPDATE_KEYS['stable-2026-01'],bytes))throw Error('Native B production Ed25519 authorization invalid.');
  const archive=await hashFile(path.join(archiveDir,archiveName));
  if(archive.sha256!==manifest.artifact.sha256||archive.bytes!==manifest.artifact.bytes)throw Error('Native archive differs from signed hash.');
  files.push({name:archiveName,file:path.join(archiveDir,archiveName),...archive});
  files.push({name:manifestName,file:path.join(archiveDir,manifestName),sha256:digest(manifestBytes),bytes:manifestBytes.length});
  files.push({name:authName,file:path.join(signedDir,authName),sha256:digest(authBytes),bytes:authBytes.length});
 }
 return Object.freeze({sourceSha,files:Object.freeze(files),pointer,pointerFile:path.join(signedDir,pointerName),pointerSha256:digest(pointerBytes),pointerBytes:pointerBytes.length});
}

async function verifyCdnObject(key,sha,bytes,cache){
 const r=await fetch(`${ORIGIN}/${key}`,{redirect:'error',headers:{'accept-encoding':'identity','cache-control':'no-cache'},signal:AbortSignal.timeout(40000)});
 if(r.status!==200||r.headers.get('cache-control')?.replace(/,\s*/gu,',')!==cache||!r.body)throw Error('Public Main CDN identity/cache proof failed.');
 let size=0;const hash=createHash('sha256');
 for await(const chunk of r.body){size+=chunk.length;if(size>bytes)throw Error('CDN Main response exceeded signed size.');hash.update(chunk);}
 if(size!==bytes||hash.digest('hex')!==sha)throw Error('Public Main CDN body differs from signed bytes.');
}

export async function publishMainSignedRelease({sourceSha,archiveDir,signedDir,credentials,store=createMainSignedR2Store({credentials}),readHead}={}){
 const authority=readHead??(async()=>{const {stdout}=await exec('git',['ls-remote','https://github.com/sametbasbug/equinox-local.git','refs/heads/main'],{timeout:30000});return stdout.trim().split(/\s+/u)[0];});
 const check=async()=>{if((await authority())!==sourceSha)throw Error('Signed Main source SHA no longer equals canonical main HEAD.');};
 await check();
 const proof=await inspectMainSignedRelease({sourceSha,archiveDir,signedDir});
 for(const item of proof.files){
  await check();
  const contract={bucket:'equinox-local-main',key:`snapshots/${sourceSha}/${item.name}`,ifNoneMatch:'*',metadata:{sha256:item.sha256},cacheControl:CACHE,bytes:item.bytes,bodyName:item.name};
  await store.putIfAbsent({contract,file:item.file});
 }
 for(const item of proof.files){
  const head=await store.headArchive(sourceSha,item.name);
  if(head.bytes!==item.bytes||head.immutable!==true||(head.sha256Metadata!=null&&head.sha256Metadata!==item.sha256))throw Error('Remote R2 immutable file metadata mismatch.');
  const hash=createHash('sha256');let bytes=0;
  for await(const chunk of store.streamArchive(sourceSha,item.name)){hash.update(chunk);bytes+=chunk.length;if(bytes>item.bytes)throw Error('R2 immutable body exceeded signed bounds.');}
  if(bytes!==item.bytes||hash.digest('hex')!==item.sha256)throw Error('Remote R2 immutable object full-body mismatch.');
 }
 await check();
 const pointer=await store.putImmutableMainPointer({sourceSha,file:proof.pointerFile,sha256:proof.pointerSha256,bytes:proof.pointerBytes});
 const immutable=await store.readMainPointer({sourceSha});
 if(!immutable||immutable.sha256!==proof.pointerSha256)throw Error('Immutable R2 signed pointer readback mismatch.');
 await verifyCdnObject('pointers/main/'+sourceSha+'.json',proof.pointerSha256,proof.pointerBytes,CACHE);
 await check();
 const previous=await store.readMainPointer();
 if(previous?.sha256===proof.pointerSha256){await verifyCdnObject('latest/main.json',proof.pointerSha256,proof.pointerBytes,'no-store');return {sourceSha,status:'already_live'};}
 if(previous)validateTrustedMainInstallPointer(JSON.parse(previous.body),{expectedSourceSha:JSON.parse(previous.body).sourceSha});
 await store.compareAndSwapMainLatest({file:proof.pointerFile,sha256:proof.pointerSha256,bytes:proof.pointerBytes,previousEtag:previous?.etag??null});
 const live=await store.readMainPointer();
 if(!live||live.sha256!==proof.pointerSha256)throw Error('R2 Main latest CAS readback mismatch.');
 await verifyCdnObject('latest/main.json',proof.pointerSha256,proof.pointerBytes,'no-store');
 return {sourceSha,status:'published',immutable:pointer.status};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{
  const sha=process.env.GITHUB_SHA;
  if(!SHA.test(sha)||process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_EVENT_NAME!=='push'||process.env.GITHUB_REPOSITORY!=='sametbasbug/equinox-local'||!/^[1-9][0-9]*$/u.test(process.env.GITHUB_RUN_ID||''))throw Error('Production publisher requires canonical protected main push CI identity.');
  if(process.argv.length!==4||!path.isAbsolute(process.argv[2])||!path.isAbsolute(process.argv[3]))throw Error('Publisher expects exact absolute archive and signed directories.');
  const result=await publishMainSignedRelease({sourceSha:sha,archiveDir:process.argv[2],signedDir:process.argv[3],credentials:{accessKeyId:process.env.AWS_ACCESS_KEY_ID,secretAccessKey:process.env.AWS_SECRET_ACCESS_KEY}});
  process.stdout.write(`Verified production-signed Main ${result.sourceSha}: ${result.status}\n`);
 }catch(error){process.stderr.write(`Signed Main publication refused: ${error instanceof Error?error.message:'unknown error'}\n`);process.exitCode=1;}
}
