// Public-repo AWS/S3 adapter for a separately verified signed Main release. NEVER receives the signing key,
// executes public checkout code, mutates Git tags, or decides release readiness.
// Used by the existing protected main-push publication job, never a separate update engine.
import {execFile as cb} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';

const MAIN_R2_BUCKET='equinox-local-main';
const MAIN_R2_IMMUTABLE_CACHE='public,max-age=31536000,immutable';
const MAIN_NAME=/^equinox-local-main-[a-f0-9]{40}-(?:darwin-arm64|darwin-x64|win32-arm64|win32-x64)(?:\.json|\.zip|\.tar\.gz)$/u;
function mainR2ImmutableKey(sourceSha,name){
 if(!/^[a-f0-9]{40}$/u.test(sourceSha)||!MAIN_NAME.test(name)||!name.startsWith(`equinox-local-main-${sourceSha}-`))throw Error('Invalid immutable Main object identity.');
 return `snapshots/${sourceSha}/${name}`;
}
const execFile=promisify(cb);
const R2_ENDPOINT='https://c1ff8ccffcbffe46094cd3a2729a1c1f.r2.cloudflarestorage.com';
const SHA=/^[a-f0-9]{64}$/u;
const COMMIT=/^[a-f0-9]{40}$/u;
const LATEST_MAIN_POINTER='latest/main.json';
const NO_STORE='no-store';
const R2_SMALL_MAX=16*1024;
const E_TAG=/^"[a-f0-9]{32}(?:-[1-9][0-9]*)?"$/u;
const immutablePointerKey=sourceSha=>{
 if(typeof sourceSha!=='string'||!COMMIT.test(sourceSha))throw Error('Main pointer object requires exact forty-hex Main commit.');
 return 'pointers/main/'+sourceSha+'.json';
};
async function validatedPointerBody(file,sha256,bytes){
 if(typeof file!=='string'||!path.isAbsolute(file)||path.resolve(file)!==file||!SHA.test(sha256)||
  !Number.isSafeInteger(bytes)||bytes<200||bytes>R2_SMALL_MAX)throw Error('Signed pointer source identity is not bounded.');
 const st=await fs.lstat(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||st.size!==bytes)throw Error('Signed pointer must be a bounded normal file.');
 const fd=await fs.open(file,'r');
 try{
  const opened=await fd.stat();
  if(opened.dev!==st.dev||opened.ino!==st.ino||opened.size!==st.size)throw Error('Signed pointer file changed during open.');
  const body=await fd.readFile();
  if(body.length!==bytes||createHash('sha256').update(body).digest('hex')!==sha256)throw Error('Signed pointer body differs from admitted SHA-256.');
  return body;
 }finally{await fd.close();}
}


function boundedCredentials(credentials){
 if(!credentials||typeof credentials!=='object'||typeof credentials.accessKeyId!=='string'||
    typeof credentials.secretAccessKey!=='string'||!credentials.accessKeyId.trim()||!credentials.secretAccessKey.trim()||
    credentials.accessKeyId.length>256||credentials.secretAccessKey.length>512){
   throw Error('Private R2 publish credentials must be supplied separately from the signing FD3.');
 }
 const env={PATH:'/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',LC_ALL:'C',
  AWS_ACCESS_KEY_ID:credentials.accessKeyId,AWS_SECRET_ACCESS_KEY:credentials.secretAccessKey,
  AWS_DEFAULT_REGION:'auto',AWS_EC2_METADATA_DISABLED:'true',AWS_RETRY_MODE:'standard',AWS_MAX_ATTEMPTS:'4',AWS_PAGER:''};
 if(credentials.sessionToken){
  if(typeof credentials.sessionToken!=='string'||credentials.sessionToken.length>8192)throw Error('Invalid R2 session token.');
  env.AWS_SESSION_TOKEN=credentials.sessionToken;
 }
 return Object.freeze(env);
}
function contractToArguments(contract){
 if(!contract||contract.bucket!==MAIN_R2_BUCKET||contract.ifNoneMatch!=='*'||contract.cacheControl!==MAIN_R2_IMMUTABLE_CACHE||
    !SHA.test(contract.metadata?.sha256)||!Number.isSafeInteger(contract.bytes)||contract.bytes<1){
  throw Error('R2 upload contract must be immutable and cryptographically exact.');
 }
 const expectedKey=mainR2ImmutableKey(contract.key.split('/')[1],contract.bodyName);
 if(contract.key!==expectedKey)throw Error('R2 upload key must be exact source SHA and immutable basename.');
 return ['s3api','put-object','--bucket',contract.bucket,'--key',contract.key,'--if-none-match','*',
  '--metadata',`sha256=${contract.metadata.sha256}`,'--cache-control',MAIN_R2_IMMUTABLE_CACHE];
}

// Tests can inject the AWS CLI protocol runner, NEVER a trusted production
// admission/gating callback or a signer. The protected Main job calls
// this only after current-Main and Ed25519 admission.
export function createMainSignedR2Store({credentials,runner=execFile}={}){
 const env=boundedCredentials(credentials);
 if(typeof runner!=='function')throw Error('R2 runner must be an execution function.');
 const run=async(args,{maxTime=300000}={})=>runner('aws',[...args,'--endpoint-url',R2_ENDPOINT,'--output','json','--no-cli-pager'],{
  encoding:'utf8',env,timeout:maxTime,maxBuffer:64*1024,
 });
 async function toTemp(callback){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'equinox-main-r2-read-'));
  try{return await callback(path.join(root,'object'));}
  finally{await fs.rm(root,{recursive:true,force:true});}
 }
 return Object.freeze({
  async putIfAbsent({contract,file}){
   const before=await fs.lstat(file);
   if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size!==contract?.bytes){
    throw Error('Conditional R2 upload body changed or is not a normal file.');
   }
   const args=contractToArguments(contract);
   try{await run([...args,'--body',file]);return {status:'created'};}
   catch(e){
    // S3 412 means the object key EXISTS. Do NOT rewrite. The full remote
    // body must be verified by the independent read-only proof after all PUTs.
    const message=String(e?.stderr||e?.message||'');
    if(/PreconditionFailed|status code: 412|\(412\)/u.test(message))return {status:'already_exists'};
    throw Error('Private R2 conditional immutable PUT failed without a safe pre-existing-object result.');
   }
  },
  // Reuses the existing isolated S3 adapter; R2 PUT conditions are atomic.
  async putImmutableMainPointer({sourceSha,file,sha256,bytes}){
   const key=immutablePointerKey(sourceSha);
   await validatedPointerBody(file,sha256,bytes);
   try{
    await run(['s3api','put-object','--bucket',MAIN_R2_BUCKET,'--key',key,
      '--if-none-match','*','--body',file,'--content-type','application/json',
      '--cache-control',MAIN_R2_IMMUTABLE_CACHE,'--metadata','sha256='+sha256],{maxTime:45000});
    return Object.freeze({status:'created',key});
   }catch(error){
    const message=String(error?.stderr||error?.message||'');
    if(/PreconditionFailed|status code: 412|\(412\)/u.test(message))return Object.freeze({status:'already_exists',key});
    throw Error('Immutable Main pointer conditional R2 PUT failed.');
   }
  },
  async readMainPointer({sourceSha}={}){
   const key=sourceSha===undefined?LATEST_MAIN_POINTER:immutablePointerKey(sourceSha);
   return toTemp(async(file)=>{
    let result;
    try{result=await run(['s3api','get-object','--bucket',MAIN_R2_BUCKET,'--key',key,file],{maxTime:30000});}
    catch(error){
     const message=String(error?.stderr||error?.message||'');
     if(sourceSha===undefined&&/NoSuchKey|Not Found: \(404\)|\(404\)/u.test(message))return null;
     throw Error('R2 signed Main pointer could not be read.');
    }
    const response=JSON.parse(result.stdout);
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<200||stat.size>R2_SMALL_MAX||
      !E_TAG.test(response.ETag)||typeof response.Metadata?.sha256!=='string'||!SHA.test(response.Metadata.sha256)){
     throw Error('Remote signed Main pointer metadata is invalid.');
    }
    const bytes=await fs.readFile(file);
    const sha256=createHash('sha256').update(bytes).digest('hex');
    if(sha256!==response.Metadata.sha256)throw Error('Remote signed Main pointer body/metadata mismatch.');
    const expectedCache=sourceSha===undefined?NO_STORE:MAIN_R2_IMMUTABLE_CACHE;
    if(response.CacheControl!==expectedCache)throw Error('Remote signed Main pointer caching contract mismatch.');
    return Object.freeze({body:bytes,sha256,etag:response.ETag,key});
   });
  },
  async compareAndSwapMainLatest({file,sha256,bytes,previousEtag=null}={}){
   await validatedPointerBody(file,sha256,bytes);
   if(previousEtag!==null&&!E_TAG.test(previousEtag))throw Error('Latest Main CAS requires prior R2 ETag or first-create identity.');
   const condition=previousEtag===null?['--if-none-match','*']:['--if-match',previousEtag];
   try{
    await run(['s3api','put-object','--bucket',MAIN_R2_BUCKET,'--key',LATEST_MAIN_POINTER,
      ...condition,'--body',file,'--content-type','application/json',
      '--cache-control',NO_STORE,'--metadata','sha256='+sha256],{maxTime:45000});
   }catch(error){
    const message=String(error?.stderr||error?.message||'');
    if(/PreconditionFailed|status code: 412|\(412\)/u.test(message))throw Error('Latest Main changed concurrently; CAS refused without overwrite.');
    throw Error('Latest Main conditional R2 PUT failed.');
   }
   return Object.freeze({status:'conditional_put_accepted',key:LATEST_MAIN_POINTER});
  },
  async headArchive(sourceSha,name){
   const key=mainR2ImmutableKey(sourceSha,name);
   const {stdout}=await run(['s3api','head-object','--bucket',MAIN_R2_BUCKET,'--key',key],{maxTime:30000});
   const data=JSON.parse(stdout);
   return {bytes:data.ContentLength,sha256Metadata:data.Metadata?.sha256,
    immutable:data.CacheControl===MAIN_R2_IMMUTABLE_CACHE};
  },
  async getSmall(sourceSha,name){
   const key=mainR2ImmutableKey(sourceSha,name);
   return toTemp(async(file)=>{
    await run(['s3api','get-object','--bucket',MAIN_R2_BUCKET,'--key',key,file],{maxTime:120000});
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>65536||stat.size<1){
     throw Error('Remote Main signed JSON is not a bounded normal file.');
    }
    return fs.readFile(file);
   });
  },
  async *streamArchive(sourceSha,name){
   const key=mainR2ImmutableKey(sourceSha,name);
   const root=await fs.mkdtemp(path.join(os.tmpdir(),'equinox-main-r2-stream-'));
   try{
    const file=path.join(root,'archive');
    await run(['s3api','get-object','--bucket',MAIN_R2_BUCKET,'--key',key,file],{maxTime:600000});
    const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>1024*1024*1024){
     throw Error('Remote Main archived file is not normal and bounded.');
    }
    for await(const chunk of createReadStream(file,{highWaterMark:1024*1024})){yield chunk;}
   }finally{await fs.rm(root,{recursive:true,force:true});}
  },
 });
}
