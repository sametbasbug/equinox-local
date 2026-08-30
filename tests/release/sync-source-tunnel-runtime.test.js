import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectSourceTunnelRuntime } from "../../src/equinox-local-source-runtime.js";
import { syncSourceTunnelRuntime } from "../../scripts/release/sync-source-tunnel-runtime.mjs";

async function makeFixture(t, version = "0.0.12") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-tunnel-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o700);
  const binary = path.join(root, "equinox-tunnel-client");
  const configPath = path.join(root, "runtime.conf");
  await fs.writeFile(binary, `#!/bin/sh\necho '${version}+fixture (git sha: fixture)'\n`, { mode: 0o755 });
  await fs.writeFile(configPath, `launchAgentLabel=dev.equinox.local.dev\ntunnelRuntime=equinox-local-dev\ntunnelClient=${binary}\n`, { mode: 0o600 });
  return { root, binary, configPath };
}

async function fakeInstall(_target, releaseDir) {
  const destination = path.join(releaseDir, "runtime", "tunnel");
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(destination, "tunnel-client"), "#!/bin/sh\necho '0.0.13+fixture (git sha: fixture)'\n", { mode: 0o755 });
  await fs.writeFile(path.join(destination, "cloudflared"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

test("source tunnel sync migrates a stale external runtime into the private pinned runtime directory", async (t) => {
  const item = await makeFixture(t);
  const result = await syncSourceTunnelRuntime({
    configPath: item.configPath,
    homeDir: item.root,
    target: "darwin-arm64",
    installPinnedTunnelRuntimeImpl: fakeInstall,
  });
  assert.deepEqual(result, { changed: true, version: "0.0.13" });
  const status = await inspectSourceTunnelRuntime({ configPath: item.configPath });
  assert.equal(status.synchronized, true);
  const configText = await fs.readFile(item.configPath, "utf8");
  const managedLine = configText.split(/\r?\n/u).find((line) => line.startsWith("tunnelClient="));
  const managedBinary = managedLine.slice("tunnelClient=".length);
  assert.notEqual(managedBinary, item.binary);
  assert.equal(managedBinary.startsWith(path.join(item.root, "Library", "Application Support", "Equinox Local Developer")), true);
  assert.equal((await fs.lstat(managedBinary)).isFile(), true);
  assert.equal((await fs.lstat(path.join(path.dirname(managedBinary), "cloudflared"))).isFile(), true);
});

test("source tunnel sync is a no-op after the private pinned runtime is installed", async (t) => {
  const item = await makeFixture(t);
  await syncSourceTunnelRuntime({
    configPath: item.configPath,
    homeDir: item.root,
    target: "darwin-arm64",
    installPinnedTunnelRuntimeImpl: fakeInstall,
  });
  let installCalls = 0;
  const result = await syncSourceTunnelRuntime({
    configPath: item.configPath,
    homeDir: item.root,
    target: "darwin-arm64",
    installPinnedTunnelRuntimeImpl: async (...args) => {
      installCalls += 1;
      return fakeInstall(...args);
    },
  });
  assert.deepEqual(result, { changed: false, version: "0.0.13" });
  assert.equal(installCalls, 0);
});

test("source tunnel sync refuses a symlinked private runtime root", async (t) => {
  const item = await makeFixture(t);
  const appSupport = path.join(item.root, "Library", "Application Support");
  const elsewhere = path.join(item.root, "elsewhere");
  await fs.mkdir(appSupport, { recursive: true, mode: 0o700 });
  await fs.mkdir(elsewhere, { mode: 0o700 });
  await fs.symlink(elsewhere, path.join(appSupport, "Equinox Local Developer"));
  await assert.rejects(
    () => syncSourceTunnelRuntime({
      configPath: item.configPath,
      homeDir: item.root,
      target: "darwin-arm64",
      installPinnedTunnelRuntimeImpl: fakeInstall,
    }),
    /unsafe/u,
  );
});
