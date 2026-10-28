import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const base=new URL("../../native/windows/EquinoxLocal.Guardian/",import.meta.url);
const read=async file=>fs.readFile(new URL(file,base),"utf8");

test("original Guardian signed-native journal has a DISJOINT audit CLI; no legacy Git authority entrypoint invokes it",async()=>{
 const [program,journal,legacy,lease]=await Promise.all([
  read("Program.cs"),read("MainNativeSignedJournalAudit.cs"),
  read("MainNativeJournalIdentity.cs"),read("MainNativeJournalLease.cs"),
 ]);
 assert.match(program,/args\[0\] == "--audit-signed-native-journal"/u);
 assert.match(program,/InspectOwnedSignedNativeJournalWithoutGrant\(\);/u);
 assert.match(program,/Structural B and original A only; no signature\/Guardian grants/u);
 assert.match(program,/args\[0\] == "--audit-native-journal"/u);
 assert.match(program,/InspectOwnedNativeTransitionJournal\(\);/u);
 assert.doesNotMatch(legacy,/InspectOwnedSignedNativeJournalWithoutGrant/u);
 assert.doesNotMatch(lease,/InspectOwnedSignedNativeJournalWithoutGrant/u);
 assert.doesNotMatch(lease,/signedNativeReadOnly: true/u);
 assert.doesNotMatch(journal,/File\.Delete|File\.Move|File\.WriteAll|Process\.Start|Registry\.SetValue|Environment\.SetEnvironmentVariable/u);
});

test("signed-native Guardian journal uses original bounded file reader and distinct owner/receipt/immutable rollback schemas; no Git receipt spoof",async()=>{
 const s=await read("MainNativeSignedJournalAudit.cs");
 assert.match(s,/ReadOwnedTransitionRecord\(Path\.Combine\(tx, "active\.json"\), 8192\)/u);
 assert.match(s,/RequireExactKeys\(owner, \["schemaVersion", "kind", "transactionId",/u);
 assert.match(s,/owner\.GetProperty\("kind"\)\.GetString\(\) != "signed-native"/u);
 assert.match(s,/receiptDir|var receipts = Path\.Combine\(tx, "receipts"\)/u);
 assert.match(s,/id \+ "\.signed-native\.json"/u);
 assert.match(s,/RequireExactKeys\(receipt, \["schemaVersion", "kind", "transactionId",/u);
 assert.match(s,/receipt\.GetProperty\("status"\)\.GetString\(\) is not \("admitted" or "activating"\)/u);
 assert.match(s,/Path\.Combine\(tx, "staging", id, "native-rollback"\)/u);
 assert.match(s,/native-recovery\.json/u);
 assert.match(s,/RequireExactKeys\(descriptor, \["schemaVersion", "channel", "targetSha",/u);
 assert.match(s,/targetRuntimeContractSha256/u);
 assert.match(s,/MainSignedNativeWorkerContract\.ForSignedNativeB/u);
 assert.match(s,/ValidateOriginalReleaseFiles\(expected\)/u);
 assert.doesNotMatch(s,/rollbackSourceRoot|targetSourceRoot|sources[\/]targetSha|install\.json/u);
});

test("original Guardian independently binds Stable A or native Main A to exact durable pointer rather than user-provided paths",async()=>{
 const s=await read("MainNativeSignedJournalAudit.cs");
 assert.match(s,/if \(priorKind == "stable"\)/u);
 assert.match(s,/RequireExactKeys\(prior, \["kind", "version"\]\)/u);
 assert.match(s,/current-version\.json/u);
 assert.match(s,/RequireExactKeys\(currentStable, \["schemaVersion", "target", "version"\]\)/u);
 assert.match(s,/if \(priorKind == "main"\)/u);
 assert.match(s,/RequireExactKeys\(prior, \["kind", "sourceSha", "target", "runtimeContractSha256"\]\)/u);
 assert.match(s,/a == sha/u);
 assert.match(s,/current-native\.json/u);
 assert.match(s,/RequireExactKeys\(current, \["schemaVersion", "channel", "sourceSha",/u);
 assert.doesNotMatch(s,/RequireExactKeys\(current, [\s\S]{0,150}"payloadVersion", "releaseDir"/u,
  "durable native pointer has exactly five fields, not read-only derived release metadata");
 assert.match(s,/Signed-native previous A does not match committed native pointer/u);
 assert.match(s,/Signed-native Stable A conflicts with an existing native pointer/u);
});

test("original signed-native journal binds immutable B to verified Ed25519 pointer AND independently rehashes the release",async()=>{
 const s=await read("MainNativeSignedJournalAudit.cs");
 assert.match(s,/native-store\.json/u);
 assert.match(s,/RequireExactKeys\(store, \["schemaVersion", "channel", "sourceSha", "target",/u);
 assert.match(s,/artifactSha256/u);
 assert.match(s,/releaseFingerprint/u);
 assert.match(s,/RequireExactKeys\(fingerprint, \["schemaVersion", "sha256", "entries", "bytes"\]\)/u);
 assert.match(s,/Signed-native B stored manifest has inconsistent structural identity/u);
 assert.match(s,/VerifyOriginalSignedNativeMainSelector/u);
 assert.match(s,/FingerprintNativeMainRelease\(expected\.ReleaseDir\)/u);
 assert.match(s,/signed-native-ed25519-verified-journal-read-only-incomplete/u);
 assert.match(s,/OS HMAC\/journal authority or healthy B/u);
 const program=await read("Program.cs");
 assert.doesNotMatch(program,/args\[0\] == "--activate-signed-native"/u);
});

test("signed-native read-only owner+kernel OS argv audit does NOT expand original signed Guardian journal lease/mutation authority",async()=>{
 const [identity,argumentsCode,audit,program]=await Promise.all([
  read("MainNativeWorkerIdentity.cs"),read("MainNativeWorkerArguments.cs"),
  read("MainNativeSignedWorkerAudit.cs"),read("Program.cs"),
 ]);
 assert.match(program,/args\[0\] == "--audit-signed-native-worker-argv"/u);
 assert.match(program,/InspectOwnedNativeWorkerOsArguments\(signedNativeReadOnly: true\)/u);
 assert.match(identity,/InspectOwnedNativeWorkerProcess\(bool signedNativeReadOnly = false\)/u);
 assert.match(identity,/if \(signedNativeReadOnly\)\s+InspectOwnedSignedNativeJournalWithoutGrant\(\);\s+else\s+InspectOwnedNativeTransitionJournal\(\);/u);
 assert.match(identity,/signedNativeReadOnly\s+\? ResolveSignedNativeBNodeForReadOnlyAudit/u);
 assert.match(identity,/ReadWindowsLogonAuthenticationId/u);
 assert.match(identity,/SessionId/u);
 assert.match(argumentsCode,/InspectOwnedNativeWorkerProcess\(signedNativeReadOnly\)/u);
 assert.match(argumentsCode,/if \(!signedNativeReadOnly\)\s+throw new InvalidDataException/u);
 assert.match(argumentsCode,/Legacy Git Main cannot masquerade as signed-native Guardian read-only audit/u);
 assert.match(audit,/ReadOsProcessCommandLine\(process\)/u);
 assert.match(audit,/Process\.GetProcessById\(worker\.Pid\)/u);
 assert.doesNotMatch(program,/args\[0\] == "--hold-signed-native"/u);
 assert.doesNotMatch(identity,/Process\.Kill|File\.Delete|File\.Move/u);
});


test("existing original Windows hosted smoke exercises BOTH signed-native audit commands fail-closed for absent owner and legacy Git fixtures",async()=>{
 const source=await fs.readFile(new URL("./windows-installer-real-package-smoke.ps1",import.meta.url),"utf8");
 assert.match(source,/Invoke-GuardianCheck '--audit-signed-native-journal'/u);
 assert.match(source,/Invoke-GuardianCheck '--audit-signed-native-worker-argv'/u);
 assert.match(source,/Guardian accepted absent signed-native owner/u);
 assert.match(source,/Guardian accepted Git receipt as signed-native journal/u);
 assert.match(source,/Guardian accepted Git worker as signed-native worker/u);
 // These are negative hosted checks, not a claim that the Windows native
 // activation, original Ed25519 verification or A/B rollout works.
 assert.doesNotMatch(source,/Invoke-GuardianActivateSignedNative/u);
});


test("read-only native Guardian HMAC reuses original PID/launch-token OS pipe challenge, never original mutation lease",async()=>{
 const [identity,program,lease]=await Promise.all([
  read("MainNativeWorkerIdentity.cs"),read("Program.cs"),
  read("MainNativeJournalLease.cs"),
 ]);
 assert.match(identity,/InspectOwnedNativeWorkerPipeProof\(bool signedNativeReadOnly = false\)/u);
 assert.match(identity,/InspectOwnedNativeWorkerProcess\(signedNativeReadOnly\)/u);
 assert.match(identity,/GetNamedPipeServerProcessId\(pipe\.SafePipeHandle, out var serverPid\)/u);
 assert.match(identity,/HMACSHA256\.HashData\(key\.AsSpan\(\), message\.AsSpan\(\)\)/u);
 assert.match(identity,/CryptographicOperations\.FixedTimeEquals\(actual, expected\)/u);
 assert.match(program,/args\[0\] == "--audit-signed-native-worker-pipe"/u);
 assert.match(program,/InspectOwnedNativeWorkerOsArguments\(signedNativeReadOnly: true\);\s+InspectOwnedNativeWorkerPipeProof\(signedNativeReadOnly: true\)/u);
 assert.doesNotMatch(lease,/signedNativeReadOnly: true/u);
});
