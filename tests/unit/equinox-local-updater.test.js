import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  canonicalUpdateManifestPayload,
  compareEquinoxVersions,
  createEquinoxLocalUpdater,
  validateSignedUpdateManifest,
} from "../../src/equinox-local-updater.js";
import { resolveEquinoxLocalInstallation } from "../../src/equinox-local-installation.js";
import { EQUINOX_LOCAL_UPDATE_KEYS } from "../../src/equinox-local-update-keys.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" });
const KEY_ID = "stable-test-1";

function signedManifest(overrides = {}) {
  const base = {
    schemaVersion: 1,
    channel: "stable",
    target: "darwin-arm64",
    version: "4.3.0",
    publishedAt: "2026-08-25T00:00:00.000Z",
    artifact: {
      url: "https://local.sametbasbug.dev/downloads/updates/equinox-local-4.3.0-darwin-arm64.tar.gz",
      sha256: "a".repeat(64),
      bytes: 123456,
    },
    ...overrides,
  };
  const unsigned = {
    schemaVersion: base.schemaVersion,
    channel: base.channel,
    target: base.target,
    version: base.version,
    publishedAt: base.publishedAt,
    artifact: base.artifact,
  };
  const value = sign(
    null,
    Buffer.from(canonicalUpdateManifestPayload(unsigned), "utf8"),
    privateKey,
  ).toString("base64");
  return {
    ...unsigned,
    signature: { algorithm: "ed25519", keyId: KEY_ID, value },
  };
}

test("shipped stable update keyring contains the provisioned Ed25519 public key", () => {
  assert.deepEqual(Object.keys(EQUINOX_LOCAL_UPDATE_KEYS), ["stable-2026-01"]);
  const pem = EQUINOX_LOCAL_UPDATE_KEYS["stable-2026-01"];
  assert.match(pem, /^-----BEGIN PUBLIC KEY-----/u);
  assert.equal(createPublicKey(pem).asymmetricKeyType, "ed25519");
});

test("version comparison is strict and monotonic", () => {
  assert.equal(compareEquinoxVersions("4.2.0", "4.2.0"), 0);
  assert.equal(compareEquinoxVersions("4.2.0", "4.2.1"), -1);
  assert.equal(compareEquinoxVersions("5.0.0", "4.99.99"), 1);
  assert.throws(() => compareEquinoxVersions("4.2", "4.2.0"), /Unsupported/u);
});

test("managed installation is accepted only in the per-user Equinox Local releases root", () => {
  const home = "/Users/example";
  const root = "/Users/example/Library/Application Support/Equinox Local";
  const managed = resolveEquinoxLocalInstallation({
    homeDir: home,
    env: {
      EQUINOX_LOCAL_INSTALL_ROOT: root,
      EQUINOX_LOCAL_RELEASE_DIR: `${root}/releases/4.2.0`,
    },
  });
  assert.equal(managed.kind, "managed");
  assert.equal(managed.selfUpdateSupported, true);
  assert.equal(managed.currentLink, `${root}/current`);

  const escaped = resolveEquinoxLocalInstallation({
    homeDir: home,
    env: {
      EQUINOX_LOCAL_INSTALL_ROOT: root,
      EQUINOX_LOCAL_RELEASE_DIR: "/tmp/fake-release",
    },
  });
  assert.equal(escaped.selfUpdateSupported, false);

  const source = resolveEquinoxLocalInstallation({ homeDir: home, env: {} });
  assert.equal(source.kind, "source");
  assert.equal(source.selfUpdateSupported, false);
});

test("signed update manifest is pinned to Equinox HTTPS paths and trusted Ed25519 keys", () => {
  const manifest = signedManifest();
  const verified = validateSignedUpdateManifest(manifest, {
    publicKeys: { [KEY_ID]: PUBLIC_PEM },
    target: "darwin-arm64",
  });
  assert.equal(verified.version, "4.3.0");

  const tampered = structuredClone(manifest);
  tampered.version = "9.9.9";
  assert.throws(
    () => validateSignedUpdateManifest(tampered, { publicKeys: { [KEY_ID]: PUBLIC_PEM }, target: "darwin-arm64" }),
    /signature verification/u,
  );

  const offOrigin = signedManifest({
    artifact: {
      ...manifest.artifact,
      url: "https://evil.example/equinox-local.tar.gz",
    },
  });
  assert.throws(
    () => validateSignedUpdateManifest(offOrigin, { publicKeys: { [KEY_ID]: PUBLIC_PEM }, target: "darwin-arm64" }),
    /pinned Equinox Local HTTPS update path/u,
  );

  assert.throws(
    () => validateSignedUpdateManifest(manifest, { publicKeys: { [KEY_ID]: PUBLIC_PEM }, target: "darwin-x64" }),
    /target does not match/u,
  );
});

test("updater checks a signed stable manifest only for managed configured installs", async () => {
  const root = "/Users/example/Library/Application Support/Equinox Local";
  const installation = resolveEquinoxLocalInstallation({
    homeDir: "/Users/example",
    env: {
      EQUINOX_LOCAL_INSTALL_ROOT: root,
      EQUINOX_LOCAL_RELEASE_DIR: `${root}/releases/4.2.0`,
    },
  });
  const calls = [];
  const updater = createEquinoxLocalUpdater({
    currentVersion: "4.2.0",
    installation,
    publicKeys: { [KEY_ID]: PUBLIC_PEM },
    target: "darwin-arm64",
    now: () => new Date("2026-08-25T01:00:00.000Z"),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify(signedManifest()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const status = await updater.check();
  assert.equal(status.selfUpdateSupported, true);
  assert.equal(status.updateAvailable, true);
  assert.equal(status.latestVersion, "4.3.0");
  assert.equal(status.checkedAt, "2026-08-25T01:00:00.000Z");
  assert.equal(updater.candidate()?.version, "4.3.0");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://local.sametbasbug.dev/downloads/updates/stable-darwin-arm64.json");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.credentials, "omit");

  const sourceUpdater = createEquinoxLocalUpdater({
    currentVersion: "4.2.0",
    installation: resolveEquinoxLocalInstallation({ homeDir: "/Users/example", env: {} }),
    publicKeys: { [KEY_ID]: PUBLIC_PEM },
    target: "darwin-arm64",
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
  });
  const sourceStatus = await sourceUpdater.check();
  assert.equal(sourceStatus.selfUpdateSupported, false);
  assert.match(sourceStatus.reason, /source checkout/u);
});

test("a failed re-check clears the previously verified install candidate", async () => {
  const root = "/Users/example/Library/Application Support/Equinox Local";
  const installation = resolveEquinoxLocalInstallation({
    homeDir: "/Users/example",
    env: {
      EQUINOX_LOCAL_INSTALL_ROOT: root,
      EQUINOX_LOCAL_RELEASE_DIR: `${root}/releases/4.2.0`,
    },
  });
  let call = 0;
  const updater = createEquinoxLocalUpdater({
    currentVersion: "4.2.0",
    installation,
    publicKeys: { [KEY_ID]: PUBLIC_PEM },
    target: "darwin-arm64",
    fetchImpl: async () => {
      call += 1;
      return new Response(call === 1 ? JSON.stringify(signedManifest()) : "not-json", { status: 200 });
    },
  });

  await updater.check();
  assert.equal(updater.candidate()?.version, "4.3.0");
  await assert.rejects(updater.check(), /invalid JSON/u);
  assert.equal(updater.candidate(), null);
  assert.equal(updater.snapshot().updateAvailable, null);
  assert.match(updater.snapshot().lastError, /invalid JSON/u);
});
