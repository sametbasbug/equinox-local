import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  installManagedEquinoxRelease,
  validateFirstInstallRelease,
} from "../../src/equinox-local-first-install.js";

const TARGET = "darwin-arm64";

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function createFixture(version = "4.2.0") {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-first-install-"));
  const installRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local");
  const stageRoot = path.join(installRoot, "staging", "fixture");
  const releaseDir = path.join(stageRoot, "release");
  await fs.mkdir(path.join(releaseDir, "runtime", "node", "bin"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(releaseDir, "runtime", "tunnel"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(releaseDir, "release.json"), `${JSON.stringify({
    schemaVersion: 1,
    version,
    target: TARGET,
    nodeVersion: "24.19.0",
    tunnelClientVersion: "0.0.12",
    serverEntry: "server.js",
  })}\n`, { mode: 0o600 });
  for (const relative of [
    path.join("runtime", "node", "bin", "node"),
    path.join("runtime", "tunnel", "tunnel-client"),
    path.join("runtime", "tunnel", "cloudflared"),
  ]) {
    await fs.writeFile(path.join(releaseDir, relative), "fixture\n", { mode: 0o700 });
  }
  for (const relative of [
    "server.js",
    "equinox-local-bootstrap.js",
    "equinox-local-supervisor.js",
    "equinox-local-first-install.js",
  ]) {
    await fs.writeFile(path.join(releaseDir, relative), "// fixture\n", { mode: 0o600 });
  }
  return { homeDir, installRoot, releaseDir, version };
}

test("first-install release validation requires exact target metadata and bundled runtime", async () => {
  const fixture = await createFixture();
  try {
    const result = await validateFirstInstallRelease(fixture.releaseDir, { target: TARGET });
    assert.equal(result.version, "4.2.0");
    assert.equal(result.target, TARGET);
    await fs.writeFile(path.join(fixture.releaseDir, "release.json"), `${JSON.stringify({
      schemaVersion: 1,
      version: "4.2.0",
      target: "darwin-x64",
      nodeVersion: "24.19.0",
      tunnelClientVersion: "0.0.12",
      serverEntry: "server.js",
    })}\n`);
    await assert.rejects(
      validateFirstInstallRelease(fixture.releaseDir, { target: TARGET }),
      /invalid for darwin-arm64/u,
    );
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("first-install release validation rejects symlinks anywhere in the extracted tree", async () => {
  const fixture = await createFixture();
  try {
    await fs.symlink("server.js", path.join(fixture.releaseDir, "linked-server.js"));
    await assert.rejects(
      validateFirstInstallRelease(fixture.releaseDir, { target: TARGET }),
      /may not contain symbolic links/u,
    );
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("first install promotes the verified release, bootstraps the user and loads LaunchAgent without sudo", async () => {
  const fixture = await createFixture();
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const execCalls = [];
  const waited = [];
  try {
    const result = await installManagedEquinoxRelease({
      stagedReleaseDir: fixture.releaseDir,
      homeDir: fixture.homeDir,
      uid,
      platform: "darwin",
      target: TARGET,
      readCurrentImpl: async () => null,
      bootstrapImpl: async () => ({
        configCreated: true,
        controlCenterUrl: "http://127.0.0.1:24891/",
      }),
      execFileImpl: async (command, args) => {
        execCalls.push([command, args]);
        return { stdout: "", stderr: "" };
      },
      waitForVersionImpl: async (version) => { waited.push(version); return true; },
    });
    assert.equal(result.status, "installed");
    assert.equal(result.version, "4.2.0");
    const targetRelease = path.join(fixture.installRoot, "releases", "4.2.0");
    assert.equal(await exists(targetRelease), true);
    assert.equal(await fs.readlink(path.join(fixture.installRoot, "current")), "releases/4.2.0");
    assert.deepEqual(waited, ["4.2.0"]);
    assert.equal(execCalls.some(([command, args]) => command === "/bin/launchctl" && args[0] === "bootstrap"), true);
    assert.equal(execCalls.some(([command]) => /sudo/u.test(command)), false);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("first installer refuses root and never downgrades an existing managed release", async () => {
  const fixture = await createFixture("4.2.0");
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  try {
    await assert.rejects(
      installManagedEquinoxRelease({
        stagedReleaseDir: fixture.releaseDir,
        homeDir: fixture.homeDir,
        uid: 0,
        platform: "darwin",
        target: TARGET,
      }),
      /sudo or as root/u,
    );
    const result = await installManagedEquinoxRelease({
      stagedReleaseDir: fixture.releaseDir,
      homeDir: fixture.homeDir,
      uid,
      platform: "darwin",
      target: TARGET,
      readCurrentImpl: async () => ({
        version: "5.0.0",
        releaseDir: path.join(fixture.installRoot, "releases", "5.0.0"),
      }),
      bootstrapImpl: async () => { throw new Error("bootstrap must not run"); },
    });
    assert.equal(result.status, "newer-installed");
    assert.equal(result.version, "5.0.0");
    assert.equal(result.requestedVersion, "4.2.0");
    assert.equal(await exists(path.join(fixture.installRoot, "releases", "4.2.0")), false);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("installing over an older managed release delegates activation to the rollback-capable updater path", async () => {
  const fixture = await createFixture("4.2.0");
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const activations = [];
  let bootstrapCount = 0;
  try {
    const oldRelease = path.join(fixture.installRoot, "releases", "4.1.0");
    await fs.mkdir(oldRelease, { recursive: true, mode: 0o700 });
    const result = await installManagedEquinoxRelease({
      stagedReleaseDir: fixture.releaseDir,
      homeDir: fixture.homeDir,
      uid,
      platform: "darwin",
      target: TARGET,
      readCurrentImpl: async () => ({ version: "4.1.0", releaseDir: oldRelease }),
      bootstrapImpl: async () => {
        bootstrapCount += 1;
        return { configCreated: false, controlCenterUrl: "http://127.0.0.1:24891/" };
      },
      activateImpl: async ({ installation, targetVersion }) => {
        activations.push({ installation, targetVersion });
        return { status: "activated", version: targetVersion, previousVersion: "4.1.0" };
      },
    });
    assert.equal(result.status, "activated");
    assert.equal(result.previousVersion, "4.1.0");
    assert.equal(bootstrapCount, 2);
    assert.equal(activations.length, 1);
    assert.equal(activations[0].targetVersion, "4.2.0");
    assert.equal(await exists(path.join(fixture.installRoot, "releases", "4.2.0")), true);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});
