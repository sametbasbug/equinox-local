// Common source-SHA native archive verifier for both external OS installers.
// Its entrypoint requires an independently SHA-256-pinned Node executable and
// verified copy of THIS script. No system Git/npm or private keys are needed.
import {createHash, verify as verifySignature} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const POINTER_URL='https://main.local.sametbasbug.dev/latest/main.json';
const PUBLIC_BASE='https://main.local.sametbasbug.dev/snapshots/';
const TRUSTED_KEY_ID='stable-2026-01';
const TRUSTED_KEY='-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAmFYwZkZ7Aabb8QZ/RAwhxr3D4RenekD4Cf2vhs7Vk/A=\n-----END PUBLIC KEY-----\n';
const SHA=/^[a-f0-9]{40}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const VERSION=/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const TARGETS=Object.freeze(['darwin-arm64','darwin-x64','win32-arm64','win32-x64']);
const MAX_POINTER=16384;
const MAX_ARCHIVE=1073741824;

function exactFields(value,fields,label){
 if(!value||typeof value!=='object'||Array.isArray(value)||
  Object.keys(value).sort().join(',')!==fields.slice().sort().join(',')){
  throw Error(label+' has missing or unexpected fields.');
 }
 return value;
}
function exactHash(value,label){
 if(typeof value!=='string'||!DIGEST.test(value))throw Error(label+' is not an exact SHA-256.');
 return value;
}
function validatedPayload(raw){
 const pointer=exactFields(raw,['schemaVersion','channel','sourceSha','version','publishedAt','targets','signature'],'Main selector');
 const signature=exactFields(pointer.signature,['algorithm','keyId','value'],'Main signature');
 if(signature.algorithm!=='ed25519'||signature.keyId!==TRUSTED_KEY_ID||
   typeof signature.value!=='string'||signature.value.length>256){
  throw Error('Untrusted Main Ed25519 signing identity.');
 }
 const signatureBytes=Buffer.from(signature.value,'base64');
 if(signatureBytes.length!==64||signatureBytes.toString('base64')!==signature.value){
  throw Error('Noncanonical Main signing bytes.');
 }
 if(pointer.schemaVersion!==1||pointer.channel!=='main'||typeof pointer.sourceSha!=='string'||!SHA.test(pointer.sourceSha)||
   typeof pointer.version!=='string'||!VERSION.test(pointer.version)||
   typeof pointer.publishedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(pointer.publishedAt)||
   !Number.isFinite(Date.parse(pointer.publishedAt))||
   new Date(pointer.publishedAt).toISOString()!==pointer.publishedAt||
   !Array.isArray(pointer.targets)||pointer.targets.length!==TARGETS.length){
  throw Error('Main selector metadata is invalid.');
 }
 const sourceSha=pointer.sourceSha;
 const targets=pointer.targets.map((candidate,index)=>{
  const row=exactFields(candidate,['target','runtimeContractSha256','artifact'],'Main target');
  const target=TARGETS[index];
  if(row.target!==target)throw Error('Main four-target order or coverage changed.');
  const artifact=exactFields(row.artifact,['url','sha256','bytes'],'Main artifact');
  const extension=target.startsWith('win32-')?'.zip':'.tar.gz';
  const url=PUBLIC_BASE+sourceSha+'/equinox-local-main-'+sourceSha+'-'+target+extension;
  if(artifact.url!==url||!Number.isSafeInteger(artifact.bytes)||
    artifact.bytes<1||artifact.bytes>MAX_ARCHIVE){
   throw Error('Main archive URL or byte count is not admitted.');
  }
  return {target,runtimeContractSha256:exactHash(row.runtimeContractSha256,'Runtime contract'),
    artifact:{url,sha256:exactHash(artifact.sha256,'Main artifact hash'),bytes:artifact.bytes}};
 });
 return {payload:{schemaVersion:1,channel:'main',sourceSha,version:pointer.version,
   publishedAt:pointer.publishedAt,targets},signatureBytes};
}

// Public entry never takes a key, test key, or arbitrary artifact URL.
export function verifyMainInstallerPointer(raw,{target}={}){
 if(!TARGETS.includes(target))throw Error('Unsupported native Main target.');
 const {payload,signatureBytes}=validatedPayload(raw);
 if(!verifySignature(null,Buffer.from(JSON.stringify(payload),'utf8'),TRUSTED_KEY,signatureBytes)){
  throw Error('Main Ed25519 production signature verification failed.');
 }
 const selected=payload.targets.find(entry=>entry.target===target);
 return Object.freeze({sourceSha:payload.sourceSha,version:payload.version,publishedAt:payload.publishedAt,target,
   runtimeContractSha256:selected.runtimeContractSha256,
   artifact:Object.freeze({...selected.artifact})});
}
async function smallResponse(response){
 if(response.status!==200||!response.body)throw Error('Main selector HTTPS request failed.');
 if(response.headers.get('cache-control')!=='no-store')throw Error('Mutable Main selector must use no-store caching.');
 const encoding=response.headers.get('content-encoding');
 if(encoding&&encoding!=='identity')throw Error('Main selector content encoding is unsupported.');
 const length=response.headers.get('content-length');
 if(length!==null&&(!/^\d+$/u.test(length)||Number(length)>MAX_POINTER)){
  throw Error('Main selector HTTP size is invalid.');
 }
 let size=0;const parts=[];
 for await(const part of response.body){
  size+=part.length;
  if(size>MAX_POINTER)throw Error('Main selector exceeds bounded size.');
  parts.push(part);
 }
 if(size<200)throw Error('Main selector truncated.');
 return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

// Caller provides a NEW absolute file inside its owned private staging root.
// File creation uses exclusive mode; failed partial downloads are removed.
export async function downloadVerifiedMainArchive({target,destination,pointerDestination}={}){
 if(!TARGETS.includes(target)||typeof destination!=='string'||!path.isAbsolute(destination)||
    path.resolve(destination)!==destination){
  throw Error('Main verification needs a supported target and absolute new file.');
 }
 if(pointerDestination!==undefined&&
   (typeof pointerDestination!=='string'||!path.isAbsolute(pointerDestination)||
    path.resolve(pointerDestination)!==pointerDestination||
    pointerDestination===destination)){
  throw Error('Signed Main selector output requires a separate absolute new file.');
 }
 const response=await fetch(POINTER_URL,{redirect:'error',
  headers:{'cache-control':'no-cache','accept-encoding':'identity'},signal:AbortSignal.timeout(30000)});
 const signedPointer=await smallResponse(response);
 const selected=verifyMainInstallerPointer(signedPointer,{target});
 const artifact=selected.artifact;
 const data=await fetch(artifact.url,{redirect:'error',headers:{'accept-encoding':'identity'},signal:AbortSignal.timeout(600000)});
 if(data.status!==200||!data.body)throw Error('Main native archive HTTP request failed.');
 const encoding=data.headers.get('content-encoding');
 if(encoding&&encoding!=='identity')throw Error('Main archive HTTP content encoding is unsupported.');
 const length=data.headers.get('content-length');
 if(length!==null&&(!/^\d+$/u.test(length)||Number(length)!==artifact.bytes)){
  throw Error('Main archive Content-Length differs from signed bytes.');
 }
 const file=await fs.open(destination,'wx',0o600);
 let verified=false;
 let pointerCreated=false;
 try{
  let total=0;
  const sha=createHash('sha256');
  for await(const part of data.body){
   total+=part.length;
   if(total>artifact.bytes)throw Error('Main archive exceeds signed bytes.');
   sha.update(part);
   let offset=0;
   while(offset<part.length){
    const {bytesWritten}=await file.write(part,offset,part.length-offset);
    if(bytesWritten<1)throw Error('Main archive write made no progress.');
    offset+=bytesWritten;
   }
  }
  if(total!==artifact.bytes||sha.digest('hex')!==artifact.sha256){
   throw Error('Main archive failed signed SHA-256 and byte count.');
  }
  await file.sync();
  if(pointerDestination!==undefined){
   // Exact original production signature and payload are retained for the
   // already trusted native A/B stage, whose pinned root rechecks it.
   const bytes=Buffer.from(JSON.stringify(signedPointer));
   if(bytes.length>MAX_POINTER)throw Error('Signed Main selector exceeded the bounded persistence size.');
   const pointer=await fs.open(pointerDestination,'wx',0o600);
   pointerCreated=true;
   try{await pointer.writeFile(bytes);await pointer.sync();}
   finally{await pointer.close();}
  }
  verified=true;
  return Object.freeze({sourceSha:selected.sourceSha,version:selected.version,publishedAt:selected.publishedAt,target,
   runtimeContractSha256:selected.runtimeContractSha256,
   artifactSha256:artifact.sha256,artifactBytes:artifact.bytes});
 }finally{
  await file.close();
  if(!verified){
   await fs.rm(destination,{force:true});
   if(pointerCreated)await fs.rm(pointerDestination,{force:true});
  }
 }
}
async function main(args){
 if((args.length!==4&&args.length!==6)||args[0]!=='--target'||args[2]!=='--output'||
   (args.length===6&&args[4]!=='--pointer-output')){
  throw Error('Usage: install-main-verify.mjs --target <native-target> --output <new-absolute-file> [--pointer-output <new-absolute-file>]');
 }
 const result=await downloadVerifiedMainArchive({target:args[1],destination:args[3],
  ...(args.length===6?{pointerDestination:args[5]}:{})});
 process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main(process.argv.slice(2)).catch((error)=>{
  // This is an installer, so failed downloads must expose their stage instead
  // of a generic catch that makes a missing native release impossible to diagnose.
  const reason=error instanceof Error?error.message:'unknown failure';
  process.stderr.write('Signed Main verification failed: '+reason.slice(0,400)+'. Unverified archive refused.\n');
  process.exitCode=1;
 });
}
