import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { materializeEquinoxLocalMainNativeArtifact } from "../../scripts/release/materialize-main-native-artifact.mjs";

const SHA = "a".repeat(40);

async function fixture(t, suffix = ".tar.gz") {
  const fixtureBase = path.dirname(fileURLToPath(import.meta.url));
  const root = await fs.mkdtemp(path.join(fixtureBase, ".equinox-main-native-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const candidate = path.join(root, `candidate${suffix}`);
  const output = path.join(root, "out");
  await fs.writeFile(candidate, Buffer.from("native-artifact-bytes"));
  return { root, candidate, output };
}

function gitStub({ dirty = false, head = SHA } = {}) {
  return async (_command, args) => {
    if (args.includes("rev-parse")) return { stdout: `${head}\n`, stderr: "" };
    if (args.includes("status")) return { stdout: dirty ? " M app/EquinoxLocalApp.swift\n" : "", stderr: "" };
    throw new Error(`unexpected git call: ${args.join(" ")}`);
  };
}

const computeRuntimeContractImpl = async ({ target }) => ({
  schemaVersion: 1,
  target,
  sha256: "b".repeat(64),
  inputCount: 3,
  inputs: [],
});

test("materializer emits an exact-SHA Main artifact and manifest without Stable version identity", async (t) => {
  const { root, candidate, output } = await fixture(t);
  const result = await materializeEquinoxLocalMainNativeArtifact({
    rootDir: root,
    sourceSha: SHA,
    target: "darwin-arm64",
    candidateArtifactPath: candidate,
    outputDir: output,
    execFileImpl: gitStub(),
    computeRuntimeContractImpl,
  });
  assert.equal(path.basename(result.artifactPath), `equinox-local-main-${SHA}-darwin-arm64.tar.gz`);
  assert.equal(path.basename(result.manifestPath), `equinox-local-main-${SHA}-darwin-arm64.json`);
  assert.equal(result.manifest.channel, "main");
  assert.equal(result.manifest.sourceSha, SHA);
  assert.equal(result.manifest.runtimeContractSha256, "b".repeat(64));
  assert.equal(result.manifest.artifact.bytes, Buffer.byteLength("native-artifact-bytes"));
  assert.match(result.manifest.artifact.sha256, /^[a-f0-9]{64}$/u);
  assert.equal((await fs.readFile(result.artifactPath, "utf8")), "native-artifact-bytes");
  const written = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  assert.deepEqual(written, result.manifest);
  assert.equal(JSON.stringify(written).includes("5.2.1"), false);
});

test("materializer refuses checkout drift dirty source target mismatch symlinks and output replacement", async (t) => {
  const { root, candidate, output } = await fixture(t);
  const base = { rootDir: root, sourceSha: SHA, target: "darwin-arm64", candidateArtifactPath: candidate, outputDir: output, computeRuntimeContractImpl };
  await assert.rejects(materializeEquinoxLocalMainNativeArtifact({ ...base, execFileImpl: gitStub({ head: "c".repeat(40) }) }), /exact source SHA/u);
  await assert.rejects(materializeEquinoxLocalMainNativeArtifact({ ...base, execFileImpl: gitStub({ dirty: true }) }), /dirty/u);
  await assert.rejects(materializeEquinoxLocalMainNativeArtifact({ ...base, target: "win32-x64", execFileImpl: gitStub() }), /extension/u);
  const link = path.join(root, "candidate-link.tar.gz");
  await fs.symlink(candidate, link);
  await assert.rejects(materializeEquinoxLocalMainNativeArtifact({ ...base, candidateArtifactPath: link, execFileImpl: gitStub() }), /safe bounded normal file/u);
  await materializeEquinoxLocalMainNativeArtifact({ ...base, execFileImpl: gitStub() });
  await assert.rejects(materializeEquinoxLocalMainNativeArtifact({ ...base, execFileImpl: gitStub() }), /EEXIST/u);
});
