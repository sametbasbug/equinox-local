import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const read=async file=>fs.readFile(new URL(
 "../../native/windows/EquinoxLocal.Guardian/"+file,import.meta.url),"utf8");

test("original signed-native Windows Guardian kernel worker parent must be original installed WPF, not Git/writable PID",async()=>{
 const [parent,program]=await Promise.all([
  read("MainNativeSignedWorkerWpfParent.cs"),read("Program.cs"),
 ]);
 assert.match(parent,/InspectSignedNativeWorkerWpfParentWithoutGrant\(OwnedWorkerClaim worker\)/u);
 assert.match(parent,/Path\.Combine\(local, "Programs", "Equinox Local", "EquinoxLocal\.exe"\)/u);
 assert.match(parent,/RequireNormalFile\(shellPath\)/u);
 assert.match(parent,/FindSingleOwnedStableShell\(shellPath\)/u);
 assert.match(parent,/Process\.GetProcessById\(worker\.Pid\)/u);
 assert.match(parent,/process\.StartTime\.ToUniversalTime\(\)\.Ticks\.ToString\(CultureInfo\.InvariantCulture\) != worker\.Ticks/u);
 assert.match(parent,/NtQueryInformationProcess\(process\.Handle, processBasicInformation,/u);
 assert.match(parent,/const int processBasicInformation = 0/u);
 assert.match(parent,/const int processBasicInformationBytes = 48/u);
 assert.match(parent,/Marshal\.ReadIntPtr\(buffer, 40\)\.ToInt64\(\) != parent\.Id/u);
 assert.match(parent,/parent\.SessionId != guardian\.SessionId/u);
 assert.match(parent,/OpenProcessToken\(parent\.Handle, TokenQuery, out var parentToken\)/u);
 assert.match(parent,/ReadWindowsLogonAuthenticationId\(parentToken\)/u);
 assert.match(parent,/GetNamedPipeServerProcessId\(pipe\.SafePipeHandle, out var serverPid\)/u);
 assert.match(parent,/serverPid != parent\.Id/u);
 assert.match(parent,/Original WPF logon SID\/LUID differs/u);
 assert.match(parent,/signed-native-wpf-parent-read-only-complete/u);
 assert.doesNotMatch(parent,/Process\.Start|File\.Move|File\.Delete|Registry\.SetValue|File\.WriteAllText/u);
 assert.match(program,/var audited = InspectOwnedNativeWorkerOsArguments\(signedNativeReadOnly: true\);\s+InspectSignedNativeWorkerWpfParentWithoutGrant\(audited\);\s+InspectOwnedNativeWorkerPipeProof\(signedNativeReadOnly: true, previouslyAudited: audited\);/u);
});
test("independent original Guardian native parent-proof cannot grant existing Git Guardian mutation or WPF shutdown",async()=>{
 const [parent,session,program]=await Promise.all([
  read("MainNativeSignedWorkerWpfParent.cs"),
  read("MainNativeJournalLease.cs"),read("Program.cs"),
 ]);
 assert.doesNotMatch(session,/InspectSignedNativeWorkerWpfParentWithoutGrant/u);
 assert.doesNotMatch(parent,/HoldOwnedNativeJournalLease|InspectOwnedNativeTransitionJournal|quiesce|StopWpf|Kill\(entireProcessTree/u);
 assert.doesNotMatch(program,/--hold-signed-native-journal-authority|--activate-signed-native/u);
 assert.match(parent,/positive read-only proof NEVER stands/u);
});
