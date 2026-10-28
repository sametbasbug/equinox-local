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
 assert.match(source,/json.WriteString\("stage", "prepared"\)/u);
 assert.match(source,/json.WriteNumber\("sequence", 0\)/u);
 assert.match(source,/json.WriteNumber\("workerPid", workerPid\)/u);
 assert.match(source,/json.WriteString\("workerStartTimeUtcTicks", workerTicks\)/u);
 assert.match(source,/json.WriteNumber\("guardianPid", Environment.ProcessId\)/u);
 assert.match(source,/json.WriteString\("guardianStartTimeUtcTicks", Process.GetCurrentProcess\(\)/u);
 assert.match(source,/FileMode\.CreateNew, FileAccess\.Write,\s*FileShare\.None/u);
 assert.match(source,/FileOptions\.WriteThrough/u);
 assert.match(source,/journal\.Flush\(flushToDisk: true\)/u);
 assert.match(source,/InspectOriginalSignedNativePreviousABaseline\(id, sha, target, contract\)/u);
 assert.doesNotMatch(source,/JsonSerializer\.SerializeToUtf8Bytes|JsonSerializer\.Serialize\(/u);
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


test("Main full reinstall never requests old prepared-journal mutation",async()=>{
 const script=await fs.readFile(new URL("../../scripts/install-equinox-local.ps1",import.meta.url),"utf8");
 assert.match(script,/--install-main-fresh/u);
 assert.doesNotMatch(script,/--prepare-signed-native-journal|--reconcile-signed-native-prepared-orphan/u);
});

test("Windows native Main WPF startup uses original signed ZIP audit without a journal grant",async()=>{
 const source=await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainOriginalInstalledSignedMainAudit.cs",import.meta.url),"utf8");
 assert.match(source,/VerifyOriginalSignedNativeMainSelector/u);
 assert.match(source,/InspectOriginalSignedWindowsArchive/u);
 assert.match(source,/FingerprintNativeMainRelease/u);
 assert.doesNotMatch(source,/File\.Move|File\.Delete|QuiesceOwnedStableShell/u);
});

test("CP15 original installed Guardian authenticates previous signed Main A via independent original Ed25519 retained ZIP, full A shell and Chrome NM before fsync PREPARED",async()=>{
 const [prior,prepared,owner,legacy]=await Promise.all([
  read("MainSignedNativePreviousABaseline.cs"),
  read("MainSignedNativePreparedJournal.cs"),
  read("MainSignedNativeOwnerLease.cs"),
  read("MainNativeJournalLease.cs"),
 ]);
 assert.match(prior,/if \(kind == "stable"\)/u);
 assert.match(prior,/InspectBaseline\(allowActiveOrphanForReconciliation: true\)/u);
 assert.match(prior,/else if \(kind == "main"\)/u);
 assert.match(prior,/current\.GetProperty\("sourceSha"\)\.GetString\(\) != aSha/u);
 assert.match(prior,/VerifyOriginalSignedNativeMainSelector\(Path\.Combine\(payload,/u);
 assert.match(prior,/FingerprintNativeMainRelease\(release\)/u);
 assert.match(prior,/InspectOriginalSignedWindowsArchive\(Path\.Combine\(payload, "signed-artifact\.zip"\)/u);
 assert.match(prior,/CompareNativeTrees\(Path\.Combine\(release, "runtime", "shell"\)/u);
 assert.match(prior,/InspectOwnedMainNativeMessaging\(install, release\)/u);
 assert.match(prior,/No previous Stable or signed Main A exists for rollback/u);
 assert.doesNotMatch(prior,/InspectOwnedMainGit\(|InspectMainNativeIdentity\(|File\.Delete|File\.Move|Kill\(|Process\.Start|Registry\.CurrentUser\.CreateSubKey/u);
 assert.ok(prepared.indexOf("InspectOriginalSignedNativePreviousABaseline(id, sha, target, contract)")<prepared.indexOf("FileMode.CreateNew, FileAccess.Write"));
 assert.match(owner,/InspectSignedNativeWorkerWpfParentWithoutGrant\(audited\)/u);
 assert.ok(owner.indexOf("InspectSignedNativeWorkerWpfParentWithoutGrant(audited)")<owner.indexOf("afterLiveProof?.Invoke("));
 assert.doesNotMatch(legacy,/InspectOriginalSignedNativePreviousABaseline|InspectSignedNativeWorkerWpfParentWithoutGrant/u);
});
