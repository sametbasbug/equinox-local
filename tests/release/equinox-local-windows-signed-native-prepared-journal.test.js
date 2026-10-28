import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const base=new URL("../../native/windows/EquinoxLocal.Guardian/",import.meta.url);
const read=async name=>fs.readFile(new URL(name,base),"utf8");

test("ORIGINAL Guardian creates durable PREPARED-only native journal only after exclusive live original OS owner lease, full B Ed25519 ZIP and fresh HMAC",async()=>{
 const [owner,prepared,program]=await Promise.all([
  read("MainSignedNativeOwnerLease.cs"),
  read("MainSignedNativePreparedJournal.cs"),
  read("Program.cs"),
 ]);
 assert.match(owner,/InspectSignedNativeOwnerExclusiveLeaseWithoutGrant\(\s*Action<string, string, string, string, int, string>\? afterLiveProof = null\)/u);
 assert.match(owner,/FileMode\.CreateNew, FileAccess\.ReadWrite,\s*FileShare\.None/u);
 assert.match(owner,/name\.EndsWith\("\.signed-native\.json", StringComparison\.OrdinalIgnoreCase\)/u);
 assert.match(owner,/FileOptions\.DeleteOnClose \| FileOptions\.WriteThrough/u);
 const anchor=owner.indexOf("afterLiveProof?.Invoke(");
 const signature=owner.indexOf("InspectOwnedNativeWorkerOsArguments(signedNativeReadOnly: true)");
 const nonce=owner.indexOf("InspectOwnedNativeWorkerPipeProof(signedNativeReadOnly: true");
 const guardianPin=owner.indexOf("VerifyPinnedNativeGuardianFile(originalGuardian);");
 assert.ok(signature>=0&&nonce>signature&&guardianPin>nonce&&anchor>guardianPin);
 assert.match(prepared,/InspectSignedNativeOwnerExclusiveLeaseWithoutGrant\(\s*PrepareSignedNativeJournalUnderOriginalLiveOwner\)/u);
 assert.match(program,/args\[0\] == "--prepare-signed-native-journal"/u);
 assert.match(program,/PrepareSignedNativeJournalWithoutMutation\(\)/u);
 assert.match(program,/Durable PREPARED evidence, never A\/B mutation/u);
});

test("original signed-native journal prepared writer is create-only, durable on crash and has no WPF stop or A/B switch side effect",async()=>{
 const source=await read("MainSignedNativePreparedJournal.cs");
 assert.match(source,/Path\.Combine\(transactionRoot, "guardian-journal",\s*transactionId \+ "\.signed-native\.json"\)/u);
 assert.match(source,/RequireNormalDirectory\(journalRoot\)/u);
 assert.match(source,/EndsWith\("\.signed-native\.json",/u);
 assert.match(source,/HashOriginalBoundedSignedNativeFile\(receipt\)/u);
 assert.match(source,/HashOriginalBoundedSignedNativeFile\(descriptor\)/u);
 assert.match(source,/stage = "prepared", sequence = 0,/u);
 assert.match(source,/workerPid, workerStartTimeUtcTicks = workerTicks,/u);
 assert.match(source,/FileMode\.CreateNew, FileAccess\.Write,\s*FileShare\.None/u);
 assert.match(source,/FileOptions\.WriteThrough/u);
 assert.match(source,/journal\.Flush\(flushToDisk: true\)/u);
 assert.match(source,/worker\.StartTime\.ToUniversalTime\(\)\.Ticks\.ToString\(CultureInfo\.InvariantCulture\) != workerTicks/u);
 assert.doesNotMatch(source,/FileMode\.Create\b|File\.Delete|File\.Move|Directory\.Delete|Process\.Start|Process\.Kill|SetDisposition|SwitchMainNative|CurrentNativePointer/u);
 assert.doesNotMatch(source,/EQUINOX_LOCAL_MAIN_WORKER_TOKEN|owner\.Token|token =/u);
});

test("ORIGINAL signed-native prepared crash audit never auto-reclaims or promotes prepared evidence to Guardian OS mutation authority",async()=>{
 const [source,program,legacy]=await Promise.all([
  read("MainSignedNativePreparedJournal.cs"),
  read("Program.cs"),read("MainNativeJournalLease.cs"),
 ]);
 assert.match(program,/args\[0\] == "--audit-signed-native-prepared-journal"/u);
 assert.match(program,/AuditSignedNativePreparedJournalWithoutGrant\(\)/u);
 assert.match(program,/Crash forensic inspection; never journal authority/u);
 assert.match(source,/InspectOwnedSignedNativeJournalWithoutGrant\(\)/u);
 assert.match(source,/RequireExactKeys\(j, \["schemaVersion", "channel", "kind", "transactionId",/u);
 assert.match(source,/j\.GetProperty\("stage"\)\.GetString\(\) != "prepared"/u);
 assert.match(source,/j\.GetProperty\("sequence"\)\.GetInt32\(\) != 0/u);
 assert.match(source,/j\.GetProperty\("receiptSha256"\)\.GetString\(\) != receiptSha/u);
 assert.match(source,/j\.GetProperty\("rollbackDescriptorSha256"\)\.GetString\(\) != rollbackSha/u);
 assert.match(source,/signed-native-prepared-reconciled-read-only/u);
 assert.doesNotMatch(legacy,/PrepareSignedNativeJournalWithoutMutation|AuditSignedNativePreparedJournalWithoutGrant/u);
});

test("same original Windows native B worker is NOT promoted to signed-native prepared mutation or original legacy Git journal after proof",async()=>{
 const w=await fs.readFile(new URL("../../src/equinox-local-signed-main-windows-worker.ts",import.meta.url),"utf8");
 assert.match(w,/original native OS mutation session is not authorized/u);
 assert.doesNotMatch(w,/--prepare-signed-native-journal|--hold-native-journal-authority|writeEquinoxLocalMainNativePointer|switchNative/u);
 const shell=await fs.readFile(new URL("../../scripts/install-equinox-local.ps1",import.meta.url),"utf8");
 assert.doesNotMatch(shell,/\[switch\]\$ActivateMain/u);
});


test("existing hosted Windows package smoke denies signed-native prepared write and crash audit for absent owner and legacy Git worker",async()=>{
 const smoke=await fs.readFile(new URL("./windows-installer-real-package-smoke.ps1",import.meta.url),"utf8");
 for(const cmd of ["--prepare-signed-native-journal","--audit-signed-native-prepared-journal"]){
  assert.ok(smoke.includes("Invoke-GuardianCheck '"+cmd+"'"));
  const count=smoke.split("Invoke-GuardianCheck '"+cmd+"'").length-1;
  assert.equal(count,2,"one absent owner and one Git owner negative case");
 }
});
