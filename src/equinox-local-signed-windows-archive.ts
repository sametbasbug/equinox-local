import {createHash,randomBytes} from "node:crypto";
import {constants as fsConstants} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
 protectWindowsPrivateStatePath,verifyWindowsPrivateStateAcl,
} from "./equinox-local-private-state.js";

const TX=/^main-[a-f0-9]{32}$/u;
const SHA=/^[a-f0-9]{40}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const TARGET=/^win32-(?:arm64|x64)$/u;
const MAX_BYTES=1024*1024*1024;

type Options={
 transactionRoot:string;transactionId:string;sourceSha:string;target:string;
 artifactSha256:string;artifactBytes:number;
 env?:NodeJS.ProcessEnv;fsImpl?:typeof fs;pathApi?:typeof path.win32;
 protectImpl?:typeof protectWindowsPrivateStatePath;
 verifyAclImpl?:typeof verifyWindowsPrivateStateAcl;
};

async function assertExactArchive(
 file:string,size:number,digest:string,fsImpl:typeof fs,expectedLinks=1){
 const handle=await fsImpl.open(file,fsConstants.O_RDONLY|(fsConstants.O_NOFOLLOW??0));
 try{
  const [open,name]=await Promise.all([handle.stat(),fsImpl.lstat(file)]);
  if(!open.isFile()||!name.isFile()||name.isSymbolicLink()||
     name.nlink!==expectedLinks||open.nlink!==expectedLinks||
     open.size!==size||open.dev!==name.dev||open.ino!==name.ino){
   throw new Error("Original signed Windows archive has unsafe file identity or byte count.");
  }
  const hash=createHash("sha256");
  const buffer=Buffer.allocUnsafe(1024*1024);
  let offset=0;
  while(offset<size){
   const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,size-offset),offset);
   if(bytesRead<1)throw new Error("Original signed Windows archive ended early.");
   hash.update(buffer.subarray(0,bytesRead));
   offset+=bytesRead;
  }
  if(hash.digest("hex")!==digest)throw new Error("Original signed Windows archive differs from Ed25519 artifact SHA256.");
  const final=await handle.stat();
  if(final.size!==size||final.ino!==open.ino||final.dev!==open.dev) {
   throw new Error("Original signed Windows archive changed while being verified.");
  }
 }finally{await handle.close();}
}

// Keep the actual production-Ed25519-authorized ZIP next to immutable B.
// Previously native-store.json merely *claimed* the archive digest after
// discarding the ZIP; it cannot prove executable B was extracted from it.
// This is a create-only, idempotent, SHA-scoped archival operation. It never
// switches A/B, touches a running service or trusts an unsigned archive.
export async function preserveOriginalSignedWindowsArchive({
 transactionRoot,transactionId,sourceSha,target,artifactSha256,artifactBytes,
 env=process.env,fsImpl=fs,pathApi=path.win32,
 protectImpl=protectWindowsPrivateStatePath,verifyAclImpl=verifyWindowsPrivateStateAcl,
}:Options){
 if(!TX.test(transactionId)||!SHA.test(sourceSha)||!TARGET.test(target)||
    !DIGEST.test(artifactSha256)||
    !Number.isSafeInteger(artifactBytes)||artifactBytes<1||artifactBytes>MAX_BYTES||
    typeof transactionRoot!=="string"||!pathApi.isAbsolute(transactionRoot)||
    pathApi.normalize(transactionRoot)!==transactionRoot){
  throw new Error("Original Windows signed archive has no exact transaction or signed artifact identity.");
 }
 const stored=pathApi.join(transactionRoot,"native-store",target,sourceSha);
 const archive=pathApi.join(stored,"signed-artifact.zip");
 const input=pathApi.join(transactionRoot,"staging",transactionId,"native",
  "equinox-local-main-"+sourceSha+"-"+target+".zip");
 const stat=await fsImpl.lstat(stored);
 if(!stat.isDirectory()||stat.isSymbolicLink()||
    await fsImpl.realpath(stored)!==stored){
  throw new Error("Original Windows signed archive has no canonical native-store B.");
 }
 await protectImpl({target:stored,type:"directory",env});
 if(!(await verifyAclImpl({target:stored,type:"directory",env})).safe) {
  throw new Error("Original Windows native B store ACL is not private.");
 }
 const existing=await fsImpl.lstat(archive).catch(error=>{
  if((error as NodeJS.ErrnoException).code==="ENOENT")return null;
  throw error;
 });
 if(existing){
  if(existing.nlink===2 && existing.isFile() && !existing.isSymbolicLink()){
   // Crash after create-only fs.link(temp, archive) but before unlink(temp).
   // The ONLY recoverable second link must be the single exact private
   // temporary path with matching device/inode and signed ZIP digest.
   await assertExactArchive(archive,artifactBytes,artifactSha256,fsImpl,2);
   const entries=await fsImpl.readdir(stored);
   const matches=[];
   for(const entry of entries){
    if(!/^\.signed-archive-[a-f0-9]{24}\.tmp$/u.test(entry))continue;
    const temporary=pathApi.join(stored,entry);
    const stat=await fsImpl.lstat(temporary);
    if(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===2&&
       stat.dev===existing.dev&&stat.ino===existing.ino)matches.push(temporary);
   }
   if(matches.length!==1)throw new Error("Original Windows archive has ambiguous interrupted publication.");
   await assertExactArchive(matches[0]!,artifactBytes,artifactSha256,fsImpl,2);
   await fsImpl.unlink(matches[0]!);
  }
  await assertExactArchive(archive,artifactBytes,artifactSha256,fsImpl);
  return Object.freeze({status:"already_archived",archive});
 }
 // This is the SAME previously full-SHA inspected short-lived staging ZIP.
 await assertExactArchive(input,artifactBytes,artifactSha256,fsImpl);
 const temporary=pathApi.join(stored,".signed-archive-"+randomBytes(12).toString("hex")+".tmp");
 try{
  await fsImpl.copyFile(input,temporary,fsConstants.COPYFILE_EXCL);
  await protectImpl({target:temporary,type:"file",env});
  if(!(await verifyAclImpl({target:temporary,type:"file",env})).safe) {
   throw new Error("Original Windows staged archive ACL is not private.");
  }
  await assertExactArchive(temporary,artifactBytes,artifactSha256,fsImpl);
  // FlushFileBuffers on Windows requires a writable file handle; a read-only
 // descriptor makes Node fsync() return EPERM even for a valid owned ZIP.
 const handle=await fsImpl.open(temporary,"r+");
  try{await handle.sync();}finally{await handle.close();}
  // Never overwrite an existing signed SHA archive (including races).
  await fsImpl.link(temporary,archive);
  await fsImpl.unlink(temporary);
  await assertExactArchive(archive,artifactBytes,artifactSha256,fsImpl);
  return Object.freeze({status:"archived",archive});
 }finally{await fsImpl.rm(temporary,{force:true}).catch(()=>{});}
}
