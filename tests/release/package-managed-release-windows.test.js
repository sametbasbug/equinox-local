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

test("hosted Windows package timings are stderr-only and cannot corrupt CLI JSON stdout", async () => {
  const source = await fs.readFile(new URL("../../scripts/release/package-managed-release-windows.mjs", import.meta.url), "utf8");
  assert.match(source, /process\.stderr\.write\("Hosted Windows package phase: "/u);
  assert.match(source, /process\.stderr\.write\("Hosted Windows ZIP writer phase: "/u);
  assert.doesNotMatch(source, /process\.stdout\.write\("Hosted Windows/u);
  assert.match(source, /process\.stdout\.write\(`\$\{JSON\.stringify\(result, null, 2\)\}\\n`\)/u);
});

test("ARM64 native Guardian and Job cache is exact-source keyed and fails closed on unsafe binaries", async () => {
  const action = await fs.readFile(new URL("../../.github/actions/prepare-arm64-package/action.yml", import.meta.url), "utf8");
  const builder = await fs.readFile(new URL("../../scripts/release/package-managed-release-windows.mjs", import.meta.url), "utf8");
  assert.match(action, /Cache source-keyed ARM64 Guardian and Job Object binaries/u);
  const workflow = await fs.readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const producer = workflow.split("  windows-x64-package-build:")[1]?.split("\n  windows-package:")[0];
  assert.ok(producer, "x64 producer job must exist");
  assert.match(producer, /Cache source-keyed x64 Guardian and Job Object binaries/u);
  assert.match(producer, /native-helpers-v1-/u);
  assert.match(producer, /EQUINOX_WINDOWS_NATIVE_HELPER_CACHE_DIR/u);
  assert.match(producer, /EQUINOX_WINDOWS_NATIVE_HELPER_CACHE_HIT/u);
  assert.match(action, /native-helpers-v1-/u);
  assert.match(action, /scripts\/release\/package-managed-release-windows\.mjs/u);
  assert.match(producer, /scripts\/release\/package-managed-release-windows\.mjs/u);

  assert.match(action, /hashFiles\('native\/windows\/EquinoxLocal\.Guardian\/\*\*', 'native\/windows\/equinox-local-job-object-helper\.cpp'/u);
  assert.match(action, /EQUINOX_WINDOWS_NATIVE_HELPER_CACHE_HIT/u);
  assert.match(builder, /process\.env\.GITHUB_ACTIONS === "true" && process\.env\.EQUINOX_WINDOWS_NATIVE_HELPER_CACHE_HIT === "true"/u);
  assert.match(builder, /await assertNormalTree\(source\)/u);
  assert.match(builder, /portableExecutableMachine\(executable\) !== contract\.peMachine/u);
  assert.match(builder, /owned-process-gate-v1\.marker/u);
  assert.match(builder, /Cache only after the whole source-bound package has passed validation/u);
  assert.match(builder, /: compileWindowsGuardian\(rootDir, releaseDir, transaction, contract\)/u);
  assert.match(builder, /: compileWindowsJobObjectHelper\(/u);
});

test("Windows package stages node_modules through normal-file hardlinks", async () => {
  const source = await fs.readFile(new URL("../../scripts/release/package-managed-release-windows.mjs", import.meta.url), "utf8");
  assert.match(source, /async function hardlinkNormalTree/u);
  assert.match(source, /await fs\.link\(source, destination\)/u);
  assert.match(source, /if\s*\(entry\.name === "\.bin" && sourceDir === sourceRoot\)\s*continue/u);
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
  const packageStart = workflow.indexOf("  windows-x64-package-build:");
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
  assert.match(source, /\/SUBSYSTEM:WINDOWS \/ENTRY:wmainCRTStartup/u, "pipe-only native helper must not request a console window");
  const helperSource = await fs.readFile(new URL("../../native/windows/equinox-local-job-object-helper.cpp", import.meta.url), "utf8");
  assert.match(helperSource, /AllocConsoleWithOptions/u, "Windows 11 native gate must support windowless inherited consoles");
  assert.match(helperSource, /ALLOC_CONSOLE_MODE_NO_WINDOW/u);
  assert.match(helperSource, /EnsureInheritedWindowlessConsole\(\) \? 0 : CREATE_NO_WINDOW/u,
    "never detach PowerShell children from the inherited headless console");
  assert.match(source, /owned-process-gate-v1\.marker/u, "source-only Main upgrades need the native gate capability marker");
  assert.match(source, /equinox-local-job-object-helper\.cpp/u);
  assert.match(source, /\/MT \/DUNICODE/u);
  assert.match(source, /Windows Job Object helper architecture mismatch/u);
  assert.match(helper, /CreateJobObjectW/u);
  assert.match(helper, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/u);
  assert.match(helper, /AssignProcessToJobObject/u);
  assert.match(helper, /QueryInformationJobObject/u);
  assert.match(helper, /GetProcessTimes/u);
  assert.match(helper, /QueryFullProcessImageNameW/u);
  assert.match(helper, /--inspect-process/u);
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


test("Guardian independently audits original A WPF kernel identity without granting Main A/B mutation", async () => {
  const program = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/Program.cs", import.meta.url), "utf8");
  const audit = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainNativeWpfOwnerAudit.cs", import.meta.url), "utf8");
  assert.match(program, /args\[0\] == "--audit-native-wpf-owner"/u);
  assert.match(program, /Read-only kernel ownership evidence, never transition authority/u);
  for (const required of [
    "InspectOwnedNativeWorkerProcess()", "guardian-journal",
    "current-native.json", "native-store", "previousNative",
    "stage", "prepared", "sequence", "CompareNativeTrees",
    "FindSingleOwnedStableShell", "OpenProcessToken",
    "ReadWindowsLogonAuthenticationId", "SessionId",
    "GetNamedPipeServerProcessId", "shell.StartTime",
    "Original A WPF ownership pipe",
    "current-version.json", "RequireExactKeys(nativeA",
    "InspectOwnedMainGit(install, target, sourceRoot, sourceSha)",
    "InspectOwnedMainNativeMessaging(install, release)",
  ]) {
    assert.ok(audit.includes(required), "Missing exact original A WPF observation: " + required);
  }
  // Audit may observe a native OS handle but may never send a shell command,
  // change a journal or start a native process.
  assert.doesNotMatch(audit, /Process\.Start\s*\(|ProcessStartInfo|File\.Move|File\.Delete|File\.WriteAllText|Registry\.|Kill\s*\(|\.WriteAsync\s*\(|\.Write\s*\(/u);
  assert.match(audit, /No command is sent on this pipe/u);
  assert.match(audit, /never an admitted native supervisor/u);
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
  assert.match(gitAudit, /PinnedWindowsGit = "2\.56\.0-1"/u);
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
  assert.match(inspector, /File\.Exists\(Path\.Combine\(tx, "active\.json"\)\)/u);
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
  assert.match(lease, /RecordNativeJournalWorkerAuthority\(owner, root, worker, recordPreparedAbort, recordNativeStaged\)/u);
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
  const bootstrap = await fs.readFile(new URL("../../native/windows/EquinoxLocal.Guardian/MainNativeBootstrap.cs", import.meta.url), "utf8");
  assert.match(bootstrap, /runtime", "node"/u);
  assert.match(auditor, /ResolveOwnedMainWorkerNodePath/u);
  assert.match(auditor, /WorkerTokenPattern/u);
  assert.doesNotMatch(auditor, /Process\.Start|Registry\.SetValue|File\.WriteAllText|File\.Delete/u);
});

test('vintage Windows A/B real PE smoke accepts pre-6.1.2 marker absence but always verifies modern native gates', async () => {
  const smoke = await fs.readFile(new URL('./windows-native-ab-installed-smoke.mjs', import.meta.url), 'utf8');
  assert.match(smoke, /compareEquinoxVersions\(installedRelease\.version, "6\.1\.2"\) >= 0/u);
  assert.match(smoke, /assert\.equal\(\(await fs\.stat\(nativeHelper\)\)\.isFile\(\), true/u);
  assert.match(smoke, /if \(hasNativeInspector\) \{[\s\S]*?await fs\.readFile\(nativeGateMarker, "utf8"\)/u);
  assert.match(smoke, /inspectWindowsMainUpdateWorkerProcess\(ownership\)/u);
  assert.match(smoke, /exact LIVE product Node PID\/birthtime\/executable\/token/u);
  assert.match(smoke, /Get-Process -Id/u);
  assert.match(smoke, /StartTime\.ToUniversalTime\(\)\.Ticks/u);
  assert.match(smoke, /timeout: 20_000, windowsHide: true/u);
  // The hosted package fixture runs in a workflow that explicitly provisions
  // pwsh. Avoid a separate cold Windows PowerShell 5.1 startup solely for
  // worker birth ticks; preserve the exact live-PID birthtime attestation.
  assert.match(smoke, /execFile\('pwsh\.exe', \[/u);
  assert.doesNotMatch(smoke, /execFile\('powershell\.exe', \[/u);
  assert.match(smoke, /Get-Process -Id \$\{process\.pid\} -ErrorAction Stop/u);
});

test('vintage installed Main upgrade does not require a Guardian absent from old signed packages', async () => {
  const fixture = await fs.readFile(new URL('./windows-installer-real-package-smoke.ps1', import.meta.url), 'utf8');
  assert.match(fixture, /\$SkipLegacyGuardianFixture = \(\$env:GITHUB_ACTIONS -ceq 'true' -and -not \[string\]::IsNullOrWhiteSpace\(\$env:EQUINOX_WINDOWS_MAIN_ACCEPT_TARGET_SHA\)\)/u);
  assert.ok((fixture.match(/if \(-not \$SkipLegacyGuardianFixture\) \{/gu) ?? []).length >= 4);
  assert.match(fixture, /if \(-not \$SkipLegacyGuardianFixture -and -not \$RepairOnly -and -not \$GuardianAuditElsewhere\) \{/u,
    "The real full installer must retain Guardian negative cases, while CI-only repair stays isolated.");
  assert.match(fixture, /if \(\$RepairOnly -and \(\$env:GITHUB_ACTIONS -cne 'true'/u,
    "Repair-only smoke must remain restricted to disposable hosted CI.");
  assert.match(fixture, /EQUINOX_WINDOWS_NATIVE_AB_IN_PACKAGE/u);
  assert.match(fixture, /Native A\/B package-lane ownership requires a current-product full installer running in GitHub CI/u);
  assert.match(fixture, /if \(-not \$RepairOnly -and -not \$NativeABInPackage\)/u);
  assert.match(fixture, /windows-native-ab-installed-smoke\.mjs/u);
  assert.match(fixture, /Old installed A user config is missing/u);
  assert.match(fixture, /Real Main upgrade lost user settings/u);
  assert.match(fixture, /Real Main upgrade lost user browser data/u);
  assert.match(fixture, /Updated Native Messaging manifest did not select exact B or restore A on failure/u);
});

test("signed Windows native WPF witness acceptance demands real owner and rejects impersonation", async () => {
  const script = await fs.readFile(new URL("./windows-installer-real-package-smoke.ps1", import.meta.url), "utf8");
  assert.match(script, /function Invoke-NativeWpfWitness/u);
  assert.match(script, /runtime\\job\\equinox-local-job-object-helper\.exe/u);
  assert.match(script, /Read-PeMachine \$NativeWpfWitness/u);
  assert.match(script, /\$start\.Arguments = '--inspect-owned-wpf'/u);
  assert.match(script, /\$start\.EnvironmentVariables\.Clear\(\)/u);
  assert.match(script, /\$start\.EnvironmentVariables\['EQUINOX_LOCAL_CHECK_WPF_PID'\]/u);
  assert.match(script, /\$start\.EnvironmentVariables\['EQUINOX_LOCAL_CHECK_WPF_TICKS'\]/u);
  // CI launches this fixture explicitly with Windows PowerShell 5.1.
  // Prevent accidental .NET Core-only ProcessStartInfo API regressions.
  assert.doesNotMatch(script, /\$start\.ArgumentList\b|\$start\.Environment\s*\[/u);
  assert.match(script, /\$start\.RedirectStandardOutput = \$true/u);
  assert.match(script, /\$process\.WaitForExit\(5000\)/u);
  assert.match(script, /OS native helper refused the genuine installed WPF owner/u);
  assert.match(script, /OS native helper accepted a forged WPF birth time/u);
  assert.match(script, /OS native helper accepted the native worker Node as WPF/u);
  assert.match(script, /OS native helper accepted a terminated WPF owner/u);
  assert.doesNotMatch(script, /EQUINOX_LOCAL_CHECK_WPF_EXE/u);
});


test("native Guardian durable owner identity binds exact OS worker birth across lease, authority, WPF and orphan recovery", async () => {
  const base = new URL('../../native/windows/EquinoxLocal.Guardian/', import.meta.url);
  const read = async (name) => fs.readFile(new URL(name,base),'utf8');
  const [lease,authority,wpf,recovery,host]=await Promise.all([
    read('MainNativeJournalLease.cs'), read('MainNativeJournalAuthority.cs'),
    read('MainNativeStableShellQuiesce.cs'), read('MainNativePreparedAbortRecovery.cs'),
    fs.readFile(new URL('./windows-installer-real-package-smoke.ps1', import.meta.url),'utf8'),
  ]);
  assert.match(lease, /workerStartTimeUtcTicks=\{owner\.Ticks\}/u);
  assert.match(authority, /WriteString\("workerStartTimeUtcTicks", owner\.Ticks\)/u);
  assert.match(wpf, /proof\.GetProperty\("workerStartTimeUtcTicks"\)\.GetString\(\) != owner\.Ticks/u);
  assert.match(wpf, /proof\.GetProperty\("guardianPid"\)\.GetInt32\(\) != Environment\.ProcessId/u);
  assert.match(wpf, /WriteString\("workerStartTimeUtcTicks", owner\.Ticks\)/u);
  assert.match(recovery, /workerTicks\.ToString\(CultureInfo\.InvariantCulture\)/u);
  assert.match(recovery, /GetProperty\("startTimeUtcTicks"\)\.GetString\(\) != workerTicks/u);
  assert.match(recovery, /GetProperty\("workerStartTimeUtcTicks"\)\.GetString\(\) != workerTicks/u);
  assert.match(host, /Orphan recovery accepted forged worker creation time in the native writer lease/u);
  assert.match(host, /Orphan recovery accepted forged worker creation time in the native authority receipt/u);
});


test("native Guardian binds immutable worker handoff bytes through live authorization, WPF shutdown, and orphan recovery", async () => {
  const base = new URL("../../native/windows/EquinoxLocal.Guardian/", import.meta.url);
  const read = async (name) => fs.readFile(new URL(name, base), "utf8");
  const [authority, quiesce, recovery, hosted] = await Promise.all([
    read("MainNativeJournalAuthority.cs"), read("MainNativeStableShellQuiesce.cs"),
    read("MainNativePreparedAbortRecovery.cs"),
    fs.readFile(new URL("./windows-installer-real-package-smoke.ps1", import.meta.url), "utf8"),
  ]);
  assert.match(authority, /RequireNormalDirectory\(handoffRoot\)/u);
  assert.match(authority, /RequireNormalFile\(path\)/u);
  assert.match(authority, /handle.Length is < 2 or > 8192/u);
  assert.match(authority, /CryptographicOperations\.FixedTimeEquals\(handoffDigest, HashOwnedWorkerHandoff/u);
  assert.match(authority, /WriteString\("handoffSha256", Convert\.ToHexStringLower\(handoffDigest\)\)/u);
  assert.match(quiesce, /GetProperty\("handoffSha256"\)/u);
  assert.match(quiesce, /HashOwnedWorkerHandoff\(journalRoot, owner\.TransactionId\)/u);
  assert.match(recovery, /GetProperty\("handoffSha256"\)/u);
  assert.match(recovery, /HashOwnedWorkerHandoff\(root, id\)/u);
  assert.match(hosted, /AuthorityRecord\.handoffSha256/u);
  assert.match(hosted, /Orphan recovery accepted a changed authenticated worker handoff token/u);
});


test("native prepared abort commit retains exact prepared-to-aborted journal digest lineage", async () => {
  const root = new URL("../../native/windows/EquinoxLocal.Guardian/", import.meta.url);
  const [writer,recovery,host] = await Promise.all([
    fs.readFile(new URL("MainNativePreparedAbort.cs",root),"utf8"),
    fs.readFile(new URL("MainNativePreparedAbortRecovery.cs",root),"utf8"),
    fs.readFile(new URL("./windows-installer-real-package-smoke.ps1",import.meta.url),"utf8"),
  ]);
  assert.match(writer,/WriteString\("preparedJournalSha256", Convert\.ToHexStringLower\(expectedDigest\)\)/u);
  assert.match(writer,/WriteString\("journalSha256", Convert\.ToHexStringLower\(SHA256\.HashData\(File\.ReadAllBytes\(journalPath\)\)\)\)/u);
  assert.match(recovery,/GetProperty\("preparedJournalSha256"\)/u);
  assert.match(recovery,/auth\.GetProperty\("journalSha256"\)/u);
  assert.match(host,/AbortReceipt\.preparedJournalSha256 -ceq \$AuthorityRecord\.journalSha256/u);
  assert.match(host,/Orphan recovery accepted an abort commit forged to an unrelated prepared journal/u);
});

test('Windows native B rollback preflight pins OS-installed B shell to SHA release and exact rollback journal without granting shutdown', async () => {
  const root = new URL('../../native/windows/EquinoxLocal.Guardian/', import.meta.url);
  const native = await fs.readFile(new URL('MainNativeBRollbackPreflight.cs', root), 'utf8');
  const dispatcher = await fs.readFile(new URL('Program.cs', root), 'utf8');
  assert.match(native, /private static void InspectOwnedMainBRollbackPreflight\(string transactionId, string sourceSha\)/u);
  assert.match(native, /NativeTransactionPattern\.IsMatch\(transactionId\)/u);
  assert.match(native, /SourceShaPattern\.IsMatch\(sourceSha\)/u);
  assert.match(native, /Environment\.SpecialFolder\.LocalApplicationData/u);
  assert.match(native, /Path\.Combine\(tx, "native-store"\)/u);
  assert.match(native, /Path\.Combine\(targetStore, sourceSha\)/u);
  assert.match(native, /foreach \(var directory in new\[\] \{/u);
  assert.match(native, /RequireNormalDirectory\(directory\)/u);
  assert.match(native, /ReadOwnedTransitionRecord\(Path\.Combine\(tx, "active\.json"\), 8192\)/u);
  assert.match(native, /ReadOwnedTransitionRecord\(Path\.Combine\(journalRoot, transactionId \+ "\.json"\), 8192\)/u);
  assert.match(native, /journal\.GetProperty\("stage"\)\.GetString\(\) != "rollback_started"/u);
  assert.match(native, /journal\.GetProperty\("sequence"\)\.GetInt32\(\) is < 1 or > 6/u);
  assert.match(native, /CompareNativeTrees\(sourceShell, programRoot\)/u);
  assert.match(native, /FindSingleOwnedStableShell\(installedExe\)/u);
  assert.match(native, /OpenProcessToken\(shell\.Handle, TokenQuery/u);
  assert.match(native, /ReadWindowsLogonAuthenticationId\(shellToken\) != ReadWindowsLogonAuthenticationId\(guardianIdentity\.AccessToken\)/u);
  assert.match(native, /shell\.StartTime\.ToUniversalTime\(\)\.Ticks\.ToString\(CultureInfo\.InvariantCulture\) != ticks/u);
  assert.match(native, /native-b-rollback-preflight-only-no-shutdown/u);
  assert.doesNotMatch(native, /shutdown-for-update|CloseMainWindow|\.Kill\(|\.Rename\(|File\.Move\(|NamedPipeClientStream|SetValue\(/u);
  assert.doesNotMatch(dispatcher, /InspectOwnedMainBRollbackPreflight\(/u);
});

test('Guardian B rollback stage challenge uses separate live worker PID/HMAC, nonreclaimed lock and create-only read-only receipt', async () => {
  const root=new URL('../../native/windows/EquinoxLocal.Guardian/',import.meta.url);
  const native=await fs.readFile(new URL('MainNativeBRollbackAuthority.cs',root),'utf8');
  const dispatcher=await fs.readFile(new URL('Program.cs',root),'utf8');
  const inspector=await fs.readFile(new URL('MainNativeJournalIdentity.cs',root),'utf8');
  const worker=await fs.readFile(new URL('../../src/equinox-local-windows-native-journal-authority-client.ts',import.meta.url),'utf8');
  assert.match(native,/BRollbackProofDomain = "equinox-local-guardian-b-rollback-authority-v1:"/u);
  assert.match(worker,/ROLLBACK_DOMAIN = Buffer.from\("equinox-local-guardian-b-rollback-authority-v1:"/u);
  assert.match(native,/GetProperty\("stage"\)\.GetString\(\) != "rollback_started"/u);
  assert.match(native,/GetProperty\("sequence"\)\.GetInt32\(\) is < 1 or > 6/u);
  assert.match(native,/InspectOwnedNativeWorkerOsArguments\(\)/u);
  assert.match(native,/InspectOwnedNativeWorkerPipeProof\(\)/u);
  assert.match(native,/InspectOwnedMainBRollbackPreflight\(owner.TransactionId, sourceSha\)/u);
  assert.match(native,/\.rollback\.writer-lock/u);
  assert.match(inspector,/name.EndsWith\("\.writer-lock"/u);
  assert.match(native,/FileMode.CreateNew, FileAccess.ReadWrite/u);
  assert.match(native,/FileShare.None, 4096, FileOptions.WriteThrough/u);
  assert.match(native,/GetNamedPipeClientProcessId\(listener.SafePipeHandle, out var clientPid\) \|\| clientPid != owner.Pid/u);
  assert.match(native,/worker.StartTime.ToUniversalTime\(\).Ticks.ToString\(CultureInfo.InvariantCulture\) != owner.Ticks/u);
  assert.match(native,/CryptographicOperations.FixedTimeEquals\(HMACSHA256.HashData\(key.AsSpan\(\), message.AsSpan\(\)\), response\)/u);
  assert.match(native,/CryptographicOperations.ZeroMemory\(key\)/u);
  assert.match(native,/CryptographicOperations.FixedTimeEquals\(digest, SHA256.HashData\(File.ReadAllBytes\(journalPath\)\)\)/u);
  assert.match(native,/CryptographicOperations.FixedTimeEquals\(handoffDigest, HashOwnedWorkerHandoff\(journalRoot, owner.TransactionId\)\)/u);
  assert.match(native,/FileMode.CreateNew, FileAccess.Write/u);
  assert.match(native,/receipt.Flush\(flushToDisk: true\)/u);
  assert.match(native,/native-b-rollback-authority-recorded-no-wpf-mutation/u);
  assert.doesNotMatch(native,/shutdown-for-update|CloseMainWindow|\.Kill\(|File.Move\(|RegisterNative|NamedPipeClientStream/u);
  assert.doesNotMatch(dispatcher,/InspectOwnedNativeBRollbackWorkerAuthority\(/u);
});

test('B rollback pilot requires native rollback owner receipt and exact WPF pipe/exit before durable B quiesce proof', async () => {
  const root = new URL('../../native/windows/EquinoxLocal.Guardian/', import.meta.url);
  const [pilot, authority, dispatcher] = await Promise.all([
    fs.readFile(new URL('MainNativeBRollbackShellQuiesce.cs', root), 'utf8'),
    fs.readFile(new URL('MainNativeBRollbackAuthority.cs', root), 'utf8'),
    fs.readFile(new URL('Program.cs', root), 'utf8'),
  ]);
  assert.match(pilot, /private static void QuiesceOwnedMainBRollbackShell\(OwnedWorkerClaim owner, string journalRoot/u);
  assert.match(pilot, /InspectOwnedMainBRollbackPreflight\(owner.TransactionId, sourceSha\)/u);
  assert.match(pilot, /\.rollback-authority\.json/u);
  assert.match(pilot, /RequireExactKeys\(receipt, \["schemaVersion", "transactionId", "stage", "sequence", "workerPid"/u);
  assert.match(pilot, /GetProperty\("stage"\)\.GetString\(\) != "rollback_started"/u);
  assert.match(pilot, /GetProperty\("guardianPid"\)\.GetInt32\(\) != Environment\.ProcessId/u);
  assert.match(pilot, /GetProperty\("workerStartTimeUtcTicks"\)\.GetString\(\) != owner.Ticks/u);
  assert.match(pilot, /CryptographicOperations.FixedTimeEquals/u);
  assert.match(pilot, /FindSingleOwnedStableShell\(installedExe\)/u);
  assert.match(pilot, /OpenProcessToken\(shell.Handle, TokenQuery/u);
  assert.match(pilot, /ReadWindowsLogonAuthenticationId\(shellToken\)/u);
  assert.match(pilot, /shell.SessionId != Process.GetCurrentProcess\(\).SessionId/u);
  assert.match(pilot, /EquinoxLocal.WindowsShell.Reopen/u);
  assert.match(pilot, /GetNamedPipeServerProcessId\(pipe.SafePipeHandle, out var serverPid\) \|\| serverPid != pid/u);
  assert.match(pilot, /shell.StartTime.ToUniversalTime\(\).Ticks.ToString\(CultureInfo.InvariantCulture\) != ticks/u);
  assert.match(pilot, /GetBytes\("shutdown-for-update\\n"\)/u);
  assert.match(pilot, /shell.WaitForExit\(12000\)/u);
  assert.match(pilot, /FileMode.CreateNew, FileAccess.Write/u);
  assert.match(pilot, /FileShare.None, 4096, FileOptions.WriteThrough/u);
  assert.match(pilot, /output.Flush\(flushToDisk: true\)/u);
  assert.match(pilot, /"b-shell-quiesced-only"/u);
  assert.doesNotMatch(pilot, /\.Kill\(|TerminateProcess|File.Move\(|registerNative|SetValue\(/u);
  assert.doesNotMatch(authority, /QuiesceOwnedMainBRollbackShell\(/u);
  assert.doesNotMatch(dispatcher, /QuiesceOwnedMainBRollbackShell\(/u);
});

test('native B WPF quiesce receipt preserves exact rollback stage and sequence lineage', async () => {
  const root=new URL('../../native/windows/EquinoxLocal.Guardian/', import.meta.url);
  const pilot=await fs.readFile(new URL('MainNativeBRollbackShellQuiesce.cs',root),'utf8');
  assert.match(pilot,/using var rollbackJournal = JsonDocument.Parse\(journalHandle\)/u);
  assert.match(pilot,/journal\.GetProperty\("sequence"\)\.GetInt32\(\) != receipt\.GetProperty\("sequence"\)\.GetInt32\(\)/u);
  assert.match(pilot,/journal\.GetProperty\("stage"\)\.GetString\(\) != "rollback_started"/u);
  assert.match(pilot,/json\.WriteString\("stage", "rollback_started"\)/u);
  assert.match(pilot,/json\.WriteNumber\("sequence", journal\.GetProperty\("sequence"\)\.GetInt32\(\)\)/u);
});

test('native B quiesce pins rollback authority receipt via a read-only non-replaceable Windows handle for entire exit', async () => {
  const root = new URL('../../native/windows/EquinoxLocal.Guardian/', import.meta.url);
  const native = await fs.readFile(new URL('MainNativeBRollbackShellQuiesce.cs', root), 'utf8');
  assert.match(native, /RequireNormalFile\(nativeAuthorityPath\)/u);
  assert.match(native, /using var nativeAuthorityHandle = new FileStream\(nativeAuthorityPath, FileMode\.Open,/u);
  assert.match(native, /FileAccess\.Read, FileShare\.Read\)/u);
  assert.match(native, /nativeAuthorityHandle\.Length is < 2 or > 8192/u);
  assert.match(native, /using var nativeAuthority = JsonDocument\.Parse\(nativeAuthorityHandle\)/u);
  assert.match(native, /using var pipe = new NamedPipeClientStream/u);
  assert.match(native, /shell\.WaitForExit\(12000\)/u);
  assert.doesNotMatch(native, /FileShare\.(?:ReadWrite|Delete)|nativeAuthorityHandle\.Dispose\(\)/u);
});

test('B rollback graceful shutdown pins the original HMAC journal on one Windows read-only OS handle throughout exit', async () => {
  const root = new URL('../../native/windows/EquinoxLocal.Guardian/', import.meta.url);
  const source = await fs.readFile(new URL('MainNativeBRollbackShellQuiesce.cs', root), 'utf8');
  assert.match(source, /RequireNormalFile\(journalPath\)/u);
  assert.match(source, /using var journalHandle = new FileStream\(journalPath, FileMode.Open,/u);
  assert.match(source, /FileAccess.Read, FileShare.Read\)/u);
  assert.match(source, /journalHandle.Length is < 2 or > 8192/u);
  assert.match(source, /using var rollbackJournal = JsonDocument.Parse\(journalHandle\)/u);
  assert.match(source, /CryptographicOperations.FixedTimeEquals\(originalJournalDigest, SHA256.HashData\(journalHandle\)\)/u);
  assert.match(source, /HashPinnedBRollbackJournal\(journalHandle\)/u);
  assert.match(source, /journalHandle.Position = 0/u);
  assert.match(source, /shell.WaitForExit\(12000\)/u);
  assert.doesNotMatch(source, /SHA256.HashData\(File.ReadAllBytes\(journalPath\)\)|journalHandle.Dispose\(\)|FileShare.Delete/u);
});

test('all Guardian native transition record reads validate size and parse on one bounded nonreplaceable OS handle', async () => {
  const root = new URL('../../native/windows/EquinoxLocal.Guardian/', import.meta.url);
  const native = await fs.readFile(new URL('MainNativeJournalIdentity.cs', root), 'utf8');
  const start = native.indexOf('private static JsonDocument ReadOwnedTransitionRecord(string file, int limit)');
  const end = native.indexOf('private static void InspectOwnedNativeTransitionJournal', start);
  assert.ok(start !== -1 && end > start);
  const body = native.slice(start, end);
  assert.match(body, /RequireNormalFile\(file\)/u);
  assert.match(body, /using var handle = new FileStream\(file, FileMode\.Open, FileAccess\.Read, FileShare\.Read\)/u);
  assert.match(body, /handle\.Length is < 2 or > 65536 \|\| handle\.Length > limit/u);
  assert.match(body, /return JsonDocument\.Parse\(handle\)/u);
  assert.doesNotMatch(body, /FileInfo\(|File\.ReadAllBytes\(|FileShare\.(?:Delete|ReadWrite)|FileMode\.OpenOrCreate/u);
});

test("Guardian forward B staging advances an authenticated prepared journal but cannot alter installed WPF or Native Messaging", async () => {
  const root = new URL("../../native/windows/EquinoxLocal.Guardian/", import.meta.url);
  const [program, lease, authority, writer] = await Promise.all([
    "Program.cs", "MainNativeJournalLease.cs", "MainNativeJournalAuthority.cs", "MainNativeStageB.cs",
  ].map((name) => fs.readFile(new URL(name, root), "utf8")));
  assert.match(program, /args\[0\] == "--hold-native-stage-b"/u);
  assert.match(lease, /RecordNativeJournalWorkerAuthority\(owner, root, worker, recordPreparedAbort, recordNativeStaged\)/u);
  assert.match(authority, /if \(recordNativeStaged\) WriteNativeJournalStagedB\(owner, journalPath, journalBytes, digest\)/u);
  for (const requirement of [
    "prepared", "native_staged", "sequence", "targetSha", "targetRuntimeContractSha256",
    "InspectOwnedMainGit(install, target, source, sourceSha)", "native-store.json",
    "runtimeContractSha256", "releaseFingerprint", "FingerprintNativeMainRelease",
    "node.exe", "EquinoxLocal.exe", "equinox-browser-native-host.exe",
    "CryptographicOperations.FixedTimeEquals", "File.Move(temp, journalPath, overwrite: true)",
    "FileMode.CreateNew", "FileOptions.WriteThrough", "nativeBFingerprintSha256",
    "preparedJournalSha256", "journalSha256",
    "using var stagedHandle = new FileStream(journalPath, FileMode.Open, FileAccess.Read, FileShare.Read)",
    "SHA256.HashData(stagedHandle)",
  ]) {
    assert.ok(writer.includes(requirement), "Guardian stage B must bind: " + requirement);
  }
  assert.doesNotMatch(writer, /Process\.Start\(|Kill\(|shutdown-for-update|\.WriteAsync\(|Registry\.(?:CurrentUser|SetValue)|SetValue\(|CopyDirectory|Directory\.Move|File\.Delete|File\.Copy|Programs.*Equinox Local/u);
  assert.match(writer, /"stage", "native_staged"/u);
  assert.match(writer, /"sequence", 1/u);
  assert.match(writer, /native-stage-b-committed-under-lease/u);
  assert.doesNotMatch(writer, /"stage", "(?:switched|healthy|committed|shell_stopped|restarted|rolled_back)"|File.ReadAllBytes\(journalPath\)/u);
});

test('Guardian authenticates one pinned prepared journal OS handle across HMAC and durable authority proof', async () => {
  const root = new URL('../../native/windows/EquinoxLocal.Guardian/', import.meta.url);
  const native = await fs.readFile(new URL('MainNativeJournalAuthority.cs', root), 'utf8');
  const start = native.indexOf('private static void RecordNativeJournalWorkerAuthority(');
  const end = native.indexOf('\n    }', start);
  assert.ok(start !== -1 && end > start);
  const body = native.slice(start);
  assert.match(body, /using var pinnedJournal = new FileStream\(journalPath, FileMode.Open, FileAccess.Read, FileShare.Read\)/u);
  assert.match(body, /pinnedJournal.Length is < 2 or > 8192/u);
  assert.match(body, /using var journal = JsonDocument.Parse\(pinnedJournal\)/u);
  assert.match(body, /pinnedJournal.ReadExactly\(journalBytes\)/u);
  assert.match(body, /CryptographicOperations.FixedTimeEquals\(digest, SHA256.HashData\(pinnedJournal\)\)/u);
  assert.match(body, /pinnedJournal.Dispose\(\);\s*if \(recordNativeStaged\) WriteNativeJournalStagedB\(owner, journalPath, journalBytes, digest\);\s*else WriteNativeJournalPreparedAbort/u);
  assert.doesNotMatch(body, /SHA256.HashData\(File.ReadAllBytes\(journalPath\)\)|var journalBytes = File.ReadAllBytes\(journalPath\)/u);
});

test('Guardian shared native worker handoff digest hashes the same bounded Windows OS file handle', async () => {
  const root=new URL('../../native/windows/EquinoxLocal.Guardian/',import.meta.url);
  const source=await fs.readFile(new URL('MainNativeJournalAuthority.cs',root),'utf8');
  const start=source.indexOf('private static byte[] HashOwnedWorkerHandoff(string journalRoot, string transactionId)');
  const end=source.indexOf('[DllImport(',start);
  assert.ok(start!==-1 && end>start);
  const body=source.slice(start,end);
  assert.match(body,/RequireNormalDirectory\(handoffRoot\)/u);
  assert.match(body,/RequireNormalFile\(path\)/u);
  assert.match(body,/using var handle = new FileStream\(path, FileMode.Open, FileAccess.Read, FileShare.Read\)/u);
  assert.match(body,/handle.Length is < 2 or > 8192/u);
  assert.match(body,/return SHA256.HashData\(handle\)/u);
  assert.doesNotMatch(body,/FileInfo\(|File.ReadAllBytes\(|FileShare.(?:Delete|ReadWrite)/u);
});

test('prepared orphan recovery pins original A pointer and rollback journal through native quarantine', async () => {
  const root = new URL('../../native/windows/EquinoxLocal.Guardian/', import.meta.url);
  const source = await fs.readFile(new URL('MainNativePreparedAbortRecovery.cs',root),'utf8');
  assert.match(source,/RequireNormalFile\(pointerPath\)/u);
  assert.match(source,/using var pointerHandle = new FileStream\(pointerPath, FileMode.Open,/u);
  assert.match(source,/FileAccess.Read, FileShare.Read\)/u);
  assert.match(source,/pointerHandle.Length is < 15 or > 8192/u);
  assert.match(source,/using var pointerReader = new StreamReader\(pointerHandle,/u);
  assert.match(source,/pointerReader.ReadToEnd\(\)/u);
  assert.match(source,/RequireNormalFile\(journalPath\)/u);
  assert.match(source,/using var journalHandle = new FileStream\(journalPath, FileMode.Open,/u);
  assert.match(source,/journalHandle.Length is < 2 or > 8192/u);
  assert.match(source,/using var journal = JsonDocument.Parse\(journalHandle\)/u);
  assert.match(source,/journalHandle.Position = 0/u);
  assert.match(source,/var updatedDigest = SHA256.HashData\(journalHandle\)/u);
  assert.match(source,/File.Move\(lockPath, quarantinedLock\)/u);
  assert.doesNotMatch(source,/new FileInfo\(pointerPath\)|File.ReadAllText\(pointerPath\)|File.ReadAllBytes\(journalPath\)|pointerHandle.Dispose\(\)|journalHandle.Dispose\(\)/u);
});

test('native orphan writer lock is read exactly within 8..512 bytes on its original Windows handle until durable quarantine receipt', async () => {
  const root = new URL('../../native/windows/EquinoxLocal.Guardian/', import.meta.url);
  const source = await fs.readFile(new URL('MainNativePreparedAbortRecovery.cs',root),'utf8');
  assert.match(source, /RequireNormalFile\(lockPath\)/u);
  assert.match(source, /using var lockHandle = new FileStream\(lockPath, FileMode.Open,/u);
  assert.match(source, /FileAccess.Read, FileShare.Read\)/u);
  assert.match(source, /lockHandle.Length is < 8 or > 512/u);
  assert.match(source, /var lockBytes = new byte\[\(int\)lockHandle.Length\]/u);
  assert.match(source, /lockHandle.ReadExactly\(lockBytes\)/u);
  assert.doesNotMatch(source, /File.ReadAllBytes\(lockPath\)|FileShare.Delete/u);
  const receipt = source.indexOf('fd.Flush(flushToDisk: true);');
  const close = source.indexOf('lockHandle.Dispose();');
  const move = source.indexOf('File.Move(lockPath, quarantinedLock);');
  assert.ok(receipt !== -1 && receipt < close && close < move,'Lock remains pinned through evidence; original handle is released before Windows rename');
  assert.match(source, /same-user rename between close/u);
});

test('Guardian unexposed pilot renames orphan lock by original DELETE-capable OS handle with no replace or reparse traversal', async () => {
  const root = new URL('../../native/windows/EquinoxLocal.Guardian/', import.meta.url);
  const source = await fs.readFile(new URL('MainNativeOrphanHandleRename.cs', root),'utf8');
  const recovery = await fs.readFile(new URL('MainNativePreparedAbortRecovery.cs', root),'utf8');
  const dispatcher = await fs.readFile(new URL('Program.cs', root),'utf8');
  assert.match(source,/NativeTransactionPattern.IsMatch\(transactionId\)/u);
  assert.match(source,/Path.Combine\(journalRoot, "\." \+ transactionId \+ "\.writer-lock"\)/u);
  assert.match(source,/Path.Combine\(original.JournalRoot, "\." \+ original.TransactionId \+ "\.quarantined.writer-lock"\)/u);
  assert.match(source,/NativeOrphanGenericRead \| NativeOrphanDelete/u);
  assert.match(source,/NativeOrphanShareRead, 0, NativeOrphanOpenExisting, NativeOrphanOpenReparsePoint/u);
  assert.match(source,/GetFileInformationByHandle/u);
  assert.match(source,/NativeOrphanReparseAttribute \| NativeOrphanDirectoryAttribute/u);
  assert.match(source,/opened.LinkCount != 1/u);
  assert.match(source,/opened.SizeHigh != 0/u);
  assert.match(source,/opened.SizeLow is < 8 or > 512/u);
  assert.match(source,/var stream = new FileStream\(native, FileAccess.Read, 512, isAsync: false\)/u);
  assert.match(source,/stream.Length != opened.SizeLow/u);
  assert.match(source,/SetFileInformationByHandle/u);
  assert.match(source,/NativeOrphanFileRenameInfo = 3/u);
  assert.match(source,/Marshal.WriteInt32\(buffer, 0, 0\)/u);
  assert.match(source,/Marshal.WriteIntPtr\(buffer, 8, IntPtr.Zero\)/u);
  assert.match(source,/Marshal.WriteInt32\(buffer, 16, name.Length\)/u);
  assert.match(source,/private sealed class NativeOrphanPinnedWriterLock : IDisposable/u);
  assert.match(source,/internal FileStream Handle \{ get; \}/u);
  assert.match(source,/internal string JournalRoot \{ get; \}/u);
  assert.match(source,/internal string TransactionId \{ get; \}/u);
  assert.match(source,/return new NativeOrphanPinnedWriterLock\(stream, journalRoot, transactionId\)/u);
  assert.match(source,/RenameNativeOrphanWriterLockPilot\(NativeOrphanPinnedWriterLock original\)/u);
  assert.match(source,/original.Handle.SafeFileHandle.IsClosed/u);
  assert.match(source,/original.Handle.SafeFileHandle.IsInvalid/u);
  assert.match(source,/Path.Combine\(original.JournalRoot, "\." \+ original.TransactionId \+ "\.quarantined.writer-lock"\)/u);
  assert.match(source,/RenameNativeOrphanByHandle\(original.Handle.SafeFileHandle/u);
  assert.doesNotMatch(source,/RenameNativeOrphanWriterLockPilot\(FileStream original/u);
  assert.match(source,/Marshal.FreeHGlobal\(buffer\)/u);
  assert.doesNotMatch(source,/File.Move\(|FileShare.Delete|FileShare.Write|ReplaceIfExists=TRUE/u);
  assert.doesNotMatch(recovery,/OpenNativeOrphanWriterLockPilot\(|RenameNativeOrphanWriterLockPilot\(/u);
  assert.doesNotMatch(dispatcher,/OpenNativeOrphanWriterLockPilot\(|RenameNativeOrphanWriterLockPilot\(/u);
});

test("Windows managed release source mapping refuses drive-qualified paths and NTFS alternate streams", () => {
  for (const unsafe of [
    "C:\\Windows\\system.ini",
    "C:relative.dll",
    "src\\server.js:alternate",
    "src/./server.js",
  ]) {
    assert.throws(() => windowsManagedReleaseDestinationRelative(unsafe), /unsafe/u,
      `A release source path cannot contain a drive, alternate stream or dot segment: ${unsafe}`);
  }
});
