import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { hashFile, hashStream } from "../../scripts/lib/package-io.mjs";
import { createSignedUpdateManifest } from "../../scripts/release/sign-update-manifest.mjs";

async function withOpenCloseFailure(filePath, content, closeError, run) {
  const originalOpen = fs.open;
  let opened = false;
  fs.open = async (openedPath, flags) => {
    assert.equal(openedPath, filePath);
    assert.equal(flags, "r");
    opened = true;
    return {
      createReadStream: () => Readable.from([Buffer.from(content)]),
      close: () => Promise.reject(closeError),
    };
  };
  try {
    await run();
    assert.equal(opened, true, "the file hashing path should open the fixture");
  } finally {
    fs.open = originalOpen;
  }
}

test("package I/O hashes known streamed bytes and counts their exact length", async () => {
  const result = await hashStream(Readable.from([Buffer.from("a"), Buffer.from("bc")]));
  assert.deepEqual(Object.keys(result), ["bytes", "sha256"]);
  assert.deepEqual(result, {
    bytes: 3,
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
  assert.equal(Object.isFrozen(result), true);
});

test("package I/O hashes an empty stream with zero bytes", async () => {
  const result = await hashStream(Readable.from([]));
  assert.deepEqual(Object.keys(result), ["bytes", "sha256"]);
  assert.deepEqual(result, {
    bytes: 0,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  });
});

test("package I/O propagates stream and file-open errors", async () => {
  const streamError = new Error("stream read failed");
  async function* brokenStream() {
    yield Buffer.from("partial");
    throw streamError;
  }
  await assert.rejects(hashStream(brokenStream()), (error) => error === streamError);
  const scratchDirectory = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  assert.ok(scratchDirectory, "a configured scratch directory is required");
  await assert.rejects(hashFile(path.join(scratchDirectory, "missing-package-io-file")), { code: "ENOENT" });
});

test("package I/O rejects file close errors by default", async () => {
  const closeError = new Error("file close failed");
  await withOpenCloseFailure("close-error-fixture", "fixture bytes", closeError, async () => {
    await assert.rejects(hashFile("close-error-fixture"), (error) => error === closeError);
  });
});

test("package I/O suppresses file close errors only when requested", async () => {
  const closeError = new Error("file close failed");
  const content = "fixture bytes";
  await withOpenCloseFailure("close-error-fixture", content, closeError, async () => {
    const result = await hashFile("close-error-fixture", { suppressCloseErrors: true });
    assert.deepEqual(Object.keys(result), ["bytes", "sha256"]);
    assert.equal(result.bytes, Buffer.byteLength(content));
    assert.equal(result.sha256, createHash("sha256").update(content).digest("hex"));
  });
});

test("signed-manifest adapter suppresses close errors while hashing the artifact", async () => {
  const scratchDirectory = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  assert.ok(scratchDirectory, "a configured scratch directory is required");
  const directory = await fs.mkdtemp(path.join(scratchDirectory, "equinox-package-io-adapter-"));
  const file = path.join(directory, "artifact.bin");
  const content = "signed adapter digest bytes";
  try {
    await fs.writeFile(file, "a normal file is required for artifact validation");
    const { privateKey } = generateKeyPairSync("ed25519");
    const closeError = new Error("file close failed");
    await withOpenCloseFailure(file, content, closeError, async () => {
      const result = await createSignedUpdateManifest({
        version: "4.2.1",
        target: "darwin-arm64",
        artifactPath: file,
        keyId: "test-key",
        privateKey,
        publishedAt: "2026-08-25T03:00:00.000Z",
      });
      assert.deepEqual(Object.keys(result), ["manifest", "publicKeyPem", "bytes", "sha256"]);
      assert.equal(result.bytes, Buffer.byteLength(content));
      assert.equal(result.sha256, createHash("sha256").update(content).digest("hex"));
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("package I/O hashes a real filesystem read stream", async () => {
  const scratchDirectory = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  assert.ok(scratchDirectory, "a configured scratch directory is required");
  const directory = await fs.mkdtemp(path.join(scratchDirectory, "equinox-package-io-"));
  const file = path.join(directory, "known.bin");
  try {
    await fs.writeFile(file, Buffer.from("real filesystem stream bytes"));
    const result = await hashFile(file);
    assert.deepEqual(Object.keys(result), ["bytes", "sha256"]);
    assert.equal(result.bytes, 28);
    assert.equal(result.sha256, "65cf62f2d465173a54d036b613523e551252082d5b928202d34ac5cd2ad87e9c");
    assert.equal(Object.isFrozen(result), true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
