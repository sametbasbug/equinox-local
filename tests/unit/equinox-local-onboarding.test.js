import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  configureManagedTunnel,
  getManagedOnboardingStatus,
  validateTunnelOnboardingInput,
} from "../../src/equinox-local-onboarding.js";
import { managedSupervisorPaths } from "../../src/equinox-local-supervisor.js";

const TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef";
const RUNTIME_KEY = "runtime-secret-value-0123456789";

async function makeManagedFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-onboarding-"));
  const homeDir = path.join(root, "Home With Space");
  const paths = managedSupervisorPaths(homeDir);
  const releaseDir = path.join(paths.releasesRoot, "4.2.0");
  await fs.mkdir(releaseDir, { recursive: true });
  return {
    root,
    homeDir,
    paths,
    installation: {
      managed: true,
      selfUpdateSupported: true,
      installRoot: paths.installRoot,
      releaseDir,
    },
  };
}

test("tunnel onboarding accepts only the documented tunnel id shape and opaque bounded key", () => {
  const input = validateTunnelOnboardingInput({ tunnelId: TUNNEL_ID, runtimeKey: RUNTIME_KEY });
  assert.equal(input.tunnelId, TUNNEL_ID);
  assert.equal(input.runtimeKey, RUNTIME_KEY);
  assert.throws(
    () => validateTunnelOnboardingInput({ tunnelId: "tunnel_zz23456789abcdef0123456789abcdef", runtimeKey: RUNTIME_KEY }),
    /lowercase hexadecimal/u,
  );
  assert.throws(
    () => validateTunnelOnboardingInput({ tunnelId: TUNNEL_ID, runtimeKey: ` ${RUNTIME_KEY}` }),
    /whitespace/u,
  );
  assert.throws(
    () => validateTunnelOnboardingInput({ tunnelId: TUNNEL_ID, runtimeKey: RUNTIME_KEY, extra: true }),
    /only tunnelId and runtimeKey/u,
  );
});

test("managed tunnel configuration stores the secret privately and status never returns it", async (t) => {
  const fixture = await makeManagedFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const result = await configureManagedTunnel({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    tunnelId: TUNNEL_ID,
    runtimeKey: RUNTIME_KEY,
  });
  assert.deepEqual(result, { configured: true, tunnelId: TUNNEL_ID, restartRequired: true });
  assert.equal(await fs.readFile(fixture.paths.runtimeKeyPath, "utf8"), RUNTIME_KEY);
  assert.equal((await fs.lstat(fixture.paths.runtimeKeyPath)).mode & 0o077, 0);
  assert.equal((await fs.lstat(fixture.paths.transportConfigPath)).mode & 0o077, 0);

  const localOnly = await getManagedOnboardingStatus({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    supervisorMode: "local-only",
  });
  assert.equal(localOnly.transportConfigured, true);
  assert.equal(localOnly.tunnelId, TUNNEL_ID);
  assert.equal(localOnly.connectedThroughTunnel, false);
  assert.equal(localOnly.needsAttention, true);
  assert.equal(JSON.stringify(localOnly).includes(RUNTIME_KEY), false);

  const tunnel = await getManagedOnboardingStatus({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    supervisorMode: "tunnel",
  });
  assert.equal(tunnel.connectedThroughTunnel, true);
  assert.equal(tunnel.needsAttention, false);
  assert.equal(JSON.stringify(tunnel).includes(RUNTIME_KEY), false);
});

test("source checkout onboarding reports unavailable without touching disk", async () => {
  const status = await getManagedOnboardingStatus({
    installation: { managed: false, selfUpdateSupported: false },
    homeDir: "/Users/example",
  });
  assert.equal(status.available, false);
  assert.equal(status.supervisorMode, "source");
});
