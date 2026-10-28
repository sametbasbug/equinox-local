import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root=path.resolve(import.meta.dirname,"../..");
const read=async relative=>fs.readFile(path.join(root,relative),"utf8");

test("ONE exact native Main OS worker-argv source is linked into BOTH original signed Windows WPF and Guardian builds",async()=>{
 const [wpfProject,guardianProject,shared]=await Promise.all([
  read("native/windows/EquinoxLocal.WindowsShell/EquinoxLocal.WindowsShell.csproj"),
  read("native/windows/EquinoxLocal.Guardian/EquinoxLocal.Guardian.csproj"),
  read("native/windows/EquinoxLocal.NativeShared/MainSignedNativeWorkerContract.cs"),
 ]);
 const include='<Compile Include="../EquinoxLocal.NativeShared/MainSignedNativeWorkerContract.cs"';
 for(const project of [wpfProject,guardianProject]){
  assert.equal(project.split(include).length-1,1,"one shared WPF/Guardian contract include");
 }
 assert.match(shared,/namespace EquinoxLocal\.NativeShared;/u);
 assert.match(shared,/internal static class MainSignedNativeWorkerContract/u);
 assert.match(shared,/RuntimeInformation\.ProcessArchitecture switch/u);
 assert.match(shared,/"win32-x64"/u);
 assert.match(shared,/"win32-arm64"/u);
 assert.match(shared,/Path\.Combine\(expectedRoot, "native-store", target, sourceSha, "release"\)/u);
 assert.match(shared,/Path\.Combine\(releaseDir, "runtime", "node", "bin", "node\.exe"\)/u);
 assert.match(shared,/Path\.Combine\(releaseDir, "equinox-local-main-update-worker\.js"\)/u);
 assert.match(shared,/node, worker, "--signed-native", "--transaction-id", transactionId,/u);
 assert.match(shared,/"--transaction-root", expectedRoot/u);
 assert.match(shared,/actual\.Length != expected\.OsArgv\.Length/u);
 assert.match(shared,/i is 0 or 1 or 6/u);
 assert.match(shared,/Path\.IsPathFullyQualified\(actual\[i\]\)/u);
 assert.match(shared,/string\.Equals\(actual\[i\], expected\.OsArgv\[i\], StringComparison\.Ordinal\)/u);
 assert.match(shared,/FileAttributes\.ReparsePoint/u);
 assert.match(shared,/Path\.Combine\(expected\.ReleaseDir, "runtime", "node", "bin"\)/u);
 assert.match(shared,/var selector = Path\.Combine\(Path\.GetDirectoryName\(expected\.ReleaseDir\)!, "signed-selector\.json"\)/u);
 assert.match(shared,/var storeManifest = Path\.Combine\(Path\.GetDirectoryName\(expected\.ReleaseDir\)!, "native-store\.json"\)/u);
 assert.match(shared,/info\.Length < minBytes \|\| info\.Length > maxBytes/u);
});

test("original WPF handoff distinguishes signed-native immutable record grammar from Git sources but NEVER launches it before independent trust",async()=>{
 const wpf=await read("native/windows/EquinoxLocal.WindowsShell/MainUpdateHandoff.cs");
 const call=wpf.indexOf("InspectPendingSignedNativeWithoutGrant(transactionId);");
 const git=wpf.indexOf("ValidateInstallStamp(Path.Combine(transactionRoot");
 assert.ok(call>0 && call<git,"signed-native must be intercepted before Git stamp lookup");
 assert.match(wpf,/RequireExactProperties\(active, \["schemaVersion", "kind", "transactionId",/u);
 assert.match(wpf,/RequireString\(active, "kind", "signed-native"\)/u);
 assert.match(wpf,/RequireExactProperties\(receipt, \["schemaVersion", "kind", "transactionId",/u);
 assert.match(wpf,/transactionId \+ "\.signed-native\.json"/u);
 assert.match(wpf,/MainSignedNativeWorkerContract\.ForSignedNativeB/u);
 assert.match(wpf,/MainSignedNativeWorkerContract\.ValidateOriginalReleaseFiles/u);
 assert.match(wpf,/signed-selector\.json/u);
 assert.match(wpf,/throw new InvalidOperationException\(\s*"Signed-native Main WPF handoff requires independent original Ed25519 and Guardian OS session/u);
 assert.doesNotMatch(wpf,/Process\.Start\(expected\./u);
});

test("ORIGINAL Guardian reads kernel live signed-native OS worker argv with shared contract, then refuses native session without original Ed25519 and journal authorization",async()=>{
 const [argv,audit]=await Promise.all([
  read("native/windows/EquinoxLocal.Guardian/MainNativeWorkerArguments.cs"),
  read("native/windows/EquinoxLocal.Guardian/MainNativeSignedWorkerAudit.cs"),
 ]);
 assert.match(argv,/marker\.TryGetProperty\("kind", out var kind\)/u);
 assert.match(argv,/InspectSignedNativeWorkerArgvWithoutGrant\(marker, worker\)/u);
 assert.match(argv,/throw new InvalidOperationException\(\s*"Signed-native worker still requires independent Ed25519 and original Guardian journal admission/u);
 assert.match(audit,/RequireExactKeys\(marker, \["schemaVersion", "kind", "transactionId",/u);
 assert.match(audit,/ReadOwnedTransitionRecord\(Path\.Combine\(\s*root, "receipts", worker\.TransactionId \+ "\.signed-native\.json"\)/u);
 assert.match(audit,/MainSignedNativeWorkerContract\.ForSignedNativeB/u);
 assert.match(audit,/MainSignedNativeWorkerContract\.ValidateOriginalReleaseFiles/u);
 assert.match(audit,/Process\.GetProcessById\(worker\.Pid\)/u);
 assert.match(audit,/process\.StartTime\.ToUniversalTime\(\)\.Ticks\.ToString\(CultureInfo\.InvariantCulture\) != worker\.Ticks/u);
 assert.match(audit,/MainSignedNativeWorkerContract\.ValidateOsArgv\(\s*ParseWindowsOsArgv\(ReadOsProcessCommandLine\(process\)\), expected\)/u);
 assert.match(audit,/signed-native-os-argv-read-only-incomplete/u);
 // A structurally valid argv is NOT an original Guardian HMAC capability.
 const guardian=await read("native/windows/EquinoxLocal.Guardian/MainNativeJournalLease.cs");
 assert.match(guardian,/InspectOwnedNativeWorkerOsArguments\(\)/u);
 assert.match(guardian,/InspectOwnedNativeWorkerPipeProof\(\)/u);
 assert.doesNotMatch(audit,/Process\.Start|File\.Move|File\.Delete|File\.WriteAllBytes|launchctl/u);
});

test("Windows signed native contract remains INSPECT-ONLY: public PowerShell activation is gated and actual packaged Node worker is Mac-only until original Guardian signs its transition",async()=>{
 const [ps,worker]=await Promise.all([
  read("scripts/install-equinox-local.ps1"),
  read("src/equinox-local-main-update-worker.ts"),
 ]);
 assert.match(ps,/\[switch\]\$CheckMainNative = \$false/u);
 assert.doesNotMatch(ps,/\[switch\]\$ActivateMain/u);
 assert.match(worker,/if\(platform!=="darwin" \|\| !\["arm64","x64"\]\.includes\(arch\)/u);
 assert.match(worker,/argv\.length!==5 \|\| argv\[0\]!=="--signed-native"/u);
});
