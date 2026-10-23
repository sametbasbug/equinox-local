import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pruneInactiveManagedStableReleases } from "../../src/equinox-local-release-retention.js";

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-owned-retention-")));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const releasesRoot = path.join(root, "releases");
  await fs.mkdir(releasesRoot);
  for (const version of ["6.0.2", "6.0.3", "6.1.1"]) {
    await fs.mkdir(path.join(releasesRoot, version));
    await fs.writeFile(path.join(releasesRoot, version, "release.json"), version);
  }
  return { installation: { platform: "darwin", installRoot: root, releasesRoot },
    readCurrent: async () => ({ version: "6.1.1", releaseDir: path.join(releasesRoot, "6.1.1") }) };
}

test("successful activation retains only active numbered Stable directory", async (t) => {
  const { installation, readCurrent } = await fixture(t);
  const result = await pruneInactiveManagedStableReleases(installation, { readCurrent });
  assert.deepEqual(result, { active: "6.1.1", deleted: ["6.0.2", "6.0.3"] });
  assert.deepEqual(await fs.readdir(installation.releasesRoot), ["6.1.1"]);
});

test("inactive symlink and foreign files are not recursively removed", async (t) => {
  const { installation, readCurrent } = await fixture(t);
  const foreign = path.join(installation.installRoot, "outside");
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, "secret"), "protected");
  await fs.symlink(foreign, path.join(installation.releasesRoot, "6.0.1"), "dir");
  await fs.writeFile(path.join(installation.releasesRoot, "README"), "not a release");
  const result = await pruneInactiveManagedStableReleases(installation, { readCurrent });
  assert.deepEqual(result.deleted, ["6.0.2", "6.0.3"]);
  assert.equal(await fs.readFile(path.join(foreign, "secret"), "utf8"), "protected");
  assert.equal((await fs.lstat(path.join(installation.releasesRoot, "6.0.1"))).isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(installation.releasesRoot, "README"), "utf8"), "not a release");
});

test("cleanup refuses a moved active pointer without deleting either installed release", async (t) => {
  const { installation } = await fixture(t);
  let reads = 0;
  const readCurrent = async () => {
    reads++;
    const version = reads === 1 ? "6.1.1" : "6.0.2";
    return { version, releaseDir: path.join(installation.releasesRoot, version) };
  };
  await assert.rejects(pruneInactiveManagedStableReleases(installation, { readCurrent }), /moved during cleanup/u);
  assert.deepEqual(await fs.readdir(installation.releasesRoot), ["6.0.2", "6.0.3", "6.1.1"]);
});

test("cleanup refuses foreign root and invalid authenticated pointer", async (t) => {
  const { installation, readCurrent } = await fixture(t);
  await assert.rejects(pruneInactiveManagedStableReleases({
    ...installation, releasesRoot: installation.installRoot,
  }, { readCurrent }), /foreign directory/u);
  await assert.rejects(pruneInactiveManagedStableReleases(installation, {
    readCurrent: async () => ({ version: "6.0.4", releaseDir: "/tmp/other" }),
  }), /cannot verify the active pointer/u);
});

test("cleanup fails closed if authenticated active pointer disappears before a deletion", async (t) => {
  const { installation, readCurrent } = await fixture(t);
  let reads = 0;
  await assert.rejects(
    pruneInactiveManagedStableReleases(installation, {
      readCurrent: async (value) => (++reads === 1 ? readCurrent(value) : null),
    }),
    /moved during cleanup/u,
  );
  assert.deepEqual(await fs.readdir(installation.releasesRoot), ["6.0.2", "6.0.3", "6.1.1"]);
});

test("cleanup refuses a symlinked release root without following its contents", async (t) => {
  const { installation, readCurrent } = await fixture(t);
  const realReleases = path.join(installation.installRoot, "releases-real");
  await fs.rename(installation.releasesRoot, realReleases);
  await fs.symlink(realReleases, installation.releasesRoot, "dir");
  await assert.rejects(
    pruneInactiveManagedStableReleases(installation, { readCurrent }),
    /canonical normal directory/u,
  );
  assert.deepEqual(await fs.readdir(realReleases), ["6.0.2", "6.0.3", "6.1.1"]);
});

test("Windows retention path comparison is case-insensitive but refuses a foreign sibling root", async () => {
  const installRoot = String.raw`C:\Program Files\Equinox Local`;
  const releasesRoot = String.raw`c:\program files\equinox local\releases`;
  const activeVersion = "6.1.1";
  const deleted = [];
  const directoryStat = { isDirectory: () => true, isSymbolicLink: () => false };
  const fsImpl = {
    lstat: async () => directoryStat,
    realpath: async (value) => value,
    readdir: async () => ["6.1.1", "6.0.2"].map((name) => ({
      name, isDirectory: () => true, isSymbolicLink: () => false,
    })),
    rm: async (target) => { deleted.push(target); },
  };
  const readCurrent = async () => ({
    version: activeVersion,
    releaseDir: String.raw`C:\PROGRAM FILES\EQUINOX LOCAL\RELEASES\6.1.1`,
  });
  const installation = { platform: "win32", installRoot, releasesRoot };
  const result = await pruneInactiveManagedStableReleases(installation, { fsImpl, readCurrent });
  assert.deepEqual(result, { active: activeVersion, deleted: ["6.0.2"] });
  assert.deepEqual(deleted, [String.raw`c:\program files\equinox local\releases\6.0.2`]);

  await assert.rejects(
    pruneInactiveManagedStableReleases({
      ...installation, releasesRoot: String.raw`C:\Program Files\Equinox Local\releases-sibling`,
    }, { fsImpl, readCurrent }),
    /foreign directory/u,
  );
  assert.equal(deleted.length, 1, "foreign release roots must never delete anything");
});
