// One canonical public-repo production signer, called ONLY from a successful
// main-push CI's main-only protected deployment environment. Never log a key.
import { createHash, createPublicKey } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPrivateUpdateSigningKey } from './sign-update-manifest.mjs';
import { createSignedMainInstallPointer } from '../../src/equinox-local-main-install-pointer.js';
import { validateEquinoxLocalMainNativeArtifactManifest } from '../../src/equinox-local-main-native-admission.js';
import { EQUINOX_LOCAL_UPDATE_KEYS } from '../../src/equinox-local-update-keys.js';
import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from '../../src/equinox-local-platform.js';

const SHA = /^[a-f0-9]{40}$/u;
const SOURCE_ROOT = path.resolve(import.meta.dirname, '../..');
const KEY_ID = 'stable-2026-01';
const TARGETS = EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS;
const MAX_ARCHIVE = 1024 * 1024 * 1024;

// The existing external installer needs one signed four-target Main selector.
// There is no native B authorization or second update engine to publish.
export async function prepareMainNativeSigningManifests({sourceSha,directory}={}) {
  if(!SHA.test(sourceSha)||!path.isAbsolute(directory))throw Error('Exact public Main SHA and absolute native artifacts directory required.');
  const manifests=[];
  for(const target of TARGETS){
    const name=`equinox-local-main-${sourceSha}-${target}`;
    const archiveName=name+(target.startsWith('darwin-')?'.tar.gz':'.zip');
    const manifestPath=path.join(directory,name+'.json');
    const archivePath=path.join(directory,archiveName);
    const manifest=validateEquinoxLocalMainNativeArtifactManifest(JSON.parse(await fs.readFile(manifestPath,'utf8')),{expectedSourceSha:sourceSha,expectedTarget:target});
    if(manifest.artifact.name!==archiveName)throw Error('Native Main artifact name differs from signed manifest.');
    const st=await fs.lstat(archivePath);
    if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size<1||st.size>MAX_ARCHIVE||st.size!==manifest.artifact.bytes)throw Error('Native Main archive identity/size mismatch.');
    const fd=await fs.open(archivePath,'r');
    try{
      const first=await fd.stat();
      if(first.dev!==st.dev||first.ino!==st.ino||first.size!==st.size)throw Error('Native Main archive changed before hashing.');
      const hash=createHash('sha256');
      for await(const chunk of fd.createReadStream({autoClose:false}))hash.update(chunk);
      const last=await fd.stat();
      if(last.dev!==first.dev||last.ino!==first.ino||last.size!==first.size||last.mtimeMs!==first.mtimeMs||hash.digest('hex')!==manifest.artifact.sha256)throw Error('Native Main archive differs from exact CI manifest.');
    }finally{await fd.close().catch(()=>{});}
    manifests.push(manifest);
  }
  return Object.freeze({sourceSha,manifests:Object.freeze(manifests)});
}

export async function signMainSnapshotSet({sourceSha,version,directory,keyFile,outputDir}={}) {
  if(!path.isAbsolute(keyFile)||!path.isAbsolute(outputDir))throw Error('External signing key path and output directory required.');
  if((await fs.readdir(outputDir)).length!==0)throw Error('Signed Main output directory must be empty.');
  const prepared=await prepareMainNativeSigningManifests({sourceSha,directory});
  const key=await readPrivateUpdateSigningKey(keyFile,{repositoryRoot:SOURCE_ROOT});
  const publicKey=EQUINOX_LOCAL_UPDATE_KEYS[KEY_ID];
  if(createPublicKey(key).export({type:'spki',format:'der'}).toString('base64')!==createPublicKey(publicKey).export({type:'spki',format:'der'}).toString('base64'))throw Error('Protected signing key does not match production Ed25519 trust root.');
  const epoch=Number(process.env.SOURCE_DATE_EPOCH);
  if(!Number.isSafeInteger(epoch)||epoch<=0)throw Error('Protected Main signing requires deterministic SOURCE_DATE_EPOCH.');
  const pointer=createSignedMainInstallPointer({sourceSha,version,publishedAt:new Date(epoch*1000).toISOString(),nativeManifests:prepared.manifests,keyId:KEY_ID,privateKey:key});
  const pointerFile=path.join(outputDir,`equinox-local-main-${sourceSha}.install-pointer.json`);
  await fs.writeFile(pointerFile,JSON.stringify(pointer,null,2)+'\n',{flag:'wx',mode:0o600});
  return {sourceSha,targets:prepared.manifests.length,pointerFile};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const args=process.argv.slice(2);if(args.length!==10||args.some((v,i)=>i%2===0&&!['--source-sha','--version','--manifest-dir','--key-file','--output-dir'].includes(v)))throw Error('Expected five signing argument pairs.');
    const opts=Object.fromEntries(Array.from({length:5},(_,i)=>[args[2*i].slice(2),args[2*i+1]]));
    const result=await signMainSnapshotSet({sourceSha:opts['source-sha'],version:opts.version,directory:opts['manifest-dir'],keyFile:opts['key-file'],outputDir:opts['output-dir']});
    process.stdout.write(`Verified and signed one Main installer selector for ${result.targets} targets at ${result.sourceSha}\n`);
  }catch(e){process.stderr.write(`Main signing failed: ${e instanceof Error?e.message:'unknown error'}\n`);process.exitCode=1;}
}
