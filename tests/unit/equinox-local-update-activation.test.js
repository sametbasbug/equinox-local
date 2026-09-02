import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activatePreparedEquinoxRelease,
  atomicSwitchCurrentRelease,
  kickstartEquinoxLocalLaunchAgent,
  readManagedCurrentRelease,
} from "../../src/equinox-local-update-activation.js";
import { equinoxLocalUpdateTarget } from "../../src/equinox-local-updater.js";

async function makeInstall() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-activation-"));
  const installRoot = path.join(root, "Equinox Local");
  const releasesRoot = path.join(installRoot, "releases");
  await fs.mkdir(releasesRoot, { recursive: true });
  const target = equinoxLocalUpdateTarget();
  for (const version of ["4.2.0", "4.3.0"]) {
    const release = path.join(releasesRoot, version);
    const nodeBinary = path.join(release, "runtime", "node", "bin", "node");
    const tunnelDir = path.join(release, "runtime", "tunnel");
    const peekabooDir = path.join(release, "runtime", "peekaboo");
    await fs.mkdir(path.dirname(nodeBinary), { recursive: true });
    await fs.mkdir(tunnelDir, { recursive: true });
    await fs.mkdir(peekabooDir, { recursive: true });
    await fs.writeFile(path.join(release, "release.json"), JSON.stringify({
      schemaVersion: 1,
      version,
      target,
      nodeVersion: "24.19.0",
      tunnelClientVersion: "0.0.12",
      serverEntry: "server.js",
    }));
    await fs.writeFile(nodeBinary, "fixture-node\n");
    await fs.chmod(nodeBinary, 0o755);
    for (const name of ["tunnel-client", "cloudflared"]) {
      const binary = path.join(tunnelDir, name);
      await fs.writeFile(binary, `${name}\n`);
      await fs.chmod(binary, 0o755);
    }
    for (const name of ["peekaboo", "libswiftCompatibilitySpan.dylib"]) {
      const binary = path.join(peekabooDir, name);
      await fs.writeFile(binary, `${name}\n`);
      await fs.chmod(binary, 0o755);
    }
  }
  const currentLink = path.join(installRoot, "current");
  await fs.symlink("releases/4.2.0", currentLink, "dir");
  return {
    root,
    installation: {
      kind: "managed",
      managed: true,
      selfUpdateSupported: true,
      installRoot,
      releasesRoot,
      stagingRoot: path.join(installRoot, "staging"),
      currentLink,
      launchAgentPath: path.join(root, "dev.equinox.local.plist"),
      launchAgentLabel: "dev.equinox.local",
    },
  };
}

async function currentVersion(installation) {
  return (await readManagedCurrentRelease(installation)).version;
}

test("current release switch is atomic and remains inside the managed releases root", async (t) => {
  const fixture = await makeInstall();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  assert.equal(await currentVersion(fixture.installation), "4.2.0");
  const result = await atomicSwitchCurrentRelease(fixture.installation, "4.3.0");
  assert.equal(result.changed, true);
  assert.equal(result.previous.version, "4.2.0");
  assert.equal(await currentVersion(fixture.installation), "4.3.0");
  assert.equal(await fs.readlink(fixture.installation.currentLink), "releases/4.3.0");
  await assert.rejects(
    atomicSwitchCurrentRelease(fixture.installation, "../evil"),
    /Unsupported Equinox Local version/u,
  );
});

test("managed LaunchAgent restart drains the exact runtime child before reload and never uses kickstart -k", async (t) => {
  const fixture = await makeInstall();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const calls = [];
  let loaded = true;
  let childAlive = true;
  const execFileImpl = async (command, args) => {
    calls.push([command, ...args]);
    if (command === "/bin/launchctl" && args[0] === "print") {
      if (!loaded) throw Object.assign(new Error("not loaded"), { code: 3 });
      return { stdout: "state = running\n\tpid = 123\n" };
    }
    if (command === "/usr/bin/pgrep") return { stdout: "456\n" };
    if (command === "/bin/ps") return { stdout: "501 123\n" };
    if (command === "/bin/kill" && args[0] === "-TERM") {
      childAlive = false;
      return { stdout: "" };
    }
    if (command === "/bin/kill" && args[0] === "-0") {
      if (childAlive) return { stdout: "" };
      throw Object.assign(new Error("gone"), { code: 1 });
    }
    if (command === "/bin/launchctl" && args[0] === "bootout") {
      loaded = false;
      return { stdout: "" };
    }
    if (command === "/bin/launchctl" && args[0] === "bootstrap") {
      loaded = true;
      return { stdout: "" };
    }
    if (command === "/bin/launchctl" && args[0] === "kickstart") return { stdout: "" };
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

  await kickstartEquinoxLocalLaunchAgent(fixture.installation, {
    execFileImpl,
    uid: 501,
    sleepImpl: async () => {},
  });

  assert.equal(calls.some((call) => call[0] === "/bin/kill" && call[1] === "-TERM" && call[2] === "456"), true);
  assert.equal(calls.some((call) => call[0] === "/bin/launchctl" && call[1] === "bootout"), true);
  assert.equal(calls.some((call) => call[0] === "/bin/launchctl" && call[1] === "bootstrap"), true);
  assert.equal(calls.some((call) => call[0] === "/bin/launchctl" && call[1] === "kickstart" && call.includes("-k")), false);
});

test("successful activation restarts and accepts only the requested healthy version", async (t) => {
  const fixture = await makeInstall();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const restarts = [];
  const appSyncs = [];
  const result = await activatePreparedEquinoxRelease({
    installation: fixture.installation,
    targetVersion: "4.3.0",
    kickstartImpl: async (version) => restarts.push(version),
    syncAppHostImpl: async ({ version }) => appSyncs.push(version),
    fetchImpl: async () => new Response(JSON.stringify({
      status: {
        server: { version: await currentVersion(fixture.installation) },
        health: { state: "HEALTHY" },
      },
    }), { status: 200 }),
    sleepImpl: async () => {},
    healthAttempts: 2,
    now: () => new Date("2026-08-25T02:00:00.000Z"),
  });
  assert.deepEqual(restarts, ["4.3.0"]);
  assert.deepEqual(appSyncs, ["4.3.0"]);
  assert.equal(result.status, "activated");
  assert.equal(await currentVersion(fixture.installation), "4.3.0");
  const state = JSON.parse(await fs.readFile(path.join(fixture.installation.installRoot, "update-state.json"), "utf8"));
  assert.equal(state.status, "activated");
  assert.equal(state.version, "4.3.0");
  assert.equal(state.previousVersion, "4.2.0");
});

test("failed target health automatically restores and verifies the previous release", async (t) => {
  const fixture = await makeInstall();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const restarts = [];
  const appSyncs = [];
  let targetHealthAttempts = 0;
  const fetchImpl = async () => {
    const version = await currentVersion(fixture.installation);
    if (version === "4.3.0") {
      targetHealthAttempts += 1;
      throw new Error("new runtime unavailable");
    }
    return new Response(JSON.stringify({
      status: {
        server: { version },
        health: { state: "HEALTHY" },
      },
    }), { status: 200 });
  };

  await assert.rejects(
    activatePreparedEquinoxRelease({
      installation: fixture.installation,
      targetVersion: "4.3.0",
      kickstartImpl: async (version) => restarts.push(version),
      syncAppHostImpl: async ({ version }) => appSyncs.push(version),
      fetchImpl,
      sleepImpl: async () => {},
      healthAttempts: 2,
      now: () => new Date("2026-08-25T02:05:00.000Z"),
    }),
    /was rolled back to 4\.2\.0/u,
  );
  assert.equal(targetHealthAttempts, 2);
  assert.deepEqual(restarts, ["4.3.0", "4.2.0"]);
  assert.deepEqual(appSyncs, ["4.3.0", "4.2.0"]);
  assert.equal(await currentVersion(fixture.installation), "4.2.0");
  const state = JSON.parse(await fs.readFile(path.join(fixture.installation.installRoot, "update-state.json"), "utf8"));
  assert.equal(state.status, "rolled-back");
  assert.equal(state.failedVersion, "4.3.0");
  assert.equal(state.version, "4.2.0");
});
