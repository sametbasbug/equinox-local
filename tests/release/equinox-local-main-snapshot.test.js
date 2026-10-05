import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  equinoxLocalMainSnapshotArtifactUrl,
  equinoxLocalMainSnapshotManifestUrl,
  inspectStagedEquinoxLocalMainSnapshotArtifact,
  stageEquinoxLocalMainSnapshotArtifact,
  fetchEquinoxLocalMainSnapshotManifest,
} from "../../src/equinox-local-main-snapshot.js";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const TARGET = "darwin-arm64";
const MANIFEST = Object.freeze({
  schemaVersion: 1,
  channel: "main",
  sourceSha: SHA,
  target: TARGET,
  runtimeContractSha256: DIGEST,
  artifact: Object.freeze({
    name: `equinox-local-main-${SHA}-${TARGET}.tar.gz`,
    sha256: "c".repeat(64),
    bytes: 12345,
  }),
});

function jsonResponse(value, { status = 200, contentLength = null } = {}) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-length" ? (contentLength ?? String(bytes.length)) : null },
    body: (async function* () { yield bytes; })(),
  };
}

function bytesResponse(bytes, { status = 200, contentLength = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-length" ? (contentLength ?? String(bytes.length)) : null },
    body: (async function* () { yield bytes; })(),
  };
}

function manifestWithArtifact(artifact) {
  return { ...MANIFEST, artifact };
}

test("Main snapshot URLs are deterministic exact-SHA public paths", () => {
  assert.equal(
    equinoxLocalMainSnapshotManifestUrl(SHA, TARGET),
    `https://main.local.sametbasbug.dev/snapshots/${SHA}/equinox-local-main-${SHA}-${TARGET}.json`,
  );
  assert.equal(
    equinoxLocalMainSnapshotArtifactUrl(SHA, "win32-x64"),
    `https://main.local.sametbasbug.dev/snapshots/${SHA}/equinox-local-main-${SHA}-win32-x64.zip`,
  );
  assert.throws(() => equinoxLocalMainSnapshotManifestUrl("../main", TARGET), /source SHA is invalid/u);
  assert.throws(() => equinoxLocalMainSnapshotArtifactUrl(SHA, "linux-x64"), /target is unsupported/u);
});

test("Main snapshot manifest fetch is tokenless bounded and exact-contract validated", async () => {
  const calls = [];
  const result = await fetchEquinoxLocalMainSnapshotManifest({
    sourceSha: SHA,
    target: TARGET,
    expectedRuntimeContractSha256: DIGEST,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(MANIFEST);
    },
  });
  assert.equal(result.manifest.sourceSha, SHA);
  assert.equal(result.manifest.target, TARGET);
  assert.equal(result.manifest.runtimeContractSha256, DIGEST);
  assert.equal(result.artifactUrl, equinoxLocalMainSnapshotArtifactUrl(SHA, TARGET));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, equinoxLocalMainSnapshotManifestUrl(SHA, TARGET));
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.cache, "no-store");
});

test("Main snapshot manifest fetch fails closed on identity and response drift", async () => {
  const fetchManifest = (value, options) => fetchEquinoxLocalMainSnapshotManifest({
    sourceSha: SHA,
    target: TARGET,
    expectedRuntimeContractSha256: DIGEST,
    fetchImpl: async () => jsonResponse(value, options),
  });

  await assert.rejects(fetchManifest({ ...MANIFEST, sourceSha: "d".repeat(40) }), /source SHA does not match/u);
  await assert.rejects(fetchManifest({ ...MANIFEST, target: "darwin-x64" }), /target does not match/u);
  await assert.rejects(fetchManifest({ ...MANIFEST, runtimeContractSha256: "e".repeat(64) }), /runtime contract digest does not match/u);
  await assert.rejects(fetchManifest(MANIFEST, { status: 404 }), /HTTP 404/u);
  await assert.rejects(fetchManifest(MANIFEST, { contentLength: String(64 * 1024 + 1) }), /size limit/u);
  await assert.rejects(fetchEquinoxLocalMainSnapshotManifest({
    sourceSha: SHA,
    target: TARGET,
    expectedRuntimeContractSha256: DIGEST,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: (async function* () { yield Buffer.alloc(64 * 1024 + 1); })() }),
  }), /size limit/u);
  await assert.rejects(fetchEquinoxLocalMainSnapshotManifest({
    sourceSha: SHA,
    target: TARGET,
    expectedRuntimeContractSha256: DIGEST,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "8" }, body: (async function* () { yield Buffer.from("not-json"); })() }),
  }), /not valid JSON/u);
});

test("Main snapshot artifact staging streams into transaction-owned storage and verifies exact bytes", async (t) => {
  const fixtureBase = path.dirname(fileURLToPath(import.meta.url));
  const root = await fs.mkdtemp(path.join(fixtureBase, ".equinox-main-snapshot-stage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionId = `main-${"d".repeat(32)}`;
  const transactionDir = path.join(root, "staging", transactionId);
  await fs.mkdir(transactionDir, { recursive: true, mode: 0o700 });
  const artifactBytes = Buffer.from("verified-main-native-artifact");
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  const manifest = manifestWithArtifact({ name: `equinox-local-main-${SHA}-darwin-arm64.tar.gz`, sha256: artifactSha256, bytes: artifactBytes.length });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? jsonResponse(manifest) : bytesResponse(artifactBytes);
  };
  const result = await stageEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId, fetchImpl,
  });
  assert.equal(result.bytes, artifactBytes.length);
  assert.equal(result.sha256, artifactSha256);
  assert.equal(await fs.readFile(result.artifactPath, "utf8"), artifactBytes.toString("utf8"));
  assert.equal((await fs.lstat(result.artifactPath)).isFile(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(result.manifestPath, "utf8")), manifest);
  const inspected = await inspectStagedEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId,
  });
  assert.equal(inspected.artifactPath, result.artifactPath);
  assert.equal(inspected.manifestPath, result.manifestPath);
  assert.equal(inspected.sha256, artifactSha256);
  assert.equal(inspected.bytes, artifactBytes.length);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, equinoxLocalMainSnapshotArtifactUrl(SHA, "darwin-arm64"));
  assert.equal(calls[1].options.redirect, "error");
  assert.equal(calls[1].options.credentials, "omit");
});

test("Main snapshot artifact staging cleans partial state on byte digest and destination collisions", async (t) => {
  const fixtureBase = path.dirname(fileURLToPath(import.meta.url));
  const root = await fs.mkdtemp(path.join(fixtureBase, ".equinox-main-snapshot-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionId = `main-${"e".repeat(32)}`;
  const transactionDir = path.join(root, "staging", transactionId);
  await fs.mkdir(transactionDir, { recursive: true, mode: 0o700 });
  const artifactBytes = Buffer.from("artifact-bytes");
  const manifest = manifestWithArtifact({ name: `equinox-local-main-${SHA}-darwin-arm64.tar.gz`, sha256: "f".repeat(64), bytes: artifactBytes.length });
  const fetchImpl = async (url) => url.endsWith(".json") ? jsonResponse(manifest) : bytesResponse(artifactBytes);
  await assert.rejects(stageEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId, fetchImpl,
  }), /SHA-256/u);
  await assert.rejects(fs.lstat(path.join(transactionDir, "native")), { code: "ENOENT" });

  await fs.mkdir(path.join(transactionDir, "native"), { mode: 0o700 });
  await assert.rejects(stageEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId, fetchImpl,
  }), { code: "EEXIST" });
});

test("Main snapshot artifact staging rejects symlinked transaction storage before network access", async (t) => {
  const fixtureBase = path.dirname(fileURLToPath(import.meta.url));
  const root = await fs.mkdtemp(path.join(fixtureBase, ".equinox-main-snapshot-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionId = `main-${"1".repeat(32)}`;
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.mkdir(path.join(root, "staging"));
  await fs.symlink(outside, path.join(root, "staging", transactionId));
  let called = false;
  await assert.rejects(stageEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId, fetchImpl: async () => { called = true; throw new Error("must not fetch"); },
  }), /canonical normal directory/u);
  assert.equal(called, false);
});


test("staged Main snapshot inspection revalidates local manifest identity, bytes and directory ownership", async (t) => {
  const fixtureBase = path.dirname(fileURLToPath(import.meta.url));
  const root = await fs.mkdtemp(path.join(fixtureBase, ".equinox-main-snapshot-inspect-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionId = `main-${"2".repeat(32)}`;
  const nativeDir = path.join(root, "staging", transactionId, "native");
  await fs.mkdir(nativeDir, { recursive: true, mode: 0o700 });
  const artifactBytes = Buffer.from("transaction-bound-native-artifact");
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  const manifest = manifestWithArtifact({ name: `equinox-local-main-${SHA}-darwin-arm64.tar.gz`, sha256: artifactSha256, bytes: artifactBytes.length });
  const manifestPath = path.join(nativeDir, `equinox-local-main-${SHA}-darwin-arm64.json`);
  const artifactPath = path.join(nativeDir, manifest.artifact.name);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await fs.writeFile(artifactPath, artifactBytes, { mode: 0o600 });

  await assert.rejects(inspectStagedEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: "e".repeat(64), transactionRoot: root, transactionId,
  }), /runtime contract digest does not match/u);

  await fs.appendFile(artifactPath, "tamper");
  await assert.rejects(inspectStagedEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST, transactionRoot: root, transactionId,
  }), /byte size does not match/u);
  await fs.writeFile(artifactPath, artifactBytes);
  await fs.writeFile(path.join(nativeDir, "unexpected.txt"), "nope");
  await assert.rejects(inspectStagedEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST, transactionRoot: root, transactionId,
  }), /unexpected entries/u);
});
