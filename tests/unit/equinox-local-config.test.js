import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONFIG_ID_PATTERN,
  createEquinoxLocalConfigManager,
  defaultEquinoxLocalConfigPath,
  equinoxLocalConfigRevision,
  serializeEquinoxLocalConfig,
  validateEquinoxLocalConfig,
} from "../../src/equinox-local-config.js";

function fixture(root = "/tmp/equinox-config-fixture") {
  return {
    version: 1,
    defaultProject: "orbit",
    runtime: {
      workspaceProject: "workspace",
      downloadsRoot: "downloads",
    },
    projects: {
      orbit: { name: "Orbit", root: path.join(root, "orbit") },
      workspace: { name: "Workspace", root: path.join(root, "workspace"), worktrees: false },
    },
    fileRoots: {
      downloads: { name: "Downloads", root: path.join(root, "downloads"), access: "read-only" },
    },
    controlCenter: { enabled: true, port: 24891 },
  };
}

async function withTempDir(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-local-config-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("config validation normalizes a generic project/file-root registry", () => {
  const config = validateEquinoxLocalConfig(fixture());
  assert.equal(config.version, 1);
  assert.equal(config.defaultProject, "orbit");
  assert.equal(config.runtime.workspaceProject, "workspace");
  assert.equal(config.runtime.downloadsRoot, "downloads");
  assert.equal(config.projects.orbit.worktrees, true);
  assert.equal(config.projects.workspace.worktrees, false);
  assert.equal(config.fileRoots.downloads.access, "read-only");
  assert.equal(config.agentAccess.files, "selected", "legacy configs keep selected-root file access");
  assert.equal(config.agentAccess.terminal, true);
  assert.equal(config.agentAccess.desktop, true);
  assert.equal(config.agentAccess.browser, true);
  assert.equal(config.controlCenter.port, 24891);
  assert.equal(CONFIG_ID_PATTERN.test("orbit_mcp"), true);
});

test("agent access accepts explicit full mode and rejects unknown access policy", () => {
  const full = fixture();
  full.agentAccess = {
    files: "full",
    terminal: false,
    desktop: true,
    browser: false,
  };
  const normalized = validateEquinoxLocalConfig(full);
  assert.deepEqual(normalized.agentAccess, {
    files: "full",
    terminal: false,
    desktop: true,
    browser: false,
  });

  const invalid = fixture();
  invalid.agentAccess = { files: "everything" };
  assert.throws(() => validateEquinoxLocalConfig(invalid), /selected veya full/u);

  const unknown = fixture();
  unknown.agentAccess = { files: "full", sudo: true };
  assert.throws(() => validateEquinoxLocalConfig(unknown), /agentAccess\.sudo desteklenmiyor/u);

  const nonBoolean = fixture();
  nonBoolean.agentAccess = { files: "full", terminal: "false" };
  assert.throws(() => validateEquinoxLocalConfig(nonBoolean), /agentAccess\.terminal true veya false/u);
});

test("config rejects unsafe ids, duplicate roots, unknown fields and writable file roots", () => {
  const badId = fixture();
  badId.projects["NOPE!"] = { name: "Nope", root: "/tmp/nope" };
  assert.throws(() => validateEquinoxLocalConfig(badId), /Proje kimliği/u);

  const duplicate = fixture();
  duplicate.fileRoots.downloads.root = duplicate.projects.orbit.root;
  assert.throws(() => validateEquinoxLocalConfig(duplicate), /Aynı klasör iki kez/u);

  const unknown = fixture();
  unknown.projects.orbit.command = "rm -rf /";
  assert.throws(() => validateEquinoxLocalConfig(unknown), /command desteklenmiyor/u);

  const writable = fixture();
  writable.fileRoots.downloads.access = "read-write";
  assert.throws(() => validateEquinoxLocalConfig(writable), /yalnız read-only/u);
});

test("config requires valid default, workspace and downloads references", () => {
  const missingDefault = fixture();
  missingDefault.defaultProject = "missing";
  assert.throws(() => validateEquinoxLocalConfig(missingDefault), /defaultProject/u);

  const missingWorkspace = fixture();
  missingWorkspace.runtime.workspaceProject = "missing";
  assert.throws(() => validateEquinoxLocalConfig(missingWorkspace), /workspaceProject/u);

  const projectAsDownloads = fixture();
  projectAsDownloads.runtime.downloadsRoot = "orbit";
  assert.throws(() => validateEquinoxLocalConfig(projectAsDownloads), /read-only fileRoots/u);
});

test("canonical serialization and revision are stable across key order", () => {
  const first = fixture();
  const second = fixture();
  second.projects = {
    workspace: second.projects.workspace,
    orbit: second.projects.orbit,
  };
  assert.equal(serializeEquinoxLocalConfig(first), serializeEquinoxLocalConfig(second));
  assert.equal(equinoxLocalConfigRevision(first), equinoxLocalConfigRevision(second));
});

test("config manager reads external config and guarded replacement is atomic/restart-required", async () => {
  await withTempDir(async (root) => {
    const configPath = path.join(root, "Application Support", "Equinox Local", "config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, serializeEquinoxLocalConfig(fixture(root)), { mode: 0o600 });

    const manager = createEquinoxLocalConfigManager({ homeDir: root, configPath });
    const initial = await manager.initialize();
    assert.equal(initial.configPath, configPath);
    assert.equal(initial.revision, equinoxLocalConfigRevision(fixture(root)));
    assert.equal(manager.defaultProjectId, "orbit");
    assert.equal(manager.workspaceProjectId, "workspace");
    assert.equal(manager.getFileRootDefinitions().downloads.name, "Downloads");

    const next = fixture(root);
    next.projects.docs = { name: "Docs", root: path.join(root, "docs"), worktrees: false };
    const replaced = await manager.replacePersisted(next, { expectedRevision: initial.revision });
    assert.equal(replaced.restartRequired, true);
    assert.notEqual(replaced.persistedRevision, initial.revision);
    assert.equal(manager.snapshot().revision, initial.revision, "running config intentionally stays pinned until restart");

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.equal(persisted.projects.docs.name, "Docs");
    const mode = (await fs.stat(configPath)).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test("config replacement refuses stale revisions and symlink config files", async () => {
  await withTempDir(async (root) => {
    const realPath = path.join(root, "real.json");
    const linkPath = path.join(root, "link.json");
    await fs.writeFile(realPath, serializeEquinoxLocalConfig(fixture(root)));
    await fs.symlink(realPath, linkPath);
    const linked = createEquinoxLocalConfigManager({ homeDir: root, configPath: linkPath });
    await assert.rejects(linked.initialize(), /symlink olmayan/u);

    const configPath = path.join(root, "config.json");
    await fs.writeFile(configPath, serializeEquinoxLocalConfig(fixture(root)));
    const manager = createEquinoxLocalConfigManager({ homeDir: root, configPath });
    const initial = await manager.initialize();
    const externallyChanged = fixture(root);
    externallyChanged.controlCenter.port = 24892;
    await fs.writeFile(configPath, serializeEquinoxLocalConfig(externallyChanged));
    await assert.rejects(
      manager.replacePersisted(fixture(root), { expectedRevision: initial.revision }),
      /revision guard/u,
    );
  });
});

test("default config path lives under the user's Application Support", () => {
  assert.equal(
    defaultEquinoxLocalConfigPath("/Users/example"),
    "/Users/example/Library/Application Support/Equinox Local/config.json",
  );
});
