import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const root=new URL("../../native/windows/",import.meta.url);
const read=async relative=>fs.readFile(new URL(relative,root),"utf8");

test("ORIGINAL installed Windows WPF offers exact read-only native B proof but NEVER routes it through Git main-update or activation",async()=>{
 const [handoff,ipc]=await Promise.all([
  read("EquinoxLocal.WindowsShell/MainUpdateHandoff.cs"),
  read("EquinoxLocal.WindowsShell/SingleInstanceCoordinator.cs"),
 ]);
 assert.match(ipc,/command\.StartsWith\("main-native-proof:", StringComparison\.Ordinal\)/u);
 assert.match(ipc,/MainUpdateHandoff\.LaunchSignedNativeProofOnly\(transactionId\)/u);
 assert.match(ipc,/WriteLineAsync\("proof-started-read-only"\)/u);
 assert.match(ipc,/command\.StartsWith\("main-native-audit:", StringComparison\.Ordinal\)/u);
 assert.match(ipc,/command\.StartsWith\("main-update:", StringComparison\.Ordinal\)/u);
 assert.match(ipc,/MainUpdateHandoff\.Launch\(transactionId\)/u);
 assert.doesNotMatch(ipc,/main-native-activate:|main-native-switch:|main-native-commit:/u);
 assert.match(handoff,/private static MainSignedNativeWorkerContract\.Expected\? InspectPendingSignedNativeWithoutGrant/u);
 const normal=handoff.indexOf('internal static int Launch(string transactionId)');
 const normalNativeDenial=handoff.indexOf('InspectPendingSignedNativeWithoutGrant(transactionId);');
 const legacyGit=handoff.indexOf('ValidateInstallStamp(Path.Combine(transactionRoot, "install.json"));');
 assert.ok(normal>=0&&normalNativeDenial>normal&&normalNativeDenial<legacyGit,
  "original normal Git update first denies signed-native owner");
 assert.match(handoff,/Signed-native Main WPF handoff requires independent original Ed25519 and Guardian OS session/u);
});

test("original WPF starts only exact B-owned Node+worker argv AFTER full original Guardian Ed25519 and ZIP provenance audit",async()=>{
 const [handoff,contract,guardian]=await Promise.all([
  read("EquinoxLocal.WindowsShell/MainUpdateHandoff.cs"),
  read("EquinoxLocal.NativeShared/MainSignedNativeWorkerContract.cs"),
  read("EquinoxLocal.Guardian/MainNativeSignedJournalAudit.cs"),
 ]);
 const launch=handoff.slice(handoff.indexOf("internal static int LaunchSignedNativeProofOnly"),
  handoff.indexOf("private static MainSignedNativeWorkerContract.Expected?"));
 assert.match(launch,/InspectPendingSignedNativeWithoutGrant\(transactionId, auditOnly: true,/u);
 assert.match(launch,/afterVerifiedReadOnly: expected =>/u);
 assert.match(launch,/Environment\.ProcessPath, wpf, StringComparison\.OrdinalIgnoreCase/u);
 assert.match(launch,/Path\.Combine\(local, "Programs", "Equinox Local", "EquinoxLocal\.exe"\)/u);
 assert.match(launch,/RequireNormalFile\(wpf, "Original installed WPF shell"\)/u);
 assert.match(handoff,/MainSignedNativeWorkerContract\.ValidateOriginalReleaseFiles\(expected\)/u);
 assert.match(handoff,/using var pinned = MainSignedNativeWorkerContract\.PinExactBExecutables\(expected\);/u);
 const validated=launch.indexOf("InspectPendingSignedNativeWithoutGrant(transactionId, auditOnly: true,");
 const started=launch.indexOf("Process.Start(start)");
 assert.ok(validated>=0&&started>validated,"full Ed25519 signed B gate BEFORE any worker process");
 assert.match(launch,/new ProcessStartInfo\(expected\.NodePath\)/u);
 assert.match(launch,/WorkingDirectory = expected\.ReleaseDir/u);
 assert.match(launch,/foreach \(var arg in expected\.OsArgv\.Skip\(1\)\)/u);
 assert.match(launch,/start\.Environment\.Clear\(\)/u);
 assert.match(launch,/CopyEnvironment\(start, "LOCALAPPDATA"\)/u);
 assert.match(launch,/RandomNumberGenerator\.GetBytes\(32\)/u);
 assert.match(launch,/start\.Environment\["EQUINOX_LOCAL_MAIN_WORKER_TOKEN"\] = token/u);
 assert.match(launch,/Directory\.EnumerateFileSystemEntries\(handoff,/u);
 assert.match(launch,/independent OS owner recovery is required/u);
 assert.doesNotMatch(launch,/RemoveStaleOwnershipOrRejectActive\(ownershipPath, transactionId\)/u);
 assert.match(launch,/WriteWorkerOwnership\(ownershipPath, transactionId, process\.Id,/u);
 assert.match(launch,/process\.StartTime\.ToUniversalTime\(\)\.Ticks/u);
 assert.match(launch,/process\.Kill\(entireProcessTree: true\)/u);
 assert.match(launch,/return process\.Id;/u);
 assert.match(contract,/node, worker, "--signed-native", "--transaction-id", transactionId,/u);
 assert.match(contract,/"--transaction-root", expectedRoot/u);
 assert.match(guardian,/InspectOriginalSignedWindowsArchive\(/u);
 assert.doesNotMatch(launch,/Write.*NativePointer|File\.Move|shutdown-for-update|UpdateShutdownRequested|SetValue|--hold-native-journal-authority/u);
});

test("native proof IPC never claims success of A/B and exact Windows Node worker always refuses Guardian mutation",async()=>{
 const [handoff,ipc,worker,originalGuardian]=await Promise.all([
  read("EquinoxLocal.WindowsShell/MainUpdateHandoff.cs"),
  read("EquinoxLocal.WindowsShell/SingleInstanceCoordinator.cs"),
  fs.readFile(new URL("../../src/equinox-local-signed-main-windows-worker.ts",import.meta.url),"utf8"),
  read("EquinoxLocal.Guardian/Program.cs"),
 ]);
 assert.match(handoff,/this PID is NOT an update receipt/u);
 assert.match(handoff,/return expected; \/\/ Only the explicit PROOF launcher can start B, never switch A\/B/u);
 assert.match(ipc,/proof-started-read-only/u);
 assert.match(worker,/startEquinoxWindowsMainWorkerProof/u);
 assert.match(worker,/--audit-signed-native-worker-pipe/u);
 assert.match(worker,/finally\{\s*await proof\.close\(\);/u);
 assert.match(worker,/throw new Error\("Signed Windows Main B passed read-only Guardian kernel HMAC, but original native OS mutation session is not authorized\."\)/u);
 assert.match(originalGuardian,/--audit-signed-native-worker-pipe/u);
 assert.doesNotMatch(originalGuardian,/--hold-signed-native-journal-authority|--signed-native-activate/u);
});
