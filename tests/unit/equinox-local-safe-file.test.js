import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readBoundedNormalFile,
  SAFE_FILE_ERROR_CODES,
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
