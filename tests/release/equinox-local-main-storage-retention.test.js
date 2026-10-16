import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pruneVerifiedMainLargeStorage } from "../../src/equinox-local-main-storage-retention.js";
import { equinoxLocalToolchainContract } from "../../src/equinox-local-toolchain-contract.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const OK = "main-" + "1".repeat(32);
const FAILED = "main-" + "2".repeat(32);

async function fixture(t) {
  const installRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-gc-")));
  t.after(() => fs.rm(installRoot, { recursive: true, force: true }));
  const tx = path.join(installRoot, "main-update");
  const sourceRoot = path.join(tx, "sources", B);
  const nativeRelease = path.join(tx, "native-store", "darwin-arm64", B, "release");
  for (const dir of [
    path.join(installRoot, "releases", "6.0.5"),
    path.join(installRoot, "releases", "6.1.0"),
    path.join(tx, "sources", A), sourceRoot,
    path.join(tx, "native-store", "darwin-arm64", A),
    nativeRelease, path.join(tx, "staging", OK),
    path.join(tx, "staging", FAILED), path.join(tx, "receipts"),
    path.join(tx, "private"),
  ]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(tx, "receipts", OK + ".json"), JSON.stringify({
    transactionId: OK, status: "succeeded", stage: "healthy",
  }));
  await fs.writeFile(path.join(tx, "receipts", FAILED + ".json"), JSON.stringify({
    transactionId: FAILED, status: "rollback_failed", stage: "rollback_failed",
  }));
  await fs.mkdir(path.join(sourceRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, "src", "equinox-local-version.js"),
    'export const EQUINOX_LOCAL_VERSION = "6.1.1";\n');
  const credentials = path.join(tx, "private", "do-not-touch");
  await fs.writeFile(credentials, "SECRET");
  const installation = {
    kind: "managed-source", managed: true, platform: "darwin",
    target: "darwin-arm64", installRoot,
    mainTransactionRoot: tx, sourceSha: B, sourceRoot, releaseDir: nativeRelease,
  };
  const processExecutable = path.join(nativeRelease, "runtime", "node", "bin", "node");
  const readSource = async () => ({ sha: B, sourceRoot });
  const readNative = async () => ({ sourceSha: B, target: "darwin-arm64", releaseDir: nativeRelease });
  return { tx, installRoot, installation, processExecutable, readSource, readNative, credentials, runtimeVersion: "6.1.1" };
}

test("verified active Main B removes only obsolete large versions and terminal staging", async (t) => {
  const f = await fixture(t);
  const result = await pruneVerifiedMainLargeStorage({ ...f, platform: "darwin" });
  assert.deepEqual(result.releases, ["6.0.5", "6.1.0"]);
  assert.deepEqual(result.sources, [A]);
  assert.deepEqual(result.native, [A]);
  assert.deepEqual(result.staging, [OK, FAILED]);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(await fs.readdir(path.join(f.installRoot, "releases")), []);
  assert.deepEqual(await fs.readdir(path.join(f.tx, "sources")), [B]);
  assert.deepEqual(await fs.readdir(path.join(f.tx, "native-store", "darwin-arm64")), [B]);
  assert.deepEqual(await fs.readdir(path.join(f.tx, "staging")), []);
  assert.equal(await fs.readFile(f.credentials, "utf8"), "SECRET");
  assert.equal((await fs.readdir(path.join(f.tx, "receipts"))).length, 2);
});

test("old Stable runtime or in-flight Main transaction never triggers disk deletions", async (t) => {
  const f = await fixture(t);
  await assert.rejects(pruneVerifiedMainLargeStorage({
    ...f, platform: "darwin", processExecutable: "/tmp/node-from-old-stable",
  }), /Old bootstrap is still executing/u);
  await assert.rejects(pruneVerifiedMainLargeStorage({
    ...f, platform: "darwin", runtimeVersion: "6.1.0",
  }), /Active runtime version is not/u);
  await fs.writeFile(path.join(f.tx, "active.json"), "{}");
  await assert.rejects(pruneVerifiedMainLargeStorage({ ...f, platform: "darwin" }), /active Main update/u);
  assert.deepEqual(await fs.readdir(path.join(f.installRoot, "releases")), ["6.0.5", "6.1.0"]);
});

test("foreign symlink and changed source pointer never authorize sweeping user data", async (t) => {
  const f = await fixture(t);
  const foreign = path.join(f.installRoot, "unowned");
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, "keep"), "SAFE");
  await fs.symlink(foreign, path.join(f.installRoot, "releases", "6.0.1"));
  await assert.rejects(pruneVerifiedMainLargeStorage({
    ...f, platform: "darwin", readSource: async () => ({ sha: A, sourceRoot: f.installation.sourceRoot }),
  }), /pointer identity changed/u);
  const result = await pruneVerifiedMainLargeStorage({ ...f, platform: "darwin" });
  assert.deepEqual(result.releases, ["6.0.5", "6.1.0"]);
  assert.equal(await fs.readFile(path.join(foreign, "keep"), "utf8"), "SAFE");
  assert.equal((await fs.lstat(path.join(f.installRoot, "releases", "6.0.1"))).isSymbolicLink(), true);
});


test("only old product-owned Git and Node distributions are reclaimed; pinned B tools survive", async (t) => {
  const f = await fixture(t);
  const contract = equinoxLocalToolchainContract({
    runtimeRoot: path.join(f.installRoot, "runtime"), target: "darwin-arm64",
  });
  for (const item of [contract.git, contract.node]) {
    const base = path.join(contract.toolchainRoot, item.component);
    const oldVersion = path.join(base, "1.2.3");
    await fs.mkdir(path.join(oldVersion, "darwin-arm64"), { recursive: true });
    await fs.mkdir(item.root, { recursive: true });
    await fs.writeFile(path.join(oldVersion, "darwin-arm64", "old-data"), "large old tool");
    await fs.writeFile(path.join(item.root, "active-data"), "keep");
    await fs.mkdir(path.join(base, "user-data"), { recursive: true });
    await fs.writeFile(path.join(base, "user-data", "owned?"), "protect unrecognized tree");
  }
  Object.assign(f.installation, {
    gitPath: contract.gitPath, nodePath: contract.nodePath, npmPath: contract.npmPath,
  });
  const result = await pruneVerifiedMainLargeStorage({ ...f, platform: "darwin" });
  assert.deepEqual(result.toolchains, ["1.2.3", "1.2.3"]);
  for (const component of [contract.git, contract.node]) {
    await assert.rejects(fs.stat(path.join(contract.toolchainRoot, component.component, "1.2.3")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(component.root, "active-data"), "utf8"), "keep");
    assert.equal(await fs.readFile(path.join(contract.toolchainRoot, component.component, "user-data", "owned?"), "utf8"),
      "protect unrecognized tree");
  }
});
