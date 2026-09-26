import assert from "node:assert/strict";
import test from "node:test";

import { inspectPrivateStatePath } from "../../src/equinox-local-private-state.js";

function fakeFs(stat) {
  return { async lstat() { return stat; } };
}

function fakeStat({ type = "file", mode = 0o100600 } = {}) {
  return {
    mode,
    isFile: () => type === "file",
    isDirectory: () => type === "directory",
    isSymbolicLink: () => type === "symlink",
  };
}

test("Darwin private-state inspection preserves exact type/mode semantics", async () => {
  const safe = await inspectPrivateStatePath("/private/config", { platform: "darwin", type: "file", mode: "600", fsImpl: fakeFs(fakeStat()) });
  assert.equal(safe.safe, true);
  assert.equal(safe.security, "posix");
  assert.equal(safe.mode, "600");

  const broad = await inspectPrivateStatePath("/private/config", { platform: "darwin", type: "file", mode: "600", fsImpl: fakeFs(fakeStat({ mode: 0o100644 })) });
  assert.equal(broad.safe, false);
  assert.equal(broad.reason, "type-or-mode");
});

test("Windows private state fails closed until an ACL verifier explicitly proves safety", async () => {
  const stat = fakeStat();
  const unknownAcl = await inspectPrivateStatePath("C:\\State\\config.json", { platform: "win32", type: "file", fsImpl: fakeFs(stat) });
  assert.equal(unknownAcl.safe, false);
  assert.equal(unknownAcl.security, "windows-acl");
  assert.equal(unknownAcl.reason, "acl-unverified");

  const calls = [];
  const verified = await inspectPrivateStatePath("C:\\State\\config.json", {
    platform: "win32",
    type: "file",
    fsImpl: fakeFs(stat),
    verifyWindowsAcl: async (input) => { calls.push(input); return { safe: true }; },
  });
  assert.equal(verified.safe, true);
  assert.deepEqual(calls, [{ target: "C:\\State\\config.json", type: "file" }]);
});

test("private-state inspection rejects symlinks on every supported platform", async () => {
  for (const platform of ["darwin", "win32"]) {
    const result = await inspectPrivateStatePath("x", { platform, type: "file", fsImpl: fakeFs(fakeStat({ type: "symlink" })), verifyWindowsAcl: async () => ({ safe: true }) });
    assert.equal(result.safe, false);
    assert.equal(result.reason, "symlink");
  }
});
