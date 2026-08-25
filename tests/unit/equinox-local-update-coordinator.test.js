import assert from "node:assert/strict";
import test from "node:test";

import {
  createEquinoxLocalUpdateCoordinator,
  scheduleEquinoxLocalActivation,
} from "../../src/equinox-local-update-coordinator.js";
import { runEquinoxLocalUpdateHelper } from "../../src/equinox-local-update-helper.js";

function managedInstallation() {
  const installRoot = "/Users/example/Library/Application Support/Equinox Local";
  return {
    kind: "managed",
    managed: true,
    selfUpdateSupported: true,
    installRoot,
    releasesRoot: `${installRoot}/releases`,
    stagingRoot: `${installRoot}/staging`,
    currentLink: `${installRoot}/current`,
    releaseDir: `${installRoot}/releases/4.2.0`,
    launchAgentLabel: "dev.equinox.local",
  };
}

function updaterStub({ available = true } = {}) {
  const candidate = available
    ? {
        schemaVersion: 1,
        channel: "stable",
        target: "darwin-arm64",
        version: "4.3.0",
        publishedAt: "2026-08-25T00:00:00.000Z",
        artifact: {
          url: "https://local.sametbasbug.dev/downloads/updates/equinox-local-4.3.0-darwin-arm64.tar.gz",
          sha256: "a".repeat(64),
          bytes: 100,
        },
        signature: { algorithm: "ed25519", keyId: "stable-1", value: "x".repeat(88) },
      }
    : null;
  return {
    snapshot: () => ({
      currentVersion: "4.2.0",
      selfUpdateSupported: true,
      updateAvailable: available,
      latestVersion: candidate?.version ?? "4.2.0",
    }),
    candidate: () => candidate,
  };
}

test("detached activation helper receives only a minimal credential-free environment", () => {
  const calls = [];
  const child = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const installation = managedInstallation();
  const result = scheduleEquinoxLocalActivation({
    installation,
    version: "4.3.0",
    nodePath: "/managed/node",
    helperPath: "/managed/helper.js",
    sourceEnv: {
      HOME: "/Users/example",
      USER: "example",
      LOGNAME: "example",
      TMPDIR: "/tmp/example",
      OPENAI_API_KEY: "must-not-leak",
      GITHUB_TOKEN: "must-not-leak",
      PATH: "/malicious/path",
    },
    spawnImpl: (...args) => {
      calls.push(args);
      return child;
    },
  });
  assert.equal(result.scheduled, true);
  assert.equal(child.unrefCalled, true);
  assert.equal(calls.length, 1);
  const [command, args, options] = calls[0];
  assert.equal(command, "/managed/node");
  assert.deepEqual(args, ["/managed/helper.js", "--activate", "4.3.0"]);
  assert.equal(options.detached, true);
  assert.equal(options.stdio, "ignore");
  assert.equal(options.env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(options.env.EQUINOX_LOCAL_INSTALL_ROOT, installation.installRoot);
  assert.equal(options.env.EQUINOX_LOCAL_RELEASE_DIR, installation.releaseDir);
  assert.equal("OPENAI_API_KEY" in options.env, false);
  assert.equal("GITHUB_TOKEN" in options.env, false);
});

test("coordinator prepares only a newer verified candidate and schedules activation", async () => {
  const installation = managedInstallation();
  const prepared = [];
  const spawned = [];
  const coordinator = createEquinoxLocalUpdateCoordinator({
    installation,
    updater: updaterStub(),
    prepareRelease: async ({ installation: actualInstallation, manifest }) => {
      prepared.push({ actualInstallation, manifest });
      return { fileCount: 42, extractedBytes: 1234 };
    },
    nodePath: "/managed/node",
    helperPath: "/managed/helper.js",
    sourceEnv: { HOME: "/Users/example" },
    spawnImpl: (...args) => {
      spawned.push(args);
      return { unref() {} };
    },
  });
  const result = await coordinator.apply();
  assert.equal(result.scheduled, true);
  assert.equal(result.targetVersion, "4.3.0");
  assert.equal(result.fileCount, 42);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0].manifest.version, "4.3.0");
  assert.equal(spawned.length, 1);
  assert.equal(coordinator.snapshot().restartScheduledFor, "4.3.0");
});

test("coordinator refuses install before a newer signed candidate exists", async () => {
  const coordinator = createEquinoxLocalUpdateCoordinator({
    installation: managedInstallation(),
    updater: updaterStub({ available: false }),
    prepareRelease: async () => {
      throw new Error("must not prepare");
    },
  });
  await assert.rejects(coordinator.apply(), /Check for updates/u);
});

test("update helper validates managed environment and delegates activation after delay", async () => {
  const installation = managedInstallation();
  const delays = [];
  const activations = [];
  const result = await runEquinoxLocalUpdateHelper({
    argv: ["--activate", "4.3.0"],
    env: {
      HOME: "/Users/example",
      EQUINOX_LOCAL_INSTALL_ROOT: installation.installRoot,
      EQUINOX_LOCAL_RELEASE_DIR: installation.releaseDir,
    },
    homeDir: "/Users/example",
    sleepImpl: async (ms) => delays.push(ms),
    activateImpl: async (args) => {
      activations.push(args);
      return { status: "activated", version: args.targetVersion };
    },
  });
  assert.deepEqual(delays, [1500]);
  assert.equal(activations.length, 1);
  assert.equal(activations[0].targetVersion, "4.3.0");
  assert.equal(activations[0].installation.selfUpdateSupported, true);
  assert.equal(result.status, "activated");
});
