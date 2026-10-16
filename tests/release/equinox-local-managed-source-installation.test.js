import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveEquinoxLocalInstallation } from "../../src/equinox-local-installation.js";

import {
  equinoxLocalManagedSourcePaths,
  resolveEquinoxLocalManagedSourceInstallation,
} from "../../src/equinox-local-managed-source-installation.js";

const SHA = "a".repeat(40);

function base(root) {
  return {
    kind: "managed",
    managed: true,
    selfUpdateSupported: true,
    platform: "darwin",
    arch: "arm64",
    target: "darwin-arm64",
    installRoot: root,
    releaseDir: path.join(root, "releases", "5.2.0"),
  };
}

test("server startup upgrades a trusted managed base installation to managed-source identity", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const server = await fs.readFile(path.join(root, "src", "server.js"), "utf8");
  assert.match(server, /resolveEquinoxLocalManagedSourceInstallation/u);
  assert.match(server, /const equinoxLocalBaseInstallation = resolveEquinoxLocalInstallation/u);
  assert.match(server, /const equinoxLocalInstallation = await resolveEquinoxLocalManagedSourceInstallation/u);
  assert.match(server, /baseInstallation: equinoxLocalBaseInstallation/u);
});

test("server routes managed-source Main check/apply without changing Stable routing", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const server = await fs.readFile(path.join(root, "src", "server.js"), "utf8");
  assert.match(server, /createEquinoxLocalMainApplyController/u);
  assert.match(server, /\["source", "managed-source"\]\.includes\(equinoxLocalInstallation\.kind\)/u);
  assert.match(server, /equinoxLocalMainApplyController\.resetError\(\)/u);
  assert.match(server, /kind === "managed-source"[\s\S]*equinoxLocalMainApplyController\.apply\(\)[\s\S]*equinoxLocalUpdateCoordinator\.apply\(\)/u);
  assert.match(server, /\.\.\.equinoxLocalMainApplyController\.snapshot\(\)/u);
});

test("Windows Main native-store bootstrap is owned, but foreign and malformed releases cannot claim it", () => {
  const home = String.raw`C:\Users\Example`;
  const local = String.raw`C:\Users\Example\AppData\Local`;
  const install = String.raw`C:\Users\Example\AppData\Local\Equinox Local`;
  const sha = "b".repeat(40);
  const native = String.raw`C:\Users\Example\AppData\Local\Equinox Local\state\main-update\native-store\win32-x64`
    + `\\${sha}\\release`;
  const identity = (release) => resolveEquinoxLocalInstallation({
    platform: "win32", arch: "x64", homeDir: home,
    env: { LOCALAPPDATA: local, EQUINOX_LOCAL_INSTALL_ROOT: install, EQUINOX_LOCAL_RELEASE_DIR: release },
  });
  const main = identity(native);
  assert.equal(main.kind, "managed");
  assert.equal(main.releaseDir, native);
  assert.equal(main.mainNativeSha, sha);
  for (const release of [
    native + String.raw`\evil`,
    native.replace("win32-x64", "win32-arm64"),
    native.replace(sha, "non-sha"),
    String.raw`C:\Windows\System32`,
  ]) assert.equal(identity(release).kind, "unsupported", release);
});

test("managed-source paths stay product-owned on macOS and Windows", () => {
  const mac = equinoxLocalManagedSourcePaths({ platform: "darwin", arch: "arm64", homeDir: "/Users/example", env: {} });
  assert.equal(mac.mainTransactionRoot, "/Users/example/Library/Application Support/Equinox Local/main-update");
  assert.equal(mac.installStampPath, mac.mainTransactionRoot + "/install.json");

  const win = equinoxLocalManagedSourcePaths({
    platform: "win32",
    arch: "x64",
    homeDir: String.raw`C:\Users\Example`,
    env: { LOCALAPPDATA: String.raw`C:\Users\Example\AppData\Local` },
  });
  assert.equal(win.mainTransactionRoot, String.raw`C:\Users\Example\AppData\Local\Equinox Local\state\main-update`);
  assert.equal(win.sourcePointerPath, String.raw`C:\Users\Example\AppData\Local\Equinox Local\state\main-update\current-source.conf`);
});

test("managed-source resolver requires a private canonical stamp and exact source pointer", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-managed-source-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const installRoot = path.join(home, "Library", "Application Support", "Equinox Local");
  const paths = equinoxLocalManagedSourcePaths({ platform: "darwin", arch: "arm64", homeDir: home, env: {} });
  await fs.mkdir(paths.mainTransactionRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.mainTransactionRoot, 0o700);
  await fs.writeFile(paths.installStampPath, JSON.stringify({
    schemaVersion: 1,
    channel: "main",
    repository: "sametbasbug/equinox-local",
    branch: "main",
    bootstrapSha: SHA,
  }) + "\n", { mode: 0o600 });
  const sourceRoot = path.join(paths.mainTransactionRoot, "sources", SHA);

  const resolved = await resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation: base(installRoot),
    platform: "darwin",
    arch: "arm64",
    homeDir: home,
    env: {},
    readPointerImpl: async (pointerPath) => {
      assert.equal(pointerPath, paths.sourcePointerPath);
      return { sourceRoot, sha: SHA };
    },
  });

  assert.equal(resolved.kind, "managed-source");
  assert.equal(resolved.channel, "main");
  assert.equal(resolved.mainUpdateSupported, true);
  assert.equal(resolved.sourceRoot, sourceRoot);
  assert.equal(resolved.sourceSha, SHA);
  assert.equal(resolved.mainTransactionRoot, paths.mainTransactionRoot);
  assert.equal(resolved.mainInstallStamp.bootstrapSha, SHA);
});

test("managed-source resolver prefers exact product-owned Git when the M8 toolchain is present", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-managed-source-toolchain-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const installRoot = path.join(home, "Library", "Application Support", "Equinox Local");
  const paths = equinoxLocalManagedSourcePaths({ platform: "darwin", arch: "arm64", homeDir: home, env: {} });
  const managedGit = path.join(installRoot, "runtime", "toolchain", "git", "2.53.0-4", "darwin-arm64", "bin", "git");
  const managedNode = path.join(installRoot, "runtime", "toolchain", "node", "26.12.0", "darwin-arm64", "bin", "node");
  const managedNpm = path.join(installRoot, "runtime", "toolchain", "node", "26.12.0", "darwin-arm64", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  await fs.mkdir(path.dirname(managedGit), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(managedNode), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(managedNpm), { recursive: true, mode: 0o700 });
  await fs.writeFile(managedGit, "fixture\n", { mode: 0o700 });
  await fs.writeFile(managedNode, "fixture\n", { mode: 0o700 });
  await fs.writeFile(managedNpm, "fixture\n", { mode: 0o600 });
  await fs.mkdir(paths.mainTransactionRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(paths.installStampPath, JSON.stringify({
    schemaVersion: 1, channel: "main", repository: "sametbasbug/equinox-local", branch: "main", bootstrapSha: SHA,
  }) + "\n", { mode: 0o600 });

  const resolved = await resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation: base(installRoot),
    platform: "darwin",
    arch: "arm64",
    homeDir: home,
    env: {},
    readPointerImpl: async (pointerPath, options) => {
      assert.equal(pointerPath, paths.sourcePointerPath);
      assert.equal(options.gitPath, managedGit);
      return { sourceRoot: path.join(paths.mainTransactionRoot, "sources", SHA), sha: SHA };
    },
  });
  assert.equal(resolved.gitPath, managedGit);
  assert.match(resolved.nodePath, /runtime\/toolchain\/node\/26\.12\.0\/darwin-arm64\/bin\/node$/u);
  assert.match(resolved.npmPath, /npm-cli\.js$/u);
  assert.equal(resolved.shellPath, null);
});

test("managed-source resolver preserves Stable identity when no stamp exists and fails closed on unsafe stamp", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-managed-source-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const installRoot = path.join(home, "Library", "Application Support", "Equinox Local");
  const original = base(installRoot);
  const paths = equinoxLocalManagedSourcePaths({ platform: "darwin", arch: "arm64", homeDir: home, env: {} });

  assert.equal(await resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation: original, platform: "darwin", arch: "arm64", homeDir: home, env: {},
  }), original);

  await fs.mkdir(paths.mainTransactionRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(paths.installStampPath, "{}\n", { mode: 0o644 });
  await assert.rejects(resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation: original, platform: "darwin", arch: "arm64", homeDir: home, env: {},
  }), /install stamp is not private/u);
});

test("signed Stable ignores leftover incomplete Main toolchain but enrolled Main rejects it", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-stable-toolchain-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const installRoot = path.join(home, "Library", "Application Support", "Equinox Local");
  const original = base(installRoot);
  const paths = equinoxLocalManagedSourcePaths({ platform: "darwin", arch: "arm64", homeDir: home, env: {} });
  const leftoverGit = path.join(installRoot, "runtime", "toolchain", "git", "2.53.0-4", "darwin-arm64", "bin", "git");
  await fs.mkdir(path.dirname(leftoverGit), { recursive: true });
  await fs.writeFile(leftoverGit, "old product-owned leftover\n", { mode: 0o700 });
  await fs.mkdir(paths.mainTransactionRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.mainTransactionRoot, 0o700);

  // A repaired Stable must start without touching the residual old Main bits.
  assert.equal(await resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation: original, platform: "darwin", arch: "arm64", homeDir: home, env: {},
  }), original);
  assert.equal(await fs.readFile(leftoverGit, "utf8"), "old product-owned leftover\n");

  // An actual enrolled Main still rejects an incomplete product-owned toolchain.
  await fs.writeFile(paths.installStampPath, JSON.stringify({
    schemaVersion: 1, channel: "main", repository: "sametbasbug/equinox-local", branch: "main", bootstrapSha: SHA,
  }) + "\n", { mode: 0o600 });
  await assert.rejects(resolveEquinoxLocalManagedSourceInstallation({
    baseInstallation: original, platform: "darwin", arch: "arm64", homeDir: home, env: {},
  }), /Managed product-owned toolchain is incomplete/u);
});
