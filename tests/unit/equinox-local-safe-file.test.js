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

test("private hard-linked files are rejected before the safe reader touches bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-safe-file-hardlink-before-read-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside.txt");
  const alias = path.join(root, "private.txt");
  await fs.writeFile(outside, "foreign-private-content", { mode: 0o600 });
  try { await fs.link(outside, alias); }
  catch (error) {
    if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) { t.skip("Hard links unsupported"); return; }
    throw error;
  }
  assert.equal((await fs.stat(alias)).nlink, 2);
  let reads = 0;
  let closes = 0;
  const mockFs = Object.create(fs);
  mockFs.open = async (...args) => {
    const handle = await fs.open(...args);
    return {
      stat: (...params) => handle.stat(...params),
      read: (...params) => { reads += 1; return handle.read(...params); },
      close: (...params) => { closes += 1; return handle.close(...params); },
    };
  };
  await assert.rejects(readBoundedNormalFile(alias, {
    fsImpl: mockFs, requireSingleLink: true, minBytes: 1, maxBytes: 128,
    encoding: "utf8", label: "Private fixture",
  }), (error) => error?.code === SAFE_FILE_ERROR_CODES.notNormal);
  assert.equal(reads, 0, "Never read foreign linked bytes into application memory");
  assert.equal(closes, 1, "Close the refused descriptor");
  assert.equal(await fs.readFile(outside, "utf8"), "foreign-private-content");
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



test("Windows safe reader rejects link-like entries and file-identity swaps before reading", async () => {
  const fileStat = {
    dev: 7,
    ino: 11,
    size: 5,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const linkStat = {
    dev: 7,
    ino: 12,
    size: 0,
    isFile: () => false,
    isSymbolicLink: () => true,
  };

  let opened = false;
  await assert.rejects(
    readBoundedNormalFile("C:\\State\\config.json", {
      platform: "win32",
      maxBytes: 16,
      fsImpl: {
        lstat: async () => linkStat,
        open: async () => { opened = true; throw new Error("must not open"); },
      },
      label: "Fixture",
    }),
    (error) => error?.code === SAFE_FILE_ERROR_CODES.notNormal,
  );
  assert.equal(opened, false);

  let readCalled = false;
  let closed = false;
  await assert.rejects(
    readBoundedNormalFile("C:\\State\\config.json", {
      platform: "win32",
      maxBytes: 16,
      fsImpl: {
        lstat: async () => fileStat,
        open: async () => ({
          stat: async () => ({ ...fileStat, ino: 99 }),
          read: async () => { readCalled = true; return { bytesRead: 0 }; },
          close: async () => { closed = true; },
        }),
      },
      label: "Fixture",
    }),
    (error) => error?.code === SAFE_FILE_ERROR_CODES.notNormal,
  );
  assert.equal(readCalled, false);
  assert.equal(closed, true);
});

test("Windows safe reader accepts a stable regular file handle identity", async () => {
  const stat = {
    dev: 7,
    ino: 11,
    size: 5,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  let reads = 0;
  const result = await readBoundedNormalFile("C:\\State\\config.json", {
    platform: "win32",
    minBytes: 1,
    maxBytes: 16,
    encoding: "utf8",
    fsImpl: {
      lstat: async () => stat,
      open: async () => ({
        stat: async () => stat,
        read: async (buffer, offset, length, position) => {
          reads += 1;
          if (position > 0) return { bytesRead: 0 };
          Buffer.from("hello").copy(buffer, offset, 0, Math.min(length, 5));
          return { bytesRead: 5 };
        },
        close: async () => {},
      }),
    },
    label: "Fixture",
  });
  assert.equal(result.data, "hello");
  assert.equal(reads, 2);
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

test("safe file writer never clobbers a file created during publish", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-safe-file-race-"));
  try {
    const target = path.join(root, "created.txt");
    let injected = false;
    const racingFs = {
      stat: (...args) => fs.stat(...args),
      lstat: (...args) => fs.lstat(...args),
      link: (...args) => fs.link(...args),
      unlink: (...args) => fs.unlink(...args),
      rm: (...args) => fs.rm(...args),
      open: async (...args) => {
        const handle = await fs.open(...args);
        if (!injected) {
          injected = true;
          await fs.writeFile(target, "rival", { mode: 0o600, flag: "wx" });
        }
        return handle;
      },
    };

    await assert.rejects(
      writeBoundedUtf8File(target, {
        content: "ours",
        fsImpl: racingFs,
        maxBytes: 64,
        label: "Fixture",
      }),
      (error) => error?.code === "EEXIST",
    );

    assert.equal(await fs.readFile(target, "utf8"), "rival");
    assert.deepEqual(await fs.readdir(root), ["created.txt"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("safe file writer rejects foreign normal temp substituted after close for create and replacement", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-safe-writer-original-inode-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const replacing of [false, true]) {
    const name = replacing ? "replace.txt" : "create.txt";
    const target = path.join(root, name);
    const savedOriginal = path.join(root, `original-${name}`);
    const foreign = path.join(root, `foreign-${name}`);
    const foreignData = `foreign unrelated source ${name}`;
    await fs.writeFile(foreign, foreignData, { mode: 0o600, flag: "wx" });
    if (replacing) await fs.writeFile(target, "old trusted bytes", { mode: 0o600, flag: "wx" });
    const expectedSha256 = replacing
      ? createHash("sha256").update("old trusted bytes").digest("hex") : undefined;
    let swapped = null;
    const racingFs = Object.create(fs);
    racingFs.open = async (candidate, ...args) => {
      const originalHandle = await fs.open(candidate, ...args);
      if (!path.basename(String(candidate)).startsWith(`.${name}.equinox-write-`)) return originalHandle;
      return new Proxy(originalHandle, {
        get(handle, property) {
          if (property === "close") return async () => {
            await handle.close();
            await fs.rename(candidate, savedOriginal);
            await fs.rename(foreign, candidate);
            swapped = candidate;
          };
          const value = handle[property];
          return typeof value === "function" ? value.bind(handle) : value;
        },
      });
    };
    await assert.rejects(writeBoundedUtf8File(target, {
      content: "new trusted bytes", expectedSha256, maxBytes: 128,
      label: "Original inode fixture", fsImpl: racingFs,
    }), /original.*temporary|temporary.*changed|foreign.*temporary|original.*inode/u);
    assert.ok(swapped, "Another writer must substitute a distinct normal inode after close");
    assert.equal(await fs.readFile(swapped, "utf8"), foreignData,
      "Rejected writes must preserve the other writer's replacement temp");
    assert.equal(await fs.readFile(savedOriginal, "utf8"), "new trusted bytes");
    if (replacing) assert.equal(await fs.readFile(target, "utf8"), "old trusted bytes");
    else await assert.rejects(fs.access(target), { code: "ENOENT" });
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

test("safe file writer rejects a replacement raced after the initial SHA guard and removes temp files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-safe-file-cas-race-"));
  try {
    const target = path.join(root, "state.txt");
    await fs.writeFile(target, "before", { mode: 0o600, flag: "wx" });
    const expectedSha256 = createHash("sha256").update("before").digest("hex");
    let openedTargetCount = 0;
    const racingFs = {
      stat: (...args) => fs.stat(...args),
      lstat: (...args) => fs.lstat(...args),
      link: (...args) => fs.link(...args),
      unlink: (...args) => fs.unlink(...args),
      rename: (...args) => fs.rename(...args),
      rm: (...args) => fs.rm(...args),
      open: async (...args) => {
        if (args[0] === target && ++openedTargetCount === 2) {
          await fs.writeFile(target, "rival", { flag: "w" });
        }
        return fs.open(...args);
      },
    };
    await assert.rejects(
      writeBoundedUtf8File(target, {
        content: "ours",
        expectedSha256,
        fsImpl: racingFs,
        maxBytes: 64,
        label: "Fixture",
      }),
      /SHA-256 guard changed before replacement/u,
    );
    assert.equal(openedTargetCount, 2);
    assert.equal(await fs.readFile(target, "utf8"), "rival");
    assert.deepEqual(await fs.readdir(root), ["state.txt"], "rejected replacement must not leave a temporary file");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
