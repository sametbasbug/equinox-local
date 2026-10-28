import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const guardian = new URL("../../native/windows/EquinoxLocal.Guardian/",import.meta.url);
const read = name=>fs.readFile(new URL(name,guardian),"utf8");

test("one ORIGINAL Guardian signed-native exclusive OS lease is read-only, kernel-attested, and explicitly not a Git mutation lease",async()=>{
 const [source,cli,oldLease] = await Promise.all([
  read("MainSignedNativeOwnerLease.cs"),read("Program.cs"),read("MainNativeJournalLease.cs"),
 ]);
 assert.match(cli,/args\[0\] == "--audit-signed-native-owner-lease"/u);
 assert.match(cli,/InspectSignedNativeOwnerExclusiveLeaseWithoutGrant\(\)/u);
 assert.match(cli,/Exclusive live OS proof only; NO native mutation/u);
 assert.match(source,/ReadOwnedTransitionRecord\(\s*Path\.Combine\(root, "active\.json"\), 8192\)/u);
 assert.match(source,/RequireExactKeys\(active, \["schemaVersion", "kind", "transactionId",/u);
 assert.match(source,/active\.GetProperty\("kind"\)\.GetString\(\) != "signed-native"/u);
 assert.match(source,/MainSignedNativeWorkerContract\.ForSignedNativeB\(/u);
 assert.match(source,/FileMode\.CreateNew, FileAccess\.ReadWrite,\s*FileShare\.None/u);
 assert.match(source,/FileOptions\.DeleteOnClose \| FileOptions\.WriteThrough/u);
 assert.match(source,/\.signed-native-owner-proof\.lock/u);
 assert.match(source,/PinNativeGuardianFileForSession\(\)/u);
 assert.match(source,/PinExactBExecutables\(expected\)/u);
 assert.match(source,/InspectOwnedNativeWorkerOsArguments\(signedNativeReadOnly: true\)/u);
 assert.match(source,/InspectOwnedNativeWorkerPipeProof\(signedNativeReadOnly: true, previouslyAudited: audited\)/u);
 assert.match(source,/VerifyPinnedNativeGuardianFile\(originalGuardian\)/u);
 assert.match(source,/Process\.GetProcessById\(audited\.Pid\)/u);
 assert.match(source,/process\.StartTime\.ToUniversalTime\(\)\.Ticks/u);
 assert.match(source,/\.writer-lock"/u);
 assert.match(source,/\.guardian-session-lock"/u);
 assert.doesNotMatch(source,/QuiesceOwnedStableShell|QuiesceOwnedMainBRollbackShell|TryRetireCompletedNativeGuardianSession|RecordNativeJournalWorkerAuthority|File\.Move|File\.Delete|Kill\(/u);
 assert.doesNotMatch(oldLease,/InspectSignedNativeOwnerExclusiveLeaseWithoutGrant/u);
 assert.doesNotMatch(oldLease,/signedNativeReadOnly: true/u);
});

test("same original bundled Windows B worker calls exclusive signed Guardian kernel owner proof, then ALWAYS denies A/B mutation",async()=>{
 const [worker,owner]=await Promise.all([
  fs.readFile(new URL("../../src/equinox-local-signed-main-windows-worker.ts",import.meta.url),"utf8"),
  read("MainSignedNativeOwnerLease.cs"),
 ]);
 assert.match(worker,/execFile\(guardianPath,\["--audit-signed-native-owner-lease"\]/u);
 assert.match(worker,/await proof\.close\(\)/u);
 assert.match(worker,/original native OS mutation session is not authorized/u);
 assert.doesNotMatch(worker,/--hold-native-journal-authority|--activate-signed-native|--stop-wpf/u);
 assert.match(owner,/Not a second journal writer/u);
 assert.match(owner,/mutating lease MUST be durable\/crash-recoverable/u);
});

test("original Windows packaged Guardian smoke checks signed-native owner lease denies absent and legacy Git-only owner",async()=>{
 const smoke=await fs.readFile(new URL("./windows-installer-real-package-smoke.ps1",import.meta.url),"utf8");
 assert.match(smoke,/Invoke-GuardianCheck '--audit-signed-native-owner-lease'/u);
 assert.match(smoke,/Guardian accepted absent signed-native kernel exclusive owner/u);
 assert.match(smoke,/Guardian accepted Git worker as signed-native exclusive owner/u);
 assert.doesNotMatch(smoke,/Invoke-GuardianSignedNativeActivate/u);
});
