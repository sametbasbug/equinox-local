import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { provisionWindowsGuardianFromRelease as provision } from "../../src/equinox-local-windows-guardian-provision.js";

async function fixture(t, { guardian = true } = {}) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-windows-guardian-install-")));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const installRoot = path.join(temp, "Equinox Local");
  const releaseDir = path.join(installRoot, "releases", "6.0.4");
  const source = path.join(releaseDir, "runtime", "guardian", "EquinoxLocalGuardian.exe");
  const target = path.join(installRoot, "runtime", "guardian", "EquinoxLocalGuardian.exe");
  await fs.mkdir(path.dirname(source), { recursive: true });
  // A fresh Windows installation has not yet created the independent
  // runtime ownership directory. The provisioner must create it itself.
  if (guardian) await fs.writeFile(source, Buffer.alloc(2048, 0x5d));
  else await fs.rm(path.dirname(source), { recursive: true });
  return {
    temp, installRoot, releaseDir, source, target,
    installation: { platform: "win32", target: "win32-x64", installRoot, releaseDir },
  };
}

test("independent Guardian is staged byte-for-byte outside WPF and remains unregistered", async (t) => {
  const f = await fixture(t);
  const result = await provision({ installation: f.installation });
  assert.equal(result.status, "provisioned");
  assert.match(result.sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.source));
  assert.deepEqual((await fs.readdir(path.dirname(f.target))).sort(), ["EquinoxLocalGuardian.exe"]);
  assert.equal((await provision({ installation: f.installation })).status, "already-provisioned");
});

test("legacy Stable without a Guardian stays compatible and remains untouched", async (t) => {
  const f = await fixture(t, { guardian: false });
  assert.deepEqual(await provision({ installation: f.installation }), { status: "legacy-release", installed: false });
  await assert.rejects(fs.lstat(path.dirname(f.target)), { code: "ENOENT" });
});

test("installed Guardian with untrusted bytes is never overwritten", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.target), { recursive: true });
  await fs.writeFile(f.target, Buffer.alloc(2048, 0x43));
  await assert.rejects(provision({ installation: f.installation }), /differs from the trusted release/u);
  assert.equal((await fs.readFile(f.target))[0], 0x43);
});

test("foreign release identity, unsupported platform and wrong architecture refuse changes", async (t) => {
  const f = await fixture(t);
  for (const changed of [
    { platform: "darwin" }, { target: "win32-ia32" },
    { releaseDir: f.temp }, { installRoot: f.temp },
    { releaseDir: "." },
  ]) {
    await assert.rejects(provision({ installation: { ...f.installation, ...changed } }), /exact owned managed release/u);
    await assert.rejects(fs.lstat(f.target), { code: "ENOENT" });
  }
});

test("symlinked release source or destination directory never admits executable", async (t) => {
  const f = await fixture(t);
  await fs.rm(f.source);
  await fs.symlink(path.join(f.temp, "foreign.exe"), f.source);
  await assert.rejects(provision({ installation: f.installation }), /normal executable|unsafe/u);
  await fs.rm(f.source);
  await fs.writeFile(f.source, Buffer.alloc(2048, 1));
  await fs.symlink(path.join(f.temp, "foreign"), path.dirname(f.target), "dir");
  await assert.rejects(provision({ installation: f.installation }), /normal owned directory/u);
});

test("short, invalid, or missing Guardian in a declared source folder fails closed", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.source, "too short");
  await assert.rejects(provision({ installation: f.installation }), /bounded normal executable/u);
  await fs.rm(f.source);
  await assert.rejects(provision({ installation: f.installation }), { code: "ENOENT" });
});

test("concurrent exclusive publishing cannot silently replace another installer result", async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.allSettled([
    provision({ installation: f.installation }),
    provision({ installation: f.installation }),
  ]);
  const fulfilled = [a, b].filter((result) => result.status === "fulfilled");
  assert.ok(fulfilled.length >= 1);
  for (const result of [a, b]) {
    if (result.status === "rejected") assert.equal(result.reason.code, "EEXIST");
  }
  assert.deepEqual(await fs.readFile(f.target), await fs.readFile(f.source));
  assert.deepEqual((await fs.readdir(path.dirname(f.target))).sort(), ["EquinoxLocalGuardian.exe"]);
});
