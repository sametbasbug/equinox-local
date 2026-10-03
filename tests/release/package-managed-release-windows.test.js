import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { packageManagedEquinoxWindowsRelease, windowsManagedPackageContract, windowsManagedReleaseDestinationRelative } from "../../scripts/release/package-managed-release-windows.mjs";

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
    "src/equinox-local-windows-job-object.ps1",
    "src/equinox-local-windows-private-state.ps1",
    "src/equinox-local-windows-process-gate.ps1",
    "src/equinox-local-windows-release-zip.ps1",
  ]);
  assert.deepEqual(arm64.requiredShellFiles, [
    "EquinoxLocal.exe", "coreclr.dll", "hostfxr.dll", "Microsoft.Web.WebView2.Core.dll",
  ]);
  assert.throws(() => windowsManagedPackageContract({ target: "win32-ia32" }), /Unsupported Windows managed release target/u);
});


test("Windows desktop lifecycle helper is a fixed Win32 boundary", async () => {
  const helper = await fs.readFile(new URL("../../src/equinox-local-windows-desktop.ps1", import.meta.url), "utf8");
  assert.match(helper, /ValidateSet\('AppList','AppLaunch','AppQuit','AppRelaunch','AppFocus','WindowFocus','WindowClose','WindowMinimize','WindowRestore','WindowMaximize','WindowMove','WindowResize','WindowSetBounds'\)/u);
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
  assert.match(helper, /ZipArchive\]\.Assembly\.Location/u);
  assert.match(helper, /ZipFile\]\.Assembly\.Location/u);
  assert.match(helper, /-ReferencedAssemblies @\(\$CompressionAssembly, \$CompressionFileSystemAssembly\)/u);
});

test("Windows managed package builder requires a native x64/ARM64 host-target match", async () => {
  if (process.platform === "win32" && ["x64", "arm64"].includes(process.arch)) return;
  await assert.rejects(packageManagedEquinoxWindowsRelease(), /requires a native win32-x64 or win32-arm64 host\/target match/u);
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
  assert.match(source, /0x8664/u);
  assert.match(source, /0xaa64/u);
  assert.match(source, /architecture mismatch/u);
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
