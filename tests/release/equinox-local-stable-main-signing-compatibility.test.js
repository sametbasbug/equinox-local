import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createSignedUpdateManifest } from "../../scripts/release/sign-update-manifest.mjs";
import { EQUINOX_LOCAL_UPDATE_KEYS } from "../../src/equinox-local-update-keys.js";
import { createEquinoxLocalUpdater, validateSignedUpdateManifest } from "../../src/equinox-local-updater.js";
import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from "../../src/equinox-local-platform.js";

// Fingerprint of the immutable public Ed25519 SPKI in the published v6.0.3
// release. A newer bridge cannot reassign the old ID or break its installed
// updater's verification, even if future releases add other trusted keys.
const OLD_STABLE_KEY_ID = "stable-2026-01";
const OLD_603_SPKI_SHA256 = "3c76e65b52f4b1ed0cd823f4d2ee3083ec7290657eea125bb35e54f3439058b1";

test("one-time Stable bridge retains the exact production signing public key trusted by shipped 6.0.3", () => {
  const pem = EQUINOX_LOCAL_UPDATE_KEYS[OLD_STABLE_KEY_ID];
  assert.equal(typeof pem, "string");
  const der = createPublicKey(pem).export({ type: "spki", format: "der" });
  assert.equal(createHash("sha256").update(der).digest("hex"), OLD_603_SPKI_SHA256);
});

test("four-target bridge preview signs and checks exact candidate through the installed Stable verifier contract", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-bridge-sign-preview-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  // Fixture key exists ONLY in memory. Never use a production private key,
  // alter a shipped trust root, or write any signed output to publishing paths.
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = "test-bridge-key-only";
  for (const target of EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS) {
    const artifactPath = path.join(base, target.startsWith("win32") ? `${target}.zip` : `${target}.tar.gz`);
    const syntheticPayload = Buffer.from(`NOT A NATIVE RELEASE; SIGNING CONTRACT ONLY; ${target}`);
    await fs.writeFile(artifactPath, syntheticPayload, { mode: 0o600 });
    const { manifest } = await createSignedUpdateManifest({
      version: "6.0.4", target, artifactPath, keyId, privateKey,
      publishedAt: "2026-10-11T00:00:00.000Z",
    });
    const fetchImpl = async () => new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const updater = createEquinoxLocalUpdater({
      installation: { kind: "managed", managed: true, selfUpdateSupported: true },
      currentVersion: "6.0.3", target,
      publicKeys: { [keyId]: publicKeyPem }, fetchImpl,
    });
    const result = await updater.check();
    assert.equal(result.updateAvailable, true, target);
    assert.equal(updater.candidate()?.version, "6.0.4", target);
    assert.equal(updater.candidate()?.artifact.bytes, syntheticPayload.byteLength, target);
    assert.equal(updater.candidate()?.artifact.sha256, createHash("sha256").update(syntheticPayload).digest("hex"), target);

    // The fixture signer must NEVER be accepted by the real 6.0.3 keys.
    assert.throws(() => validateSignedUpdateManifest(manifest, {
      publicKeys: EQUINOX_LOCAL_UPDATE_KEYS, target,
    }), /signing key|signature/u, target);

    const swapped = structuredClone(manifest);
    swapped.version = "6.0.5";
    assert.throws(() => validateSignedUpdateManifest(swapped, {
      publicKeys: { [keyId]: publicKeyPem }, target,
    }), /signature/u, `${target} altered version must be rejected`);
    const damagedDigest = structuredClone(manifest);
    damagedDigest.artifact.sha256 = "a".repeat(64);
    assert.throws(() => validateSignedUpdateManifest(damagedDigest, {
      publicKeys: { [keyId]: publicKeyPem }, target,
    }), /signature/u, `${target} artifact tampering must be rejected`);
  }
});
