import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { equinoxLocalReleaseRuntimeContract } from "../../src/equinox-local-release-runtime-contract.js";

test("Darwin release runtime contract preserves bundled Peekaboo policy", () => {
  const historical = equinoxLocalReleaseRuntimeContract({ target: "darwin-arm64", version: "4.3.1" });
  assert.equal(historical.bundledPeekaboo, false);
  assert.equal(historical.runtimeExecutables.includes(path.join("runtime", "peekaboo", "peekaboo")), false);

  const modern = equinoxLocalReleaseRuntimeContract({ target: "darwin-x64", version: "5.2.1" });
  assert.equal(modern.executableModeRequired, true);
  assert.equal(modern.bundledPeekaboo, true);
  assert.equal(modern.runtimeExecutables.includes(path.join("runtime", "node", "bin", "node")), true);
  assert.equal(modern.runtimeExecutables.includes(path.join("runtime", "peekaboo", "peekaboo")), true);
  assert.equal(modern.nativeAppKind, "macos-app");
});

test("Windows x64 5.2.1 release runtime bundles native winapp while excluding Peekaboo", () => {
  const contract = equinoxLocalReleaseRuntimeContract({ target: "win32-x64", version: "5.2.1" });
  assert.equal(contract.platform, "win32");
  assert.equal(contract.executableModeRequired, false);
  assert.equal(contract.bundledPeekaboo, false);
  assert.deepEqual(contract.runtimeExecutables, [
    path.join("runtime", "node", "bin", "node.exe"),
    path.join("runtime", "tunnel", "tunnel-client.exe"),
    path.join("runtime", "tunnel", "cloudflared.exe"),
    path.join("runtime", "browser", "equinox-browser-native-host.exe"),
    path.join("runtime", "job", "equinox-local-job-object-helper.exe"),
    path.join("runtime", "winapp", "winapp.exe"),
    path.join("runtime", "winapp", "libHarfBuzzSharp.dll"),
    path.join("runtime", "winapp", "libSkiaSharp.dll"),
  ]);
  assert.equal(contract.bundledWinapp, true);
  assert.equal(contract.runtimeDocuments.includes(path.join("runtime", "winapp", "LICENSE")), true);
  assert.equal(contract.runtimeExecutables.some((entry) => /peekaboo/iu.test(entry)), false);
  assert.equal(contract.runtimeDocuments.some((entry) => /peekaboo/iu.test(entry)), false);
  assert.equal(contract.requiredReleaseFiles.includes("equinox-local-windows-desktop.ps1"), true);
  assert.equal(contract.nativeJobObjectHelper, true);
  assert.equal(contract.nodeRuntimeGate, true);
  assert.equal(contract.requiredReleaseFiles.includes("equinox-local-windows-job-object.ps1"), false);
  assert.equal(contract.requiredReleaseFiles.includes("equinox-local-windows-process-gate.ps1"), true);
  assert.equal(contract.requiredReleaseFiles.includes("equinox-local-windows-runtime-gate.mjs"), true);
  assert.equal(contract.nativeAppKind, "windows-shell");
  assert.deepEqual(contract.nativeShellFiles.map((value) => value.replaceAll("\\", "/")), [
    "runtime/shell/EquinoxLocal.exe",
    "runtime/shell/coreclr.dll",
    "runtime/shell/hostfxr.dll",
    "runtime/shell/Microsoft.Web.WebView2.Core.dll",
  ]);
});

test("Windows ARM64 release runtime uses the same native Windows shape with exact target binding", () => {
  const contract = equinoxLocalReleaseRuntimeContract({ target: "win32-arm64", version: "5.2.1" });
  assert.equal(contract.target, "win32-arm64");
  assert.equal(contract.platform, "win32");
  assert.equal(contract.executableModeRequired, false);
  assert.equal(contract.bundledPeekaboo, false);
  assert.equal(contract.bundledWinapp, true);
  assert.equal(contract.runtimeExecutables.includes(path.join("runtime", "winapp", "winapp.exe")), true);
  assert.equal(contract.nativeAppKind, "windows-shell");
  assert.equal(contract.runtimeExecutables.includes(path.join("runtime", "node", "bin", "node.exe")), true);
  assert.equal(contract.runtimeExecutables.includes(path.join("runtime", "browser", "equinox-browser-native-host.exe")), true);
  assert.equal(contract.runtimeExecutables.includes(path.join("runtime", "job", "equinox-local-job-object-helper.exe")), true);
  assert.equal(contract.nativeShellFiles.includes(path.join("runtime", "shell", "EquinoxLocal.exe")), true);
});


test("Windows 5.2.0 historical runtime remains valid without winapp", () => {
  const contract = equinoxLocalReleaseRuntimeContract({ target: "win32-x64", version: "5.2.0" });
  assert.equal(contract.bundledWinapp, false);
  assert.equal(contract.nativeJobObjectHelper, false);
  assert.equal(contract.nodeRuntimeGate, false);
  assert.equal(contract.requiredReleaseFiles.includes("equinox-local-windows-runtime-gate.mjs"), false);
  assert.equal(contract.runtimeExecutables.some((entry) => /job-object-helper/iu.test(entry)), false);
  assert.equal(contract.requiredReleaseFiles.includes("equinox-local-windows-job-object.ps1"), true);
  assert.equal(contract.runtimeExecutables.some((entry) => /winapp/iu.test(entry)), false);
  assert.equal(contract.runtimeDocuments.some((entry) => /winapp/iu.test(entry)), false);
});
