import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const read=async relative=>fs.readFile(new URL("../../"+relative,import.meta.url),"utf8");

test("the SAME original WPF/Guardian signed-native contract opens read-only Windows kernel file-ID pins for B's Node and worker, not just names",async()=>{
 const [shared,wpfProject,guardianProject]=await Promise.all([
  read("native/windows/EquinoxLocal.NativeShared/MainSignedNativeWorkerContract.cs"),
  read("native/windows/EquinoxLocal.WindowsShell/EquinoxLocal.WindowsShell.csproj"),
  read("native/windows/EquinoxLocal.Guardian/EquinoxLocal.Guardian.csproj"),
 ]);
 for(const project of [wpfProject,guardianProject]){
  assert.equal(project.split('<Compile Include="../EquinoxLocal.NativeShared/MainSignedNativeWorkerContract.cs"').length-1,1);
 }
 assert.match(shared,/private static extern bool ReadOriginalKernelFileIdentity\(SafeFileHandle handle,/u);
 assert.match(shared,/OpenOriginalBWithoutFollowingFinalReparse\(file,\s*genericRead, shareRead, 0, openExisting, openReparsePoint, 0\)/u);
 assert.match(shared,/const uint openReparsePoint = 0x00200000/u);
 assert.match(shared,/const uint shareRead = 0x00000001/u);
 assert.match(shared,/pinned = new FileStream\(handle, FileAccess\.Read, 64 \* 1024, isAsync: false\)/u);
 assert.match(shared,/ReadOriginalKernelFileIdentity\(pinned\.SafeFileHandle, out var identity\)/u);
 assert.match(shared,/identity\.Attributes & \(reparsePoint \| directory\)/u);
 assert.match(shared,/identity\.LinkCount != 1/u);
 assert.match(shared,/identity\.VolumeSerial == 0/u);
 assert.match(shared,/identity\.FileIndexHigh == 0 && identity\.FileIndexLow == 0/u);
 assert.match(shared,/pinned\.Length != identity\.SizeLow/u);
 assert.match(shared,/private static FileStream PinNormalBExecutable\(string file\)/u);
 assert.match(shared,/var node = PinNormalBExecutable\(expected\.NodePath\);/u);
 assert.match(shared,/var worker = PinNormalBExecutable\(expected\.WorkerPath\);/u);
 assert.match(shared,/internal sealed class PinnedExecutables : IDisposable/u);
 assert.match(shared,/_worker\.Dispose\(\);\s*_node\.Dispose\(\);/u);
 assert.doesNotMatch(shared,/FileShare\.ReadWrite|FileShare\.Delete|FileAccess\.Write|FileMode\.Create/u);
});

test("ORIGINAL installed WPF holds exact live Node/worker NTFS handle pins through Ed25519 ZIP audit AND read-only Process.Start",async()=>{
 const wpf=await read("native/windows/EquinoxLocal.WindowsShell/MainUpdateHandoff.cs");
 assert.match(wpf,/afterVerifiedReadOnly: expected =>\s*\{\s*launchedPid = LaunchVerifiedSignedNativeProofOnly\(expected, transactionId\);/u);
 assert.match(wpf,/using var pinned = MainSignedNativeWorkerContract\.PinExactBExecutables\(expected\);/u);
 assert.match(wpf,/startInfo\.ArgumentList\.Add\("--audit-signed-native-journal"\);/u);
 const pin=wpf.indexOf("using var pinned = MainSignedNativeWorkerContract.PinExactBExecutables(expected);");
 const audit=wpf.indexOf('startInfo.ArgumentList.Add("--audit-signed-native-journal");');
 const callback=wpf.indexOf("afterVerifiedReadOnly?.Invoke(expected);");
 assert.ok(pin>0&&pin<audit&&audit<callback);
 const wrapped=wpf.slice(pin,callback);
 assert.match(wrapped,/if \(guardian\.ExitCode != 0\)\s*throw new InvalidDataException/u);
 const launch=wpf.slice(wpf.indexOf("private static int LaunchVerifiedSignedNativeProofOnly"));
 assert.match(launch,/using var process = Process\.Start\(start\)/u);
 assert.match(launch,/Directory\.EnumerateFileSystemEntries\(handoff,\s*transactionId \+ "\.windows-worker\.json", SearchOption\.TopDirectoryOnly\)\.Any\(\)/u);
 assert.match(launch,/independent OS owner recovery is required/u);
 assert.doesNotMatch(launch,/RemoveStaleOwnershipOrRejectActive\(ownershipPath, transactionId\)/u);
 assert.match(launch,/WriteWorkerOwnership\(ownershipPath, transactionId, process\.Id/u);
 assert.match(wpf,/return process\.Id;\s*\}\s*private static MainSignedNativeWorkerContract\.Expected\? InspectPendingSignedNativeWithoutGrant/u);
 assert.match(wpf,/Signed-native Main WPF handoff requires independent original Ed25519 and Guardian OS session/u);
});

test("original Guardian pins the same B Node/worker kernel identities while reconstructing Ed25519 and comparing ALL extracted signed ZIP contents",async()=>{
 const guardian=await read("native/windows/EquinoxLocal.Guardian/MainNativeSignedJournalAudit.cs");
 const pin=guardian.indexOf("using var pinnedB = MainSignedNativeWorkerContract.PinExactBExecutables(expected);");
 const selector=guardian.indexOf("VerifyOriginalSignedNativeMainSelector(");
 const zip=guardian.indexOf("InspectOriginalSignedWindowsArchive(");
 assert.ok(pin>0&&pin<selector&&selector<zip);
 assert.match(guardian,/signed-native-ed25519-verified-journal-read-only-incomplete/u);
 assert.doesNotMatch(guardian,/HoldOwnedNativeJournalLease\(|QuiesceOwnedStableShell\(|Process\.Start\(/u);
});

test("original user-facing PowerShell native activation remains unavailable until a separately authenticated signed-native Guardian OS mutation journal and actual Windows host tests",async()=>{
 const [ps,guardian,worker]=await Promise.all([
  read("scripts/install-equinox-local.ps1"),
  read("native/windows/EquinoxLocal.Guardian/MainNativeJournalLease.cs"),
  read("src/equinox-local-signed-main-windows-worker.ts"),
 ]);
 assert.match(ps,/\[switch\]\$CheckMainNative = \$false/u);
 assert.doesNotMatch(ps,/\[switch\]\$ActivateMain/u);
 assert.match(guardian,/InspectOwnedNativeWorkerOsArguments\(\);\s*InspectOwnedNativeWorkerPipeProof\(\);\s*var owner = InspectOwnedNativeWorkerProcess\(\);/u);
 assert.doesNotMatch(guardian,/signedNativeReadOnly:\s*true/u);
 assert.match(worker,/original native OS mutation session is not authorized/u);
});
