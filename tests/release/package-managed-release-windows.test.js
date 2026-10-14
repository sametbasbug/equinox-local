import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { assertWindowsBatchQuotedPath, packageManagedEquinoxWindowsRelease, windowsManagedPackageContract, windowsManagedReleaseDestinationRelative } from "../../scripts/release/package-managed-release-windows.mjs";

test("Windows managed package contract keeps x64 stable and defines explicit native ARM64 tooling", () => {
  const x64 = windowsManagedPackageContract();
  assert.equal(x64.target, "win32-x64");
  assert.equal(x64.artifactSuffix, "win32-x64.zip");
  assert.equal(x64.shellRid, "win-x64");
  assert.equal(x64.shellPlatform, "x64");
  assert.equal(x64.vcvars, "vcvars64.bat");
  assert.equal(x64.peMachine, 0x8664);

  const arm64 = windowsManagedPackageContract({ target: "win32-arm64" });
  assert.equal(arm64.target, "win32-arm64");
  assert.equal(arm64.artifactSuffix, "win32-arm64.zip");
  assert.equal(arm64.shellRid, "win-arm64");
  assert.equal(arm64.shellPlatform, "ARM64");
  assert.equal(arm64.visualStudioComponent, "Microsoft.VisualStudio.Component.VC.Tools.ARM64");
  assert.equal(arm64.vcvars, "vcvarsarm64.bat");
  assert.equal(arm64.peMachine, 0xaa64);
  assert.deepEqual(arm64.extraReleaseFiles, [
    "src/equinox-local-windows-clipboard.ps1",
    "src/equinox-local-windows-desktop.ps1",
    "src/equinox-local-windows-private-state.ps1",
    "src/equinox-local-windows-process-gate.ps1",
    "src/equinox-local-windows-runtime-gate.mjs",
    "src/equinox-local-windows-runtime-supervisor.js",
    "src/equinox-local-windows-release-zip.ps1",
  ]);
  assert.deepEqual(arm64.requiredShellFiles, [
    "EquinoxLocal.exe", "coreclr.dll", "hostfxr.dll", "Microsoft.Web.WebView2.Core.dll",
  ]);
  assert.throws(() => windowsManagedPackageContract({ target: "win32-ia32" }), /Unsupported Windows managed release target/u);
});


test("Windows desktop lifecycle helper is a fixed Win32 boundary", async () => {
  const helper = await fs.readFile(new URL("../../src/equinox-local-windows-desktop.ps1", import.meta.url), "utf8");
  assert.match(helper, /ValidateSet\('AppList','AppLaunch','AppOpen','AppQuit','AppRelaunch','AppFocus','WindowFocus','WindowClose','WindowMinimize','WindowRestore','WindowMaximize','WindowMove','WindowResize','WindowSetBounds'\)/u);
  assert.match(helper, /SetForegroundWindow/u);
  assert.match(helper, /PostMessage/u);
  assert.match(helper, /SetWindowPos/u);
  assert.match(helper, /CloseMainWindow/u);
  assert.match(helper, /UseShellExecute = \$true/u);
  assert.doesNotMatch(helper, /Invoke-Expression|cmd\.exe|Start-Process/u);
});

test("Windows release source mapping is separator-independent and flattens src", () => {
  assert.equal(windowsManagedReleaseDestinationRelative("src/server.js"), "server.js");
  assert.equal(windowsManagedReleaseDestinationRelative("src\\server.js"), "server.js");
  assert.equal(windowsManagedReleaseDestinationRelative("package.json"), "package.json");
  assert.throws(() => windowsManagedReleaseDestinationRelative("../server.js"), /unsafe/u);
});


test("Windows managed ZIP helper uses bounded fast compression", async () => {
  let helper;
  for (const relative of ["./windows-managed-zip.ps1", "../../scripts/release/windows-managed-zip.ps1"]) {
    try {
      helper = await fs.readFile(new URL(relative, import.meta.url), "utf8");
      break;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  assert.equal(typeof helper, "string");
  assert.ok(helper.includes("public static class EquinoxManagedZip"));
  assert.ok(helper.includes("items.Sort"));
  assert.ok(helper.includes("CompressionLevel.Fastest"));
  assert.ok(!helper.includes("Get-ChildItem -LiteralPath $source -Recurse"));
  let source;
  for (const relative of ["./package-managed-release-windows.mjs", "../../scripts/release/package-managed-release-windows.mjs"]) {
    try {
      source = await fs.readFile(new URL(relative, import.meta.url), "utf8");
      break;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  assert.equal(typeof source, "string");
  assert.match(source, /WINDOWS_ZIP_TIMEOUT_MS = 180_000/u);
  assert.match(source, /Windows managed ZIP creation exceeded/u);
});

test("Windows package stages node_modules through normal-file hardlinks", async () => {
  const source = await fs.readFile(new URL("../../scripts/release/package-managed-release-windows.mjs", import.meta.url), "utf8");
  assert.match(source, /async function hardlinkNormalTree/u);
  assert.match(source, /await fs\.link\(source, destination\)/u);
  assert.match(source, /if \(entry\.name === "\.bin" && sourceDir === sourceRoot\) continue/u);
  assert.doesNotMatch(source, /await fs\.cp\(modulesSource, path\.join\(releaseDir, "node_modules"\)/u);
});

test("Windows pinned dependency ZIP extraction uses bounded native tar instead of Expand-Archive", async () => {
  let source;
  for (const relative of ["./package-managed-release-windows.mjs", "../../scripts/release/package-managed-release-windows.mjs"]) {
    try {
      source = await fs.readFile(new URL(relative, import.meta.url), "utf8");
      break;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  assert.equal(typeof source, "string");
  assert.ok(source.includes('execFile("tar.exe", ["-xf", archive, "-C", destination]'));
  assert.match(source, /timeout:\s*60_000/u);
  assert.doesNotMatch(source, /Expand-Archive/u);
});


test("Windows release ZIP helper explicitly references compression assemblies for PowerShell 5.1", async () => {
  const helper = await fs.readFile(new URL("../../src/equinox-local-windows-release-zip.ps1", import.meta.url), "utf8");
  assert.match(helper, /\$ExpectedRoot = 'release'/u);
  assert.match(helper, /ValidateArchive\(zip, expectedRoot/u);
  assert.match(helper, /escaped the expected archive root/u);
  assert.match(helper, /ZipArchive\]\.Assembly\.Location/u);
  assert.match(helper, /ZipFile\]\.Assembly\.Location/u);
  assert.match(helper, /-ReferencedAssemblies @\(\$CompressionAssembly, \$CompressionFileSystemAssembly\)/u);
  assert.match(helper, /\$PSVersionTable\.PSEdition -eq 'Core'/u);
  assert.match(helper, /Add-Type -TypeDefinition \$TypeDefinition/u);
});

test("Windows managed package builder allows only native targets plus x64-to-ARM64 cross-packaging", async () => {
  if (process.platform === "win32" && ["x64", "arm64"].includes(process.arch)) return;
  await assert.rejects(packageManagedEquinoxWindowsRelease({ target: "win32-arm64" }), /requires a supported native or x64-to-ARM64 Windows host\/target pair/u);
});



test("Windows native launcher toolchain is target-specific and architecture-verified", async () => {
  let source;
  for (const relative of ["./package-managed-release-windows.mjs", "../../scripts/release/package-managed-release-windows.mjs"]) {
    try {
      source = await fs.readFile(new URL(relative, import.meta.url), "utf8");
      break;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  assert.equal(typeof source, "string");
  assert.match(source, /Microsoft\.VisualStudio\.Component\.VC\.Tools\.x86\.x64/u);
  assert.match(source, /Microsoft\.VisualStudio\.Component\.VC\.Tools\.ARM64/u);
  assert.match(source, /vcvars64\.bat/u);
  assert.match(source, /vcvarsarm64\.bat/u);
  assert.match(source, /vcvarsamd64_arm64\.bat/u);
  assert.match(source, /EQUINOX_WINDOWS_BROWSER_LAUNCHER_PATH/u);
  assert.match(source, /copyPrecompiledBrowserLauncher/u);
  assert.match(source, /const canExecuteTarget = target === hostTarget/u);
  assert.match(source, /Pinned Windows Node architecture mismatch/u);
  assert.ok(source.includes('Pinned Windows ${name} architecture mismatch'));
  assert.match(source, /if \(canExecuteTarget\)/u);
  assert.ok(source.includes('call "${vcvars}" >nul'));
  assert.match(source, /\.compile-browser-launcher\.cmd/u);
  assert.doesNotMatch(source, /windowsVerbatimArguments:\s*true/u);
  assert.match(source, /0x8664/u);
  assert.match(source, /0xaa64/u);
  assert.match(source, /architecture mismatch/u);
  assert.match(source, /\["-latest", "-products", "\*", "-property", "installationPath"\]/u);
  assert.match(source, /Visual Studio target environment is unavailable/u);
  assert.ok(source.includes(JSON.stringify(".\\.compile-job-object-helper.cmd")));
  assert.ok(source.includes(JSON.stringify(".\\.compile-browser-launcher.cmd")));
  assert.doesNotMatch(source, /\["\/d", "\/c", compileScript\]/u);
  assert.match(source, /Promise\.allSettled/u);
});

test("Windows release ZIP security acceptance is wired to the package CI lane", async () => {
  const smoke = await fs.readFile(new URL("./windows-release-zip-smoke.ps1", import.meta.url), "utf8");
  assert.match(smoke, /release\/\.\.\/escape\.txt/u);
  assert.match(smoke, /CON\.txt/u);
  assert.match(smoke, /case-collision/u);
  assert.match(smoke, /symlink-metadata/u);
  assert.match(smoke, /reparse-metadata/u);
  assert.match(smoke, /2147483649/u);
  let workflow;
  for (const relative of ["./public-template/.github/workflows/ci.yml", "../../.github/workflows/ci.yml"]) {
    try {
      workflow = await fs.readFile(new URL(relative, import.meta.url), "utf8");
      break;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }
  }
  assert.equal(typeof workflow, "string");
  const packageStart = workflow.indexOf("  windows-package:");
  const aggregateStart = workflow.indexOf("  windows-headless:");
  assert.ok(packageStart >= 0 && aggregateStart > packageStart);
  const packageLane = workflow.slice(packageStart, aggregateStart);
  assert.match(packageLane, /Windows release ZIP security acceptance/u);
  assert.match(packageLane, /windows-release-zip-smoke\.ps1/u);
});


test("Windows native Job Object helper uses target-specific MSVC and direct Win32 ownership", async () => {
  const source = await fs.readFile(new URL("../../scripts/release/package-managed-release-windows.mjs", import.meta.url), "utf8");
  const helper = await fs.readFile(new URL("../../native/windows/equinox-local-job-object-helper.cpp", import.meta.url), "utf8");
  assert.match(source, /compileWindowsJobObjectHelper/u);
  assert.match(source, /equinox-local-job-object-helper\.cpp/u);
  assert.match(source, /\/MT \/DUNICODE/u);
  assert.match(source, /Windows Job Object helper architecture mismatch/u);
  assert.match(helper, /CreateJobObjectW/u);
  assert.match(helper, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(helper, /AssignProcessToJobObject/u);
  assert.match(helper, /QueryInformationJobObject/u);
  assert.match(helper, /TerminateJobObject/u);
});


test("Windows public installer reuses the current PowerShell host for verified ZIP extraction", async () => {
  const installer = await fs.readFile(new URL("../../scripts/install-equinox-local.ps1", import.meta.url), "utf8");
  assert.match(installer, /GetCurrentProcess\(\)\.MainModule\.FileName/u);
  assert.match(installer, /& \$powerShellHost -NoLogo -NoProfile -NonInteractive/u);
  assert.doesNotMatch(installer, /\$PSHOME\\powershell\.exe/u);
});


test("Windows shell runtime gate is product-owned Node with explicit child-start acknowledgement", async () => {
  const gate = await fs.readFile(new URL("../../src/equinox-local-windows-runtime-gate.mjs", import.meta.url), "utf8");
  assert.match(gate, /from "node:child_process"/u);
  assert.match(gate, /EQUINOX_LOCAL_OWNED_PROCESS_SPEC/u);
  assert.match(gate, /EQUINOX_LOCAL_OWNED_PROCESS_READY_MARKER/u);
  assert.match(gate, /stdio: \["inherit", "inherit", "inherit"\]/u);
  assert.match(gate, /child\.once\("spawn"/u);
  assert.match(gate, /process\.stdout\.write/u);
  assert.doesNotMatch(gate, /powershell|cmd\.exe|shell:\s*true/iu);
});


test("Windows VC and C++ compile script paths reject CMD metacharacters before script creation", () => {
  const safe = "C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\VC\\Auxiliary\\Build\\vcvars64.bat";
  assert.equal(assertWindowsBatchQuotedPath(safe), safe);
  assert.equal(assertWindowsBatchQuotedPath("C:\\Users\\Özge Şahin\\Proje\\vcvars64.bat"), "C:\\Users\\Özge Şahin\\Proje\\vcvars64.bat");
  assert.equal(assertWindowsBatchQuotedPath("D:\\a\\equinox-local\\native\\windows\\job-object.cpp"), "D:\\a\\equinox-local\\native\\windows\\job-object.cpp");
  for (const value of [
    `${safe}" & whoami & rem \"`, `${safe}%USERNAME%`, `${safe}!USERNAME!`, `${safe}&echo injected`,
    `${safe}|echo injected`, `${safe}^&echo`, `${safe}\r\necho injected`, `${safe}<input`, `${safe}>output`,
    "C:relative\\vcvars64.bat", "\\\\server\\share\\vcvars64.bat", "", null,
  ]) {
    assert.throws(() => assertWindowsBatchQuotedPath(value), /unsafe CMD characters/u);
  }
});


test("Windows package builds independent native Guardian for both CPU targets outside replaceable WPF", async () => {
  const packager = await fs.readFile(new URL("../../scripts/release/package-managed-release-windows.mjs", import.meta.url), "utf8");
  const csproj = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/EquinoxLocal.Guardian.csproj", import.meta.url), "utf8");
  const source = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/Program.cs", import.meta.url), "utf8");
  assert.match(packager, /compileWindowsGuardian\(rootDir, releaseDir, transaction, contract\)/u);
  assert.match(packager, /"runtime", "guardian"/u);
  assert.match(packager, /portableExecutableMachine\(executable\)/u);
  assert.match(csproj, /<PublishSingleFile>true<\/PublishSingleFile>/u);
  assert.match(csproj, /<SelfContained>true<\/SelfContained>/u);
  assert.match(csproj, /win-x64/u);
  assert.match(csproj, /win-arm64/u);
  assert.match(source, /Main native switching is not activated/u);
  assert.match(source, /CompareNativeTrees\(sourceShell, programRoot\)/u);
  assert.match(source, /CryptographicOperations\.FixedTimeEquals/u);
  assert.match(source, /FileAccess\.Read, share/u);
  assert.match(source, /FileShare\.ReadWrite \| FileShare\.Delete/u);
  assert.match(source, /Native file changed during Guardian admission/u);
  assert.match(source, /EquinoxLocal\.exe\.WebView2/u);
  assert.match(source, /%SystemDrive%/u);
  assert.match(source, /RuntimeInformation\.ProcessArchitecture/u);
  assert.match(source, /Unsupported Guardian argument/u);
  assert.doesNotMatch(source, /UseShellExecute = true|cmd\.exe|powershell\.exe/u);
});


test("independent Windows Guardian audits exact Main SHA/native-store identity without enabling Main launch", async () => {
  const program = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/Program.cs", import.meta.url), "utf8");
  const inspector = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainNativeIdentity.cs", import.meta.url), "utf8");
  assert.match(program, /args\[0\] == "--audit-native-identity"/u);
  assert.match(program, /Structural audit only; never a Main launch signal/u);
  assert.match(program, /Main native switching is not activated for the Stable-only Guardian/u);
  assert.match(inspector, /current-source\.conf/u);
  assert.match(inspector, /current-native\.json/u);
  assert.match(inspector, /native-store/u);
  assert.match(inspector, /runtimeContractSha256/u);
  assert.match(inspector, /artifactSha256/u);
  assert.match(inspector, /CompareNativeTrees\(immutableShell, activeProgram\)/u);
  assert.match(inspector, /InspectOwnedMainGit\(install, target, expectedSource, sourceSha\)/u);
  const gitAudit = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainGitIdentity.cs", import.meta.url), "utf8");
  assert.match(gitAudit, /PinnedWindowsGit = "2\.53\.0-4"/u);
  assert.match(gitAudit, /ProcessStartInfo\(executable\)/u);
  assert.match(gitAudit, /UseShellExecute = false/u);
  assert.match(gitAudit, /core\.autocrlf=true/u);
  assert.match(gitAudit, /core\.fsmonitor=false/u);
  assert.match(gitAudit, /ArgumentList\.Add/u);
  assert.match(gitAudit, /rev-parse", "HEAD"/u);
  assert.match(gitAudit, /symbolic-ref", "--quiet", "--short", "HEAD"/u);
  assert.match(gitAudit, /status", "--porcelain=v1", "--untracked-files=normal"/u);
  assert.match(gitAudit, /git@github\.com:sametbasbug\/equinox-local\.git/u);
  assert.doesNotMatch(gitAudit, /cmd\.exe|powershell\.exe|UseShellExecute = true/u);
  assert.match(inspector, /InspectOwnedMainNativeMessaging\(install, release\)/u);
  const nativeMessaging = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainNativeMessagingIdentity.cs", import.meta.url), "utf8");
  assert.match(nativeMessaging, /Registry\.CurrentUser\.OpenSubKey/u);
  assert.match(nativeMessaging, /RegistryValueKind\.String/u);
  assert.match(nativeMessaging, /dev\.equinox\.browser/u);
  assert.match(nativeMessaging, /chrome-extension:\/\/npdneefcobilfkjlihghjgjnknenhfoj\//u);
  assert.match(nativeMessaging, /GetArrayLength\(\) != 1/u);
  assert.match(nativeMessaging, /Path\.Combine\(selectedRelease, "runtime", "browser"/u);
  assert.doesNotMatch(nativeMessaging, /Registry\.SetValue|WriteAllText|CreateSubKey/u);
  assert.match(inspector, /FingerprintNativeMainRelease\(release\)/u);
  assert.match(inspector, /measured\.Sha256 != claimSha/u);
  const fingerprintCode = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainNativeFingerprint.cs", import.meta.url), "utf8");
  assert.match(fingerprintCode, /equinox-local-native-state-v1/u);
  assert.match(fingerprintCode, /MaxNativeFingerprintEntries/u);
  assert.match(fingerprintCode, /CultureInfo\.GetCultureInfo\("en"\)/u);
  assert.match(fingerprintCode, /CompareOptions\.None/u);
  const guardianProject = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/EquinoxLocal.Guardian.csproj", import.meta.url), "utf8");
  assert.match(guardianProject, /<InvariantGlobalization>false<\/InvariantGlobalization>/u);
  assert.doesNotMatch(fingerprintCode, /DllImport|WindowsStringSortSha256/u);
  assert.match(fingerprintCode, /IncrementalHash\.CreateHash/u);
  assert.match(inspector, /if \(active\) throw new InvalidDataException\("Unreconciled native Main transaction blocks audit/u);
  assert.doesNotMatch(inspector, /Process\.Start|UseShellExecute|cmd\.exe|powershell\.exe/u);
});


test("independent Windows Guardian journal audit is read-only and binds active marker receipt and durable journal", async () => {
  const program = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/Program.cs", import.meta.url), "utf8");
  const journal = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainNativeJournalIdentity.cs", import.meta.url), "utf8");
  assert.match(program, /args\[0\] == "--audit-native-journal"/u);
  assert.match(program, /Receipt ownership audit ONLY; no resume or launch/u);
  assert.match(program, /Main native switching is not activated for the Stable-only Guardian/u);
  for (const name of ["active.json", "receipts", "guardian-journal", "writer-lock", "previousNative", "targetRuntimeContractSha256", "receiptStartedAt"]) {
    assert.ok(journal.includes(name), `Missing native journal binding: ${name}`);
  }
  assert.match(journal, /status is not \("promoting" or "verifying"\)/u);
  assert.match(journal, /"committed"/u);
  assert.match(journal, /"rollback_started"/u);
  assert.match(journal, /oldSha == newSha/u);
  assert.match(journal, /previous Main native identity changed|Previous Main native identity changed/u);
  assert.doesNotMatch(journal, /Registry\.SetValue|Process\.Start|File\.WriteAllText|File\.Delete|Directory\.Delete/u);
});


test("native journal authority accepts only kernel-PID+HMAC live prepared worker and writes durable native-owned sidecar", async () => {
  const program = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/Program.cs', import.meta.url), 'utf8');
  const source = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeJournalAuthority.cs', import.meta.url), 'utf8');
  const lease = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeJournalLease.cs', import.meta.url), 'utf8');
  assert.match(program, /--hold-native-journal-authority/u);
  assert.match(lease, /RecordNativeJournalWorkerAuthority\(owner, root, worker, recordPreparedAbort\)/u);
  assert.match(source, /GetNamedPipeClientProcessId\(listener\.SafePipeHandle/u);
  assert.match(source, /clientPid != owner\.Pid/u);
  assert.match(source, /stage"\)\.GetString\(\) != "prepared"/u);
  assert.match(source, /sequence"\)\.GetInt32\(\) != 0/u);
  assert.match(source, /HMACSHA256\.HashData/u);
  assert.match(source, /CryptographicOperations\.FixedTimeEquals/u);
  assert.match(source, /FileMode\.CreateNew, FileAccess\.Write/u);
  assert.match(source, /FileShare\.None, 4096, FileOptions\.WriteThrough/u);
  assert.match(source, /FileOptions\.WriteThrough/u);
  assert.match(source, /fd\.Flush\(flushToDisk: true\)/u);
  assert.match(source, /new Utf8JsonWriter\(fd\)/u);
  assert.doesNotMatch(source, /JsonSerializer\.Serialize\(/u);
  assert.doesNotMatch(source, /Process\.Start|Registry\.SetValue|\.writer-lock"\s*,\s*FileMode\.OpenOrCreate|"shell_stopped"|"switched"/u);
});

test("integrated Guardian authorizes the existing shared JS native A/B slot instead of duplicate filesystem replacement", async () => {
  const code = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeIntegratedABSlot.cs', import.meta.url), 'utf8');
  const client = await fs.readFile(new URL('../../src/equinox-local-windows-native-ab-owner-client.js', import.meta.url), 'utf8');
  assert.match(code, /GetNamedPipeClientProcessId\(endpoint\.SafePipeHandle/u);
  assert.match(code, /clientPid != owner\.Pid/u);
  assert.match(code, /CryptographicOperations\.FixedTimeEquals\(response, expected\)/u);
  assert.match(code, /journal\.RootElement\.GetProperty\("stage"\)\.GetString\(\) != "shell_stopped"/u);
  assert.match(code, /endpoint\.WriteByte\(\(byte\)'S'\)/u);
  assert.match(code, /CompareNativeTrees\(newShell, program\)/u);
  assert.match(code, /CompareNativeTrees\(previousShell, backup\)/u);
  assert.match(code, /InspectOwnedMainNativeMessaging\(install, stagedRelease\)/u);
  assert.match(code, /WriteIntegratedOwnedNativeStage\(owner, journalPath, "shell_stopped", 2, "switched", 3\)/u);
  assert.doesNotMatch(code, /Directory\.Move|File\.Move|Registry\.SetValue|Process\.Start|File\.Delete/u);
  assert.match(client, /switchWindowsNativeABSlot/u);
  assert.match(client, /registerWindowsNativeMessagingHost/u);
  assert.match(client, /assertWindowsNativeMessagingHostOwnership/u);
  assert.match(client, /createHmac\('sha256', key\)/u);
  assert.match(client, /journal\.stage !== 'shell_stopped'/u);
  assert.match(client, /programRoot: path\.win32\.join\(env\.LOCALAPPDATA, 'Programs', 'Equinox Local'\)/u);
});

test("integrated Windows Guardian stages exact native B and journals two real milestones under one exclusive owner", async () => {
  const source = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeIntegratedABSupervisor.cs', import.meta.url), 'utf8');
  const program = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/Program.cs', import.meta.url), 'utf8');
  const lease = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeJournalLease.cs', import.meta.url), 'utf8');
  assert.match(program, /--hold-native-integrated-ab/u);
  assert.match(lease, /RecordNativeJournalWorkerAuthority\(owner, root, worker, recordPreparedAbort\)/u);
  assert.match(lease, /RunOwnedIntegratedMainABSupervisor\(owner, root, worker\)/u);
  assert.match(source, /InspectBaseline\(allowActiveOrphanForReconciliation: true\)/u);
  assert.match(source, /FingerprintNativeMainRelease\(release\)/u);
  assert.match(source, /measured\.Sha256 != expected\.GetProperty\("sha256"\)/u);
  assert.match(source, /QuiesceOwnedStableShell\(owner, journalRoot, worker\)/u);
  assert.match(source, /WriteIntegratedOwnedNativeStage\(owner, journalPath, "prepared", 0, "native_staged", 1\)/u);
  assert.match(source, /WriteIntegratedOwnedNativeStage\(owner, journalPath, "native_staged", 1, "shell_stopped", 2\)/u);
  assert.match(source, /CryptographicOperations\.FixedTimeEquals\(before, SHA256\.HashData\(File\.ReadAllBytes\(path\)\)\)/u);
  assert.match(source, /File\.Move\(temp, path, overwrite: true\)/u);
  assert.match(source, /FileMode\.CreateNew, FileAccess\.Write, FileShare\.None/u);
  assert.match(source, /FileOptions\.WriteThrough/u);
  assert.match(source, /fd\.Flush\(flushToDisk: true\)/u);
  assert.match(source, /\.commit\.json/u);
  assert.doesNotMatch(source, /Process\.Start|Process\.Kill|Registry\.SetValue|Directory\.Delete|File\.Delete/u);
});

test("native Guardian WPF graceful quiesce requires exact OS shell PID and live worker authority without Main activation", async () => {
  const code = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeStableShellQuiesce.cs', import.meta.url), 'utf8');
  const lease = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeJournalLease.cs', import.meta.url), 'utf8');
  const program = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/Program.cs', import.meta.url), 'utf8');
  assert.match(program, /--hold-native-stable-shell-quiesce/u);
  assert.match(lease, /QuiesceOwnedStableShell\(owner, root, worker\)/u);
  assert.match(code, /InspectBaseline\(allowActiveOrphanForReconciliation: true\)/u);
  assert.match(code, /GetNamedPipeServerProcessId\(pipe\.SafePipeHandle/u);
  assert.match(code, /serverPid != pid/u);
  assert.match(code, /ReadWindowsLogonAuthenticationId\(shellToken\)/u);
  assert.match(code, /"shutdown-for-update\\n"/u);
  assert.match(code, /shell\.WaitForExit\(12000\)/u);
  assert.match(code, /FileMode\.CreateNew, FileAccess\.Write/u);
  assert.match(code, /"stable-shell-quiesced-only"/u);
  assert.doesNotMatch(code, /Process\.Start|Process\.Kill|Registry\.SetValue|File\.Move|File\.Delete|native_staged"\)|switched"\)|committed"\)/u);
});

test("Windows native Guardian only commits prepared/0 to rollback_started/1 through exclusive journal lease", async () => {
  const code = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativePreparedAbort.cs', import.meta.url), 'utf8');
  const program = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/Program.cs', import.meta.url), 'utf8');
  assert.match(program, /--hold-native-prepared-abort/u);
  assert.match(code, /WriteNativeJournalPreparedAbort\(/u);
  assert.match(code, /GetProperty\("stage"\)\.GetString\(\) != "prepared"/u);
  assert.match(code, /GetProperty\("sequence"\)\.GetInt32\(\) != 0/u);
  assert.match(code, /writer\.WriteString\("stage", "rollback_started"\)/u);
  assert.match(code, /writer\.WriteNumber\("sequence", 1\)/u);
  assert.match(code, /CryptographicOperations\.FixedTimeEquals\(expectedDigest/u);
  assert.match(code, /FileMode\.CreateNew, FileAccess\.Write, FileShare\.None/u);
  assert.match(code, /FileOptions\.WriteThrough/u);
  assert.match(code, /File\.Move\(temp, journalPath, overwrite: true\)/u);
  assert.match(code, /\.abort-commit\.json/u);
  assert.match(code, /FileMode\.CreateNew, FileAccess\.Write/u);
  assert.match(code, /committed\.RootElement\.GetProperty\("sequence"\)\.GetInt32\(\) != 1/u);
  assert.doesNotMatch(code, /Process\.Start|Registry\.SetValue|native_staged"\)|shell_stopped"\)|switched"\)|healthy"\)|committed"\)/u);
});

test("Windows native Guardian quarantines only a dead exact prepared abort without unlocking Main", async () => {
  const source = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativePreparedAbortRecovery.cs', import.meta.url), 'utf8');
  const program = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/Program.cs', import.meta.url), 'utf8');
  const audit = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeJournalIdentity.cs', import.meta.url), 'utf8');
  assert.match(program, /--reconcile-native-prepared-abort/u);
  assert.match(source, /InspectBaseline\(allowActiveOrphanForReconciliation: true\)/u);
  assert.match(source, /InspectOwnedNativeTransitionJournal\(allowExactPreparedAbortOrphanLock: true\)/u);
  assert.match(source, /GetProperty\("stage"\)\.GetString\(\) != "rollback_started"/u);
  assert.match(source, /GetProperty\("sequence"\)\.GetInt32\(\) != 1/u);
  assert.match(source, /GetProperty\("kind"\)\.GetString\(\) != "stable"/u);
  assert.match(source, /OsProcessExists\(workerPid\) \|\| OsProcessExists\(guardianPid\)/u);
  assert.match(source, /CryptographicOperations\.FixedTimeEquals/u);
  assert.match(source, /"quarantined-no-resume"/u);
  assert.match(source, /FileMode\.CreateNew, FileAccess\.Write/u);
  assert.match(source, /File\.Move\(lockPath, quarantinedLock\)/u);
  assert.match(audit, /name\.EndsWith\("\.writer-lock"/u);
  assert.doesNotMatch(source, /File\.Delete|Directory\.Delete|Process\.Start|Registry\.SetValue|native_staged"\)|switched"\)|healthy"\)|committed"\)/u);
});

test("independent native Guardian obtains an OS-exclusive durable journal lease with no automatic reclaim or WPF mutation", async () => {
  const program = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/Program.cs', import.meta.url), 'utf8');
  const code = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeJournalLease.cs', import.meta.url), 'utf8');
  assert.match(program, /--hold-native-journal-lease/u);
  assert.match(code, /InspectOwnedNativeWorkerOsArguments\(\)/u);
  assert.match(code, /InspectOwnedNativeWorkerPipeProof\(\)/u);
  assert.match(code, /FileMode\.CreateNew, FileAccess\.ReadWrite/u);
  assert.match(code, /FileShare\.None/u);
  assert.match(code, /FileOptions\.WriteThrough/u);
  assert.match(code, /lease\.Flush\(flushToDisk: true\)/u);
  assert.match(code, /\.writer-lock/u);
  assert.match(code, /explicit owner reconciliation/u);
  assert.doesNotMatch(code, /File\.Delete|File\.Move|Directory\.Delete|Process\.Start|Registry\.SetValue|NativeMessaging|shell_stopped|switched/u);
});

test("independent Guardian worker process provenance never invokes a launcher or accepts unbound PID ownership", async () => {
  const program = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/Program.cs", import.meta.url), "utf8");
  const auditor = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainNativeWorkerIdentity.cs", import.meta.url), "utf8");
  assert.match(program, /--audit-native-worker/u);
  assert.match(program, /--audit-native-worker-ipc/u);
  const argv = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeWorkerArguments.cs', import.meta.url), 'utf8');
  assert.match(program, /--audit-native-worker-argv/u);
  assert.match(argv, /NtQueryInformationProcess\(process\.Handle, ProcessCommandLineInformation/u);
  assert.match(argv, /ProcessCommandLineInformation = 60/u);
  assert.match(argv, /CommandLineToArgvW/u);
  assert.match(argv, /rollbackSourceRoot/u);
  assert.match(argv, /targetSourceRoot/u);
  assert.match(argv, /"--transaction-id", worker\.TransactionId/u);
  assert.match(argv, /"--transaction-root", tx/u);
  assert.match(argv, /InspectOwnedNativeWorkerProcess\(\)/u);
  assert.doesNotMatch(argv, /Process\.Start|File\.WriteAllText|File\.Delete|Registry\.SetValue/u);
  assert.match(auditor, /GetNamedPipeServerProcessId\(pipe\.SafePipeHandle/u);
  assert.match(auditor, /serverPid != owner\.Pid/u);
  assert.match(auditor, /HMACSHA256\.HashData/u);
  assert.match(auditor, /CryptographicOperations\.FixedTimeEquals/u);
  assert.match(auditor, /CancellationTokenSource\(TimeSpan\.FromSeconds\(2\)\)/u);
  assert.match(auditor, /InspectOwnedNativeTransitionJournal\(\)/u);
  assert.match(auditor, /windows-worker\.json/u);
  assert.match(auditor, /Process\.GetProcessById\(pid\)/u);
  assert.match(auditor, /StartTime\.ToUniversalTime\(\)\.Ticks/u);
  assert.match(auditor, /MainModule\?\.FileName/u);
  assert.match(auditor, /OpenProcessToken\(running\.Handle, TokenQuery/u);
  assert.match(auditor, /WindowsIdentity\(workerToken\.DangerousGetHandle\(\)\)/u);
  assert.match(auditor, /WindowsIdentity\.GetCurrent\(\)/u);
  assert.match(auditor, /workerSid\.Equals\(guardianSid\)/u);
  assert.match(auditor, /native-worker-user-identity/u);
  assert.match(auditor, /native-worker-logon-authentication/u);
  assert.match(auditor, /TokenStatisticsClass = 10/u);
  assert.match(auditor, /GetTokenInformation\(token, TokenStatisticsClass/u);
  assert.match(auditor, /AuthenticationIdOffset = 8/u);
  assert.match(auditor, /BinaryPrimitives\.ReadInt64LittleEndian/u);
  assert.match(auditor, /workerLogon != guardianLogon/u);
  assert.match(auditor, /guardianIdentity\.AccessToken/u);
  assert.match(auditor, /native-worker-os-session/u);
  assert.match(auditor, /running\.SessionId != guardian\.SessionId/u);
  assert.match(auditor, /different Windows OS session/u);
  assert.match(auditor, /runtime", "node"/u);
  assert.match(auditor, /WorkerTokenPattern/u);
  assert.doesNotMatch(auditor, /Process\.Start|Registry\.SetValue|File\.WriteAllText|File\.Delete/u);
});

test('Guardian read-only native identity audit remains unavailable during active Main; only exact live owner may call it internally', async () => {
  const identity = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeIdentity.cs', import.meta.url), 'utf8');
  const program = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/Program.cs', import.meta.url), 'utf8');
  const restart = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeIntegratedABRestart.cs', import.meta.url), 'utf8');
  assert.match(program, /InspectMainNativeIdentity\(\)/u);
  assert.match(identity, /private static void InspectMainNativeIdentity\(OwnedWorkerClaim\? exactOwnedWorker = null\)/u);
  assert.match(identity, /if \(active\) throw new InvalidDataException\("Unreconciled native Main transaction blocks audit/u);
  assert.match(identity, /journal\.GetProperty\("stage"\)\.GetString\(\) != "switched"/u);
  assert.match(identity, /InspectOwnedNativeWorkerProcess\(guardianHoldsJournalLease: true\)/u);
  assert.match(identity, /live\.TransactionId != exactOwnedTransactionId/u);
  assert.match(identity, /live\.Pid != exactOwnedWorker\.Pid/u);
  assert.match(identity, /live\.Ticks != exactOwnedWorker\.Ticks/u);
  assert.match(identity, /Directory\.EnumerateFileSystemEntries\(handoff, "\*\.windows-worker\.json"\)\.Count\(\) != 1/u);
  assert.match(restart, /InspectMainNativeIdentity\(owner\)/u);
});

test('integrated Guardian B WPF restart requires native owner OS PID+HMAC, exact B pointer, shell PID+token+pipe and durable restarted/4', async () => {
  const source = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeIntegratedABRestart.cs', import.meta.url), 'utf8');
  const supervisor = await fs.readFile(new URL('../../native/windows/EquinoxLocal.Guardian/MainNativeIntegratedABSupervisor.cs', import.meta.url), 'utf8');
  const worker = await fs.readFile(new URL('../../src/equinox-local-main-update-worker.js', import.meta.url), 'utf8');
  assert.match(supervisor, /RestartOwnedIntegratedBWpf\(owner, journalRoot, worker\)/u);
  assert.match(source, /GetNamedPipeClientProcessId\(endpoint\.SafePipeHandle/u);
  assert.match(source, /clientPid != owner\.Pid/u);
  assert.match(source, /CryptographicOperations\.FixedTimeEquals\(response, expected\)/u);
  assert.match(source, /"switched" \|\| j\.GetProperty\("sequence"\)\.GetInt32\(\) != 3/u);
  assert.match(source, /InspectMainNativeIdentity\(owner\)/u);
  assert.match(source, /using var shell = Launch\(executable, null\)/u);
  assert.match(source, /ReadWindowsLogonAuthenticationId\(shellToken\)/u);
  assert.match(source, /GetNamedPipeServerProcessId\(pipe\.SafePipeHandle/u);
  assert.match(source, /serverPid != shell\.Id/u);
  assert.match(source, /FileMode\.CreateNew, FileAccess\.Write, FileShare\.None/u);
  assert.match(source, /WriteIntegratedOwnedNativeStage\(owner, journalPath, "switched", 3, "restarted", 4\)/u);
  assert.match(worker, /guardianOwnedBWpfRestartImpl\(/u);
  assert.match(worker, /Windows native A rollback WPF restart requires independently verified Guardian recovery/u);
  assert.doesNotMatch(source, /File\.Move|Directory\.Move|Registry\.SetValue|Directory\.Delete|Process\.Kill/u);
});


test('real installed x64/ARM64 acceptance commits clean disposable source B and proves OS Guardian WPF restarted/4', async () => {
  const fixture = await fs.readFile(new URL('../../tests/release/windows-installer-real-package-smoke.ps1', import.meta.url), 'utf8');
  const witness = await fs.readFile(new URL('../../tests/release/owned-windows-worker-proof.mjs', import.meta.url), 'utf8');
  assert.match(fixture, /clone --quiet --branch main \$ManagedSourceRoot \$JournalCandidateRoot/u);
  assert.match(fixture, /commit --quiet -m 'test: ephemeral Windows native Main B restart witness'/u);
  assert.match(fixture, /\$JournalTarget -cne \$JournalCurrent/u);
  assert.match(fixture, /\$JournalBSourceStatus\.Count -eq 0/u);
  assert.match(fixture, /robocopy\.exe \$JournalCandidateRoot \$JournalTargetRoot \/E \/COPY:DAT \/DCOPY:DAT/u);
  assert.match(fixture, /\$BFixtureCopyResult -ge 0 -and \$BFixtureCopyResult -le 7/u);
  assert.match(fixture, /\$CopiedSourceSha -ceq \$JournalTarget/u);
  assert.match(fixture, /windows-seed-native-b-source-fixture\.mjs/u);
  const dependencyFixture = await fs.readFile(new URL('../../tests/release/windows-seed-native-b-source-fixture.mjs', import.meta.url), 'utf8');
  assert.match(dependencyFixture, /seedPrebuiltDependenciesFromStableRelease\(sourceB, sourceA\)/u);
  assert.match(dependencyFixture, /process\.env\.GITHUB_ACTIONS !== 'true'/u);
  assert.match(fixture, /\$SeedProductNode = Join-Path \$ReleaseDir/u);
  assert.match(fixture, /\$JournalTargetRoot 'node_modules'/u);
  assert.match(fixture, /Disposable B dependency seed changed its tracked Git identity/u);
  assert.match(fixture, /\$SelectedBSourcePointer/u);
  assert.match(fixture, /\$SelectedBNativePointer/u);
  assert.match(fixture, /\$JournalBRestartTrigger/u);
  assert.match(fixture, /\$JournalRestartedCommit/u);
  assert.match(fixture, /\$BRestartWitness\.shellPid/u);
  assert.match(fixture, /\$RestartEvidenceReadable/u);
  assert.match(fixture, /\$EvidenceAttempt -lt 75/u);
  assert.match(fixture, /\$BRestartJournal\.stage -ceq 'restarted'/u);
  assert.match(fixture, /robocopy\.exe \$ReleaseDir \$StagedBRelease \/E \/COPY:DAT \/DCOPY:DAT/u);
  assert.match(fixture, /\$BReleaseCopyResult -ge 0 -and \$BReleaseCopyResult -le 7/u);
  assert.match(fixture, /\$StagedBRuntime 'node\\bin\\node\.exe'/u);
  assert.match(fixture, /\$StagedBRelease 'equinox-local-windows-runtime-gate\.mjs'/u);
  assert.match(fixture, /\$StagedBRelease 'equinox-local-windows-runtime-supervisor\.js'/u);
  assert.match(fixture, /\$JournalGuardianSpawnTrigger/u);
  assert.match(fixture, /\$JournalGuardianPidReceipt/u);
  assert.match(fixture, /\$WorkerStartInfo\.EnvironmentVariables\['EQUINOX_LOCAL_TEST_GUARDIAN_LAUNCH_MODULE'\]/u);
  assert.match(fixture, /\$IntegratedGuardian = \[Diagnostics\.Process\]::GetProcessById/u);
  assert.match(fixture, /Same-Path \$IntegratedGuardian\.MainModule\.FileName \$GuardianExe/u);
  assert.doesNotMatch(fixture, /\$IntegratedStart = \[Diagnostics\.ProcessStartInfo\]::new\(\$GuardianExe\)/u);
  const worker = await fs.readFile(new URL('../../tests/release/owned-windows-worker-proof.mjs', import.meta.url), 'utf8');
  assert.match(worker, /launchEquinoxLocalWindowsNativeMainGuardian/u);
  assert.match(worker, /fs\.writeFileSync\(pidReceipt/u);
  assert.match(fixture, /\$BBackendConsecutive -ge 4/u);
  assert.match(fixture, /\$BBackendLastPhase/u);
  assert.match(fixture, /\$BBackendSourceMatch/u);
  assert.match(fixture, /\$BBackendNativeMatch/u);
  assert.match(fixture, /\$BBackendManifestMatch/u);
  assert.match(fixture, /\$BBackendRegistryMatch/u);
  assert.match(fixture, /Hosted B native WPF bounded lifecycle classifications/u);
  assert.match(fixture, /\$BBackendStatus\.status\.installation\.sourceSha -ceq \$JournalTarget/u);
  assert.match(fixture, /\$BManifestCurrent\.path \$BExpectedLauncher/u);
  assert.match(fixture, /\$BNativeCurrent\.sourceSha -ceq \$JournalTarget/u);
  assert.match(fixture, /Stop-OwnedShell \$StableExe/u);
  assert.match(fixture, /\$OriginalIntegratedSourcePointer/u);
  assert.match(fixture, /\$OriginalIntegratedNativePointer/u);
  assert.match(witness, /requestEquinoxLocalGuardianOwnedBWpfRestart/u);
  assert.doesNotMatch(fixture, /Native B sustained backend health PASSED/u);
});

test('managed Windows WPF selects exact installed source/native pointers before inherited old Stable release environment', async () => {
  const supervisor = await fs.readFile(new URL('../../native/windows/EquinoxLocal.WindowsShell/RuntimeSupervisor.cs', import.meta.url), 'utf8');
  const harness = await fs.readFile(new URL('../../tests/windows/EquinoxLocal.WindowsShell.ManagedSourceHarness/Program.cs', import.meta.url), 'utf8');
  const resolver = supervisor.slice(supervisor.indexOf('internal static RuntimeSupervisor? TryCreateFromEnvironmentOrManagedInstall()'));
  const pointerFirst = resolver.indexOf('if (WindowsManagedReleaseLocator.HasCurrentPointer())');
  const envFallback = resolver.indexOf('Environment.GetEnvironmentVariable("EQUINOX_LOCAL_RELEASE_DIR")');
  assert.ok(pointerFirst >= 0 && pointerFirst < envFallback, 'managed source/native pointer must override inherited Stable release environment');
  assert.match(resolver, /return new RuntimeSupervisor\(WindowsManagedSourceRuntimeLocator\.Resolve\)/u);
  assert.match(harness, /Environment\.SetEnvironmentVariable\("EQUINOX_LOCAL_RELEASE_DIR", stableRelease\)/u);
  assert.match(harness, /await WaitForIdentityAsync\(port, "B"/u);
});
