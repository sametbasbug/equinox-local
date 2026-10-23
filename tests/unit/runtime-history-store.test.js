import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createRuntimeHistoryStore } from "../../src/runtime-history-store.js";

async function withTempDir(run) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-history-store-"));
  try {
    await run(rootDir);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

test("history store tolerates malformed/foreign-schema lines and atomically retains bounded JSONL with private modes", async () => {
  await withTempDir(async (rootDir) => {
    const store = createRuntimeHistoryStore({
      rootDir,
      fileName: "history.jsonl",
      schemaVersion: 1,
      maxRecords: 2,
      randomId: () => "test-temp",
    });
    assert.deepEqual(await store.read(), []);

    await fs.writeFile(store.historyPath, [
      JSON.stringify({ schemaVersion: 1, id: "first" }),
      "{malformed",
      JSON.stringify({ schemaVersion: 2, id: "foreign" }),
      JSON.stringify({ schemaVersion: 1, id: "second" }),
      "",
    ].join("\r\n"));
    assert.deepEqual(await store.read(), [
      { schemaVersion: 1, id: "first" },
      { schemaVersion: 1, id: "second" },
    ]);

    await store.append({ schemaVersion: 1, id: "third" });
    assert.deepEqual(await store.read(), [
      { schemaVersion: 1, id: "second" },
      { schemaVersion: 1, id: "third" },
    ]);
    assert.equal(
      await fs.readFile(store.historyPath, "utf8"),
      `${JSON.stringify({ schemaVersion: 1, id: "second" })}\n${JSON.stringify({ schemaVersion: 1, id: "third" })}\n`,
    );
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(rootDir)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(store.historyPath)).mode & 0o777, 0o600);
    }
    assert.deepEqual(await fs.readdir(rootDir), ["history.jsonl"]);
  });
});

test("history store requests the exact private directory and file modes on every platform", async () => {
  const rootDir = path.join(os.tmpdir(), "mode-request-fixture");
  const calls = [];
  const fsImpl = {
    mkdir: async (...args) => { calls.push(["mkdir", ...args]); },
    chmod: async (...args) => { calls.push(["chmod", ...args]); },
    access: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    writeFile: async (file, _content, options) => { calls.push(["writeFile", file, options]); },
    readFile: async () => "",
    rename: async (...args) => { calls.push(["rename", ...args]); },
  };
  const store = createRuntimeHistoryStore({ rootDir, fileName: "history.jsonl", schemaVersion: 1,
    maxRecords: 5, randomId: () => "mode-fixture", fsImpl });
  await store.append({ schemaVersion: 1, id: "fixture" });
  const temporary = `${store.historyPath}.${process.pid}.mode-fixture.tmp`;
  assert.deepEqual(calls, [
    ["mkdir", rootDir, { recursive: true, mode: 0o700 }],
    ["chmod", rootDir, 0o700],
    ["writeFile", store.historyPath, { mode: 0o600, flag: "wx" }],
    ["chmod", store.historyPath, 0o600],
    ["writeFile", temporary, { mode: 0o600, flag: "wx" }],
    ["rename", temporary, store.historyPath],
    ["chmod", store.historyPath, 0o600],
  ]);
});

test("concurrent appends serialize read-modify-write so no history record is lost", async () => {
  await withTempDir(async (rootDir) => {
    const temporaryPaths = [];
    const recordingFs = {
      ...fs,
      writeFile: async (filePath, ...args) => {
        if (String(filePath).endsWith(".tmp")) temporaryPaths.push(filePath);
        return fs.writeFile(filePath, ...args);
      },
    };
    const store = createRuntimeHistoryStore({ rootDir, fileName: "history.jsonl", schemaVersion: 1, maxRecords: 5, fsImpl: recordingFs });
    await Promise.all([
      store.append({ schemaVersion: 1, id: "first" }),
      store.append({ schemaVersion: 1, id: "second" }),
    ]);
    assert.deepEqual((await store.read()).map(({ id }) => id), ["first", "second"]);
    assert.equal(temporaryPaths.length, 2);
    assert.equal(new Set(temporaryPaths).size, 2);
  });
});

test("history store retains a caller-provided temporary id generator", async () => {
  await withTempDir(async (rootDir) => {
    const temporaryPaths = [];
    const recordingFs = {
      ...fs,
      writeFile: async (filePath, ...args) => {
        if (String(filePath).endsWith(".tmp")) temporaryPaths.push(filePath);
        return fs.writeFile(filePath, ...args);
      },
    };
    const store = createRuntimeHistoryStore({
      rootDir,
      fileName: "history.jsonl",
      schemaVersion: 1,
      maxRecords: 5,
      randomId: () => "provided-id",
      fsImpl: recordingFs,
    });

    await store.append({ schemaVersion: 1, id: "record" });

    assert.deepEqual(temporaryPaths, [`${store.historyPath}.${process.pid}.provided-id.tmp`]);
  });
});

test("history store propagates non-ENOENT read failures", async () => {
  await withTempDir(async (rootDir) => {
    const failingFs = {
      ...fs,
      readFile: async () => {
        const error = new Error("history denied");
        error.code = "EACCES";
        throw error;
      },
    };
    const store = createRuntimeHistoryStore({
      rootDir,
      fileName: "history.jsonl",
      schemaVersion: 1,
      maxRecords: 5,
      fsImpl: failingFs,
    });

    await assert.rejects(store.read(), /history denied/u);
  });
});

test("history initialize refuses inaccessible records instead of truncating a private file", async () => {
  await withTempDir(async (rootDir) => {
    const historyPath = path.join(rootDir, "history.jsonl");
    const original = `${JSON.stringify({ schemaVersion: 1, id: "private-original" })}\n`;
    await fs.writeFile(historyPath, original);
    let writes = 0;
    const fsImpl = {
      ...fs,
      access: async () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); },
      writeFile: async (...args) => { writes += 1; return fs.writeFile(...args); },
    };
    const store = createRuntimeHistoryStore({ rootDir, fileName: "history.jsonl", schemaVersion: 1, maxRecords: 10, fsImpl });
    await assert.rejects(store.append({ schemaVersion: 1, id: "new" }), /permission denied/u);
    assert.equal(writes, 0);
    assert.equal(await fs.readFile(historyPath, "utf8"), original);
  });
});

test("history append refuses a preexisting symlink in its temporary slot", async () => {
  await withTempDir(async (rootDir) => {
    const foreign = path.join(rootDir, "foreign.txt");
    await fs.writeFile(foreign, "DO NOT TOUCH");
    const store = createRuntimeHistoryStore({
      rootDir, fileName: "history.jsonl", schemaVersion: 1, maxRecords: 5, randomId: () => "collision",
    });
    const temporary = `${store.historyPath}.${process.pid}.collision.tmp`;
    await fs.symlink(foreign, temporary);
    await assert.rejects(store.append({ schemaVersion: 1, id: "new" }), { code: "EEXIST" });
    assert.equal(await fs.readFile(foreign, "utf8"), "DO NOT TOUCH");
    assert.equal((await fs.lstat(temporary)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(store.historyPath, "utf8"), "");
  });
});

test("history rename failure removes only its temporary file and later writes continue", async () => {
  await withTempDir(async (rootDir) => {
    const fileName = "history.jsonl";
    const historyPath = path.join(rootDir, fileName);
    const original = `${JSON.stringify({ schemaVersion: 1, id: "before" })}\n`;
    await fs.writeFile(historyPath, original);
    let failRename = true;
    const fsImpl = {
      ...fs,
      rename: async (...args) => {
        if (failRename) {
          failRename = false;
          throw Object.assign(new Error("rename interrupted"), { code: "EIO" });
        }
        return fs.rename(...args);
      },
    };
    const store = createRuntimeHistoryStore({
      rootDir, fileName, schemaVersion: 1, maxRecords: 5, fsImpl,
    });
    await assert.rejects(store.append({ schemaVersion: 1, id: "failed" }), /rename interrupted/u);
    assert.equal(await fs.readFile(historyPath, "utf8"), original);
    assert.deepEqual(await fs.readdir(rootDir), [fileName]);
    await store.append({ schemaVersion: 1, id: "recovered" });
    assert.deepEqual((await store.read()).map(({ id }) => id), ["before", "recovered"]);
    assert.deepEqual(await fs.readdir(rootDir), [fileName]);
  });
});
