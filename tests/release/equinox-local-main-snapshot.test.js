import assert from "node:assert/strict";
import test from "node:test";

import {
  equinoxLocalMainSnapshotArtifactUrl,
  equinoxLocalMainSnapshotManifestUrl,
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
