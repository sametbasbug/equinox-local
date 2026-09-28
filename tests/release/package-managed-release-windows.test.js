import assert from "node:assert/strict";
import test from "node:test";

import { packageManagedEquinoxWindowsRelease, windowsManagedPackageContract, windowsManagedReleaseDestinationRelative } from "../../scripts/release/package-managed-release-windows.mjs";

test("Windows managed package contract is x64 ZIP with versioned shell payload and lifecycle helpers", () => {
  const contract = windowsManagedPackageContract();
  assert.equal(contract.target, "win32-x64");
  assert.equal(contract.artifactSuffix, "win32-x64.zip");
  assert.deepEqual(contract.extraReleaseFiles, [
    "src/equinox-local-windows-job-object.ps1",
    "src/equinox-local-windows-process-gate.ps1",
  ]);
  assert.deepEqual(contract.requiredShellFiles, [
    "EquinoxLocal.exe", "coreclr.dll", "hostfxr.dll", "Microsoft.Web.WebView2.Core.dll",
  ]);
});


test("Windows release source mapping is separator-independent and flattens src", () => {
  assert.equal(windowsManagedReleaseDestinationRelative("src/server.js"), "server.js");
  assert.equal(windowsManagedReleaseDestinationRelative("src\\server.js"), "server.js");
  assert.equal(windowsManagedReleaseDestinationRelative("package.json"), "package.json");
  assert.throws(() => windowsManagedReleaseDestinationRelative("../server.js"), /unsafe/u);
});

test("Windows managed package builder fails closed off win32-x64", async () => {
  if (process.platform === "win32" && process.arch === "x64") return;
  await assert.rejects(packageManagedEquinoxWindowsRelease(), /requires win32-x64/u);
});
