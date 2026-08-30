import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectSourceTunnelRuntime,
  parseSourceRuntimeConfig,
  parseTunnelClientVersion,
  readSourceRuntimeConfig,
} from "../../src/equinox-local-source-runtime.js";

async function fixture(t, version = "0.0.13") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-source-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "equinox-tunnel-client");
  const configPath = path.join(root, "runtime.conf");
  await fs.writeFile(binary, `#!/bin/sh\necho '${version}+test (git sha: test)'\n`, { mode: 0o755 });
  await fs.writeFile(configPath, `launchAgentLabel=dev.equinox.local.dev\ntunnelRuntime=equinox-local-dev\ntunnelClient=${binary}\n`, { mode: 0o600 });
  return { root, binary, configPath };
}

test("source runtime config is bounded, private and parses only supported fields", async (t) => {
  const item = await fixture(t);
  const loaded = await readSourceRuntimeConfig({ configPath: item.configPath });
  assert.equal(loaded.configured, true);
  assert.equal(loaded.config.tunnelClient, item.binary);
  assert.throws(() => parseSourceRuntimeConfig(`tunnelClient=${item.binary}\nextra=value\n`), /unsupported field/u);
  assert.equal(parseTunnelClientVersion("0.0.13+abcdef (git sha: abcdef)"), "0.0.13");
});

test("source tunnel inspection reports pinned-version drift without exposing paths", async (t) => {
  const item = await fixture(t, "0.0.12");
  const result = await inspectSourceTunnelRuntime({ configPath: item.configPath });
  assert.equal(result.configured, true);
  assert.equal(result.expectedVersion, "0.0.13");
  assert.equal(result.actualVersion, "0.0.12");
  assert.equal(result.synchronized, false);
  assert.equal(result.needsAttention, true);
  assert.equal(JSON.stringify(result).includes(item.root), false);
});

test("missing source tunnel config is optional rather than a false drift alert", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-source-runtime-missing-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await inspectSourceTunnelRuntime({ configPath: path.join(root, "missing.conf") });
  assert.deepEqual(result, {
    configured: false,
    expectedVersion: "0.0.13",
    actualVersion: null,
    synchronized: null,
    needsAttention: false,
  });
});
