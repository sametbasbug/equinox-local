import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  MAIN_NATIVE_B_SIGNATURE_DOMAIN,
  canonicalMainNativeBAuthorizationPayload,
  createSignedMainNativeBAuthorization,
  validateSignedMainNativeBAuthorization,
} from "../../src/equinox-local-main-native-b-authorization.js";
import { EQUINOX_LOCAL_UPDATE_KEYS } from "../../src/equinox-local-update-keys.js";
import { canonicalUpdateManifestPayload } from "../../src/equinox-local-updater.js";

const original = {
  schemaVersion: 1, channel: "main",
  previousSourceSha: "a".repeat(40), sourceSha: "b".repeat(40), target: "win32-x64",
  runtimeContractSha256: "c".repeat(64),
  artifact: { sha256: "d".repeat(64), bytes: 1024 },
  releaseFingerprint: { sha256: "e".repeat(64), entries: 11, bytes: 4096 },
};
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const ephemeralKeyId = "test-ephemeral-not-production";
const ephemeralKeys = { [ephemeralKeyId]: publicKey.export({ type: "spki", format: "pem" }).toString() };
function signed() { return createSignedMainNativeBAuthorization(original, { privateKey, keyId: ephemeralKeyId }); }

// This test key MUST never be serialized to a file or inserted into the product keyring.
test("separate Main B signature binds old A, B target, runtime, artifact and native tree", () => {
  assert.match(MAIN_NATIVE_B_SIGNATURE_DOMAIN, /^equinox-local-main-native-b-authorization-v1\n$/u);
  const value = signed();
  assert.deepEqual(validateSignedMainNativeBAuthorization(value, { publicKeys: ephemeralKeys, expected: original }), value);
  assert.throws(() => validateSignedMainNativeBAuthorization(value), /not trusted/u);
  assert.deepEqual(Object.keys(EQUINOX_LOCAL_UPDATE_KEYS), ["stable-2026-01"]);
  assert.notEqual(canonicalMainNativeBAuthorizationPayload(original), canonicalUpdateManifestPayload({
    schemaVersion: 1, channel: "stable", target: "win32-x64", version: "6.2.0", publishedAt: "2026-10-24T00:00:00.000Z",
    artifact: { url: "https://local.sametbasbug.dev/downloads/updates/x", sha256: original.artifact.sha256, bytes: original.artifact.bytes },
  }));
});

test("Main B Ed25519 signature refuses every mutation and wrong transaction binding", () => {
  const value = signed();
  for (const change of [
    { previousSourceSha: "0".repeat(40) }, { sourceSha: "1".repeat(40) }, { target: "win32-arm64" },
    { runtimeContractSha256: "f".repeat(64) },
    { artifact: { ...value.artifact, bytes: 2048 } },
    { artifact: { ...value.artifact, sha256: "0".repeat(64) } },
    { releaseFingerprint: { ...value.releaseFingerprint, sha256: "1".repeat(64) } },
    { releaseFingerprint: { ...value.releaseFingerprint, entries: 12 } },
    { releaseFingerprint: { ...value.releaseFingerprint, bytes: 4097 } },
  ]) {
    assert.throws(() => validateSignedMainNativeBAuthorization({ ...value, ...change }, { publicKeys: ephemeralKeys }), /signature failed/u, JSON.stringify(change));
  }
  assert.throws(() => validateSignedMainNativeBAuthorization(value, {
    publicKeys: ephemeralKeys, expected: { previousSourceSha: "0".repeat(40) },
  }), /differs from the independently expected/u);
});

test("Main B authorization rejects missing, malformed, hostile or unknown signing authority", () => {
  const value = signed();
  assert.throws(() => validateSignedMainNativeBAuthorization({ ...original }), /missing or unexpected/u);
  assert.throws(() => validateSignedMainNativeBAuthorization({ ...value, extra: true }, { publicKeys: ephemeralKeys }), /missing or unexpected/u);
  assert.throws(() => validateSignedMainNativeBAuthorization({ ...value, signature: { ...value.signature, keyId: "stable-2026-01" } }), /signature failed/u);
  assert.throws(() => validateSignedMainNativeBAuthorization({ ...value, signature: { ...value.signature, value: "a" } }, { publicKeys: ephemeralKeys }), /signature metadata/u);
  assert.throws(() => validateSignedMainNativeBAuthorization({ ...value, signature: { ...value.signature, algorithm: "rsa" } }, { publicKeys: ephemeralKeys }), /signature metadata/u);
  assert.throws(() => validateSignedMainNativeBAuthorization({ ...value, signature: { ...value.signature, keyId: "not-registered" } }, { publicKeys: ephemeralKeys }), /not trusted/u);
  const empty = { ...value, sourceSha: value.previousSourceSha };
  assert.throws(() => validateSignedMainNativeBAuthorization(empty, { publicKeys: ephemeralKeys }), /distinct/u);
  assert.throws(() => createSignedMainNativeBAuthorization(original, { privateKey: publicKey, keyId: ephemeralKeyId }), /private key/u);
  assert.throws(() => createSignedMainNativeBAuthorization(original, { privateKey, keyId: "../bad" }), /key ID/u);
});

test("Main B canonical payload is deterministic, domain-separated and bounded", () => {
  const text = canonicalMainNativeBAuthorizationPayload(original);
  assert.ok(text.startsWith(MAIN_NATIVE_B_SIGNATURE_DOMAIN));
  assert.equal(createHash("sha256").update(text).digest("hex").length, 64);
  assert.equal(text, canonicalMainNativeBAuthorizationPayload({ ...original, releaseFingerprint: {...original.releaseFingerprint} }));
  for (const value of [NaN, Infinity, -1, 0, 1.5, 2**54]) {
    assert.throws(() => canonicalMainNativeBAuthorizationPayload({ ...original, artifact: { ...original.artifact, bytes: value } }), /bounded positive integer/u);
  }
  assert.throws(() => canonicalMainNativeBAuthorizationPayload({ ...original, target: "darwin-arm64" }), /architecture/u);
  assert.throws(() => canonicalMainNativeBAuthorizationPayload({ ...original, extra: "ignored" }), /missing or unexpected/u);
});


test("public Main B signing CLI consumes only approved FD3 and refuses a key pathname or private-key logging", async () => {
  const source = await fs.readFile(new URL("../../scripts/release/sign-main-native-b-authorization.mts", import.meta.url), "utf8");
  assert.match(source, /readPrivateUpdateSigningKeyFromFd\(3\)/u);
  assert.match(source, /createPublicKey\(privateKey\)/u);
  assert.match(source, /EQUINOX_LOCAL_UPDATE_KEYS/u);
  assert.match(source, /hashExactArtifact\(values\.artifact!\)/u);
  assert.match(source, /fs\.open\(output, "wx"/u);
  assert.doesNotMatch(source, /--key-file|PRIVATE KEY-----|privateKeyPem|writeFile\([^)]*privateKey/u);
});
