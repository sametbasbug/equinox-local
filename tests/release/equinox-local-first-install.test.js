import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  equinoxLocalFirstInstallHealthBudget,
  installManagedEquinoxRelease,
  synchronizeFreshWindowsShell,
  validateFirstInstallRelease,
} from "../../src/equinox-local-first-install.js";
import { equinoxLocalReleaseRuntimeContract } from "../../src/equinox-local-release-runtime-contract.js";
import {
  readWindowsNativeMessagingRegistryValue,
  unregisterWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
} from "../../src/equinox-browser-windows-native-messaging.js";

const TARGET = "darwin-arm64";

test("first-install CLI help explains Stable default and explicit fresh or existing Main choice", () => {
  const help = execFileSync(process.execPath, [fileURLToPath(new URL("../../src/equinox-local-first-install.js", import.meta.url)), "--help"], { encoding: "utf8" });
  assert.match(help, /Stable \(default\)/u);
  assert.match(help, /--enroll-existing-main/u);
  assert.match(help, /fresh or same-version/u);
});

test("Windows first-install enrollment uses durable release-local helper paths after staging promotion", async () => {
  const source = await fs.readFile(new URL("../../src/equinox-local-first-install.js", import.meta.url), "utf8");
  assert.match(source, /installation\.releaseDir, "equinox-local-windows-release-zip\.ps1"/u);
  assert.match(source, /installation\.releaseDir, "equinox-local-windows-private-state\.ps1"/u);
});

test("first-install health budget gives both Windows architectures bounded cold-start headroom", () => {
  assert.deepEqual(equinoxLocalFirstInstallHealthBudget({ platform: "darwin", arch: "arm64" }), { attempts: 120, delayMs: 500 });
  assert.deepEqual(equinoxLocalFirstInstallHealthBudget({ platform: "win32", arch: "x64" }), { attempts: 180, delayMs: 500 });
  assert.deepEqual(equinoxLocalFirstInstallHealthBudget({ platform: "win32", arch: "arm64" }), { attempts: 180, delayMs: 500 });
});

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
  await fs.mkdir(path.join(releaseDir, "runtime", "peekaboo"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(releaseDir, "runtime", "app"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(releaseDir, "release.json"), `${JSON.stringify({
    schemaVersion: 1,
    version,
    target: TARGET,
    nodeVersion: "24.19.0",
    tunnelClientVersion: "0.0.12",
    nativeAppShellVersion: 1,
    serverEntry: "server.js",
  })}\n`, { mode: 0o600 });
  for (const relative of [
    path.join("runtime", "node", "bin", "node"),
    path.join("runtime", "tunnel", "tunnel-client"),
    path.join("runtime", "tunnel", "cloudflared"),
    path.join("runtime", "peekaboo", "peekaboo"),
    path.join("runtime", "peekaboo", "libswiftCompatibilitySpan.dylib"),
    path.join("runtime", "app", "applet"),
  ]) {
    await fs.writeFile(path.join(releaseDir, relative), "fixture\n", { mode: 0o700 });
  }
  for (const name of ["LICENSE", "README.md", "VERSION"]) {
    await fs.writeFile(path.join(releaseDir, "runtime", "peekaboo", name), name === "VERSION" ? "4.3.0\n" : "fixture\n", { mode: 0o600 });
  }
  await fs.writeFile(path.join(releaseDir, "runtime", "tunnel", "LICENSE"), "fixture tunnel license\n", { mode: 0o600 });
  await fs.writeFile(path.join(releaseDir, "runtime", "tunnel", "NOTICE"), "fixture tunnel notice\n", { mode: 0o600 });
  await fs.writeFile(path.join(releaseDir, "runtime", "app", "EquinoxLocal.png"), "fixture\n", { mode: 0o600 });
  await fs.writeFile(path.join(releaseDir, "runtime", "app", "native-app.json"), "{}\n", { mode: 0o600 });
  for (const relative of [
    "server.js",
    "equinox-local-bootstrap.js",
    "equinox-local-supervisor.js",
    "equinox-local-first-install.js",
    "equinox-local-onboarding.js",
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
    assert.equal(result.tree.entryCount, 25);
    await fs.writeFile(path.join(fixture.releaseDir, "release.json"), `${JSON.stringify({
      schemaVersion: 1,
      version: "4.2.0",
      target: "darwin-x64",
      nodeVersion: "24.19.0",
      tunnelClientVersion: "0.0.12",
      nativeAppShellVersion: 1,
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


test("first-install release validation accepts exact source provenance while retaining legacy Stable compatibility", async () => {
  const fixture = await createFixture();
  try {
    const metadataPath = path.join(fixture.releaseDir, "release.json");
    const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
    const sourceSha = "b".repeat(40);
    await fs.writeFile(metadataPath, `${JSON.stringify({ ...metadata, sourceSha })}\n`);
    const current = await validateFirstInstallRelease(fixture.releaseDir, { target: TARGET });
    assert.equal(current.metadata.sourceSha, sourceSha);

    await fs.writeFile(metadataPath, `${JSON.stringify({ ...metadata, sourceSha: "bad" })}\n`);
    await assert.rejects(
      validateFirstInstallRelease(fixture.releaseDir, { target: TARGET }),
      /metadata is invalid/u,
    );

    await fs.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`);
    const legacy = await validateFirstInstallRelease(fixture.releaseDir, { target: TARGET });
    assert.equal(legacy.metadata.sourceSha, undefined);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("Windows x64 first-install release validation accepts native runtime names without Peekaboo", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-first-install-windows-contract-"));
  const releaseDir = path.join(root, "release");
  try {
    await fs.mkdir(releaseDir, { recursive: true });
    await fs.writeFile(path.join(releaseDir, "release.json"), `${JSON.stringify({
      schemaVersion: 1,
      version: "5.2.1",
      target: "win32-x64",
      nodeVersion: "26.10.0",
      tunnelClientVersion: "0.0.15",
      serverEntry: "server.js",
    })}\n`);
    const contract = equinoxLocalReleaseRuntimeContract({ target: "win32-x64", version: "5.2.1" });
    const fixtureFiles = new Set([
      ...contract.runtimeExecutables,
      ...contract.runtimeDocuments,
      ...contract.requiredReleaseFiles,
      ...contract.nativeShellFiles,
    ]);
    for (const relative of fixtureFiles) {
      await fs.mkdir(path.dirname(path.join(releaseDir, relative)), { recursive: true });
      await fs.writeFile(path.join(releaseDir, relative), "fixture\n");
    }
    const result = await validateFirstInstallRelease(releaseDir, { target: "win32-x64" });
    assert.equal(result.target, "win32-x64");
    assert.equal(result.version, "5.2.1");
    await assert.rejects(fs.lstat(path.join(releaseDir, "runtime", "peekaboo")), /ENOENT/u);

    const shellExecutable = path.join(releaseDir, "runtime", "shell", "EquinoxLocal.exe");
    await fs.rm(shellExecutable);
    await assert.rejects(
      validateFirstInstallRelease(releaseDir, { target: "win32-x64" }),
      /EquinoxLocal\.exe|Native shell/u,
      "Windows release validation must reject a missing versioned native shell payload",
    );
    await fs.writeFile(shellExecutable, "fixture\n");

    await fs.rm(path.join(releaseDir, "runtime", "browser", "equinox-browser-native-host.exe"));
    await assert.rejects(
      validateFirstInstallRelease(releaseDir, { target: "win32-x64" }),
      /equinox-browser-native-host\.exe/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
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
    assert.equal(execCalls.some(([command, args]) => command === "/bin/launchctl" && args[0] === "kickstart" && args.includes("-k")), false);
    assert.equal(execCalls.some(([command]) => /sudo/u.test(command)), false);
    const onboardingStatePath = path.join(fixture.installRoot, "onboarding-state.json");
    assert.equal(await exists(onboardingStatePath), true);
    assert.deepEqual(JSON.parse(await fs.readFile(onboardingStatePath, "utf8")), {
      version: 1,
      firstAgentCommandAt: null,
      completedAt: null,
    });
    assert.equal((await fs.lstat(onboardingStatePath)).mode & 0o077, 0);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("fresh source-provenance installation defaults to Stable without Main enrollment", async () => {
  const fixture = await createFixture("5.2.1");
  const metadataPath = path.join(fixture.releaseDir, "release.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  await fs.writeFile(metadataPath, `${JSON.stringify({ ...metadata, sourceSha: "c".repeat(40) })}\n`);
  const events = [];
  try {
    const result = await installManagedEquinoxRelease({
      stagedReleaseDir: fixture.releaseDir, homeDir: fixture.homeDir,
      uid: process.getuid?.() ?? 501, platform: "darwin", target: TARGET,
      readCurrentImpl: async () => null,
      bootstrapImpl: async () => ({ configCreated: true }),
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
      waitForVersionImpl: async () => { events.push("stable-health"); },
      enrollManagedSourceImpl: async () => { events.push("enroll"); return { bootstrapSha: "c".repeat(40) }; },
      waitForManagedSourceImpl: async () => { events.push("main-health"); },
    });
    assert.deepEqual(events, ["stable-health"]);
    assert.equal(result.managedSourceSha, null);
    await assert.rejects(fs.lstat(path.join(fixture.installRoot, "state", "main-update", "install.json")), { code: "ENOENT" });
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});

test("fresh explicit Main choice rejects missing source provenance before activation", async () => {
  const fixture = await createFixture("5.2.1");
  let mutations = 0;
  try {
    await assert.rejects(installManagedEquinoxRelease({
      stagedReleaseDir: fixture.releaseDir, homeDir: fixture.homeDir,
      uid: process.getuid?.() ?? 501, platform: "darwin", target: TARGET,
      allowExistingStableToMainMigration: true,
      readCurrentImpl: async () => null,
      bootstrapImpl: async () => { mutations++; return {}; },
      execFileImpl: async () => { mutations++; return { stdout: "", stderr: "" }; },
      waitForVersionImpl: async () => { mutations++; },
    }), /Main enrollment requires exact source provenance/u);
    assert.equal(mutations, 0);
    assert.equal(await exists(path.join(fixture.installRoot, "current")), false);
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});

test("fresh source-provenance install stays Stable-first, then enrolls and verifies exact managed-source SHA", async () => {
  const fixture = await createFixture("5.2.1");
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const sourceSha = "c".repeat(40);
  const metadataPath = path.join(fixture.releaseDir, "release.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  await fs.writeFile(metadataPath, `${JSON.stringify({ ...metadata, sourceSha })}\n`);
  const events = [];
  try {
    const result = await installManagedEquinoxRelease({
      stagedReleaseDir: fixture.releaseDir,
      homeDir: fixture.homeDir,
      uid,
      platform: "darwin",
      target: TARGET,
      readCurrentImpl: async () => null,
      bootstrapImpl: async () => ({ configCreated: true, controlCenterUrl: "http://127.0.0.1:24891/" }),
      execFileImpl: async (command, args) => { events.push(["exec", command, args[0]]); return { stdout: "", stderr: "" }; },
      waitForVersionImpl: async (version, budget) => { events.push(["stable-health", version, budget]); return true; },
      allowExistingStableToMainMigration: true,
      enrollManagedSourceImpl: async (value) => { events.push(["enroll", value.bootstrapSha, value.target]); return { status: "enrolled", bootstrapSha: value.bootstrapSha }; },
      waitForManagedSourceImpl: async (version, sha, budget) => { events.push(["source-health", version, sha, budget]); return true; },
    });
    assert.equal(result.status, "installed");
    assert.equal(result.managedSourceSha, sourceSha);
    const stableHealth = events.findIndex((event) => event[0] === "stable-health");
    const enrollment = events.findIndex((event) => event[0] === "enroll");
    const exactHealth = events.findIndex((event) => event[0] === "source-health");
    assert.equal(stableHealth >= 0 && enrollment > stableHealth && exactHealth > enrollment, true);
    assert.deepEqual(events[enrollment].slice(1), [sourceSha, TARGET]);
    assert.deepEqual(events[exactHealth].slice(1), ["5.2.1", sourceSha, { attempts: 120, delayMs: 500 }]);
    assert.equal(events.filter((event) => event[0] === "exec" && event[1] === "/bin/launchctl" && event[2] === "bootstrap").length, 2);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("managed-source health failure rolls identity back and restores healthy Stable runtime", async () => {
  const fixture = await createFixture("5.2.1");
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const sourceSha = "d".repeat(40);
  const metadataPath = path.join(fixture.releaseDir, "release.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  await fs.writeFile(metadataPath, `${JSON.stringify({ ...metadata, sourceSha })}\n`);
  const transactionRoot = path.join(fixture.installRoot, "state", "main-update");
  const installStampPath = path.join(transactionRoot, "install.json");
  const sourcePointerPath = path.join(transactionRoot, "current-source.conf");
  const events = [];
  try {
    await assert.rejects(
      installManagedEquinoxRelease({
        stagedReleaseDir: fixture.releaseDir,
        homeDir: fixture.homeDir,
        uid,
        platform: "darwin",
        target: TARGET,
        readCurrentImpl: async () => null,
        bootstrapImpl: async () => ({ configCreated: true, controlCenterUrl: "http://127.0.0.1:24891/" }),
        execFileImpl: async (command, args) => { events.push(["exec", command, args[0]]); return { stdout: "", stderr: "" }; },
        waitForVersionImpl: async (version) => { events.push(["stable-health", version]); return true; },
        allowExistingStableToMainMigration: true,
        enrollManagedSourceImpl: async () => {
          await fs.mkdir(transactionRoot, { recursive: true });
          await fs.writeFile(installStampPath, `${JSON.stringify({ schemaVersion: 1, channel: "main", repository: "sametbasbug/equinox-local", branch: "main", bootstrapSha: sourceSha })}\n`, { mode: 0o600 });
          await fs.writeFile(sourcePointerPath, `schemaVersion=1\nsourceRoot=${path.join(transactionRoot, "sources", sourceSha)}\nsha=${sourceSha}\n`, { mode: 0o600 });
          events.push(["enrolled"]);
          return { status: "enrolled", bootstrapSha: sourceSha };
        },
        waitForManagedSourceImpl: async () => { events.push(["source-health-failed"]); throw new Error("synthetic exact source health failure"); },
        rollbackManagedSourceImpl: async () => {
          events.push(["rollback"]);
          await fs.rm(installStampPath, { force: false });
          await fs.rm(sourcePointerPath, { force: false });
          return { rolledBack: true, bootstrapSha: sourceSha };
        },
      }),
      (error) => {
        assert.match(error.message, /synthetic exact source health failure/u);
        assert.match(error.message, /Stable Equinox Local remains installed and was restored healthy/u);
        return true;
      },
    );
    await assert.rejects(fs.lstat(installStampPath), { code: "ENOENT" });
    await assert.rejects(fs.lstat(sourcePointerPath), { code: "ENOENT" });
    const failed = events.findIndex((event) => event[0] === "source-health-failed");
    const rollback = events.findIndex((event) => event[0] === "rollback");
    assert.equal(rollback > failed, true);
    assert.equal(events.filter((event) => event[0] === "stable-health").length, 2);
    assert.equal(events.filter((event) => event[0] === "exec" && event[1] === "/bin/launchctl" && event[2] === "bootstrap").length, 3);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("fresh activation failure preserves the verified release and reports bounded LaunchAgent diagnostics", async () => {
  const fixture = await createFixture("5.2.0");
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const execCalls = [];
  const waitOptions = [];
  const errorLog = path.join(fixture.homeDir, "Library", "Logs", "Equinox Local.error.log");
  await fs.mkdir(path.dirname(errorLog), { recursive: true, mode: 0o700 });
  await fs.writeFile(errorLog, "[Equinox Local supervisor] delayed VM startup fixture\n", { mode: 0o600 });
  try {
    await assert.rejects(
      installManagedEquinoxRelease({
        stagedReleaseDir: fixture.releaseDir,
        homeDir: fixture.homeDir,
        uid,
        platform: "darwin",
        target: TARGET,
        readCurrentImpl: async () => null,
        bootstrapImpl: async () => ({ configCreated: true, controlCenterUrl: "http://127.0.0.1:24891/" }),
        execFileImpl: async (command, args) => {
          execCalls.push([command, args]);
          if (command === "/bin/launchctl" && args[0] === "print") {
            return { stdout: "state = running\n\tpid = 4242\n\tlast exit code = 0\n", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
        waitForVersionImpl: async (_version, options) => {
          waitOptions.push(options);
          throw new Error("Equinox Local 5.2.0 did not become healthy: fetch failed");
        },
      }),
      (error) => {
        assert.match(error.message, /files were preserved/u);
        assert.match(error.message, /LaunchAgent state=running, pid=4242, lastExit=0/u);
        assert.match(error.message, /delayed VM startup fixture/u);
        return true;
      },
    );
    const targetRelease = path.join(fixture.installRoot, "releases", "5.2.0");
    assert.equal(await exists(targetRelease), true);
    assert.equal(await fs.readlink(path.join(fixture.installRoot, "current")), "releases/5.2.0");
    assert.deepEqual(waitOptions, [{ attempts: 120, delayMs: 500 }]);
    assert.equal(execCalls.some(([command, args]) => command === "/bin/launchctl" && args[0] === "bootout"), true);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("fresh activation diagnostics never follow a symlinked error log", async () => {
  const fixture = await createFixture("5.2.0");
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const logsDir = path.join(fixture.homeDir, "Library", "Logs");
  const secretPath = path.join(fixture.homeDir, "diagnostic-secret.txt");
  const errorLog = path.join(logsDir, "Equinox Local.error.log");
  await fs.mkdir(logsDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(secretPath, "must-not-be-followed\n", { mode: 0o600 });
  await fs.symlink(secretPath, errorLog);
  try {
    await assert.rejects(
      installManagedEquinoxRelease({
        stagedReleaseDir: fixture.releaseDir,
        homeDir: fixture.homeDir,
        uid,
        platform: "darwin",
        target: TARGET,
        readCurrentImpl: async () => null,
        bootstrapImpl: async () => ({ configCreated: true, controlCenterUrl: "http://127.0.0.1:24891/" }),
        execFileImpl: async (command, args) => {
          if (command === "/bin/launchctl" && args[0] === "print") {
            return { stdout: "state = waiting\n", stderr: "" };
          }
          return { stdout: "", stderr: "" };
        },
        waitForVersionImpl: async () => { throw new Error("health failed"); },
      }),
      (error) => {
        assert.doesNotMatch(error.message, /must-not-be-followed/u);
        return true;
      },
    );
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("same-version retry keeps the extended first-install health budget", async () => {
  const fixture = await createFixture("5.2.0");
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  const targetRelease = path.join(fixture.installRoot, "releases", "5.2.0");
  await fs.mkdir(targetRelease, { recursive: true, mode: 0o700 });
  const waitOptions = [];
  try {
    const result = await installManagedEquinoxRelease({
      stagedReleaseDir: fixture.releaseDir,
      homeDir: fixture.homeDir,
      uid,
      platform: "darwin",
      target: TARGET,
      readCurrentImpl: async () => ({ version: "5.2.0", releaseDir: targetRelease }),
      bootstrapImpl: async () => ({ configCreated: false, controlCenterUrl: "http://127.0.0.1:24891/" }),
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
      waitForVersionImpl: async (_version, options) => { waitOptions.push(options); return true; },
    });
    assert.equal(result.status, "already-installed");
    assert.deepEqual(waitOptions, [{ attempts: 120, delayMs: 500 }]);
    assert.equal(await exists(path.join(fixture.installRoot, "onboarding-state.json")), true);
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


test("fresh Windows stable-shell synchronization is atomic, idempotent and refuses drift", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-windows-shell-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const releaseDir = path.join(root, "release");
  const shellDir = path.join(releaseDir, "runtime", "shell");
  const programRoot = path.join(root, "Programs", "Equinox Local");
  await fs.mkdir(path.join(shellDir, "nested"), { recursive: true });
  await fs.writeFile(path.join(shellDir, "EquinoxLocal.exe"), "exe-fixture\n");
  await fs.writeFile(path.join(shellDir, "coreclr.dll"), "coreclr-fixture\n");
  await fs.writeFile(path.join(shellDir, "nested", "WebView2Loader.dll"), "loader-fixture\n");

  const first = await synchronizeFreshWindowsShell({ releaseDir, programRoot });
  assert.equal(first.synchronized, true);
  assert.equal(first.reused, false);
  assert.equal(await fs.readFile(path.join(programRoot, "EquinoxLocal.exe"), "utf8"), "exe-fixture\n");
  assert.deepEqual((await fs.readdir(path.dirname(programRoot))).filter((name) => name.startsWith(".equinox-shell-install-")), []);

  const second = await synchronizeFreshWindowsShell({ releaseDir, programRoot });
  assert.equal(second.synchronized, false);
  assert.equal(second.reused, true);

  await fs.writeFile(path.join(programRoot, "coreclr.dll"), "foreign-drift\n");
  await assert.rejects(
    synchronizeFreshWindowsShell({ releaseDir, programRoot }),
    /does not match the verified release/u,
  );
  assert.equal(await fs.readFile(path.join(programRoot, "coreclr.dll"), "utf8"), "foreign-drift\n");
});

async function createRealWindowsFirstInstallFixture(version = "5.2.1") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-first-install-"));
  const homeDir = path.join(root, "Türk User Home");
  const localAppData = path.join(root, "Local App Data");
  const installRoot = path.join(localAppData, "Equinox Local");
  const releaseDir = path.join(installRoot, "staging", `fixture-${Math.random().toString(16).slice(2)}`, "release");
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(releaseDir, { recursive: true });
  await fs.writeFile(path.join(releaseDir, "release.json"), `${JSON.stringify({
    schemaVersion: 1,
    version,
    target: "win32-x64",
    nodeVersion: "26.10.0",
    tunnelClientVersion: "0.0.15",
    serverEntry: "server.js",
  })}\n`);
  const contract = equinoxLocalReleaseRuntimeContract({ target: "win32-x64", version });
  const fixtureFiles = new Set([
    ...contract.runtimeExecutables,
    ...contract.runtimeDocuments,
    ...contract.requiredReleaseFiles,
    ...contract.nativeShellFiles,
  ]);
  for (const relative of fixtureFiles) {
    const absolute = path.join(releaseDir, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, `fixture:${relative}\n`);
  }
  return { root, homeDir, localAppData, installRoot, releaseDir, version };
}

test("Windows x64 fresh first install promotes current-version and stable shell without admin", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = await createRealWindowsFirstInstallFixture();
  const promoted = path.join(fixture.installRoot, "releases", fixture.version);
  const manifestPath = path.join(fixture.installRoot, "browser", "native-messaging", "dev.equinox.browser.json");
  const launcherPath = windowsNativeMessagingLauncherPath(promoted);
  t.after(async () => {
    await unregisterWindowsNativeMessagingHost({ manifestPath, launcherPath }).catch(() => {});
    await fs.rm(fixture.root, { recursive: true, force: true });
  });
  const sourceSha = "e".repeat(40);
  const metadataPath = path.join(fixture.releaseDir, "release.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  await fs.writeFile(metadataPath, `${JSON.stringify({ ...metadata, sourceSha })}\n`);
  const launches = [];
  let enrollmentArgs = null;
  let promotionRenameAttempts = 0;
  const promotedNormalized = path.win32.normalize(promoted).toLowerCase();
  const fsImpl = {
    ...fs,
    rename: async (source, destination) => {
      if (path.win32.normalize(destination).toLowerCase() === promotedNormalized) {
        promotionRenameAttempts += 1;
        if (promotionRenameAttempts === 1) {
          throw Object.assign(new Error("fixture transient Windows release promotion lock"), { code: "EPERM" });
        }
      }
      return fs.rename(source, destination);
    },
  };
  const result = await installManagedEquinoxRelease({
    stagedReleaseDir: fixture.releaseDir,
    homeDir: fixture.homeDir,
    platform: "win32",
    arch: "x64",
    target: "win32-x64",
    env: { ...process.env, LOCALAPPDATA: fixture.localAppData },
    fsImpl,
    windowsRenameSleepImpl: async () => {},
    initializeOnboardingImpl: async () => ({ created: true }),
    launchWindowsShellImpl: async (shellExecutable) => { launches.push(shellExecutable); return { launched: true }; },
    waitForVersionImpl: async () => true,
    allowExistingStableToMainMigration: true,
    enrollManagedSourceImpl: async (value) => {
      enrollmentArgs = value;
      assert.equal(await exists(fixture.releaseDir), false);
      assert.equal(await exists(value.windowsZipHelperPath), true);
      assert.equal(path.win32.normalize(value.stableReleaseDir).toLowerCase(), path.win32.normalize(promoted).toLowerCase());
      return { status: "enrolled", bootstrapSha: value.bootstrapSha };
    },
    requestWindowsRestartImpl: async () => ({ requested: true }),
    waitForManagedSourceImpl: async () => true,
  });
  assert.equal(result.status, "installed");
  assert.equal(result.managedSourceSha, sourceSha);
  assert.equal(promotionRenameAttempts, 2);
  assert.equal(enrollmentArgs.bootstrapSha, sourceSha);
  assert.equal(
    path.win32.normalize(enrollmentArgs.windowsZipHelperPath).toLowerCase(),
    path.win32.normalize(path.join(promoted, "equinox-local-windows-release-zip.ps1")).toLowerCase(),
  );
  const pointerPath = path.join(fixture.installRoot, "current-version.json");
  assert.deepEqual(JSON.parse(await fs.readFile(pointerPath, "utf8")), {
    schemaVersion: 1,
    target: "win32-x64",
    version: fixture.version,
  });
  assert.equal((await fs.lstat(promoted)).isDirectory(), true);
  const stableExe = path.join(fixture.localAppData, "Programs", "Equinox Local", "EquinoxLocal.exe");
  assert.equal(await fs.readFile(stableExe, "utf8"), "fixture:runtime\\shell\\EquinoxLocal.exe\n");
  assert.deepEqual(launches, [stableExe]);
  assert.equal(await exists(fixture.releaseDir), false);
  assert.equal(path.win32.normalize(await readWindowsNativeMessagingRegistryValue()).toLowerCase(), path.win32.normalize(manifestPath).toLowerCase());
  const nativeManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(path.win32.normalize(nativeManifest.path).toLowerCase(), path.win32.normalize(launcherPath).toLowerCase());
});

async function createExistingStableFixture(version = "5.2.0", installedSourceSha = null) {
  const fixture = await createFixture(version);
  const currentRelease = path.join(fixture.installRoot, "releases", version);
  await fs.mkdir(path.dirname(currentRelease), { recursive: true });
  await fs.cp(fixture.releaseDir, currentRelease, { recursive: true });
  if (installedSourceSha) {
    const meta = path.join(currentRelease, "release.json");
    const original = JSON.parse(await fs.readFile(meta, "utf8"));
    await fs.writeFile(meta, `${JSON.stringify({ ...original, sourceSha: installedSourceSha })}\n`, { mode: 0o600 });
  }
  return { ...fixture, currentRelease };
}

test("historical 5.2.x Stable reinstall does not silently enroll Main even if staged package offers a source SHA", async () => {
  const fixture = await createExistingStableFixture("5.2.0");
  const stagedMetadata = path.join(fixture.releaseDir, "release.json");
  const original = JSON.parse(await fs.readFile(stagedMetadata, "utf8"));
  await fs.writeFile(stagedMetadata, `${JSON.stringify({ ...original, sourceSha: "a".repeat(40) })}\n`);
  const events = [];
  try {
    const result = await installManagedEquinoxRelease({
      stagedReleaseDir: fixture.releaseDir, homeDir: fixture.homeDir, platform: "darwin",
      target: TARGET, uid: process.getuid?.() ?? 501,
      readCurrentImpl: async () => ({ version: "5.2.0", releaseDir: fixture.currentRelease }),
      bootstrapImpl: async () => ({ configCreated: false }),
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
      waitForVersionImpl: async () => { events.push("stable-health"); },
      enrollManagedSourceImpl: async () => { events.push("unexpected-enrollment"); throw new Error("no silent migration"); },
    });
    assert.equal(result.status, "already-installed");
    assert.equal(result.managedSourceSha, null);
    assert.deepEqual(events, ["stable-health"]);
    assert.equal((await fs.readFile(path.join(fixture.currentRelease, "release.json"), "utf8")).includes("sourceSha"), false);
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});

test("provenance-bearing Stable rerun preserves Factory composition and does not infer Main consent", async () => {
  const sha = "a".repeat(40);
  const fixture = await createExistingStableFixture("5.2.1", sha);
  const metadataPath = path.join(fixture.releaseDir, "release.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  await fs.writeFile(metadataPath, `${JSON.stringify({ ...metadata, sourceSha: sha })}\n`);
  // These are isolated fixture bytes, never the active Factory configuration.
  const privateRoot = path.join(fixture.homeDir, "external-private");
  await fs.mkdir(privateRoot, { recursive: true });
  const privateModule = path.join(privateRoot, "composition.mjs");
  const configPath = path.join(fixture.installRoot, "config.json");
  const sourceConfigPath = path.join(fixture.installRoot, "source-runtime.conf");
  const files = new Map([
    [privateModule, "export const diagnosticFixture = true;\n"],
    [configPath, `${JSON.stringify({ privateCompositionModule: privateModule, privateCompositionRoot: privateRoot })}\n`],
    [sourceConfigPath, `privateCompositionModule=${privateModule}\nprivateCompositionRoot=${privateRoot}\n`],
  ]);
  for (const [file, bytes] of files) await fs.writeFile(file, bytes, { mode: 0o600 });
  const events = [];
  try {
    const common = {
      stagedReleaseDir: fixture.releaseDir, homeDir: fixture.homeDir, platform: "darwin",
      target: TARGET, uid: process.getuid?.() ?? 501,
      readCurrentImpl: async () => ({ version: "5.2.1", releaseDir: fixture.currentRelease }),
      bootstrapImpl: async () => ({ configCreated: false }),
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
      waitForVersionImpl: async () => { events.push("stable-health"); },
      enrollManagedSourceImpl: async (value) => { events.push("main-enrollment"); return { bootstrapSha: value.bootstrapSha }; },
      waitForManagedSourceImpl: async () => { events.push("main-health"); },
    };
    const stable = await installManagedEquinoxRelease(common);
    assert.equal(stable.managedSourceSha, null);
    assert.deepEqual(events, ["stable-health"]);
    events.length = 0;
    const main = await installManagedEquinoxRelease({ ...common, allowExistingStableToMainMigration: true });
    assert.equal(main.managedSourceSha, sha);
    assert.deepEqual(events, ["stable-health", "main-enrollment", "main-health"]);
    for (const [file, bytes] of files) assert.equal(await fs.readFile(file, "utf8"), bytes);
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});

test("explicit existing-Stable Main opt-in requires matching installed and staged source provenance before lifecycle mutation", async () => {
  const installedSha = "a".repeat(40);
  const fixture = await createExistingStableFixture("5.2.1", installedSha);
  const stagedMetadata = path.join(fixture.releaseDir, "release.json");
  const original = JSON.parse(await fs.readFile(stagedMetadata, "utf8"));
  let mutations = 0;
  const common = {
    stagedReleaseDir: fixture.releaseDir, homeDir: fixture.homeDir, platform: "darwin",
    target: TARGET, uid: process.getuid?.() ?? 501,
    allowExistingStableToMainMigration: true,
    readCurrentImpl: async () => ({ version: "5.2.1", releaseDir: fixture.currentRelease }),
    bootstrapImpl: async () => { mutations++; return { configCreated: false }; },
    execFileImpl: async () => { mutations++; return { stdout: "", stderr: "" }; },
  };
  try {
    await fs.writeFile(stagedMetadata, `${JSON.stringify({ ...original, sourceSha: "b".repeat(40) })}\n`);
    await assert.rejects(installManagedEquinoxRelease(common), /source provenance does not match/u);
    assert.equal(mutations, 0);
    await fs.writeFile(stagedMetadata, `${JSON.stringify({ ...original, sourceSha: installedSha })}\n`);
    const events = [];
    const result = await installManagedEquinoxRelease({
      ...common,
      waitForVersionImpl: async () => { events.push("stable-health"); },
      enrollManagedSourceImpl: async (value) => { events.push("enrollment"); return { bootstrapSha: value.bootstrapSha }; },
      waitForManagedSourceImpl: async (_version, sha) => { assert.equal(sha, installedSha); events.push("main-health"); },
    });
    assert.equal(result.status, "already-installed");
    assert.equal(result.managedSourceSha, installedSha);
    assert.deepEqual(events, ["stable-health", "enrollment", "main-health"]);
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});

test("explicit Main choice rejects an older candidate while ordinary reinstall preserves newer Stable", async () => {
  const fixture = await createExistingStableFixture("5.2.2", "a".repeat(40));
  const stagedMetadata = path.join(fixture.releaseDir, "release.json");
  const original = JSON.parse(await fs.readFile(stagedMetadata, "utf8"));
  await fs.writeFile(stagedMetadata, `${JSON.stringify({ ...original, version: "5.2.1", sourceSha: "a".repeat(40) })}\n`);
  let mutations = 0;
  const common = {
    stagedReleaseDir: fixture.releaseDir, homeDir: fixture.homeDir, platform: "darwin", target: TARGET,
    uid: process.getuid?.() ?? 501,
    readCurrentImpl: async () => ({ version: "5.2.2", releaseDir: fixture.currentRelease }),
    bootstrapImpl: async () => { mutations++; return {}; },
    execFileImpl: async () => { mutations++; return { stdout: "", stderr: "" }; },
    enrollManagedSourceImpl: async () => { mutations++; return {}; },
  };
  try {
    const normal = await installManagedEquinoxRelease(common);
    assert.equal(normal.status, "newer-installed");
    assert.equal(normal.version, "5.2.2");
    await assert.rejects(installManagedEquinoxRelease({ ...common, allowExistingStableToMainMigration: true }), /installer migration cannot replace a different active Stable version/u);
    assert.equal(mutations, 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture.currentRelease, "release.json"), "utf8")).version, "5.2.2");
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});

test("legacy Stable 5.2.0 cannot silently or explicitly switch channel by presenting another Stable version", async () => {
  const fixture = await createExistingStableFixture("5.2.0");
  const stagedMetadata = path.join(fixture.releaseDir, "release.json");
  const original = JSON.parse(await fs.readFile(stagedMetadata, "utf8"));
  await fs.writeFile(stagedMetadata, `${JSON.stringify({ ...original, version: "5.2.1", sourceSha: "a".repeat(40) })}\n`);
  const current = { version: "5.2.0", releaseDir: fixture.currentRelease };
  try {
    await assert.rejects(installManagedEquinoxRelease({
      stagedReleaseDir: fixture.releaseDir, homeDir: fixture.homeDir, platform: "darwin", target: TARGET,
      uid: process.getuid?.() ?? 501, readCurrentImpl: async () => current,
      allowExistingStableToMainMigration: true,
      bootstrapImpl: async () => { throw new Error("should not mutate Stable state"); },
    }), /Upgrade the existing Stable release/u);
    assert.equal(await fs.readFile(path.join(fixture.currentRelease, "release.json"), "utf8").then((v) => JSON.parse(v).version), "5.2.0");
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});

test("existing provenance-bearing Stable migration failure removes Main identity and restores the installed Stable runtime", async () => {
  const installedSha = "a".repeat(40);
  const fixture = await createExistingStableFixture("5.2.1", installedSha);
  const stagedMetadata = path.join(fixture.releaseDir, "release.json");
  const original = JSON.parse(await fs.readFile(stagedMetadata, "utf8"));
  await fs.writeFile(stagedMetadata, `${JSON.stringify({ ...original, sourceSha: installedSha })}\n`);
  const mainRoot = path.join(fixture.installRoot, "main-update");
  const events = [];
  try {
    await assert.rejects(installManagedEquinoxRelease({
      stagedReleaseDir: fixture.releaseDir, homeDir: fixture.homeDir, platform: "darwin",
      target: TARGET, uid: process.getuid?.() ?? 501,
      allowExistingStableToMainMigration: true,
      readCurrentImpl: async () => ({ version: "5.2.1", releaseDir: fixture.currentRelease }),
      bootstrapImpl: async () => ({ configCreated: false }),
      execFileImpl: async (command, args) => {
        if (command === "/bin/launchctl" && args[0] === "bootstrap") events.push("launch-stable");
        return { stdout: "", stderr: "" };
      },
      waitForVersionImpl: async () => { events.push("stable-health"); return true; },
      allowExistingStableToMainMigration: true,
      enrollManagedSourceImpl: async () => {
        await fs.mkdir(mainRoot, { recursive: true });
        await fs.writeFile(path.join(mainRoot, "install.json"), "fixture");
        events.push("enroll");
        return { bootstrapSha: installedSha };
      },
      waitForManagedSourceImpl: async () => { events.push("main-health-failure"); throw new Error("synthetic Main health failure"); },
      rollbackManagedSourceImpl: async () => {
        events.push("rollback");
        await fs.rm(mainRoot, { recursive: true, force: true });
        return { rolledBack: true };
      },
    }), /Stable Equinox Local remains installed and was restored healthy/u);
    assert.deepEqual(events, ["launch-stable", "stable-health", "enroll", "launch-stable", "main-health-failure", "rollback", "launch-stable", "stable-health"]);
    assert.equal(await exists(mainRoot), false);
    assert.equal(await exists(fixture.currentRelease), true);
    assert.equal(JSON.parse(await fs.readFile(path.join(fixture.currentRelease, "release.json"), "utf8")).sourceSha, installedSha);
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});
