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
  assert.equal(assertWindowsBatchQuotedPath("D:\\a\\equinox-local\\native\\windows\\job-object.cpp"), "D:\\a\\equinox-local\\native\\windows\\job-object.cpp");
  for (const value of [
    `${safe}" & whoami & rem \"`, `${safe}%USERNAME%`, `${safe}!USERNAME!`, `${safe}&echo injected`,
    `${safe}|echo injected`, `${safe}^&echo`, `${safe}\r\necho injected`, `${safe}<input`, `${safe}>output`,
    "C:relative\\vcvars64.bat", "\\\\server\\share\\vcvars64.bat", "", null,
  ]) {
    assert.throws(() => assertWindowsBatchQuotedPath(value), /unsafe CMD characters/u);
  }
});
