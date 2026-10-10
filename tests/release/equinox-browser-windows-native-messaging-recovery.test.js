import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  registerWindowsNativeMessagingHost,
  windowsNativeMessagingManifest,
} from "../../src/equinox-browser-windows-native-messaging.js";

const launcherPath = "C:\\Program Files\\Equinox Local\\releases\\6.0.1\\runtime\\browser\\equinox-browser-native-host.exe";

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-native-host-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifestRoot = path.join(root, "browser", "native-messaging");
  const manifestPath = path.join(manifestRoot, "dev.equinox.browser.json");
  const dummyLauncher = path.join(root, "safe-launcher.exe");
  await fs.writeFile(dummyLauncher, "launcher-fixture\n");
  const fsImpl = {
    ...fs,
    lstat: (file) => file === launcherPath ? fs.lstat(dummyLauncher) : fs.lstat(file),
  };
  let registryValue = manifestPath;
  let reads = 0;
  const execFileAsync = async (program, args) => {
    if (program.endsWith("powershell.exe")) {
      reads += 1;
      if (registryValue === null) return { stdout: "missing\n" };
      return { stdout: `value:${Buffer.from(registryValue, "utf8").toString("hex").toUpperCase()}\n` };
    }
    if (program === "reg.exe") {
      assert.deepEqual(args.slice(0, 2), ["ADD", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\dev.equinox.browser"]);
      registryValue = manifestPath;
      return { stdout: "" };
    }
    throw new Error("Unexpected executable in mocked Native Messaging registry workflow.");
  };
  return { root, manifestRoot, manifestPath, fsImpl, execFileAsync, getRegistry: () => registryValue,
    setRegistry: (value) => { registryValue = value; }, readCount: () => reads };
}

const shared = (f) => ({ manifestRoot: f.manifestRoot, launcherPath, fsImpl: f.fsImpl,
  execFileAsync: f.execFileAsync, env: { SystemRoot: "C:\\Windows" } });

test("default registration refuses missing manifest despite canonical HKCU key", async (t) => {
  const f = await makeFixture(t);
  await assert.rejects(registerWindowsNativeMessagingHost(shared(f)), /refusing to repair ambiguous ownership/u);
  await assert.rejects(fs.lstat(f.manifestPath), (e) => e?.code === "ENOENT");
});

test("explicit managed recovery rebuilds only missing canonical file without registry mutation", async (t) => {
  const f = await makeFixture(t);
  const result = await registerWindowsNativeMessagingHost({ ...shared(f), recoverMissingOwnedManifest: true });
  assert.equal(result.manifestChanged, true);
  assert.equal(result.registryChanged, false);
  assert.equal(result.idempotent, false);
  assert.equal(await fs.readFile(f.manifestPath, "utf8"), windowsNativeMessagingManifest(launcherPath));
  assert.equal(f.getRegistry(), f.manifestPath);
  assert.ok(f.readCount() >= 3);
  const retry = await registerWindowsNativeMessagingHost(shared(f));
  assert.equal(retry.idempotent, true);
});

test("recovery refuses unverified launcher and foreign registry ownership", async (t) => {
  const f = await makeFixture(t);
  await assert.rejects(registerWindowsNativeMessagingHost({ ...shared(f), recoverMissingOwnedManifest: true, verifyLauncher: false }),
    /refusing to repair ambiguous ownership/u);
  f.setRegistry("C:\\Foreign\\other.json");
  await assert.rejects(registerWindowsNativeMessagingHost({ ...shared(f), recoverMissingOwnedManifest: true }),
    /owned by another manifest/u);
  await assert.rejects(fs.lstat(f.manifestPath), (e) => e?.code === "ENOENT");
});

test("recovery refuses non-empty, foreign or symlinked manifest entries", async (t) => {
  const f = await makeFixture(t);
  await fs.mkdir(f.manifestRoot, { recursive: true });
  await fs.writeFile(f.manifestPath, "foreign native host manifest\n");
  await assert.rejects(registerWindowsNativeMessagingHost({ ...shared(f), recoverMissingOwnedManifest: true }),
    /foreign or malformed/u);
  assert.equal(await fs.readFile(f.manifestPath, "utf8"), "foreign native host manifest\n");
  await fs.rm(f.manifestPath);
  await fs.symlink(path.join(f.root, "nonexistent-manifest.json"), f.manifestPath);
  await assert.rejects(registerWindowsNativeMessagingHost({ ...shared(f), recoverMissingOwnedManifest: true }));
});

test("recovery rejects registry owner changed between validation reads", async (t) => {
  const f = await makeFixture(t);
  const base = f.execFileAsync;
  let reads = 0;
  const execFileAsync = async (...args) => {
    reads += 1;
    if (reads === 2) f.setRegistry("C:\\Foreign\\new-owner.json");
    return base(...args);
  };
  await assert.rejects(registerWindowsNativeMessagingHost({ ...shared(f), recoverMissingOwnedManifest: true, execFileAsync }),
    /changed ownership before missing-manifest recovery/u);
  await assert.rejects(fs.lstat(f.manifestPath), (e) => e?.code === "ENOENT");
});
