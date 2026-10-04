import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { equinoxLocalReleaseArtifactName, EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from "../../src/equinox-local-platform.js";
import { canonicalUpdateManifestPayload, equinoxLocalUpdateManifestUrl } from "../../src/equinox-local-updater.js";
import { EQUINOX_LOCAL_VERSION } from "../../src/equinox-local-version.js";
import {
  assertReleaseBehaviorCheckout,
  parseReleaseBehaviorCli,
  runSignRelease,
  runValidateSignedRelease,
  runVerifyLiveRelease,
} from "../../scripts/release/release-behavior-cli.mjs";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);

function smokeArgs(overrides = {}) {
  const values = {
    "expected-sha": SHA,
    "previous-version": "5.2.0",
    version: EQUINOX_LOCAL_VERSION,
    target: "darwin-arm64",
    "previous-url": "https://local.sametbasbug.dev/downloads/updates/equinox-local-5.2.0-darwin-arm64.tar.gz",
    "previous-sha256": DIGEST,
    "previous-bytes": "123",
    "candidate-manifest": "/tmp/stable-darwin-arm64.json",
    ...overrides,
  };
  return ["managed-upgrade-smoke", ...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value])];
}

test("release behavior CLI keeps one high-level managed upgrade operation plus exact-SHA describe", () => {
  assert.deepEqual(parseReleaseBehaviorCli(["describe", "--expected-sha", SHA]), { operation: "describe", expectedSha: SHA });
  const parsed = parseReleaseBehaviorCli(smokeArgs({ "candidate-artifact": "/tmp/candidate.tar.gz" }));
  assert.equal(parsed.operation, "managed-upgrade-smoke");
  assert.equal(parsed.version, EQUINOX_LOCAL_VERSION);
  assert.equal(parsed.target, "darwin-arm64");
  assert.equal(parsed.previousArtifact.bytes, 123);
  assert.equal(parsed.candidateArtifactPath, "/tmp/candidate.tar.gz");
});

test("release behavior CLI rejects version, target, URL, digest and path drift before product mutation", () => {
  assert.throws(() => parseReleaseBehaviorCli(smokeArgs({ version: "9.9.9" })), /match canonical source version/u);
  assert.throws(() => parseReleaseBehaviorCli(smokeArgs({ target: "win32-x64" })), /only Darwin/u);
  assert.throws(() => parseReleaseBehaviorCli(smokeArgs({ "previous-url": "https://example.test/release.tar.gz" })), /pinned Equinox Local release URL/u);
  assert.throws(() => parseReleaseBehaviorCli(smokeArgs({ "previous-sha256": "x".repeat(64) })), /SHA-256/u);
  assert.throws(() => parseReleaseBehaviorCli(smokeArgs({ "candidate-manifest": "relative.json" })), /absolute path/u);
});

test("release behavior checkout validation binds canonical origin, clean worktree and exact HEAD", async () => {
  const root = await fs.mkdtemp("/tmp/equinox-release-behavior-contract-");
  try {
    const calls = [];
    const execFileImpl = async (_command, args) => {
      calls.push(args.join(" "));
      if (args.join(" ") === "rev-parse --show-toplevel") return { stdout: `${root}\n` };
      if (args.join(" ") === "remote get-url origin") return { stdout: "git@github.com:sametbasbug/equinox-local.git\n" };
      if (args[0] === "status") return { stdout: "" };
      if (args.join(" ") === "rev-parse HEAD") return { stdout: `${SHA}\n` };
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    };
    const result = await assertReleaseBehaviorCheckout({ expectedSha: SHA, rootDir: root, execFileImpl });
    assert.equal(result.sourceSha, SHA);
    assert.deepEqual(calls, [
      "rev-parse --show-toplevel",
      "remote get-url origin",
      "status --porcelain=v1 --untracked-files=all",
      "rev-parse HEAD",
    ]);
    await assert.rejects(
      assertReleaseBehaviorCheckout({
        expectedSha: SHA,
        rootDir: root,
        execFileImpl: async (_command, args) => args.join(" ") === "rev-parse --show-toplevel"
          ? { stdout: `${root}\n` }
          : args.join(" ") === "remote get-url origin"
            ? { stdout: "https://github.com/example/fork.git\n" }
            : { stdout: "" },
      }),
      /origin is not canonical/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("release behavior CLI source owns the updater/release-manager/activation boundary", async () => {
  const source = await fs.readFile(new URL("../../scripts/release/release-behavior-cli.mjs", import.meta.url), "utf8");
  assert.match(source, /prepareManagedEquinoxRelease/u);
  assert.match(source, /createEquinoxLocalUpdater/u);
  assert.match(source, /activatePreparedEquinoxRelease/u);
  assert.match(source, /EQUINOX_LOCAL_UPDATE_KEYS/u);
  assert.doesNotMatch(source, /factory\//u);
});


function testSigningMaterial() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    keyId: "test-release-key",
    publicKeys: { "test-release-key": publicKey.export({ type: "spki", format: "pem" }) },
    privateKey,
  };
}

function signedManifest({ target, bytes, sha256, publishedAt, signing }) {
  const artifact = {
    url: new URL(`./${equinoxLocalReleaseArtifactName(EQUINOX_LOCAL_VERSION, target)}`, equinoxLocalUpdateManifestUrl(target)).toString(),
    sha256,
    bytes,
  };
  const unsigned = {
    schemaVersion: 1,
    channel: "stable",
    target,
    version: EQUINOX_LOCAL_VERSION,
    publishedAt,
    artifact,
  };
  const value = sign(null, Buffer.from(canonicalUpdateManifestPayload(unsigned), "utf8"), signing.privateKey).toString("base64");
  return { ...unsigned, signature: { algorithm: "ed25519", keyId: signing.keyId, value } };
}

test("release behavior CLI parses release-level signed/local and live verification operations", () => {
  const local = parseReleaseBehaviorCli([
    "validate-signed-release",
    "--expected-sha", SHA,
    "--version", EQUINOX_LOCAL_VERSION,
    "--signed-dir", "/tmp/equinox-signed",
  ]);
  assert.equal(local.operation, "validate-signed-release");
  assert.equal(local.signedDir, "/tmp/equinox-signed");
  const live = parseReleaseBehaviorCli([
    "verify-live-release",
    "--expected-sha", SHA,
    "--version", EQUINOX_LOCAL_VERSION,
  ]);
  assert.deepEqual(live, { operation: "verify-live-release", expectedSha: SHA, version: EQUINOX_LOCAL_VERSION });
});

test("signed release validation verifies all canonical manifests and artifact digests", async (t) => {
  const signedDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-signed-release-contract-"));
  t.after(() => fs.rm(signedDir, { recursive: true, force: true }));
  const signing = testSigningMaterial();
  const publishedAt = "2026-10-03T20:00:00.000Z";
  for (const target of EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS) {
    const bytes = Buffer.from(`artifact:${target}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(path.join(signedDir, equinoxLocalReleaseArtifactName(EQUINOX_LOCAL_VERSION, target)), bytes);
    await fs.writeFile(
      path.join(signedDir, `stable-${target}.json`),
      JSON.stringify(signedManifest({ target, bytes: bytes.length, sha256, publishedAt, signing })),
    );
  }
  const result = await runValidateSignedRelease({ version: EQUINOX_LOCAL_VERSION, signedDir }, { publicKeys: signing.publicKeys });
  assert.equal(result.status, "passed");
  assert.equal(result.publishedAt, publishedAt);
  assert.deepEqual(Object.keys(result.bundles), [...EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS]);
  await fs.appendFile(path.join(signedDir, equinoxLocalReleaseArtifactName(EQUINOX_LOCAL_VERSION, "darwin-arm64")), "tamper");
  await assert.rejects(
    runValidateSignedRelease({ version: EQUINOX_LOCAL_VERSION, signedDir }, { publicKeys: signing.publicKeys }),
    /does not match its signed manifest/u,
  );
});

test("live release verification validates signatures, canonical URLs and byte ranges for every target", async () => {
  const signing = testSigningMaterial();
  const publishedAt = "2026-10-03T20:00:00.000Z";
  const manifests = new Map();
  for (const target of EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS) {
    const body = Buffer.from(`live:${target}`);
    const sha256 = createHash("sha256").update(body).digest("hex");
    manifests.set(equinoxLocalUpdateManifestUrl(target), signedManifest({ target, bytes: body.length, sha256, publishedAt, signing }));
  }
  const fetchImpl = async (url, options = {}) => {
    const key = String(url);
    if (manifests.has(key)) return new Response(JSON.stringify(manifests.get(key)), { status: 200, headers: { "content-type": "application/json" } });
    const manifest = [...manifests.values()].find((item) => item.artifact.url === key);
    if (!manifest) return new Response("missing", { status: 404 });
    assert.equal(options.headers?.range, "bytes=0-0");
    return new Response(Buffer.from([0]), { status: 206, headers: { "content-range": `bytes 0-0/${manifest.artifact.bytes}` } });
  };
  const result = await runVerifyLiveRelease({ version: EQUINOX_LOCAL_VERSION }, { publicKeys: signing.publicKeys, fetchImpl });
  assert.equal(result.status, "passed");
  assert.equal(result.publishedAt, publishedAt);
  assert.deepEqual(Object.keys(result.bundles), [...EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS]);
});


test("release behavior CLI parses one exact four-target sign-release operation with descriptor-only key access", () => {
  const args = [
    "sign-release",
    "--expected-sha", SHA,
    "--version", EQUINOX_LOCAL_VERSION,
    "--key-id", "stable-2026-01",
    "--key-fd", "3",
    "--output-dir", "/tmp/equinox-signed",
    ...EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS.flatMap((target) => [`--artifact-${target}`, `/tmp/${target}.bin`]),
  ];
  const parsed = parseReleaseBehaviorCli(args);
  assert.equal(parsed.operation, "sign-release");
  assert.equal(parsed.keyFd, 3);
  assert.equal(parsed.keyId, "stable-2026-01");
  assert.deepEqual(Object.keys(parsed.artifacts), [...EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS]);
  assert.equal(JSON.stringify(parsed).includes("key-file"), false);
  const wrongFd = [...args];
  wrongFd[wrongFd.indexOf("--key-fd") + 1] = "4";
  assert.throws(() => parseReleaseBehaviorCli(wrongFd), /descriptor 3/u);
});

test("sign-release uses the inherited key object, canonical keyring and one shared timestamp without returning key material", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-sign-release-behavior-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const signing = testSigningMaterial();
  const artifacts = {};
  for (const target of EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS) {
    const artifactPath = path.join(root, `${target}.bin`);
    await fs.writeFile(artifactPath, `artifact:${target}`);
    artifacts[target] = artifactPath;
  }
  const outputDir = path.join(root, "signed");
  const calls = [];
  const result = await runSignRelease({
    version: EQUINOX_LOCAL_VERSION,
    keyId: signing.keyId,
    keyFd: 3,
    outputDir,
    publishedAt: "2026-10-04T00:00:00.000Z",
    artifacts,
  }, {
    publicKeys: signing.publicKeys,
    readPrivateKeyFromFdImpl: (fd) => { assert.equal(fd, 3); return signing.privateKey; },
    writeBundleImpl: async (input) => {
      calls.push(input);
      const content = `artifact:${input.target}`;
      return { publicKeyPem: signing.publicKeys[signing.keyId], bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
    },
  });
  assert.equal(result.status, "passed");
  assert.equal(result.publishedAt, "2026-10-04T00:00:00.000Z");
  assert.equal(calls.length, 4);
  assert.equal(calls.every((call) => call.privateKey === signing.privateKey && call.privateKeyPath === undefined), true);
  assert.equal(JSON.stringify(result).includes("PRIVATE KEY"), false);
  assert.equal(JSON.stringify(result).includes("publicKeyPem"), false);
});
