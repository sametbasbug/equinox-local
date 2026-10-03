import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { inspectPrivateStatePath, protectWindowsPrivateStatePath, verifyWindowsPrivateStateAcl } from "../../src/equinox-local-private-state.js";

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


test("Windows private-state ACL helper uses fixed PowerShell and parses bounded verification", async () => {
  const calls = [];
  const execFileAsync = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: '{"safe":true,"reason":null}\n', stderr: '' };
  };
  const env = { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32" };
  const input = { target: "C:\\Users\\Türk User\\AppData\\Local\\Equinox Local\\state\\secrets\\telegram.json", type: "file", execFileAsync, env };
  assert.deepEqual(await verifyWindowsPrivateStateAcl(input), { safe: true, reason: null });
  assert.deepEqual(await protectWindowsPrivateStatePath({ ...input, type: "directory", target: "C:\\Users\\Türk User\\AppData\\Local\\Equinox Local\\state\\secrets" }), { safe: true, reason: null });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.equal(call.args[0], "-NoLogo");
    assert.equal(call.args.includes("-File"), true);
    assert.equal(call.args.includes("-Target"), true);
    assert.equal(call.options.timeout, 45_000);
    assert.equal(call.options.windowsHide, true);
    assert.deepEqual(call.options.env, { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" });
  }
  assert.equal(calls[0].args[calls[0].args.indexOf("-Action") + 1], "verify");
  assert.equal(calls[1].args[calls[1].args.indexOf("-Action") + 1], "protect");
});

test("Windows private-state ACL protection fails closed on unsafe helper output", async () => {
  const execFileAsync = async () => ({ stdout: '{"safe":false,"reason":"foreign-principal"}\n', stderr: '' });
  await assert.rejects(
    protectWindowsPrivateStatePath({ target: "C:\\State\\secret.json", type: "file", execFileAsync, env: { SystemRoot: "C:\\Windows" } }),
    /foreign-principal/u,
  );
});


test("Windows private-state helper stays module-autoload independent", async () => {
  const helperPath = fileURLToPath(new URL("../../src/equinox-local-windows-private-state.ps1", import.meta.url));
  const helper = await fs.readFile(helperPath, "utf8");
  assert.doesNotMatch(helper, /\b(?:Set-Acl|Get-Acl|ConvertTo-Json|New-Object)\b/u);
  assert.match(helper, /System\.IO\.Directory\]::SetAccessControl/u);
  assert.match(helper, /System\.IO\.File\]::SetAccessControl/u);
  assert.match(helper, /GetOwner\(\[System\.Security\.Principal\.SecurityIdentifier\]\)/u);
});
