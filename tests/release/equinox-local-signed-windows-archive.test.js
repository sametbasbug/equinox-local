import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {preserveOriginalSignedWindowsArchive} from "../../src/equinox-local-signed-windows-archive.js";
import {readBoundedNormalFile} from "../../src/equinox-local-safe-file.js";

const SHA="e".repeat(40);
const TARGET="win32-x64";
const ID="main-"+ "f".repeat(32);
const archiveName="equinox-local-main-"+SHA+"-"+TARGET+".zip";
const bytes=Buffer.from("ephemeral signed test ZIP payload only: archive-byte-sha-v1");
const digest=createHash("sha256").update(bytes).digest("hex");

async function fixture(t){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"equinox-signed-win-b-")));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const source=path.join(root,"staging",ID,"native",archiveName);
 const store=path.join(root,"native-store",TARGET,SHA);
 await fs.mkdir(path.dirname(source),{recursive:true,mode:0o700});
 await fs.mkdir(store,{recursive:true,mode:0o700});
 await fs.writeFile(source,bytes,{mode:0o600});
 const acl=[];
 const props={
  transactionRoot:root,transactionId:ID,sourceSha:SHA,target:TARGET,
  artifactSha256:digest,artifactBytes:bytes.length,
  pathApi:path.posix,
  protectImpl:async({target,type})=>{acl.push(["protect",target,type]);},
  verifyAclImpl:async({target,type})=>{acl.push(["verify",target,type]);return {safe:true};},
 };
 return {props,source,store,acl};
}

test("signed Windows native staging create-only archives exact downloaded ZIP bytes beside one immutable sourceSHA B (not current)",async t=>{
 const f=await fixture(t);
 const first=await preserveOriginalSignedWindowsArchive(f.props);
 assert.equal(first.status,"archived");
 assert.equal(first.archive,path.join(f.store,"signed-artifact.zip"));
 assert.deepEqual(await fs.readFile(first.archive),bytes);
 assert.equal((await fs.lstat(first.archive)).nlink,1);
 assert.ok(f.acl.some(row=>row[0]==="verify"&&row[2]==="directory"));
 assert.ok(f.acl.some(row=>row[0]==="verify"&&row[2]==="file"));
 assert.equal((await fs.readdir(f.store)).includes("signed-artifact.zip"),true);
 assert.deepEqual((await fs.readdir(f.store)).filter(item=>item.endsWith(".tmp")),[]);
 await assert.rejects(fs.lstat(path.join(f.props.transactionRoot,"current-native.json")),{code:"ENOENT"});
 const again=await preserveOriginalSignedWindowsArchive(f.props);
 assert.equal(again.status,"already_archived");
 assert.equal(again.archive,first.archive);
});

test("signed Windows artifact archival refuses tampered staging bytes, wrong sourceSHA, target and compromised target store",async t=>{
 const f=await fixture(t);
 await fs.writeFile(f.source,Buffer.alloc(bytes.length,12));
 await assert.rejects(preserveOriginalSignedWindowsArchive(f.props),/differs from Ed25519 artifact SHA256/u);
 await assert.rejects(fs.lstat(path.join(f.store,"signed-artifact.zip")),{code:"ENOENT"});
 for(const wrong of [
  {sourceSha:"Z".repeat(40)}, {target:"darwin-arm64"}, {transactionId:"main-INVALID"},
  {artifactSha256:"x".repeat(64)}, {artifactBytes:bytes.length-1},
  {transactionRoot:"relative"},
 ]){
  await assert.rejects(preserveOriginalSignedWindowsArchive({...f.props,...wrong}),/exact transaction or signed artifact identity|unsafe file identity or byte count/u);
 }
});

test("existing malicious or swapped ZIP cannot be replaced or silently repaired with same sourceSHA",async t=>{
 const f=await fixture(t);
 const dest=path.join(f.store,"signed-artifact.zip");
 await fs.writeFile(dest,Buffer.alloc(bytes.length,0x61),{mode:0o600});
 await assert.rejects(preserveOriginalSignedWindowsArchive(f.props),/differs from Ed25519 artifact SHA256/u);
 assert.deepEqual(await fs.readFile(dest),Buffer.alloc(bytes.length,0x61));
 await fs.unlink(dest);
 await fs.symlink(f.source,dest);
 await assert.rejects(preserveOriginalSignedWindowsArchive(f.props),/unsafe file identity|ELOOP/u);
 await fs.unlink(dest);
 await fs.writeFile(dest,bytes);
 await fs.link(dest,path.join(f.store,"foreign-hardlink"));
 await assert.rejects(preserveOriginalSignedWindowsArchive(f.props),/ambiguous interrupted publication/u);
});

test("signed Windows ZIP publication resumes ONLY its exact same-inode hardlink crash after verified Ed25519 hash",async t=>{
 const f=await fixture(t);
 const archive=path.join(f.store,"signed-artifact.zip");
 const temporary=path.join(f.store,".signed-archive-"+"b".repeat(24)+".tmp");
 await fs.link(f.source,archive);
 await fs.link(f.source,temporary);
 // A separate external stage link would be an ambiguous 3-link owner.
 await assert.rejects(preserveOriginalSignedWindowsArchive(f.props),/unsafe file identity/u);
 await fs.unlink(archive);
 await fs.unlink(temporary);
 await fs.writeFile(temporary,bytes,{mode:0o600});
 await fs.link(temporary,archive);
 assert.equal((await fs.lstat(archive)).nlink,2);
 const result=await preserveOriginalSignedWindowsArchive(f.props);
 assert.equal(result.status,"already_archived");
 assert.equal((await fs.lstat(archive)).nlink,1);
 await assert.rejects(fs.lstat(temporary),{code:"ENOENT"});
 assert.deepEqual((await readBoundedNormalFile(archive,{minBytes:1,maxBytes:4096,requireSingleLink:true})).data,bytes);
});

test("Windows per-user native-store ZIP staging denies open ACLs before creating its SHA archive",async t=>{
 const f=await fixture(t);
 await assert.rejects(preserveOriginalSignedWindowsArchive({...f.props,
  verifyAclImpl:async()=>({safe:false}),
 }),/store ACL is not private/u);
 await assert.rejects(fs.lstat(path.join(f.store,"signed-artifact.zip")),{code:"ENOENT"});
});

test("original Guardian verifies *signed* ZIP SHA and every decompressed executable B byte rather than trusting local fingerprint",async()=>{
 const file=await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainOriginalSignedArchive.cs",import.meta.url),"utf8");
 const caller=await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainNativeSignedJournalAudit.cs",import.meta.url),"utf8");
 const staging=await fs.readFile(new URL("../../src/equinox-local-first-install.ts",import.meta.url),"utf8");
 assert.match(file,/signedArtifactBytes/u);
 assert.match(file,/Convert\.ToHexStringLower\(SHA256\.HashData\(archiveStream\)\) != signedArtifactSha256/u);
 assert.match(file,/new ZipArchive\(archiveStream, ZipArchiveMode\.Read, leaveOpen: true\)/u);
 assert.match(file,/entry\.Open\(\)/u);
 assert.match(file,/SHA256\.HashData\(original\)/u);
 assert.match(file,/SHA256\.HashData\(extracted\)/u);
 assert.match(file,/CryptographicOperations\.FixedTimeEquals\(archiveDigest, releaseDigest\)/u);
 assert.match(file,/discovered\.Count != archiveEntries\.Count/u);
 assert.match(file,/FileAttributes\.ReparsePoint/u);
 assert.match(caller,/InspectOriginalSignedWindowsArchive\(\s*Path\.Combine\(payload, "signed-artifact\.zip"\), expected\.ReleaseDir,\s*signed\.ArtifactSha256, signed\.ArtifactBytes\);/u);
 assert.match(staging,/if\(platform==="win32"\)\{\s*await persistWindowsArchiveImpl\(/u);
 assert.match(staging,/sourceSha:pointer\.sourceSha,target:expectedTarget,\s*artifactSha256:row\.artifact\.sha256,artifactBytes:row\.artifact\.bytes/u);
 assert.doesNotMatch(staging,/ActivateWindowsMain|--ActivateMain/u);
});


test("ORIGINAL Windows WPF exposes ONLY a read-only Main signature/archive provenance audit via ORIGINAL installed Guardian; normal signed launch remains denied",async()=>{
 const [wpf,ipc,guardian]=await Promise.all([
  fs.readFile(new URL("../../native/windows/EquinoxLocal.WindowsShell/MainUpdateHandoff.cs",import.meta.url),"utf8"),
  fs.readFile(new URL("../../native/windows/EquinoxLocal.WindowsShell/SingleInstanceCoordinator.cs",import.meta.url),"utf8"),
  fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainNativeSignedJournalAudit.cs",import.meta.url),"utf8"),
 ]);
 assert.match(ipc,/command\.StartsWith\("main-native-audit:", StringComparison\.Ordinal\)/u);
 assert.match(ipc,/MainUpdateHandoff\.AuditSignedNativeWithoutGrant\(transactionId\)/u);
 assert.match(ipc,/WriteLineAsync\("verified-read-only"\)/u);
 assert.match(wpf,/internal static void AuditSignedNativeWithoutGrant\(string transactionId\)/u);
 assert.match(wpf,/InspectPendingSignedNativeWithoutGrant\(transactionId, auditOnly: true\)/u);
 assert.match(wpf,/Original Git owner cannot impersonate signed-native WPF audit/u);
 assert.match(wpf,/startInfo\.ArgumentList\.Add\("--audit-signed-native-journal"\)/u);
 assert.match(wpf,/guardian\.WaitForExit\(120_000\)/u);
 assert.match(wpf,/guardian\.ExitCode != 0/u);
 assert.match(wpf,/return expected; \/\/ Only the explicit PROOF launcher can start B, never switch A\/B/u);
 assert.match(wpf,/InspectPendingSignedNativeWithoutGrant\(transactionId\);/u);
 assert.match(wpf,/throw new InvalidOperationException\(\s*"Signed-native Main WPF handoff requires independent original Ed25519 and Guardian OS session/u);
 assert.match(guardian,/InspectOriginalSignedWindowsArchive\(/u);
});

test("same original Guardian live signed-native OS HMAC challenge reuses the verified kernel owner in-process; no second full ZIP tree scan",async()=>{
 const [program,argv,identity]=await Promise.all([
  fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/Program.cs",import.meta.url),"utf8"),
  fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainNativeWorkerArguments.cs",import.meta.url),"utf8"),
  fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainNativeWorkerIdentity.cs",import.meta.url),"utf8"),
 ]);
 assert.match(program,/var audited = InspectOwnedNativeWorkerOsArguments\(signedNativeReadOnly: true\);/u);
 assert.match(program,/InspectOwnedNativeWorkerPipeProof\(signedNativeReadOnly: true, previouslyAudited: audited\);/u);
 assert.match(program,/InspectSignedNativeWorkerWpfParentWithoutGrant\(audited\)/u);
 assert.match(argv,/private static OwnedWorkerClaim InspectOwnedNativeWorkerOsArguments\(bool signedNativeReadOnly = false\)/u);
 assert.match(argv,/return worker;/u);
 assert.match(identity,/previouslyAudited \?\? InspectOwnedNativeWorkerProcess\(signedNativeReadOnly\)/u);
 assert.match(identity,/GetNamedPipeServerProcessId\(pipe\.SafePipeHandle, out var serverPid\)/u);
});
