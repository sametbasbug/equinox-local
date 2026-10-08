import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectOwnedMainUninstallState, readWindowsStartupRegistrationOwnership, runEquinoxLocalUninstallHelper, runWindowsEquinoxLocalUninstall, unregisterWindowsStartupRegistration } from "../../src/equinox-local-uninstall-helper.js";
import { scheduleEquinoxLocalUninstall, uninstallHelperEnvironment } from "../../src/equinox-local-uninstall.js";

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function uninstallExecStub(calls = null, { appBundleId = "dev.equinox.local" } = {}) {
  return async (command, args) => {
    if (Array.isArray(calls)) calls.push([command, args]);
    if (command === "/usr/libexec/PlistBuddy") return { stdout: `${appBundleId}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  };
}

async function createFixture() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-uninstall-"));
  const installRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local");
  const releasesRoot = path.join(installRoot, "releases");
  const releaseDir = path.join(releasesRoot, "4.2.0");
  const currentLink = path.join(installRoot, "current");
  const stagingRoot = path.join(installRoot, "staging");
  const launchAgentPath = path.join(homeDir, "Library", "LaunchAgents", "dev.equinox.local.plist");
  const stdoutLogPath = path.join(homeDir, "Library", "Logs", "Equinox Local.log");
  const stderrLogPath = path.join(homeDir, "Library", "Logs", "Equinox Local.error.log");
  const manifestPath = path.join(homeDir, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts", "dev.equinox.browser.json");
  const appPath = path.join(homeDir, "Applications", "Equinox Local.app");
  const appExecutablePath = path.join(appPath, "Contents", "MacOS", "applet");
  const appRuntimeWrapperPath = path.join(installRoot, "equinox-local-app-runtime");
  await fs.mkdir(releaseDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(installRoot, "secrets"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(installRoot, "tunnel-profile"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(installRoot, "workspace"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(installRoot, "config.json"), "{}\n", { mode: 0o600 });
  await fs.writeFile(path.join(installRoot, "transport.json"), "{}\n", { mode: 0o600 });
  await fs.writeFile(path.join(installRoot, "update-state.json"), "{}\n", { mode: 0o600 });
  await fs.writeFile(path.join(installRoot, "equinox-browser-native-host"), "#!/bin/bash\n", { mode: 0o700 });
  await fs.writeFile(appRuntimeWrapperPath, "#!/bin/bash\n", { mode: 0o700 });
  await fs.mkdir(path.dirname(appExecutablePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(appExecutablePath, "fixture-app\n", { mode: 0o700 });
  await fs.writeFile(path.join(appPath, "Contents", "Info.plist"), "fixture-plist\n", { mode: 0o600 });
  await fs.symlink("releases/4.2.0", currentLink);
  await fs.mkdir(path.dirname(launchAgentPath), { recursive: true });
  await fs.writeFile(launchAgentPath, "plist", { mode: 0o600 });
  await fs.mkdir(path.dirname(stdoutLogPath), { recursive: true });
  await fs.writeFile(stdoutLogPath, "stdout\n", { mode: 0o600 });
  await fs.writeFile(stderrLogPath, "stderr\n", { mode: 0o600 });
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify({
    name: "dev.equinox.browser",
    path: path.join(installRoot, "equinox-browser-native-host"),
  })}\n`, { mode: 0o600 });
  return {
    homeDir,
    installRoot,
    releaseDir,
    currentLink,
    stagingRoot,
    releasesRoot,
    launchAgentPath,
    stdoutLogPath,
    stderrLogPath,
    manifestPath,
    appPath,
    appRuntimeWrapperPath,
    env: {
      HOME: homeDir,
      USER: "example",
      LOGNAME: "example",
      EQUINOX_LOCAL_INSTALL_ROOT: installRoot,
      EQUINOX_LOCAL_RELEASE_DIR: releaseDir,
    },
  };
}

test("uninstall scheduler waits for detached helper spawn with explicit data mode", async () => {
  const installation = {
    managed: true,
    selfUpdateSupported: true,
    installRoot: "/Users/example/Library/Application Support/Equinox Local",
    releaseDir: "/Users/example/Library/Application Support/Equinox Local/releases/4.2.0",
  };
  const calls = [];
  let unrefCount = 0;
  const sourceEnv = {
    HOME: "/Users/example",
    USER: "example",
    LOGNAME: "example",
    TMPDIR: "/tmp/example",
    OPENAI_API_KEY: "secret",
    GITHUB_TOKEN: "secret",
  };
  const env = uninstallHelperEnvironment(installation, sourceEnv);
  assert.deepEqual(env, {
    HOME: "/Users/example",
    USER: "example",
    LOGNAME: "example",
    TMPDIR: "/tmp/example",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    EQUINOX_LOCAL_INSTALL_ROOT: installation.installRoot,
    EQUINOX_LOCAL_RELEASE_DIR: installation.releaseDir,
  });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);

  const result = await scheduleEquinoxLocalUninstall({
    installation,
    removeUserData: true,
    nodePath: "/managed/node",
    helperPath: "/managed/uninstall-helper.js",
    sourceEnv,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.unref = () => { unrefCount += 1; };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  assert.deepEqual(result, { scheduled: true, removeUserData: true });
  assert.equal(unrefCount, 1);
  assert.deepEqual(calls[0].args, ["/managed/uninstall-helper.js", "--uninstall", "--remove-user-data"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
});



test("Windows startup uninstall primitive deletes only the exact owned command", async () => {
  const expected = '"C:\\Users\\example\\AppData\\Local\\Programs\\Equinox Local\\EquinoxLocal.exe" --startup';
  const calls = [];
  let current = expected;
  const execFileImpl = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "powershell.exe") {
      const stdout = current === null ? "missing\n" : `value:${Buffer.from(current, "utf8").toString("hex").toUpperCase()}\n`;
      return { stdout, stderr: "" };
    }
    if (command === "reg.exe") { current = null; return { stdout: "", stderr: "" }; }
    throw new Error(`unexpected command ${command}`);
  };
  const ownership = await readWindowsStartupRegistrationOwnership({ expectedCommand: expected, execFileImpl, env: {} });
  assert.equal(ownership.enabled, true);
  const readCall = calls.find((call) => call.command === "powershell.exe");
  assert.equal(readCall.options.env.EQUINOX_LOCAL_STARTUP_REGISTRY_SUBKEY, "Software\\Microsoft\\Windows\\CurrentVersion\\Run");
  assert.equal(readCall.options.env.EQUINOX_LOCAL_STARTUP_VALUE_NAME, "Equinox Local");
  assert.equal(Object.hasOwn(readCall.options.env, "PSModulePath"), false);
  const removed = await unregisterWindowsStartupRegistration({ expectedCommand: expected, execFileImpl, env: {} });
  assert.equal(removed.removed, true);
  assert.equal(calls.filter((call) => call.command === "reg.exe").length, 1);
});

test("Windows startup uninstall primitive refuses a foreign command without mutation", async () => {
  const expected = '"C:\\Owned\\EquinoxLocal.exe" --startup';
  let mutations = 0;
  const foreign = '\"C:\\Foreign\\Other.exe\" --startup';
  const execFileImpl = async (command) => {
    if (command === "powershell.exe") return { stdout: `value:${Buffer.from(foreign, "utf8").toString("hex").toUpperCase()}\n`, stderr: "" };
    mutations += 1;
    return { stdout: "", stderr: "" };
  };
  await assert.rejects(readWindowsStartupRegistrationOwnership({ expectedCommand: expected, execFileImpl, env: {} }), /foreign/u);
  assert.equal(mutations, 0);
});

test("Windows managed uninstall is handed to the native shell instead of a runtime-owned detached helper", async () => {
  const calls = [];
  const result = await scheduleEquinoxLocalUninstall({
    installation: {
      managed: true, selfUpdateSupported: true, platform: "win32",
      installRoot: "C:\\Users\\example\\AppData\\Local\\Equinox Local",
      releaseDir: "C:\\Users\\example\\AppData\\Local\\Equinox Local\\releases\\5.2.1",
    },
    removeUserData: false,
    requestWindowsUninstallImpl: async (...args) => { calls.push(args); return { requested: true }; },
    spawnImpl: () => { throw new Error("runtime-owned spawn must not run on Windows"); },
  });
  assert.deepEqual(result, { scheduled: true, removeUserData: false });
  assert.deepEqual(calls, [[false, { platform: "win32" }]]);
});

test("Windows uninstall validates ownership before deleting exact managed paths", async () => {
  const removed = [];
  const installation = {
    platform: "win32", arch: "x64", target: "win32-x64",
    installRoot: "C:\\Users\\example\\AppData\\Local\\Equinox Local",
    releaseDir: "C:\\Users\\example\\AppData\\Local\\Equinox Local\\releases\\5.2.1",
    releasesRoot: "C:\\Users\\example\\AppData\\Local\\Equinox Local\\releases",
    stagingRoot: "C:\\Users\\example\\AppData\\Local\\Equinox Local\\staging",
    currentPointer: "C:\\Users\\example\\AppData\\Local\\Equinox Local\\current-version.json",
    programRoot: "C:\\Users\\example\\AppData\\Local\\Programs\\Equinox Local",
    nativeMessagingManifestRoot: "C:\\Users\\example\\AppData\\Local\\Equinox Local\\browser\\native-messaging",
  };
  let shellChecks = 0;
  let nativeChecks = 0;
  const result = await runWindowsEquinoxLocalUninstall({
    installation, removeUserData: false,
    env: { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local", USERPROFILE: "C:\\Users\\example",
      EQUINOX_LOCAL_EXPECTED_STARTUP_COMMAND: '"C:\\Users\\example\\AppData\\Local\\Programs\\Equinox Local\\EquinoxLocal.exe" --startup' },
    homeDir: "C:\\Users\\example", shellPid: 4242, processAliveImpl: () => false,
    readCurrentImpl: async () => ({ version: "5.2.1", releaseDir: installation.releaseDir }),
    assertStableShellImpl: async () => { shellChecks += 1; return { owned: true }; },
    readStartupImpl: async () => ({ enabled: true }),
    unregisterStartupImpl: async () => ({ removed: true }),
    assertNativeMessagingImpl: async () => { nativeChecks += 1; return { manifestPath: `${installation.nativeMessagingManifestRoot}\\dev.equinox.browser.json` }; },
    unregisterNativeMessagingImpl: async () => ({ removed: true, manifestRemoved: true, reason: null }),
    launcherPathImpl: (releaseDir) => `${releaseDir}\\runtime\\browser\\equinox-browser-native-host.exe`,
    platformPathsImpl: () => ({ appDataRoot: installation.installRoot, programRoot: installation.programRoot,
      nativeMessagingManifestRoot: installation.nativeMessagingManifestRoot, runtimeRoot: `${installation.installRoot}\\runtime`, logsRoot: `${installation.installRoot}\\logs` }),
    removePathImpl: async (target, options) => { removed.push([target, options.recursive === true]); return true; },
  });
  assert.deepEqual(result, { uninstalled: true, userDataRemoved: false, userDataPreserved: true });
  assert.equal(shellChecks, 1);
  assert.equal(nativeChecks, 1);
  assert.deepEqual(removed[0], [installation.programRoot, true]);
  assert.ok(removed.some(([target]) => target === installation.currentPointer));
  assert.ok(!removed.some(([target]) => target.toLowerCase().endsWith("\\state")));
  assert.ok(!removed.some(([target]) => target.toLowerCase().endsWith("\\workspace")));
});

test("Windows uninstall fails closed before deleting files when Native Messaging ownership is foreign", async () => {
  let removed = false;
  const installation = {
    platform: "win32", arch: "x64", target: "win32-x64",
    installRoot: "C:\\Users\\example\\AppData\\Local\\Equinox Local",
    releaseDir: "C:\\Users\\example\\AppData\\Local\\Equinox Local\\releases\\5.2.1",
    releasesRoot: "C:\\Users\\example\\AppData\\Local\\Equinox Local\\releases",
    stagingRoot: "C:\\Users\\example\\AppData\\Local\\Equinox Local\\staging",
    currentPointer: "C:\\Users\\example\\AppData\\Local\\Equinox Local\\current-version.json",
    programRoot: "C:\\Users\\example\\AppData\\Local\\Programs\\Equinox Local",
    nativeMessagingManifestRoot: "C:\\Users\\example\\AppData\\Local\\Equinox Local\\browser\\native-messaging",
  };
  await assert.rejects(runWindowsEquinoxLocalUninstall({
    installation, removeUserData: true, homeDir: "C:\\Users\\example", shellPid: 4242, processAliveImpl: () => false,
    env: { EQUINOX_LOCAL_EXPECTED_STARTUP_COMMAND: '"C:\\Users\\example\\AppData\\Local\\Programs\\Equinox Local\\EquinoxLocal.exe" --startup' },
    readCurrentImpl: async () => ({ version: "5.2.1", releaseDir: installation.releaseDir }),
    assertStableShellImpl: async () => ({ owned: true }),
    readStartupImpl: async () => ({ enabled: true }),
    unregisterStartupImpl: async () => { removed = true; },
    assertNativeMessagingImpl: async () => { throw new Error("foreign registry owner"); },
    launcherPathImpl: (releaseDir) => `${releaseDir}\\runtime\\browser\\equinox-browser-native-host.exe`,
    removePathImpl: async () => { removed = true; },
  }), /foreign registry owner/u);
  assert.equal(removed, false);
});

test("uninstall scheduler rejects an asynchronous helper spawn failure", async () => {
  await assert.rejects(
    scheduleEquinoxLocalUninstall({
      installation: {
        managed: true,
        selfUpdateSupported: true,
        installRoot: "/Users/example/Library/Application Support/Equinox Local",
        releaseDir: "/Users/example/Library/Application Support/Equinox Local/releases/4.2.0",
      },
      spawnImpl: () => {
        const child = new EventEmitter();
        child.unref = () => {};
        queueMicrotask(() => child.emit("error", new Error("ENOEXEC")));
        return child;
      },
    }),
    /uninstall helper failed to start: ENOEXEC/u,
  );
});

test("managed uninstall preserves workspace and config by default while removing runtime, credentials and native host", async () => {
  const fixture = await createFixture();
  const execCalls = [];
  try {
    const result = await runEquinoxLocalUninstallHelper({
      argv: ["--uninstall", "--preserve-user-data"],
      env: fixture.env,
      homeDir: fixture.homeDir,
      uid: 501,
      sleepImpl: async () => {},
      execFileImpl: uninstallExecStub(execCalls),
    });
    assert.equal(result.userDataPreserved, true);
    assert.equal(await exists(path.join(fixture.installRoot, "config.json")), true);
    assert.equal(await exists(path.join(fixture.installRoot, "workspace")), true);
    assert.equal(await exists(fixture.currentLink), false);
    assert.equal(await exists(fixture.releasesRoot), false);
    assert.equal(await exists(fixture.stagingRoot), false);
    assert.equal(await exists(path.join(fixture.installRoot, "secrets")), false);
    assert.equal(await exists(path.join(fixture.installRoot, "transport.json")), false);
    assert.equal(await exists(fixture.launchAgentPath), false);
    assert.equal(await exists(fixture.stdoutLogPath), false);
    assert.equal(await exists(fixture.stderrLogPath), false);
    assert.equal(await exists(fixture.manifestPath), false);
    assert.equal(await exists(fixture.appPath), false);
    assert.equal(await exists(fixture.appRuntimeWrapperPath), false);
    assert.deepEqual(execCalls[0], ["/bin/launchctl", ["bootout", "gui/501/dev.equinox.local"]]);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("full managed uninstall removes the entire Equinox Local application data root", async () => {
  const fixture = await createFixture();
  try {
    const result = await runEquinoxLocalUninstallHelper({
      argv: ["--uninstall", "--remove-user-data"],
      env: fixture.env,
      homeDir: fixture.homeDir,
      uid: 501,
      sleepImpl: async () => {},
      execFileImpl: uninstallExecStub(),
    });
    assert.equal(result.userDataRemoved, true);
    assert.equal(await exists(fixture.installRoot), false);
    assert.equal(await exists(fixture.appPath), false);
    assert.equal(await exists(fixture.stdoutLogPath), false);
    assert.equal(await exists(fixture.stderrLogPath), false);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("uninstall never removes a Native Messaging manifest owned by another host path", async () => {
  const fixture = await createFixture();
  try {
    await fs.writeFile(fixture.manifestPath, `${JSON.stringify({ name: "dev.equinox.browser", path: "/tmp/other-host" })}\n`, { mode: 0o600 });
    await runEquinoxLocalUninstallHelper({
      argv: ["--uninstall", "--preserve-user-data"],
      env: fixture.env,
      homeDir: fixture.homeDir,
      uid: 501,
      sleepImpl: async () => {},
      execFileImpl: uninstallExecStub(),
    });
    assert.equal(await exists(fixture.manifestPath), true);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("uninstall never removes an Equinox Local.app path with another bundle identity", async () => {
  const fixture = await createFixture();
  try {
    await runEquinoxLocalUninstallHelper({
      argv: ["--uninstall", "--preserve-user-data"],
      env: fixture.env,
      homeDir: fixture.homeDir,
      uid: 501,
      sleepImpl: async () => {},
      execFileImpl: uninstallExecStub(null, { appBundleId: "dev.example.other" }),
    });
    assert.equal(await exists(fixture.appPath), true);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});


const MANAGED_SOURCE_SHA = "a".repeat(40);
async function createManagedSourceFixture() {
  const fixture = await createFixture();
  const mainRoot = path.join(fixture.installRoot, "main-update");
  const runtimeRoot = path.join(fixture.installRoot, "runtime");
  const sourceRoot = path.join(mainRoot, "sources", MANAGED_SOURCE_SHA);
  await fs.mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(runtimeRoot, "toolchain", "git"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(runtimeRoot, "toolchain", "git", "owned.txt"), "owned\n");
  await fs.writeFile(path.join(mainRoot, "install.json"), `${JSON.stringify({
    schemaVersion: 1, channel: "main", repository: "sametbasbug/equinox-local", branch: "main", bootstrapSha: MANAGED_SOURCE_SHA,
  })}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(mainRoot, "current-source.conf"),
    `schemaVersion=1\nsourceRoot=${sourceRoot}\nsha=${MANAGED_SOURCE_SHA}\n`, { mode: 0o600 });
  return { ...fixture, mainRoot, runtimeRoot, sourceRoot };
}

test("legacy Stable 5.2.x no-stamp state remains unclaimed rather than being adopted", async () => {
  const fixture = await createFixture();
  try {
    const mainRoot = path.join(fixture.installRoot, "main-update");
    await fs.mkdir(mainRoot, { mode: 0o700 });
    await fs.writeFile(path.join(mainRoot, "foreign.json"), "private\n");
    assert.equal(await inspectOwnedMainUninstallState({ platform: "darwin", arch: "arm64", homeDir: fixture.homeDir, env: fixture.env }), null);
    await runEquinoxLocalUninstallHelper({
      argv: ["--uninstall", "--preserve-user-data"], env: fixture.env, homeDir: fixture.homeDir,
      uid: 501, sleepImpl: async () => {}, execFileImpl: uninstallExecStub(),
    });
    assert.equal(await exists(path.join(mainRoot, "foreign.json")), true);
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});

test("managed-source preserve uninstall removes owned checkout, update state and toolchain but keeps user data", async () => {
  const fixture = await createManagedSourceFixture();
  try {
    assert.equal(await inspectOwnedMainUninstallState({ platform: "darwin", arch: "arm64", homeDir: fixture.homeDir, env: fixture.env }), fixture.mainRoot);
    await runEquinoxLocalUninstallHelper({
      argv: ["--uninstall", "--preserve-user-data"], env: fixture.env, homeDir: fixture.homeDir,
      uid: 501, sleepImpl: async () => {}, execFileImpl: uninstallExecStub(),
    });
    assert.equal(await exists(fixture.mainRoot), false);
    assert.equal(await exists(fixture.runtimeRoot), false);
    assert.equal(await exists(path.join(fixture.installRoot, "workspace")), true);
    assert.equal(await exists(path.join(fixture.installRoot, "config.json")), true);
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});

test("managed-source preserve uninstall rejects foreign entries before stopping the app or mutating state", async () => {
  const fixture = await createManagedSourceFixture();
  const calls = [];
  try {
    await fs.writeFile(path.join(fixture.mainRoot, "someone-elses-data.txt"), "untouched\n");
    await assert.rejects(runEquinoxLocalUninstallHelper({
      argv: ["--uninstall", "--preserve-user-data"], env: fixture.env, homeDir: fixture.homeDir,
      uid: 501, sleepImpl: async () => {}, execFileImpl: uninstallExecStub(calls),
    }), /foreign entry/u);
    assert.equal(calls.length, 0);
    assert.equal(await exists(fixture.runtimeRoot), true);
    assert.equal(await exists(fixture.releasesRoot), true);
    assert.equal(await exists(path.join(fixture.mainRoot, "someone-elses-data.txt")), true);
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});

test("managed-source preserve uninstall refuses an external source pointer without deleting user files", async () => {
  const fixture = await createManagedSourceFixture();
  try {
    await fs.writeFile(path.join(fixture.mainRoot, "current-source.conf"),
      `schemaVersion=1\nsourceRoot=${fixture.homeDir}\nsha=${MANAGED_SOURCE_SHA}\n`, { mode: 0o600 });
    await assert.rejects(inspectOwnedMainUninstallState({
      platform: "darwin", arch: "arm64", homeDir: fixture.homeDir, env: fixture.env,
    }), /not product-owned/u);
    assert.equal(await exists(fixture.sourceRoot), true);
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});

test("managed-source preserve uninstall refuses a foreign SHA-store directory", async () => {
  const fixture = await createManagedSourceFixture();
  try {
    await fs.mkdir(path.join(fixture.mainRoot, "sources", "other-repo"));
    await assert.rejects(inspectOwnedMainUninstallState({
      platform: "darwin", arch: "arm64", homeDir: fixture.homeDir, env: fixture.env,
    }), /foreign data/u);
    assert.equal(await exists(fixture.sourceRoot), true);
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});

test("full managed-source uninstall removes the owned application-data root", async () => {
  const fixture = await createManagedSourceFixture();
  try {
    await runEquinoxLocalUninstallHelper({
      argv: ["--uninstall", "--remove-user-data"], env: fixture.env, homeDir: fixture.homeDir,
      uid: 501, sleepImpl: async () => {}, execFileImpl: uninstallExecStub(),
    });
    assert.equal(await exists(fixture.installRoot), false);
  } finally { await fs.rm(fixture.homeDir, { recursive: true, force: true }); }
});

test("Windows preserve uninstall includes exact product-owned Main state cleanup on both architectures", async () => {
  for (const arch of ["x64", "arm64"]) {
    const root = "C:\\Users\\example\\AppData\\Local\\Equinox Local";
    const mainRoot = `${root}\\state\\main-update`;
    const removed = [];
    const installation = {
      platform: "win32", arch, target: `win32-${arch}`, installRoot: root,
      releaseDir: `${root}\\releases\\5.2.0`, releasesRoot: `${root}\\releases`,
      stagingRoot: `${root}\\staging`, currentPointer: `${root}\\current-version.json`,
      programRoot: "C:\\Users\\example\\AppData\\Local\\Programs\\Equinox Local",
      nativeMessagingManifestRoot: `${root}\\browser\\native-messaging`,
    };
    const result = await runWindowsEquinoxLocalUninstall({
      installation, removeUserData: false, homeDir: "C:\\Users\\example", shellPid: 4242,
      processAliveImpl: () => false,
      env: { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local", USERPROFILE: "C:\\Users\\example",
        EQUINOX_LOCAL_EXPECTED_STARTUP_COMMAND: '"C:\\Users\\example\\AppData\\Local\\Programs\\Equinox Local\\EquinoxLocal.exe" --startup' },
      readCurrentImpl: async () => ({ releaseDir: installation.releaseDir }),
      assertStableShellImpl: async () => ({}), readStartupImpl: async () => ({}),
      assertNativeMessagingImpl: async () => ({ manifestPath: `${installation.nativeMessagingManifestRoot}\\dev.equinox.browser.json` }),
      unregisterStartupImpl: async () => ({}), unregisterNativeMessagingImpl: async () => ({}),
      launcherPathImpl: (dir) => `${dir}\\runtime\\equinox-browser-native-host.exe`,
      platformPathsImpl: () => ({ appDataRoot: root, programRoot: installation.programRoot,
        nativeMessagingManifestRoot: installation.nativeMessagingManifestRoot,
        runtimeRoot: `${root}\\runtime`, logsRoot: `${root}\\logs` }),
      inspectOwnedMainStateImpl: async () => mainRoot,
      removePathImpl: async (target, options) => { removed.push([target, options.recursive]); return true; },
    });
    assert.equal(result.uninstalled, true);
    assert.deepEqual(removed.find(([target]) => target === mainRoot), [mainRoot, true]);
    assert.equal(removed.some(([target]) => target.toLowerCase().endsWith("\\state")), false);
  }
});

test("preserve uninstall refuses a symlinked runtime directory without stopping the app", async () => {
  const fixture = await createManagedSourceFixture();
  const calls = [];
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-foreign-runtime-"));
  try {
    await fs.rm(fixture.runtimeRoot, { recursive: true });
    await fs.symlink(external, fixture.runtimeRoot);
    await assert.rejects(runEquinoxLocalUninstallHelper({
      argv: ["--uninstall", "--preserve-user-data"], env: fixture.env, homeDir: fixture.homeDir,
      uid: 501, sleepImpl: async () => {}, execFileImpl: uninstallExecStub(calls),
    }), /Unsafe uninstall directory/u);
    assert.equal(calls.length, 0);
    assert.equal(await exists(fixture.releasesRoot), true);
    assert.equal(await exists(external), true);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  }
});

test("Windows native filesystem accepts and removes exact owned Main state while preserving user config", {
  skip: process.platform !== "win32",
}, async () => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-windows-uninstall-"));
  const localAppData = path.win32.join(homeDir, "AppData", "Local");
  const root = path.win32.join(localAppData, "Equinox Local");
  const programRoot = path.win32.join(localAppData, "Programs", "Equinox Local");
  const mainRoot = path.win32.join(root, "state", "main-update");
  const sourceRoot = path.win32.join(mainRoot, "sources", MANAGED_SOURCE_SHA);
  const releaseDir = path.win32.join(root, "releases", "5.2.0");
  const env = {
    USERPROFILE: homeDir, LOCALAPPDATA: localAppData,
    EQUINOX_LOCAL_EXPECTED_STARTUP_COMMAND: `"${path.win32.join(programRoot, "EquinoxLocal.exe")}" --startup`,
  };
  const installation = {
    platform: "win32", arch: process.arch, target: `win32-${process.arch}`, installRoot: root,
    releaseDir, releasesRoot: path.win32.join(root, "releases"), stagingRoot: path.win32.join(root, "staging"),
    currentPointer: path.win32.join(root, "current-version.json"), programRoot,
    nativeMessagingManifestRoot: path.win32.join(root, "browser", "native-messaging"),
  };
  try {
    await fs.mkdir(sourceRoot, { recursive: true, mode: 0o700 });
    await fs.mkdir(releaseDir, { recursive: true });
    await fs.mkdir(programRoot, { recursive: true });
    await fs.mkdir(path.win32.join(root, "runtime", "toolchain"), { recursive: true });
    await fs.writeFile(path.win32.join(root, "state", "config.json"), "user-config\n");
    await fs.writeFile(path.win32.join(mainRoot, "install.json"), `${JSON.stringify({
      schemaVersion: 1, channel: "main", repository: "sametbasbug/equinox-local", branch: "main", bootstrapSha: MANAGED_SOURCE_SHA,
    })}\n`);
    await fs.writeFile(path.win32.join(mainRoot, "current-source.conf"),
      `schemaVersion=1\nsourceRoot=${sourceRoot}\nsha=${MANAGED_SOURCE_SHA}\n`);
    const result = await runWindowsEquinoxLocalUninstall({
      installation, removeUserData: false, env, homeDir, shellPid: 1234, processAliveImpl: () => false,
      readCurrentImpl: async () => ({ releaseDir }), assertStableShellImpl: async () => ({}),
      readStartupImpl: async () => ({}), unregisterStartupImpl: async () => ({}),
      assertNativeMessagingImpl: async () => ({ manifestPath: "test" }),
      unregisterNativeMessagingImpl: async () => ({ removed: false, reason: null }),
      launcherPathImpl: (directory) => path.win32.join(directory, "equinox-browser-native-host.exe"),
    });
    assert.equal(result.uninstalled, true);
    assert.equal(await exists(mainRoot), false);
    assert.equal(await exists(path.win32.join(root, "runtime")), false);
    assert.equal(await fs.readFile(path.win32.join(root, "state", "config.json"), "utf8"), "user-config\n");
  } finally { await fs.rm(homeDir, { recursive: true, force: true }); }
});
