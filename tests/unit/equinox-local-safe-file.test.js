import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readBoundedNormalFile,
  SAFE_FILE_ERROR_CODES,
  writeBoundedUtf8File,
} from "../../src/equinox-local-safe-file.js";

test("safe file reader reads bounded bytes and returns the opened file stat", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-safe-file-"));
  try {
    const target = path.join(root, "fixture.txt");
    await fs.writeFile(target, "hello", { mode: 0o600, flag: "wx" });
    const result = await readBoundedNormalFile(target, {
      minBytes: 1,
      maxBytes: 16,
      encoding: "utf8",
      label: "Fixture",
    });
    assert.equal(result.data, "hello");
    assert.equal(result.stat.isFile(), true);
    assert.equal(result.stat.size, 5);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safe file reader refuses final-component symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-safe-file-link-"));
  try {
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    await fs.writeFile(target, "secret", { mode: 0o600, flag: "wx" });
    await fs.symlink(target, link);
    await assert.rejects(
      readBoundedNormalFile(link, { minBytes: 1, maxBytes: 16, label: "Fixture" }),
      (error) => error?.code === SAFE_FILE_ERROR_CODES.notNormal,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safe file reader enforces the read bound even if the stat-sized file is too large", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-safe-file-bound-"));
  try {
    const target = path.join(root, "large.txt");
    await fs.writeFile(target, "123456789", { mode: 0o600, flag: "wx" });
    await assert.rejects(
      readBoundedNormalFile(target, { maxBytes: 8, label: "Fixture" }),
      (error) => error?.code === SAFE_FILE_ERROR_CODES.tooLarge,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safe file writer creates a bounded UTF-8 file and leaves no temporary artifact", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-safe-file-write-"));
  try {
    const target = path.join(root, "created.txt");
    const result = await writeBoundedUtf8File(target, {
      content: "hello agent\n",
      maxBytes: 64,
      label: "Fixture",
    });
    assert.equal(result.created, true);
    assert.equal(result.replaced, false);
    assert.equal(result.previousSha256, null);
    assert.equal(result.bytes, 12);
    assert.equal(
      result.sha256,
      createHash("sha256").update("hello agent\n", "utf8").digest("hex"),
    );
    assert.equal(await fs.readFile(target, "utf8"), "hello agent\n");
    assert.deepEqual(await fs.readdir(root), ["created.txt"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safe file writer replaces only with the current SHA-256 and preserves file mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-safe-file-replace-"));
  try {
    const target = path.join(root, "existing.txt");
    await fs.writeFile(target, "before", { mode: 0o600, flag: "wx" });
    const expectedSha256 = createHash("sha256").update("before").digest("hex");

    await assert.rejects(
      writeBoundedUtf8File(target, { content: "after", maxBytes: 64, label: "Fixture" }),
      /requires expectedSha256/u,
    );
    await assert.rejects(
      writeBoundedUtf8File(target, {
        content: "after",
        expectedSha256: "0".repeat(64),
        maxBytes: 64,
        label: "Fixture",
      }),
      /SHA-256 guard mismatch/u,
    );
    assert.equal(await fs.readFile(target, "utf8"), "before");

    const result = await writeBoundedUtf8File(target, {
      content: "after",
      expectedSha256,
      maxBytes: 64,
      label: "Fixture",
    });
    assert.equal(result.created, false);
    assert.equal(result.replaced, true);
    assert.equal(result.previousSha256, expectedSha256);
    assert.equal(await fs.readFile(target, "utf8"), "after");
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safe file writer rejects symlink targets, unexpected guards and oversized content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-safe-file-write-guards-"));
  try {
    const missing = path.join(root, "missing.txt");
    await assert.rejects(
      writeBoundedUtf8File(missing, {
        content: "hello",
        expectedSha256: "0".repeat(64),
        maxBytes: 64,
        label: "Fixture",
      }),
      /only valid for replacement/u,
    );

    await assert.rejects(
      writeBoundedUtf8File(missing, {
        content: "12345",
        maxBytes: 4,
        label: "Fixture",
      }),
      (error) => error?.code === SAFE_FILE_ERROR_CODES.tooLarge,
    );

    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    await fs.writeFile(target, "secret", { mode: 0o600, flag: "wx" });
    await fs.symlink(target, link);
    await assert.rejects(
      writeBoundedUtf8File(link, {
        content: "changed",
        expectedSha256: createHash("sha256").update("secret").digest("hex"),
        maxBytes: 64,
        label: "Fixture",
      }),
      (error) => error?.code === SAFE_FILE_ERROR_CODES.notNormal,
    );
    assert.equal(await fs.readFile(target, "utf8"), "secret");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
