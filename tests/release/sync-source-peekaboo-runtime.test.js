import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectSourcePeekabooRuntime } from "../../src/equinox-local-source-runtime.js";
import { syncSourcePeekabooRuntime } from "../../scripts/release/sync-source-peekaboo-runtime.mjs";

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-peekaboo-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.chmod(root, 0o700);
  const tunnelClient = path.join(root, "tunnel-client");
  const sourceLauncher = path.join(root, "start-source.sh");
  const configPath = path.join(root, "runtime.conf");
  await fs.writeFile(tunnelClient, "#!/bin/sh\necho '0.0.13+fixture'\n", { mode: 0o755 });
  await fs.writeFile(sourceLauncher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(configPath, `launchAgentLabel=dev.equinox.local.dev\ntunnelRuntime=equinox-local-dev\ntunnelClient=${tunnelClient}\nsourceLauncher=${sourceLauncher}\n`, { mode: 0o600 });
  return { root, configPath };
}

async function fakeInstall(releaseDir) {
  const destination = path.join(releaseDir, "runtime", "peekaboo");
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(destination, "peekaboo"), "#!/bin/sh\necho 'Peekaboo 4.3.0 (fixture)'\n", { mode: 0o755 });
  await fs.writeFile(path.join(destination, "libswiftCompatibilitySpan.dylib"), "fixture\n", { mode: 0o755 });
  await fs.writeFile(path.join(destination, "LICENSE"), "MIT License\n", { mode: 0o600 });
  await fs.writeFile(path.join(destination, "README.md"), "fixture\n", { mode: 0o600 });
  await fs.writeFile(path.join(destination, "VERSION"), "4.3.0\n", { mode: 0o600 });
}

test("source Peekaboo sync installs and pins the managed developer runtime", async (t) => {
  const item = await makeFixture(t);
  const result = await syncSourcePeekabooRuntime({
    configPath: item.configPath,
    homeDir: item.root,
    installPinnedPeekabooRuntimeImpl: fakeInstall,
  });
  assert.deepEqual(result, { changed: true, version: "4.3.0" });
  const status = await inspectSourcePeekabooRuntime({ configPath: item.configPath });
  assert.equal(status.synchronized, true);
  const configText = await fs.readFile(item.configPath, "utf8");
  const managedLine = configText.split(/\r?\n/u).find((line) => line.startsWith("peekabooPath="));
  assert.ok(managedLine);
  assert.equal(managedLine.includes("Equinox Local Developer/runtime/peekaboo/versions/4.3.0/peekaboo"), true);
});

test("source Peekaboo sync is a no-op once the pinned runtime is healthy", async (t) => {
  const item = await makeFixture(t);
  await syncSourcePeekabooRuntime({ configPath: item.configPath, homeDir: item.root, installPinnedPeekabooRuntimeImpl: fakeInstall });
  let installCalls = 0;
  const result = await syncSourcePeekabooRuntime({
    configPath: item.configPath,
    homeDir: item.root,
    installPinnedPeekabooRuntimeImpl: async (...args) => {
      installCalls += 1;
      return fakeInstall(...args);
    },
  });
  assert.deepEqual(result, { changed: false, version: "4.3.0" });
  assert.equal(installCalls, 0);
});
