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

test("Windows x64 release runtime contract uses native executable names and excludes Peekaboo", () => {
  const contract = equinoxLocalReleaseRuntimeContract({ target: "win32-x64", version: "5.2.1" });
  assert.equal(contract.platform, "win32");
  assert.equal(contract.executableModeRequired, false);
  assert.equal(contract.bundledPeekaboo, false);
  assert.deepEqual(contract.runtimeExecutables, [
    path.join("runtime", "node", "bin", "node.exe"),
    path.join("runtime", "tunnel", "tunnel-client.exe"),
    path.join("runtime", "tunnel", "cloudflared.exe"),
    path.join("runtime", "browser", "equinox-browser-native-host.exe"),
  ]);
  assert.equal(contract.runtimeExecutables.some((entry) => /peekaboo/iu.test(entry)), false);
  assert.equal(contract.runtimeDocuments.some((entry) => /peekaboo/iu.test(entry)), false);
  assert.equal(contract.requiredReleaseFiles.includes("equinox-local-windows-job-object.ps1"), true);
  assert.equal(contract.requiredReleaseFiles.includes("equinox-local-windows-process-gate.ps1"), true);
  assert.equal(contract.nativeAppKind, "windows-shell");
});

test("Windows ARM64 release runtime remains fail-closed until W8", () => {
  assert.throws(
    () => equinoxLocalReleaseRuntimeContract({ target: "win32-arm64", version: "5.2.1" }),
    /not implemented for win32-arm64/u,
  );
});
