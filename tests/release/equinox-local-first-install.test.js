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
import { writeWindowsClassicRepairJournal, readWindowsClassicRepairJournal } from "../../src/equinox-local-windows-classic-repair-journal.js";
import { EQUINOX_LOCAL_MAIN_BRANCH, EQUINOX_LOCAL_MAIN_REPOSITORY, EQUINOX_LOCAL_MAIN_UPDATE_CHANNEL, EQUINOX_LOCAL_MAIN_UPDATE_SCHEMA_VERSION } from "../../src/equinox-local-main-update.js";
import {
  readWindowsNativeMessagingRegistryValue,
  unregisterWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
} from "../../src/equinox-browser-windows-native-messaging.js";

const TARGET = "darwin-arm64";

test("first-install CLI distinguishes Main-default public installer from internal Stable recovery", () => {
  const help = execFileSync(process.execPath, [fileURLToPath(new URL("../../src/equinox-local-first-install.js", import.meta.url)), "--help"], { encoding: "utf8" });
  assert.match(help, /Public installers enroll the admitted Main commit by default/u);
  assert.match(help, /--enroll-existing-main/u);
  assert.match(help, /internal helper without the flag preserves legacy Stable-only recovery/u);
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

test("signed Main native admission binds full SHA AND manual version before accepting any extracted executable", async () => {
  const fixture = await createFixture("5.2.1");
  const shaA = "a".repeat(40);
  const shaB = "b".repeat(40);
  const metadataPath = path.join(fixture.releaseDir, "release.json");
  const legacy = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  try {
    for (const metadata of [legacy, { ...legacy, sourceSha: shaB }]) {
      await fs.writeFile(metadataPath, JSON.stringify(metadata) + "\n");
      await assert.rejects(
        validateFirstInstallRelease(fixture.releaseDir, {
          target: TARGET, expectedMainSourceSha: shaA, expectedMainVersion: "5.2.1",
        }), /signed full source SHA\/version/u);
    }
    await fs.writeFile(metadataPath, JSON.stringify({ ...legacy, sourceSha: shaA }) + "\n");
    const accepted = await validateFirstInstallRelease(fixture.releaseDir, {
      target: TARGET, expectedMainSourceSha: shaA, expectedMainVersion: "5.2.1",
    });
    assert.equal(accepted.metadata.sourceSha, shaA);
    assert.equal(accepted.version, "5.2.1");
    await assert.rejects(
      validateFirstInstallRelease(fixture.releaseDir, {
        target: TARGET, expectedMainSourceSha: shaA, expectedMainVersion: "5.2.2",
      }), /signed full source SHA\/version/u);
    for (const extra of [
      {expectedMainSourceSha: "malformed", expectedMainVersion: "5.2.1"},
      {expectedMainSourceSha: shaA},
      {expectedMainVersion: "5.2.1"},
      {expectedMainSourceSha: shaA, expectedMainVersion: "05.2.1"},
    ]) {
      await assert.rejects(validateFirstInstallRelease(fixture.releaseDir, {
        target: TARGET, ...extra,
      }), /Main native candidate requires/u);
    }
  } finally {
    await fs.rm(fixture.homeDir, {recursive:true,force:true});
  }
});

test("signed Main native candidate CLI checks exact SHA without starting or mutating the installed product", async () => {
  const fixture = await createFixture("5.2.1");
  const sha = "c".repeat(40);
  const inspect = fileURLToPath(new URL("../../src/equinox-local-first-install.js", import.meta.url));
  const releaseFile = path.join(fixture.releaseDir, "release.json");
  const initial = JSON.parse(await fs.readFile(releaseFile, "utf8"));
  await fs.writeFile(releaseFile, JSON.stringify({ ...initial, sourceSha: sha }) + "\n");
  const invoke = (sourceSha, version = "5.2.1") =>
    execFileSync(process.execPath, [
      inspect, "--inspect-signed-main", "--staged-release", fixture.releaseDir,
      "--source-sha", sourceSha, "--version", version, "--target", TARGET,
    ], { encoding:"utf8", timeout:10000 });
  try {
    const before = (await fs.readdir(fixture.installRoot)).sort();
    assert.deepEqual(JSON.parse(invoke(sha)), {
      status: "admitted", sourceSha: sha, version:"5.2.1", target:TARGET,
    });
    assert.deepEqual((await fs.readdir(fixture.installRoot)).sort(), before);
    assert.equal(await exists(path.join(fixture.installRoot, "current")), false);
    assert.throws(() => invoke("a".repeat(40)), /Command failed/u);
    assert.throws(() => invoke(sha,"5.2.2"), /Command failed/u);
    assert.throws(() => execFileSync(process.execPath, [
      inspect,"--inspect-signed-main","--staged-release",fixture.releaseDir,"--source-sha",sha,
    ], { encoding:"utf8" }), /Command failed/u);
    assert.deepEqual((await fs.readdir(fixture.installRoot)).sort(), before);
  } finally {
    await fs.rm(fixture.homeDir,{recursive:true,force:true});
  }
});

test("native SHA admission independently rejects a forged or wrong-root persisted signed selector before inspecting a release",async()=>{
 const fixture=await createFixture("5.2.1");
 const sha="a".repeat(40);
 const selector=path.join(fixture.homeDir,"forged-main-selector.json");
 const pointer={schemaVersion:1,channel:"main",sourceSha:sha,version:"5.2.1",
  publishedAt:"2026-10-27T20:00:00.000Z",targets:[],
  signature:{algorithm:"ed25519",keyId:"attacker",value:Buffer.alloc(64).toString("base64")}};
 await fs.writeFile(selector,JSON.stringify(pointer));
 const inspector=fileURLToPath(new URL("../../src/equinox-local-first-install.js",import.meta.url));
 try{
  assert.throws(()=>execFileSync(process.execPath,[
   inspector,"--inspect-signed-main","--staged-release",fixture.releaseDir,
   "--source-sha",sha,"--version","5.2.1","--target",TARGET,
   "--signed-pointer-file",selector,
  ],{encoding:"utf8",timeout:10000}),/Command failed/u);
  const unchanged=JSON.parse(await fs.readFile(path.join(fixture.releaseDir,"release.json"),"utf8"));
  assert.equal(unchanged.version,"5.2.1");
 }finally{
  await fs.rm(fixture.homeDir,{recursive:true,force:true});
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
      nodeVersion: "26.12.1",
      tunnelClientVersion: "0.0.17",
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
      pruneStableImpl: async (installed) => {
        assert.equal(installed.releaseDir, path.join(fixture.installRoot, "releases", "4.2.0"));
        assert.equal(activations.length, 1, "cleanup must run AFTER healthy activation");
        await fs.rm(oldRelease, { recursive: true });
        return { active: "4.2.0", deleted: ["4.1.0"] };
      },
    });
    assert.equal(result.status, "activated");
    assert.equal(result.previousVersion, "4.1.0");
    assert.equal(bootstrapCount, 2);
    assert.equal(activations.length, 1);
    assert.equal(activations[0].targetVersion, "4.2.0");
    assert.equal(await exists(path.join(fixture.installRoot, "releases", "4.2.0")), true);
    assert.equal(await exists(oldRelease), false, "classic reinstall must reclaim obsolete Stable A");

  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});


test("classic Stable installer disarms existing Main only before B restart and restores it before A rollback", async () => {
  for (const rollback of [false, true]) {
    const fixture = await createFixture("4.2.0");
    const uid = process.getuid?.() ?? 501;
    const oldRelease = path.join(fixture.installRoot, "releases", "4.1.0");
    const mainPath = path.join(fixture.installRoot, "main-update", "install.json");
    const backup = `${mainPath}.stable-install-backup`;
    const userConfig = path.join(fixture.installRoot, "config.json");
    const key = path.join(fixture.installRoot, "secrets", "openai-runtime-key");
    const stamp = JSON.stringify({ schemaVersion: EQUINOX_LOCAL_MAIN_UPDATE_SCHEMA_VERSION,
      channel: EQUINOX_LOCAL_MAIN_UPDATE_CHANNEL, repository: EQUINOX_LOCAL_MAIN_REPOSITORY,
      branch: EQUINOX_LOCAL_MAIN_BRANCH, bootstrapSha: "a".repeat(40) });
    const events = [];
    try {
      await fs.mkdir(oldRelease, { recursive: true });
      await fs.mkdir(path.dirname(mainPath), { recursive: true });
      await fs.mkdir(path.dirname(key), { recursive: true });
      await fs.writeFile(mainPath, stamp);
      await fs.writeFile(userConfig, "keep-configuration");
      await fs.writeFile(key, "keep-tunnel-secret");
      const install = () => installManagedEquinoxRelease({
        stagedReleaseDir: fixture.releaseDir, homeDir: fixture.homeDir, uid,
        platform: "darwin", target: TARGET,
        readCurrentImpl: async () => ({ version: "4.1.0", releaseDir: oldRelease }),
        pruneStableImpl: async () => {
          if (rollback) assert.fail("rollback must not remove old Stable A");
          events.push("healthy-pruned");
        },
        bootstrapImpl: async () => ({ configCreated: false }),
        execFileImpl: async (_command, args) => {
          if (args[0] === "print") throw Object.assign(new Error("not loaded"), { code: "ENOENT" });
          return { stdout: "", stderr: "" };
        },
        activateImpl: async ({ targetVersion, kickstartImpl, healthAttempts }) => {
          assert.equal(healthAttempts, 120);
          assert.equal(targetVersion, "4.2.0");
          assert.equal(typeof kickstartImpl, "function");
          await kickstartImpl("4.2.0");
          events.push("new-stable");
          assert.equal(await exists(mainPath), false);
          assert.equal(await fs.readFile(backup, "utf8"), stamp);
          if (rollback) {
            await kickstartImpl("4.1.0");
            events.push("old-main-restored");
            assert.equal(await fs.readFile(mainPath, "utf8"), stamp);
            assert.equal(await exists(backup), false);
            throw new Error("target unhealthy, old A restored");
          }
          return { status: "activated", version: "4.2.0", previousVersion: "4.1.0" };
        },
      });
      if (rollback) await assert.rejects(install(), rollback === "rollback-failed" ? /OS rollback failed/u : /old A restored/u);
      else assert.equal((await install()).status, "activated");
      assert.equal(await exists(backup), false);
      assert.equal(await exists(mainPath), rollback);
      assert.equal(await fs.readFile(userConfig, "utf8"), "keep-configuration");
      assert.equal(await fs.readFile(key, "utf8"), "keep-tunnel-secret");
      assert.deepEqual(events, rollback === "rollback-failed" ? ["new-stable"] : rollback ? ["new-stable", "old-main-restored"] : ["new-stable", "healthy-pruned"]);
    } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
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

async function createRealWindowsFirstInstallFixture(version = "5.2.1", target = "win32-x64") {
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
    target,
    nodeVersion: "26.12.1",
    tunnelClientVersion: "0.0.17",
    serverEntry: "server.js",
  })}\n`);
  const contract = equinoxLocalReleaseRuntimeContract({ target, version });
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

test("Windows installed Main yields channel to signed Stable, retaining keys and exact rollback stamp", { skip: process.platform !== "win32" }, async (t) => {
  for (const failNewHealth of [false, true]) {
    const fixture = await createRealWindowsFirstInstallFixture("5.2.1");
    t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
    const oldRelease = path.join(fixture.installRoot, "releases", "5.2.0");
    const stampPath = path.join(fixture.installRoot, "state", "main-update", "install.json");
    const secretPath = path.join(fixture.installRoot, "secrets", "openai-runtime-key");
    await fs.mkdir(oldRelease, { recursive: true });
    await fs.mkdir(path.dirname(stampPath), { recursive: true });
    await fs.mkdir(path.dirname(secretPath), { recursive: true });
    const stamp = JSON.stringify({ schemaVersion: EQUINOX_LOCAL_MAIN_UPDATE_SCHEMA_VERSION,
      channel: EQUINOX_LOCAL_MAIN_UPDATE_CHANNEL, repository: EQUINOX_LOCAL_MAIN_REPOSITORY,
      branch: EQUINOX_LOCAL_MAIN_BRANCH, bootstrapSha: "a".repeat(40) });
    await fs.writeFile(stampPath, stamp);
    await fs.writeFile(secretPath, "never-delete-user-key");
    const events = [];
    const install = () => installManagedEquinoxRelease({
      stagedReleaseDir: fixture.releaseDir, homeDir: fixture.homeDir, platform: "win32", arch: "x64",
      target: "win32-x64", env: { ...process.env, LOCALAPPDATA: fixture.localAppData },
      readCurrentImpl: async () => ({ version: "5.2.0", releaseDir: oldRelease }),
      bootstrapImpl: async () => ({ configCreated: false }),
      launchWindowsShellImpl: async () => events.push("launch"),
      activateImpl: async ({ kickstartImpl, healthAttempts }) => {
        assert.equal(healthAttempts, 180);
        await kickstartImpl("5.2.1");
        assert.equal(await exists(stampPath), false);
        assert.equal(await fs.readFile(`${stampPath}.stable-install-backup`, "utf8"), stamp);
        if (failNewHealth) {
          await kickstartImpl("5.2.0");
          assert.equal(await fs.readFile(stampPath, "utf8"), stamp);
          throw new Error("failed B was rolled back");
        }
        return { status: "activated", previousVersion: "5.2.0" };
      },
    });
    if (failNewHealth) await assert.rejects(install(), /rolled back/u);
    else assert.equal((await install()).status, "activated");
    assert.equal(await exists(stampPath), failNewHealth);
    assert.equal(await exists(`${stampPath}.stable-install-backup`), false);
    assert.equal(await fs.readFile(secretPath, "utf8"), "never-delete-user-key");
    assert.equal(events.length, failNewHealth ? 2 : 1);
  }
});

test("Windows classic install resumes an interrupted native Main->Stable handoff without losing keys", { skip: process.platform !== "win32" }, async (t) => {
  for (const phase of ["parked-main-before-stable-health", "journal-only-before-start", "healthy-committed-B"]) {
    await t.test(phase, async (sub) => {
      const fixture = await createRealWindowsFirstInstallFixture("6.1.2", "win32-" + process.arch);
      sub.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
      const api = path.win32;
      const root = fixture.installRoot;
      const tx = api.join(root, "state", "main-update");
      const stampPath = api.join(tx, "install.json");
      const journalPath = api.join(tx, "classic-repair.json");
      const currentPath = api.join(root, "current-version.json");
      const sourceSha = "a".repeat(40);
      const nativeSha = "b".repeat(40);
      const sourceRoot = api.join(tx, "sources", sourceSha);
      const nativeRelease = api.join(tx, "native-store", "win32-" + process.arch, nativeSha, "release");
      const userSecret = api.join(root, "state", "private", "saved.json");
      await fs.mkdir(api.join(sourceRoot, "src"), { recursive: true });
      await fs.mkdir(nativeRelease, { recursive: true });
      await fs.mkdir(api.dirname(userSecret), { recursive: true });
      await fs.writeFile(api.join(sourceRoot, "src", "equinox-local-version.js"),
        'export const EQUINOX_LOCAL_VERSION = "6.1.1";\n');
      await fs.writeFile(userSecret, '{"persist":true}');
      const stamp = JSON.stringify({ schemaVersion: EQUINOX_LOCAL_MAIN_UPDATE_SCHEMA_VERSION,
        channel: EQUINOX_LOCAL_MAIN_UPDATE_CHANNEL, repository: EQUINOX_LOCAL_MAIN_REPOSITORY,
        branch: EQUINOX_LOCAL_MAIN_BRANCH, bootstrapSha: sourceSha });
      const parked = phase === "parked-main-before-stable-health";
      const stableCommitted = phase === "healthy-committed-B";
      if (!stableCommitted) {
        await fs.writeFile(stampPath + (parked ? ".stable-install-backup" : ""), stamp);
      }
      await fs.writeFile(currentPath, JSON.stringify({
        schemaVersion: 1, target: "win32-" + process.arch,
        version: parked || stableCommitted ? "6.1.2" : "6.1.0",
      }));
      await writeWindowsClassicRepairJournal(journalPath, {
        schemaVersion: 1, target: "win32-" + process.arch,
        oldMainVersion: "6.1.1", oldSourceSha: sourceSha, oldNativeSha: nativeSha,
        oldStablePointerVersion: "6.1.0", targetVersion: "6.1.2", mainStamp: stamp,
      });
      const calls = [];
      const result = await installManagedEquinoxRelease({
        stagedReleaseDir: fixture.releaseDir, homeDir: fixture.homeDir,
        platform: "win32", arch: process.arch, target: "win32-" + process.arch,
        env: { ...process.env, LOCALAPPDATA: fixture.localAppData },
        readCurrentImpl: async () => ({ version: "6.1.2",
          releaseDir: api.join(root, "releases", "6.1.2") }),
        readMainSourcePointerImpl: async () => ({ sha: sourceSha, sourceRoot }),
        readMainNativePointerImpl: async () => ({
          sourceSha: nativeSha, target: "win32-" + process.arch,
          releaseDir: nativeRelease, runtimeContractSha256: "f".repeat(64),
        }),
        verifyWindowsShellOwnedImpl: async ({ releaseDir }) => {
          calls.push("shell:" + releaseDir);
          return { owned: true };
        },
        verifyWindowsNativeHostOwnedImpl: async ({ acceptedLauncherPaths }) => {
          calls.push("browser:" + acceptedLauncherPaths[0]); return {};
        },
        waitForManagedSourceImpl: async (version, sha) => {
          assert.equal(version, "6.1.1"); assert.equal(sha, sourceSha);
          calls.push("main-healthy");
        },
        waitForVersionImpl: async (version, options) => {
          assert.equal(version, "6.1.2");
          assert.equal(options.expectedInstallationKind, "managed");
          calls.push("stable-healthy");
        },
        waitWindowsPipeReleaseImpl: async () => calls.push("pipe"),
        stopWindowsShellImpl: async () => calls.push("stop"),
        syncManagedShellImpl: async (_installation, release) => {
          assert.equal(release.releaseDir, nativeRelease);
          calls.push("sync-native-A");
        },
        launchWindowsShellImpl: async () => calls.push("launch-native-A"),
      });
      assert.equal(result.status, stableCommitted ? "activated" : "restored-main");
      assert.equal(await fs.readFile(userSecret, "utf8"), '{"persist":true}');
      assert.equal(await readWindowsClassicRepairJournal(journalPath), null);
      if (!stableCommitted) {
        assert.equal(await fs.readFile(stampPath, "utf8"), stamp);
        assert.equal(JSON.parse(await fs.readFile(currentPath, "utf8")).version, "6.1.0");
        if (parked) assert.deepEqual(calls.slice(-5), [
          "stop", "sync-native-A", "pipe", "launch-native-A", "main-healthy",
        ]);
        else assert.deepEqual(calls, ["shell:" + nativeRelease,
          "browser:" + api.join(nativeRelease, "runtime", "browser", "equinox-browser-native-host.exe"),
          "main-healthy"]);
      } else {
        assert.equal(await fs.access(stampPath).then(() => true, () => false), false);
        assert.ok(calls.includes("stable-healthy"));
      }
    });
  }
});

test("Windows classic repair after Main GC uses verified native B as rollback without requiring obsolete releases", { skip: process.platform !== "win32" || process.arch !== "x64" }, async (t) => {
  for (const failNewHealth of [false, true]) {
    for (const legacyStableExists of [false, true]) {
    const fixture = await createRealWindowsFirstInstallFixture("6.1.1");
    t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
    const root = fixture.installRoot;
    const tx = path.win32.join(root, "state", "main-update");
    const stampPath = path.win32.join(tx, "install.json");
    const pointerFile = path.win32.join(root, "current-version.json");
    const sourceRoot = path.win32.join(tx, "sources", "a".repeat(40));
    const nativeRelease = path.win32.join(tx, "native-store", "win32-x64", "b".repeat(40), "release");
    const secret = path.win32.join(root, "secrets", "user-config-key");
    await fs.mkdir(path.win32.join(sourceRoot, "src"), { recursive: true });
    await fs.mkdir(path.dirname(secret), { recursive: true });
    await fs.mkdir(path.dirname(nativeRelease), { recursive: true });
    await fs.mkdir(nativeRelease, { recursive: true });
    await fs.writeFile(path.win32.join(sourceRoot, "src", "equinox-local-version.js"), 'export const EQUINOX_LOCAL_VERSION = "6.1.0";\n');
    const stamp = JSON.stringify({ schemaVersion: EQUINOX_LOCAL_MAIN_UPDATE_SCHEMA_VERSION,
      channel: EQUINOX_LOCAL_MAIN_UPDATE_CHANNEL, repository: EQUINOX_LOCAL_MAIN_REPOSITORY,
      branch: EQUINOX_LOCAL_MAIN_BRANCH, bootstrapSha: "a".repeat(40) });
    await fs.writeFile(stampPath, stamp);
    await fs.writeFile(pointerFile, JSON.stringify({ schemaVersion: 1, target: "win32-x64", version: "6.0.5" }));
    const legacyRelease = path.win32.join(root, "releases", "6.0.5");
    if (legacyStableExists) await fs.mkdir(legacyRelease, { recursive: true });
    await fs.writeFile(secret, "never-delete-user-key");
    const events = [];
    const install = () => installManagedEquinoxRelease({
      stagedReleaseDir: fixture.releaseDir, homeDir: fixture.homeDir, platform: "win32",
      arch: "x64", target: "win32-x64", env: { ...process.env, LOCALAPPDATA: fixture.localAppData },
      readCurrentImpl: async () => legacyStableExists
        ? { version: "6.0.5", releaseDir: legacyRelease } : null,
      readMainSourcePointerImpl: async () => ({ sha: "a".repeat(40), sourceRoot }),
      readMainNativePointerImpl: async () => ({ sourceSha: "b".repeat(40), target: "win32-x64",
        payloadVersion: "6.0.5", releaseDir: nativeRelease }),
      bootstrapImpl: async () => ({ configCreated: false }),
      launchWindowsShellImpl: async () => events.push("launch"),
      activateImpl: async ({ previousManagedMain, previousMainNativeReleaseDir, kickstartImpl }) => {
        assert.deepEqual(previousManagedMain, {
          version: "6.1.0", sourceSha: "a".repeat(40), releaseDir: nativeRelease,
          stablePointerVersion: "6.0.5",
        });
        assert.equal(previousMainNativeReleaseDir, nativeRelease);
        await kickstartImpl("6.1.1");
        assert.equal(await exists(stampPath), false);
        if (failNewHealth) {
          await kickstartImpl("6.1.0");
          assert.equal(await fs.readFile(stampPath, "utf8"), stamp);
          throw new Error("signed B failed and original Main was restored");
        }
        return { status: "activated", previousVersion: "6.1.0" };
      },
      pruneStableImpl: async () => {
        if (failNewHealth) assert.fail("No old directories may be pruned on failed activation");
      },
    });
    if (failNewHealth) await assert.rejects(install(), /original Main was restored/u);
    else assert.equal((await install()).status, "activated");
    assert.equal(await exists(stampPath), failNewHealth);
    assert.equal(await fs.readFile(secret, "utf8"), "never-delete-user-key");
    assert.deepEqual(events, failNewHealth ? ["launch", "launch"] : ["launch"]);
    assert.equal(await exists(legacyRelease), legacyStableExists, "Unrelated Stable files must not be pruned on rollback");
    }
  }
});

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

test("first-install metadata rejects unknown fields, oversized JSON and fake native app executable before mutation",async()=>{
  const fixture=await createFixture("4.2.0");
  try{
    const metadataPath=path.join(fixture.releaseDir,"release.json");
    const original=await fs.readFile(metadataPath,"utf8");
    await fs.writeFile(metadataPath,JSON.stringify({...JSON.parse(original),extra:"unauthorized"}));
    await assert.rejects(validateFirstInstallRelease(fixture.releaseDir,{target:TARGET}),/missing or unsupported fields/u);
    await fs.writeFile(metadataPath,JSON.stringify({...JSON.parse(original),extra:"x".repeat(20000)}));
    await assert.rejects(validateFirstInstallRelease(fixture.releaseDir,{target:TARGET}),/invalid size/u);
    await fs.writeFile(metadataPath,original);
    await fs.rm(path.join(fixture.releaseDir,"runtime","app","applet"));
    await fs.symlink("native-app.json",path.join(fixture.releaseDir,"runtime","app","applet"));
    await assert.rejects(validateFirstInstallRelease(fixture.releaseDir,{target:TARGET}),/symbolic links/u);
    assert.equal(await exists(path.join(fixture.installRoot,"current")),false);
  }finally{await fs.rm(fixture.homeDir,{recursive:true,force:true})}
});

test("first-install refuses root identity and nonboolean Main migration consent before any native boot",async()=>{
  const fixture=await createFixture("4.2.0");
  let nativeCalls=0;
  try{
    for(const opts of [
      {uid:0,allowExistingStableToMainMigration:false},
      {uid:501,allowExistingStableToMainMigration:"true"},
    ]){
      await assert.rejects(installManagedEquinoxRelease({
        stagedReleaseDir:fixture.releaseDir,homeDir:fixture.homeDir,platform:"darwin",target:TARGET,
        ...opts,bootstrapImpl:async()=>{nativeCalls++},execFileImpl:async()=>{nativeCalls++},
      }),/root|explicit boolean/u);
    }
    assert.equal(nativeCalls,0);
    assert.equal(await exists(path.join(fixture.installRoot,"current")),false);
    assert.equal(await exists(path.join(fixture.installRoot,"releases")),false);
  }finally{await fs.rm(fixture.homeDir,{recursive:true,force:true})}
});

test("first-install rejects symlinked HOME, staging escape and a candidate missing source provenance for explicit Main opt-in",async()=>{
  const fixture=await createFixture("4.2.0");
  const alias=fixture.homeDir+"-alias";
  let nativeCalls=0;
  try{
    await fs.symlink(fixture.homeDir,alias);
    await assert.rejects(installManagedEquinoxRelease({
      stagedReleaseDir:fixture.releaseDir,homeDir:alias,platform:"darwin",uid:process.getuid?.()??501,target:TARGET,
      bootstrapImpl:async()=>{nativeCalls++},
    }),/HOME directory is unsafe/u);
    const outside=path.join(fixture.homeDir,"foreign","release");
    await fs.mkdir(outside,{recursive:true});
    await assert.rejects(installManagedEquinoxRelease({
      stagedReleaseDir:outside,homeDir:fixture.homeDir,platform:"darwin",uid:process.getuid?.()??501,target:TARGET,
      bootstrapImpl:async()=>{nativeCalls++},
    }),/escaped the managed staging directory/u);
    await assert.rejects(installManagedEquinoxRelease({
      stagedReleaseDir:fixture.releaseDir,homeDir:fixture.homeDir,platform:"darwin",uid:process.getuid?.()??501,
      target:TARGET,allowExistingStableToMainMigration:true,bootstrapImpl:async()=>{nativeCalls++},
    }),/requires exact source provenance/u);
    assert.equal(nativeCalls,0);
    assert.equal(await exists(path.join(fixture.installRoot,"current")),false);
  }finally{
    await fs.rm(alias,{force:true});
    await fs.rm(fixture.homeDir,{recursive:true,force:true});
  }
});

test("first-install refuses invalid Windows architecture and cross-target override before any filesystem touch",async()=>{
  const forbidden="C:\\synthetic\\private\\installer";
  let fsCalls=0;
  const fsImpl={lstat:async()=>{fsCalls++;throw Error("unexpected native FS")}};
  for(const [platform,arch,target] of [
    ["win32","ia32","win32-x64"],["win32","x64","win32-arm64"],["linux","x64","win32-x64"],
  ]){
    await assert.rejects(installManagedEquinoxRelease({
      stagedReleaseDir:forbidden,homeDir:"C:\\synthetic\\private",
      platform,arch,target,fsImpl,
    }),/not implemented|does not match native/u);
  }
  assert.equal(fsCalls,0);
});

test('website Main-default reinstall preserves a healthy different-SHA Main without replacing its native runtime', async () => {
  const fixture = await createFixture('5.2.1');
  const previousSha = 'b'.repeat(40);
  const tx = path.join(fixture.installRoot, 'main-update');
  const sourceRoot = path.join(tx, 'sources', previousSha);
  await fs.mkdir(path.join(sourceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(tx, 'install.json'), `${JSON.stringify({ schemaVersion: 1, channel: 'main', repository: 'sametbasbug/equinox-local', branch: 'main', bootstrapSha: 'a'.repeat(40) })}\n`);
  await fs.writeFile(path.join(sourceRoot, 'src', 'equinox-local-version.js'), 'export const EQUINOX_LOCAL_VERSION = "6.2.0";\n');
  const events = [];
  const options = {
    stagedReleaseDir: fixture.releaseDir, homeDir: fixture.homeDir,
    platform: 'darwin', target: TARGET, uid: process.getuid?.() ?? 501,
    allowExistingStableToMainMigration: true,
    readCurrentImpl: async () => ({ version: '5.2.0', releaseDir: path.join(fixture.installRoot, 'releases', '5.2.0') }),
    readMainSourcePointerImpl: async () => ({ sha: previousSha, sourceRoot }),
    bootstrapImpl: async () => { events.push('bootstrap'); throw new Error('must not overwrite Main'); },
    enrollManagedSourceImpl: async () => { events.push('enroll'); throw new Error('must not reenroll Main'); },
    activateImpl: async () => { events.push('activation'); throw new Error('must not replace Main'); },
    waitForManagedSourceImpl: async (version, sha) => {
      events.push(`health:${version}:${sha}`);
    },
  };
  try {
    const result = await installManagedEquinoxRelease(options);
    assert.equal(result.status, 'already-installed');
    assert.equal(result.version, '6.2.0');
    assert.equal(result.managedSourceSha, previousSha);
    assert.deepEqual(events, [`health:6.2.0:${previousSha}`]);
    const failed = await installManagedEquinoxRelease({ ...options,
      waitForManagedSourceImpl: async () => { throw new Error('Main is unhealthy'); },
    }).then(() => null, (error) => error);
    assert.match(failed.message, /Main is unhealthy/u);
    assert.deepEqual(events, [`health:6.2.0:${previousSha}`]);
    await fs.writeFile(path.join(tx, 'active.json'), '{}\n');
    await assert.rejects(installManagedEquinoxRelease(options), /Main update transaction must complete/u);
    assert.deepEqual(events, [`health:6.2.0:${previousSha}`]);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});
