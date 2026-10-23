import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseEquinoxLocalCurrentVersionPointer,
  readEquinoxLocalCurrentVersionPointer,
  serializeEquinoxLocalCurrentVersionPointer,
  writeEquinoxLocalCurrentVersionPointer,
} from "../../src/equinox-local-current-release.js";

const windowsTest = process.platform === "win32" ? test : test.skip;

test("Windows current-version pointer is exact, target-bound and version-bounded", () => {
  const pointer = parseEquinoxLocalCurrentVersionPointer({
    schemaVersion: 1,
    target: "win32-x64",
    version: "5.2.1",
  });
  assert.deepEqual(pointer, { schemaVersion: 1, target: "win32-x64", version: "5.2.1" });
  assert.match(serializeEquinoxLocalCurrentVersionPointer(pointer), /"target": "win32-x64"/u);
  const arm64Pointer = parseEquinoxLocalCurrentVersionPointer({
    schemaVersion: 1,
    target: "win32-arm64",
    version: "5.2.1",
  }, { target: "win32-arm64" });
  assert.deepEqual(arm64Pointer, { schemaVersion: 1, target: "win32-arm64", version: "5.2.1" });
  assert.match(serializeEquinoxLocalCurrentVersionPointer({ version: "5.2.1", target: "win32-arm64" }), /"target": "win32-arm64"/u);
  assert.throws(() => parseEquinoxLocalCurrentVersionPointer(pointer, { target: "win32-arm64" }), /target does not match/u);
  assert.throws(() => parseEquinoxLocalCurrentVersionPointer({
    schemaVersion: 1,
    target: "darwin-arm64",
    version: "5.2.1",
  }), /target does not match/u);
  assert.throws(() => parseEquinoxLocalCurrentVersionPointer({
    schemaVersion: 1,
    target: "win32-x64",
    version: "5.2",
  }), /Unsupported Equinox Local version/u);
  assert.throws(() => parseEquinoxLocalCurrentVersionPointer({
    schemaVersion: 1,
    target: "win32-x64",
    version: "5.2.1",
    releaseDir: "C:\\evil",
  }), /missing or unsupported fields/u);
});

windowsTest("Windows current-version pointer writes and replaces one normal bounded file", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-current-version-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pointerPath = path.join(root, "current-version.json");

  await writeEquinoxLocalCurrentVersionPointer(pointerPath, { version: "5.2.1" });
  assert.equal((await readEquinoxLocalCurrentVersionPointer(pointerPath)).version, "5.2.1");
  await writeEquinoxLocalCurrentVersionPointer(pointerPath, { version: "5.2.2" });
  assert.equal((await readEquinoxLocalCurrentVersionPointer(pointerPath)).version, "5.2.2");

  await fs.rm(pointerPath);
  await fs.symlink(path.join(root, "missing.json"), pointerPath);
  await assert.rejects(
    writeEquinoxLocalCurrentVersionPointer(pointerPath, { version: "5.2.3" }),
    /normal, non-symlink/u,
  );
});

test("current-version pointer native-file guard works with injected Windows semantics", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-current-pointer-injected-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pointerPath = path.join(root, "current-version.json");
  const win32 = { platform: "win32", target: "win32-arm64" };

  await writeEquinoxLocalCurrentVersionPointer(pointerPath, { ...win32, version: "6.1.1" });
  assert.equal((await readEquinoxLocalCurrentVersionPointer(pointerPath, win32)).version, "6.1.1");

  await writeEquinoxLocalCurrentVersionPointer(pointerPath, { ...win32, version: "6.1.2" });
  assert.deepEqual(await readEquinoxLocalCurrentVersionPointer(pointerPath, win32), {
    schemaVersion: 1,
    target: "win32-arm64",
    version: "6.1.2",
  });
  await assert.rejects(
    readEquinoxLocalCurrentVersionPointer(pointerPath, { ...win32, target: "win32-x64" }),
    /target does not match/,
  );

  const originalContent = await fs.readFile(pointerPath, "utf8");
  await fs.rm(pointerPath);
  await fs.symlink(path.join(root, "foreign.json"), pointerPath);
  await assert.rejects(
    writeEquinoxLocalCurrentVersionPointer(pointerPath, { ...win32, version: "6.1.3" }),
    /normal, non-symlink/,
  );
  assert.equal(await fs.readlink(pointerPath), path.join(root, "foreign.json"));
  assert.match(originalContent, /"version": "6.1.2"/);
});
