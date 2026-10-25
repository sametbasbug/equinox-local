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

test("exact Main native-store Guardian is provisioned without requiring old numbered Stable",async (t)=>{
  const f=await fixture(t);
  const releaseDir=path.join(f.installRoot,'state','main-update','native-store','win32-x64','a'.repeat(40),'release');
  const source=path.join(releaseDir,'runtime','guardian','EquinoxLocalGuardian.exe');
  await fs.mkdir(path.dirname(source),{recursive:true});
  await fs.writeFile(source,Buffer.alloc(2048,0x31));
  const installation={...f.installation,releaseDir};
  assert.equal((await provision({installation})).status,'provisioned');
  assert.deepEqual(await fs.readFile(f.target),await fs.readFile(source));
  await assert.rejects(provision({installation:f.installation}),/differs from the trusted release/u);
  await assert.rejects(provision({installation:{...installation,releaseDir:path.join(f.installRoot,'state','main-update','native-store','win32-x64','b'.repeat(40),'other')}}),/exact owned managed release/u);
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
  await fs.mkdir(path.join(f.installRoot, "runtime"), { recursive: true });
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

test("Guardian source mutation during verified copy never publishes B or leaves staging files", async (t) => {
  const f = await fixture(t);
  const baseline = await fs.readFile(f.source);
  let sourceOpens = 0;
  const fsImpl = {
    ...fs,
    open: async (file, ...args) => {
      if (file === f.source) {
        sourceOpens++;
        if (sourceOpens === 2) await fs.writeFile(f.source, Buffer.alloc(2048, 0x3b));
      }
      return fs.open(file, ...args);
    },
  };
  await assert.rejects(provision({ installation: f.installation, fsImpl }),
    /Windows Guardian release or staged bytes changed during copy/u);
  assert.equal(sourceOpens >= 3, true);
  assert.notDeepEqual(await fs.readFile(f.source), baseline);
  await assert.rejects(fs.lstat(f.target), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), []);
});

test("failed exclusive Guardian publication never leaves an executable or orphaned temp", async (t) => {
  const f = await fixture(t);
  let publications = 0;
  const fsImpl = {
    ...fs,
    link: async () => {
      publications++;
      throw Object.assign(new Error("concurrent owned publisher"), { code: "EEXIST" });
    },
  };
  await assert.rejects(provision({ installation: f.installation, fsImpl }), { code: "EEXIST" });
  assert.equal(publications, 1);
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), []);
  await assert.rejects(fs.lstat(f.target), { code: "ENOENT" });
  assert.equal((await fs.readFile(f.source))[0], 0x5d);
});

test("preexisting symlinked Guardian executable cannot replace a foreign user file", async (t) => {
  const f = await fixture(t);
  const foreign = path.join(f.temp, "user-owned-profile.bin");
  const foreignBytes = Buffer.alloc(2048, 0x73);
  await fs.writeFile(foreign, foreignBytes);
  await fs.mkdir(path.dirname(f.target), { recursive: true });
  await fs.symlink(foreign, f.target);
  await assert.rejects(provision({ installation: f.installation }),
    /bounded normal executable/u);
  assert.deepEqual(await fs.readFile(foreign), foreignBytes);
  assert.equal((await fs.lstat(f.target)).isSymbolicLink(), true);
  assert.deepEqual(await fs.readdir(path.dirname(f.target)), ["EquinoxLocalGuardian.exe"]);
});
