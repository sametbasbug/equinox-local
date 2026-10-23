import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pruneVerifiedMainLargeStorage, pruneDisenrolledWindowsMainLargeStorage } from "../../src/equinox-local-main-storage-retention.js";
import { equinoxLocalToolchainContract } from "../../src/equinox-local-toolchain-contract.js";

const windowsTest = process.platform === "win32" ? test : test.skip;
const A = "a".repeat(40);
const B = "b".repeat(40);

windowsTest("real Windows x64/ARM64 filesystem: verified Main B reclaims all A payloads but never user settings", async (t) => {
  assert.match(process.arch, /^(?:x64|arm64)$/u);
  const target = `win32-${process.arch}`;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-version-gc-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const api = path.win32;
  const tx = api.join(root, "state", "main-update");
  const sourceRoot = api.join(tx, "sources", B);
  const nativeRelease = api.join(tx, "native-store", target, B, "release");
  const contract = equinoxLocalToolchainContract({ runtimeRoot: api.join(root, "runtime"), target });

  for (const dir of [
    api.join(root, "releases", "6.0.2"), api.join(root, "releases", "6.0.3"),
    api.join(root, "releases", "6.0.4"), api.join(root, "releases", "6.0.5"),
    api.join(root, "releases", "6.1.0"),
    api.join(tx, "sources", A), sourceRoot,
    api.join(tx, "native-store", target, A),
    nativeRelease,
    api.join(tx, "staging", "main-" + "1".repeat(32)),
    api.join(tx, "staging", "main-" + "2".repeat(32)),
    api.join(tx, "receipts"), api.join(root, "state", "private"),
    contract.git.root, contract.node.root,
    api.join(contract.toolchainRoot, "git", "1.2.3", target),
    api.join(contract.toolchainRoot, "node", "1.2.3", target),
  ]) await fs.mkdir(dir, { recursive: true });

  await fs.mkdir(api.join(sourceRoot, "src"));
  await fs.writeFile(api.join(sourceRoot, "src", "equinox-local-version.js"),
    'export const EQUINOX_LOCAL_VERSION = "6.1.1";\n');
  const credentials = api.join(root, "state", "private", "user-credentials.json");
  await fs.writeFile(credentials, '{"keep":true}');
  await fs.writeFile(api.join(tx, "receipts", "main-" + "1".repeat(32) + ".json"), '{"status":"succeeded"}');
  const installation = {
    kind: "managed-source", managed: true, platform: "win32",
    installRoot: root, target, mainTransactionRoot: tx, sourceRoot, sourceSha: B,
    releaseDir: nativeRelease,
    gitPath: contract.gitPath, nodePath: contract.nodePath, npmPath: contract.npmPath,
  };
  const processExecutable = api.join(nativeRelease, "runtime", "node", "bin", "node.exe");
  const readSource = async () => ({ sha: B, sourceRoot });
  const readNative = async () => ({ sourceSha: B, target, releaseDir: nativeRelease });
  const params = {
    platform: "win32", installation, processExecutable,
    readSource, readNative, runtimeVersion: "6.1.1",
  };

  await assert.rejects(pruneVerifiedMainLargeStorage({
    ...params, processExecutable: api.join(root, "releases", "6.1.0", "runtime", "node", "bin", "node.exe"),
  }), /Old bootstrap is still executing/u);
  assert.equal((await fs.readdir(api.join(root, "releases"))).length, 5);

  const result = await pruneVerifiedMainLargeStorage(params);
  assert.equal(result.releases.length, 5);
  assert.deepEqual(result.sources, [A]);
  assert.deepEqual(result.native, [A]);
  assert.equal(result.staging.length, 2);
  assert.deepEqual(result.toolchains, ["1.2.3", "1.2.3"]);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(await fs.readdir(api.join(root, "releases")), []);
  assert.deepEqual(await fs.readdir(api.join(tx, "sources")), [B]);
  assert.deepEqual(await fs.readdir(api.join(tx, "native-store", target)), [B]);
  assert.deepEqual(await fs.readdir(api.join(tx, "staging")), []);
  assert.equal(await fs.readFile(credentials, "utf8"), '{"keep":true}');
  assert.equal((await fs.readdir(api.join(tx, "receipts"))).length, 1);
  assert.equal((await fs.stat(contract.git.root)).isDirectory(), true);
  assert.equal((await fs.stat(contract.node.root)).isDirectory(), true);
});

windowsTest("disenrolled signed Stable 6.1.1 safely retires ALL abandoned Main payloads only from healthy B", async (t) => {
  const target = `win32-${process.arch}`;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-stable-retire-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const api = path.win32;
  const tx = api.join(root, "state", "main-update");
  const releaseDir = api.join(root, "releases", "6.1.1");
  const executable = api.join(releaseDir, "runtime", "node", "bin", "node.exe");
  const contract = equinoxLocalToolchainContract({ runtimeRoot: api.join(root, "runtime"), target });
  const privateState = api.join(root, "state", "user-secrets", "key.json");
  const receipt = api.join(tx, "receipts", "historical.json");
  const fixtureDirs = [
    api.dirname(executable),
    api.join(releaseDir, "runtime", "tunnel"),
    api.join(releaseDir, "runtime", "winapp"),
    api.join(tx, "sources", A), api.join(tx, "sources", B),
    api.join(tx, "native-store", target, A), api.join(tx, "native-store", target, B),
    api.join(tx, "staging", "main-" + "5".repeat(32)),
    api.dirname(receipt), api.dirname(privateState),
    api.join(contract.toolchainRoot, "git", contract.git.version),
    api.join(contract.toolchainRoot, "node", contract.node.version),
    api.join(contract.toolchainRoot, "git", "1.2.3"),
    api.join(contract.toolchainRoot, "node", "1.2.3"),
  ];
  for (const item of fixtureDirs) await fs.mkdir(item, { recursive: true });
  const documents = [
    executable, api.join(releaseDir, "runtime", "tunnel", "tunnel-client.exe"),
    api.join(releaseDir, "runtime", "tunnel", "cloudflared.exe"),
    ...["winapp.exe", "libHarfBuzzSharp.dll", "libSkiaSharp.dll"].map((x) =>
      api.join(releaseDir, "runtime", "winapp", x)),
  ];
  for (const item of documents) await fs.writeFile(item, "PRODUCT");
  await fs.writeFile(api.join(releaseDir, "release.json"), JSON.stringify({
    schemaVersion: 1, version: "6.1.1", target,
    nodeVersion: "26.12.1", tunnelClientVersion: "0.0.17", serverEntry: "server.js",
  }));
  await fs.writeFile(privateState, '{"secret":"keep"}');
  await fs.writeFile(receipt, '{"audit":"keep"}');
  await fs.writeFile(api.join(tx, "current-source.conf"),
    `schemaVersion=1\nsourceRoot=${api.join(tx, "sources", B)}\nsha=${B}\n`);
  await fs.writeFile(api.join(tx, "current-native.json"), JSON.stringify({
    schemaVersion: 1, channel: "main", target, sourceSha: A,
    runtimeContractSha256: "f".repeat(64),
  }));
  const pointer = api.join(root, "current-version.json");
  await fs.writeFile(pointer, JSON.stringify({ schemaVersion: 1, version: "6.1.1", target }));
  const installation = {
    kind: "managed", managed: true, selfUpdateSupported: true,
    platform: "win32", arch: process.arch, target, installRoot: root,
    releasesRoot: api.join(root, "releases"), releaseDir, currentPointer: pointer,
    programRoot: api.join(root, "Programs", "Equinox Local"),
    nativeMessagingManifestRoot: api.join(root, "browser", "native-messaging"),
  };
  const expectedLauncher = api.join(releaseDir, "runtime", "browser", "equinox-browser-native-host.exe");
  const base = {
    installation, runtimeVersion: "6.1.1", processExecutable: executable,
    verifyShell: async () => ({
      owned: true, shellExecutable: api.join(installation.programRoot, "EquinoxLocal.exe"),
    }),
    verifyNativeHost: async () => ({ launcherPath: expectedLauncher }),
  };
  const active = api.join(tx, "active.json");
  await fs.writeFile(active, "{}");
  await assert.rejects(pruneDisenrolledWindowsMainLargeStorage(base), /Main install or repair remains active/u);
  await fs.rm(active);
  await assert.rejects(pruneDisenrolledWindowsMainLargeStorage({
    ...base, processExecutable: api.join(tx, "native-store", target, A, "release", "node.exe"),
  }), /older Main worker/u);
  const result = await pruneDisenrolledWindowsMainLargeStorage(base);
  assert.deepEqual(result.sources.sort(), [A, B]);
  assert.deepEqual(result.native.sort(), [A, B]);
  assert.deepEqual(result.staging, ["main-" + "5".repeat(32)]);
  assert.deepEqual(result.toolchains.sort(), ["1.2.3", "1.2.3"]);
  assert.deepEqual(result.pointers.sort(), ["current-native.json", "current-source.conf"]);
  for (const component of [contract.git, contract.node]) {
    assert.equal((await fs.stat(api.join(contract.toolchainRoot, component.component, component.version))).isDirectory(), true);
  }
  await assert.rejects(fs.stat(api.join(tx, "current-source.conf")), { code: "ENOENT" });
  await assert.rejects(fs.stat(api.join(tx, "current-native.json")), { code: "ENOENT" });
  assert.deepEqual(result.pending, []);
  assert.deepEqual(await fs.readdir(api.join(tx, "sources")), []);
  assert.deepEqual(await fs.readdir(api.join(tx, "native-store", target)), []);
  assert.equal(await fs.readFile(privateState, "utf8"), '{"secret":"keep"}');
  assert.equal(await fs.readFile(receipt, "utf8"), '{"audit":"keep"}');
  assert.equal(await fs.readFile(executable, "utf8"), "PRODUCT");
});
