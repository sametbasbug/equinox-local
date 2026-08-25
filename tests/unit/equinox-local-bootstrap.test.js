import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  bootstrapManagedEquinoxUser,
  ensureWorkspaceGitRepository,
  EQUINOX_BROWSER_PRODUCTION_EXTENSION_ID,
  launchAgentPlist,
  nativeHostManifest,
  nativeHostWrapper,
  seedEquinoxLocalConfig,
} from "../../src/equinox-local-bootstrap.js";
import { managedSupervisorPaths } from "../../src/equinox-local-supervisor.js";
import { equinoxLocalUpdateTarget } from "../../src/equinox-local-updater.js";

async function makeManagedHome() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-bootstrap-"));
  const homeDir = path.join(root, "Home With Space");
  const paths = managedSupervisorPaths(homeDir);
  const releaseDir = path.join(paths.releasesRoot, "4.2.0");
  const nodeBinary = path.join(releaseDir, "runtime", "node", "bin", "node");
  const tunnelDir = path.join(releaseDir, "runtime", "tunnel");
  await fs.mkdir(path.dirname(nodeBinary), { recursive: true });
  await fs.mkdir(tunnelDir, { recursive: true });
  await fs.writeFile(path.join(releaseDir, "release.json"), JSON.stringify({
    schemaVersion: 1,
    version: "4.2.0",
    target: equinoxLocalUpdateTarget(),
    nodeVersion: "24.19.0",
    tunnelClientVersion: "0.0.12",
    serverEntry: "server.js",
  }));
  for (const relative of ["server.js", "equinox-local-supervisor.js", "equinox-browser-native-host.js"]) {
    await fs.writeFile(path.join(releaseDir, relative), `// ${relative}\n`);
  }
  await fs.writeFile(nodeBinary, "fixture-node\n");
  await fs.chmod(nodeBinary, 0o755);
  for (const name of ["tunnel-client", "cloudflared"]) {
    const binary = path.join(tunnelDir, name);
    await fs.writeFile(binary, `${name}\n`);
    await fs.chmod(binary, 0o755);
  }
  await fs.mkdir(paths.installRoot, { recursive: true });
  await fs.symlink("releases/4.2.0", paths.currentLink, "dir");
  return { root, homeDir, paths, releaseDir };
}

function mode(stat) {
  return stat.mode & 0o777;
}

test("first-run seed config exposes only a managed workspace and read-only Downloads root", () => {
  const homeDir = "/Users/example";
  const installRoot = "/Users/example/Library/Application Support/Equinox Local";
  const config = seedEquinoxLocalConfig({ homeDir, installRoot });
  assert.equal(config.defaultProject, "workspace");
  assert.equal(config.projects.workspace.root, `${installRoot}/workspace`);
  assert.equal(config.projects.workspace.worktrees, false);
  assert.deepEqual(Object.keys(config.projects), ["workspace"]);
  assert.equal(config.fileRoots.downloads.root, "/Users/example/Downloads");
  assert.equal(config.fileRoots.downloads.access, "read-only");
  assert.equal(config.controlCenter.port, 24891);
});

test("launch agent and native host always follow the managed current pointer", () => {
  const homeDir = "/Users/example person";
  const installRoot = `${homeDir}/Library/Application Support/Equinox Local`;
  const plist = launchAgentPlist({ homeDir, installRoot });
  assert.match(plist, /dev\.equinox\.local/u);
  assert.match(plist, /current\/runtime\/node\/bin\/node/u);
  assert.match(plist, /current\/equinox-local-supervisor\.js/u);
  assert.doesNotMatch(plist, /releases\/4\.2\.0/u);

  const wrapper = nativeHostWrapper({ installRoot });
  assert.match(wrapper, /current\/runtime\/node\/bin\/node/u);
  assert.match(wrapper, /current\/equinox-browser-native-host\.js/u);
  const manifest = JSON.parse(nativeHostManifest(`${installRoot}/equinox-browser-native-host`));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EQUINOX_BROWSER_PRODUCTION_EXTENSION_ID}/`]);
});

test("workspace bootstrap creates and verifies an isolated Git repository", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-workspace-git-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });
  const resolved = await ensureWorkspaceGitRepository(workspaceRoot);
  assert.equal(resolved, await fs.realpath(workspaceRoot));
  assert.equal((await fs.lstat(path.join(workspaceRoot, ".git"))).isDirectory(), true);
  assert.equal(await ensureWorkspaceGitRepository(workspaceRoot), resolved);
});

test("managed user bootstrap is idempotent and preserves user configuration", async (t) => {
  const fixture = await makeManagedHome();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const first = await bootstrapManagedEquinoxUser({ homeDir: fixture.homeDir });
  assert.equal(first.version, "4.2.0");
  assert.equal(first.configCreated, true);
  const config = JSON.parse(await fs.readFile(first.configPath, "utf8"));
  assert.equal(config.defaultProject, "workspace");
  assert.equal(config.projects.workspace.root, path.join(fixture.paths.installRoot, "workspace"));
  assert.equal(mode(await fs.lstat(first.configPath)), 0o600);
  assert.equal(mode(await fs.lstat(first.hostWrapperPath)), 0o700);
  assert.equal(mode(await fs.lstat(first.nativeHostManifestPath)), 0o600);
  assert.equal(mode(await fs.lstat(first.launchAgentPath)), 0o600);
  assert.equal((await fs.lstat(path.join(fixture.paths.installRoot, "workspace"))).isDirectory(), true);
  assert.equal((await fs.lstat(path.join(fixture.paths.installRoot, "workspace", ".git"))).isDirectory(), true);
  assert.equal((await fs.lstat(path.join(fixture.homeDir, "Downloads"))).isDirectory(), true);

  const configBefore = await fs.readFile(first.configPath, "utf8");
  const second = await bootstrapManagedEquinoxUser({ homeDir: fixture.homeDir });
  assert.equal(second.configCreated, false);
  assert.equal(await fs.readFile(second.configPath, "utf8"), configBefore);
  assert.equal(second.configRevision, first.configRevision);
});
