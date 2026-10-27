import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from "../../src/equinox-local-platform.js";
import {
  canonicalMainInstallPointerPayload,
  createSignedMainInstallPointer,
  validateSignedMainInstallPointer,
} from "../../src/equinox-local-main-install-pointer.js";

const SHA = "a".repeat(40);
const KEY_ID = "stable-2026-01";
const PUBLISHED = "2026-10-27T12:00:00.000Z";

function nativeManifests(sha = SHA) {
  return EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS.map((target, index) => ({
    schemaVersion: 1,
    channel: "main",
    sourceSha: sha,
    target,
    runtimeContractSha256: String(index + 1).repeat(64),
    artifact: {
      name: "equinox-local-main-" + sha + "-" + target + (target.startsWith("win32-") ? ".zip" : ".tar.gz"),
      sha256: String(index + 5).repeat(64),
      bytes: 1000 + index,
    },
  }));
}

function signedFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pointer = createSignedMainInstallPointer({
    sourceSha: SHA,
    version: "6.2.1",
    publishedAt: PUBLISHED,
    nativeManifests: nativeManifests(),
    keyId: KEY_ID,
    privateKey,
  });
  return { pointer, privateKey, publicKeys: { [KEY_ID]: publicKey.export({ type: "spki", format: "pem" }) } };
}

function mutate(pointer, modify) {
  const clone = structuredClone(pointer);
  modify(clone);
  return clone;
}

test("signed Main pointer binds all four immutable R2 native artifacts to exact source SHA", () => {
  const { pointer, publicKeys } = signedFixture();
  const accepted = validateSignedMainInstallPointer(pointer, { publicKeys, expectedSourceSha: SHA });
  assert.equal(accepted.sourceSha, SHA);
  assert.equal(accepted.version, "6.2.1");
  assert.equal(accepted.targets.length, 4);
  assert.deepEqual(accepted.targets.map((entry) => entry.target), [...EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS]);
  for (const entry of accepted.targets) {
    assert.equal(entry.artifact.url, "https://main.local.sametbasbug.dev/snapshots/" + SHA + "/equinox-local-main-" + SHA + "-" + entry.target +
      (entry.target.startsWith("win32-") ? ".zip" : ".tar.gz"));
  }
  assert.equal(canonicalMainInstallPointerPayload({
    schemaVersion: pointer.schemaVersion,
    channel: pointer.channel,
    sourceSha: pointer.sourceSha,
    version: pointer.version,
    publishedAt: pointer.publishedAt,
    targets: pointer.targets,
  }), JSON.stringify({
    schemaVersion: pointer.schemaVersion,
    channel: pointer.channel,
    sourceSha: pointer.sourceSha,
    version: pointer.version,
    publishedAt: pointer.publishedAt,
    targets: pointer.targets,
  }));
});

test("Main pointer signing refuses incomplete, wrong-SHA, duplicate, reordered or off-target native manifests", () => {
  const { privateKey } = signedFixture();
  const sign = (native) => createSignedMainInstallPointer({
    sourceSha: SHA, version: "6.2.1", publishedAt: PUBLISHED, nativeManifests: native,
    keyId: KEY_ID, privateKey,
  });
  assert.throws(() => sign(nativeManifests().slice(1)), /Four admitted/u);
  assert.throws(() => sign(nativeManifests("b".repeat(40))), /source SHA/u);
  assert.throws(() => sign(nativeManifests().reverse()), /target/u);
  assert.throws(() => sign(nativeManifests().map((item) => ({ ...item, target: "win32-x64" }))), /target/u);
  assert.throws(() => sign(nativeManifests().map((item) => ({
    ...item, artifact: { ...item.artifact, sha256: "not-hex" },
  }))), /SHA-256/u);
});

test("Main pointer refuses tampering, unsafe URLs, wrong signature key, stale SHA, and unsupported fields", () => {
  const { pointer, publicKeys } = signedFixture();
  assert.throws(() => validateSignedMainInstallPointer(pointer, {
    publicKeys, expectedSourceSha: "b".repeat(40),
  }), /expected SHA/u);
  assert.throws(() => validateSignedMainInstallPointer(pointer, { publicKeys: {} }), /trusted/u);
  assert.throws(() => validateSignedMainInstallPointer(
    mutate(pointer, (x) => { x.targets[0].artifact.sha256 = "f".repeat(64); }), { publicKeys },
  ), /signature verification/u);
  assert.throws(() => validateSignedMainInstallPointer(
    mutate(pointer, (x) => { x.version = "9.9.9"; }), { publicKeys },
  ), /signature verification/u);
  assert.throws(() => validateSignedMainInstallPointer(
    mutate(pointer, (x) => { x.targets[0].artifact.url = "https://attacker.invalid/archive.tar.gz"; }), { publicKeys },
  ), /URL/u);
  assert.throws(() => validateSignedMainInstallPointer(
    mutate(pointer, (x) => { x.targets.reverse(); }), { publicKeys },
  ), /target order/u);
  assert.throws(() => validateSignedMainInstallPointer(
    mutate(pointer, (x) => { x.signature.keyId = "unknown"; }), { publicKeys },
  ), /trusted/u);
  assert.throws(() => validateSignedMainInstallPointer(
    mutate(pointer, (x) => { x.unknown = "bypass"; }), { publicKeys },
  ), /fields/u);
  assert.throws(() => validateSignedMainInstallPointer(
    mutate(pointer, (x) => { x.signature.value = "A".repeat(88); }), { publicKeys },
  ), /canonical Ed25519/u);
  assert.throws(() => validateSignedMainInstallPointer(
    mutate(pointer, (x) => { x.sourceSha = "0".repeat(40); }), { publicKeys },
  ), /URL/u);
});

test("Main pointer signing requires an Ed25519 private key, and never creates a key", () => {
  const native = nativeManifests();
  const sign = (privateKey) => createSignedMainInstallPointer({
    sourceSha: SHA, version: "6.2.1", publishedAt: PUBLISHED, nativeManifests: native, keyId: KEY_ID, privateKey,
  });
  assert.throws(() => sign(undefined), /private signing key/u);
  const { publicKey } = generateKeyPairSync("ed25519");
  assert.throws(() => sign(publicKey), /private signing key/u);
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => sign(privateKey), /private signing key/u);
});


test("existing private-key signer CLI loads only bounded normal Main manifests and writes an exclusive private receipt", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-sign-cli-"));
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = path.join(root, "private.pem");
    const output = path.join(root, "pointer.json");
    await fs.writeFile(key, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    for (const native of nativeManifests()) {
      await fs.writeFile(path.join(root, "equinox-local-main-" + SHA + "-" + native.target + ".json"), JSON.stringify(native));
    }
    const args = [
      "scripts/release/sign-main-install-pointer.mjs", "--source-sha", SHA,
      "--version", "6.2.1", "--manifest-dir", root,
      "--key-file", key, "--key-id", "ephemeral-test", "--output", output,
    ];
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, args, { timeout: 12_000 });
    assert.match(stdout, /Signed Main pointer created/u);
    assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
    const pointer = JSON.parse(await fs.readFile(output, "utf8"));
    validateSignedMainInstallPointer(pointer, {
      publicKeys: { "ephemeral-test": publicKey.export({ type: "spki", format: "pem" }) },
      expectedSourceSha: SHA,
    });
    await assert.rejects(run(process.execPath, args, { timeout: 12_000 }), /EEXIST/u);
    await fs.rm(output);
    const suspect = path.join(root, "equinox-local-main-" + SHA + "-darwin-arm64.json");
    const safe = path.join(root, "original.json");
    await fs.rename(suspect, safe);
    await fs.symlink(safe, suspect);
    await assert.rejects(run(process.execPath, args, { timeout: 12_000 }), /non-symlink|normal/u);
    await assert.rejects(fs.stat(output), /ENOENT/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
