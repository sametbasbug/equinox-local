import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appRuntimeWrapper,
  bootstrapManagedEquinoxUser,
  ensureWorkspaceGitRepository,
  EQUINOX_BROWSER_PRODUCTION_EXTENSION_ID,
  launchAgentPlist,
  nativeHostManifest,
  nativeHostWrapper,
  seedEquinoxLocalConfig,
  validateIndependentGitProjectRoot,
} from "../../src/equinox-local-bootstrap.js";
import { readBoundedNormalFile } from "../../src/equinox-local-safe-file.js";
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

async function fakeAppHost({ homeDir }) {
  return {
    appPath: path.join(homeDir, "Applications", "Equinox Local.app"),
    executablePath: path.join(homeDir, "Applications", "Equinox Local.app", "Contents", "MacOS", "applet"),
    created: false,
  };
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

test("launch agent uses the stable Equinox Local app identity while runtime wrapper follows current", () => {
  const homeDir = "/Users/example person";
  const installRoot = `${homeDir}/Library/Application Support/Equinox Local`;
  const plist = launchAgentPlist({ homeDir, installRoot });
  assert.match(plist, /dev\.equinox\.local/u);
  assert.match(plist, /Applications\/Equinox Local\.app\/Contents\/MacOS\/applet/u);
  assert.match(plist, /EQUINOX_LOCAL_RUNTIME_HOST<\/key>\n    <string>1<\/string>/u);
  assert.doesNotMatch(plist, /current\/runtime\/node\/bin\/node/u);

  const runtimeWrapper = appRuntimeWrapper({ installRoot });
  assert.match(runtimeWrapper, /current\/runtime\/node\/bin\/node/u);
  assert.match(runtimeWrapper, /current\/equinox-local-supervisor\.js/u);
  assert.match(runtimeWrapper, /RUNTIME_HOST_PID=\$PPID/u);
  assert.match(runtimeWrapper, /PARENT_WATCHDOG_PID/u);
  assert.match(runtimeWrapper, /SUPERVISOR_PID/u);
  assert.match(runtimeWrapper, /watch_runtime_host/u);
  assert.match(runtimeWrapper, /trap shutdown INT TERM HUP/u);
  assert.doesNotMatch(runtimeWrapper, /exec .*equinox-local-supervisor/u);
  assert.doesNotMatch(runtimeWrapper, /releases\/4\.2\.0/u);

  const wrapper = nativeHostWrapper({ installRoot });
  assert.match(wrapper, /current\/runtime\/node\/bin\/node/u);
  assert.match(wrapper, /current\/equinox-browser-native-host\.js/u);
  const manifest = JSON.parse(nativeHostManifest(`${installRoot}/equinox-browser-native-host`));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EQUINOX_BROWSER_PRODUCTION_EXTENSION_ID}/`]);
});

test("workspace bootstrap creates an isolated Git repository without invoking system Git", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-workspace-git-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspaceRoot = path.join(root, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });
  let systemGitCalled = false;
  const resolved = await ensureWorkspaceGitRepository(workspaceRoot, {
    execFileImpl: async () => {
      systemGitCalled = true;
      throw new Error("system Git must not be required for first install");
    },
  });
  assert.equal(resolved, await fs.realpath(workspaceRoot));
  assert.equal(systemGitCalled, false);
  assert.equal((await fs.lstat(path.join(workspaceRoot, ".git"))).isDirectory(), true);
  assert.equal(await fs.readFile(path.join(workspaceRoot, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
  assert.match(await fs.readFile(path.join(workspaceRoot, ".git", "config"), "utf8"), /bare = false/u);
  assert.equal(await ensureWorkspaceGitRepository(workspaceRoot), resolved);
});

test("project-root validation accepts direct and worktree metadata without system Git", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-project-root-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const direct = path.join(root, "direct");
  await fs.mkdir(direct, { recursive: true });
  await ensureWorkspaceGitRepository(direct);
  assert.equal(await validateIndependentGitProjectRoot(direct), await fs.realpath(direct));

  const commonGitDir = path.join(root, "common", ".git", "worktrees", "child");
  await fs.mkdir(commonGitDir, { recursive: true });
  await fs.writeFile(path.join(commonGitDir, "HEAD"), "ref: refs/heads/main\n");
  const child = path.join(root, "child");
  await fs.mkdir(child, { recursive: true });
  await fs.writeFile(path.join(child, ".git"), `gitdir: ${commonGitDir}\n`);
  assert.equal(await validateIndependentGitProjectRoot(child), await fs.realpath(child));

  const nested = path.join(direct, "nested");
  await fs.mkdir(nested);
  await assert.rejects(validateIndependentGitProjectRoot(nested), /\.git/u);
});

test("managed user bootstrap is idempotent and preserves user configuration", async (t) => {
  const fixture = await makeManagedHome();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const first = await bootstrapManagedEquinoxUser({ homeDir: fixture.homeDir, ensureAppHostImpl: fakeAppHost });
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

  const { data: configBefore } = await readBoundedNormalFile(first.configPath, {
    minBytes: 1,
    maxBytes: 256 * 1024,
    encoding: "utf8",
    label: "Bootstrap config fixture",
  });
  const second = await bootstrapManagedEquinoxUser({ homeDir: fixture.homeDir, ensureAppHostImpl: fakeAppHost });
  assert.equal(second.configCreated, false);
  const { data: configAfter } = await readBoundedNormalFile(second.configPath, {
    minBytes: 1,
    maxBytes: 256 * 1024,
    encoding: "utf8",
    label: "Bootstrap config fixture",
  });
  assert.equal(configAfter, configBefore);
  assert.equal(second.configRevision, first.configRevision);
});
