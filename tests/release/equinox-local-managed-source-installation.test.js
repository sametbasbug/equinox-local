import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  assert.match(server, /kind === "source" \|\| equinoxLocalInstallation\.kind === "managed-source"/u);
  assert.match(server, /equinoxLocalMainApplyController\.resetError\(\)/u);
  assert.match(server, /kind === "managed-source"[\s\S]*equinoxLocalMainApplyController\.apply\(\)[\s\S]*equinoxLocalUpdateCoordinator\.apply\(\)/u);
  assert.match(server, /\.\.\.equinoxLocalMainApplyController\.snapshot\(\)/u);
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
  await fs.mkdir(path.dirname(managedGit), { recursive: true, mode: 0o700 });
  await fs.writeFile(managedGit, "fixture\n", { mode: 0o700 });
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
  assert.match(resolved.nodePath, /runtime\/toolchain\/node\/26\.10\.0\/darwin-arm64\/bin\/node$/u);
  assert.match(resolved.npmPath, /npm-cli\.js$/u);
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
