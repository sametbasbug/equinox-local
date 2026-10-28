// One canonical public-repo production signer, called ONLY from a successful
// main-push CI's main-only protected deployment environment. Never log a key.
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPrivateUpdateSigningKey } from './sign-update-manifest.mjs';
import { createSignedMainInstallPointer } from '../../src/equinox-local-main-install-pointer.js';
import { validateEquinoxLocalMainNativeArtifactManifest } from '../../src/equinox-local-main-native-admission.js';
import { fingerprintEquinoxLocalNativeState } from '../../src/equinox-local-native-state-fingerprint.js';
import { EQUINOX_LOCAL_UPDATE_KEYS } from '../../src/equinox-local-update-keys.js';
import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from '../../src/equinox-local-platform.js';

const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/u;
const SOURCE_ROOT = path.resolve(import.meta.dirname, '../..');
const DOMAIN = 'equinox-local-main-native-b-authorization-v2\n';
const KEY_ID = 'stable-2026-01';
const TARGETS = EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS;
const MAX_ARCHIVE = 1024 * 1024 * 1024;

export async function prepareMainNativeSignedPayloads({sourceSha, directory, extractImpl=exec}={}) {
  if (!SHA.test(sourceSha)) throw Error('Exact public Main source SHA required.');
  if (!path.isAbsolute(directory)) throw Error('Main artifact input directory must be absolute.');
  const manifestSet=[];
  const payloads=[];
  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'equinox-main-public-sign-'));
  try {
    for (const target of TARGETS) {
      const base=`equinox-local-main-${sourceSha}-${target}`;
      const name=base+(target.startsWith('darwin-')?'.tar.gz':'.zip');
      const archivePath=path.join(directory,name);
      const manifestPath=path.join(directory,base+'.json');
      const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
      const checked=validateEquinoxLocalMainNativeArtifactManifest(manifest,{expectedSourceSha:sourceSha,expectedTarget:target});
      if(checked.artifact.name!==name) throw Error('Signed Main archive name mismatch.');
      const st=await fs.lstat(archivePath);
      if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<1||st.size>MAX_ARCHIVE||st.size!==checked.artifact.bytes)throw Error('Native archive is not an admitted single-link artifact.');
      const handle=await fs.open(archivePath,'r');
      let digest;
      try{
        const beginning=await handle.stat();
        if(beginning.ino!==st.ino||beginning.dev!==st.dev||beginning.size!==st.size)throw Error('Native archive identity changed.');
        const hash=createHash('sha256');
        for await(const block of handle.createReadStream({autoClose:false}))hash.update(block);
        const ending=await handle.stat();
        if(ending.ino!==beginning.ino||ending.dev!==beginning.dev||ending.size!==beginning.size||ending.mtimeMs!==beginning.mtimeMs)throw Error('Native archive changed while hashing.');
        digest=hash.digest('hex');
      }finally{await handle.close().catch(()=>{});}
      if(digest!==checked.artifact.sha256)throw Error('Native archive SHA-256 differs from exact CI manifest.');
      const extracted=path.join(scratch,target);
      await extractImpl('python3',['-I','-B',path.join(SOURCE_ROOT,'scripts/release/extract-main-native-for-signing.py'),archivePath,extracted,target],{cwd:SOURCE_ROOT,timeout:180000,maxBuffer:4096});
      const releaseDir=path.join(extracted,'release');
      const releaseMeta=JSON.parse(await fs.readFile(path.join(releaseDir,'release.json'),'utf8'));
      if(releaseMeta.target!==target||releaseMeta.sourceSha!==sourceSha)throw Error('Native extracted release identity differs from CI source.');
      // Windows extracted ZIP POSIX modes do not travel to NTFS; the original
      // Factory B native-tree contract signs normalized 0666 modes instead.
      const nativeFs=target.startsWith('win32-')?{
        ...fs,
        async lstat(file){const v=await fs.lstat(file);if(v.isFile()||v.isDirectory())v.mode=(v.mode&~0o777)|0o666;return v;},
      }:fs;
      const fingerprint=await fingerprintEquinoxLocalNativeState(releaseDir,{fsImpl:nativeFs});
      manifestSet.push(checked);
      payloads.push({schemaVersion:2,channel:'main',sourceSha,target,runtimeContractSha256:checked.runtimeContractSha256,
        artifact:{sha256:digest,bytes:st.size},
        releaseFingerprint:{sha256:fingerprint.sha256,entries:fingerprint.entries,bytes:fingerprint.bytes}});
    }
    return Object.freeze({sourceSha,manifests:manifestSet,payloads});
  } finally {await fs.rm(scratch,{recursive:true,force:true});}
}

export async function signMainSnapshotSet({sourceSha,version,directory,keyFile,outputDir}={}) {
  if(!path.isAbsolute(keyFile)||!path.isAbsolute(outputDir))throw Error('External private key file and output directory required.');
  if((await fs.readdir(outputDir)).length!==0)throw Error('Signed Main output directory must be empty.');
  // SHA hashes and native fingerprints are verified before the key is read.
  const prepared=await prepareMainNativeSignedPayloads({sourceSha,directory});
  const key=await readPrivateUpdateSigningKey(keyFile,{repositoryRoot:SOURCE_ROOT});
  const publicKey=EQUINOX_LOCAL_UPDATE_KEYS[KEY_ID];
  if(createPublicKey(key).export({type:'spki',format:'der'}).toString('base64')!==
     createPublicKey(publicKey).export({type:'spki',format:'der'}).toString('base64'))throw Error('Protected signing key differs from pinned production Ed25519 trust root.');
  for(const payload of prepared.payloads){
    const raw=Buffer.from(DOMAIN+JSON.stringify(payload),'utf8');
    const signature=sign(null,raw,key);
    if(signature.length!==64||!verify(null,raw,publicKey,signature))throw Error('Production native B signature self-verification failed.');
    const named=`equinox-local-main-${sourceSha}-${payload.target}.b-authorization.json`;
    await fs.writeFile(path.join(outputDir,named),JSON.stringify({...payload,signature:{algorithm:'ed25519',keyId:KEY_ID,value:signature.toString('base64')}},null,2)+'\n',{flag:'wx',mode:0o600});
  }
  // Commit timestamp makes repeat attempts for the same source SHA byte-identical.
  const epoch=Number(process.env.SOURCE_DATE_EPOCH);
  if(!Number.isSafeInteger(epoch)||epoch<=0)throw Error('Protected Main signing requires deterministic SOURCE_DATE_EPOCH.');
  const pointer=createSignedMainInstallPointer({sourceSha,version,publishedAt:new Date(epoch*1000).toISOString(),nativeManifests:prepared.manifests,keyId:KEY_ID,privateKey:key});
  const pointerFile=path.join(outputDir,`equinox-local-main-${sourceSha}.install-pointer.json`);
  await fs.writeFile(pointerFile,JSON.stringify(pointer,null,2)+'\n',{flag:'wx',mode:0o600});
  return {sourceSha,targets:prepared.payloads.length,pointerFile};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2);if(args.length!==10||args.some((v,i)=>i%2===0&&!['--source-sha','--version','--manifest-dir','--key-file','--output-dir'].includes(v)))throw Error('Expected five signing argument pairs.');
    const opts=Object.fromEntries(Array.from({length:5},(_,i)=>[args[2*i].slice(2),args[2*i+1]]));
    const result=await signMainSnapshotSet({sourceSha:opts['source-sha'],version:opts.version,directory:opts['manifest-dir'],keyFile:opts['key-file'],outputDir:opts['output-dir']});
    process.stdout.write(`Verified and signed ${result.targets} exact Main native targets for ${result.sourceSha}\n`);
  }catch(e){process.stderr.write(`Main signing failed: ${e instanceof Error?e.message:'unknown error'}\n`);process.exitCode=1;}
}
