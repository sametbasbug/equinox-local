import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runEquinoxLocalUninstallHelper } from "../../src/equinox-local-uninstall-helper.js";
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
  await fs.mkdir(releaseDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(installRoot, "secrets"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(installRoot, "tunnel-profile"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(installRoot, "workspace"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(installRoot, "config.json"), "{}\n", { mode: 0o600 });
  await fs.writeFile(path.join(installRoot, "transport.json"), "{}\n", { mode: 0o600 });
  await fs.writeFile(path.join(installRoot, "update-state.json"), "{}\n", { mode: 0o600 });
  await fs.writeFile(path.join(installRoot, "equinox-browser-native-host"), "#!/bin/bash\n", { mode: 0o700 });
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
    env: {
      HOME: homeDir,
      USER: "example",
      LOGNAME: "example",
      EQUINOX_LOCAL_INSTALL_ROOT: installRoot,
      EQUINOX_LOCAL_RELEASE_DIR: releaseDir,
    },
  };
}

test("uninstall scheduler launches a detached credential-free helper with explicit data mode", () => {
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
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);

  const result = scheduleEquinoxLocalUninstall({
    installation,
    removeUserData: true,
    nodePath: "/managed/node",
    helperPath: "/managed/uninstall-helper.js",
    sourceEnv,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref: () => { unrefCount += 1; } };
    },
  });
  assert.deepEqual(result, { scheduled: true, removeUserData: true });
  assert.equal(unrefCount, 1);
  assert.deepEqual(calls[0].args, ["/managed/uninstall-helper.js", "--uninstall", "--remove-user-data"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
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
      execFileImpl: async (command, args) => {
        execCalls.push([command, args]);
        return { stdout: "", stderr: "" };
      },
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
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
    });
    assert.equal(result.userDataRemoved, true);
    assert.equal(await exists(fixture.installRoot), false);
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
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
    });
    assert.equal(await exists(fixture.manifestPath), true);
  } finally {
    await fs.rm(fixture.homeDir, { recursive: true, force: true });
  }
});
