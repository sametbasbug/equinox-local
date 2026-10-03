import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createEquinoxLocalWorkspaceRuntime } from "../../src/equinox-local-workspace-runtime.js";

const EXCLUDED_RUNTIME_ENTRIES = [
  "/worktrees/",
  "/visual-regression/",
  "/workflows/",
  "/tasks/",
  "/release-gates/",
  "/observability/",
  "/repairs/",
  "/recovery-policies/",
  "/janitor/",
  "/V4.0_OBSERVABILITY_SELF_HEALING_PLAN.md",
];

async function withTempWorkspace(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-workspace-runtime-"));
  try {
    await fs.mkdir(path.join(root, ".git"));
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("workspace runtime resolves descriptor-owned paths and initializes directories, modes, and exact Git exclusions", async () => {
  await withTempWorkspace(async (root) => {
    const excludePath = path.join(root, ".git", "info", "exclude");
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    await fs.writeFile(excludePath, "# existing local exclusion");
    const resolveCalls = [];
    const mkdirCalls = [];
    const chmodCalls = [];
    const appendCalls = [];
    const recordingFs = {
      ...fs,
      mkdir: async (directory, options) => {
        mkdirCalls.push([directory, options]);
        return fs.mkdir(directory, options);
      },
      chmod: async (file, mode) => {
        chmodCalls.push([file, mode]);
        return fs.chmod(file, mode);
      },
      appendFile: async (file, content, options) => {
        appendCalls.push([file, options]);
        return fs.appendFile(file, content, options);
      },
    };
    const runtime = createEquinoxLocalWorkspaceRuntime({
      fsImpl: recordingFs,
      workspaceProjectId: "workspace-project",
      resolveProjectContext: async (projectId) => {
        resolveCalls.push(projectId);
        return { id: projectId, rootRealPath: root };
      },
    });

    const paths = await runtime.resolveWorkspaceRuntimePaths();
    assert.deepEqual(Object.keys(paths), [
      "workspace",
      "worktreeRoot",
      "visualRoot",
      "browserScreenshotRoot",
      "workflowRoot",
      "taskRoot",
      "releaseGateRoot",
      "observabilityRoot",
      "repairRoot",
      "recoveryPolicyRoot",
      "janitorRoot",
    ]);
    assert.equal(Object.isFrozen(paths), true);
    assert.deepEqual(resolveCalls, ["workspace-project"]);
    assert.equal(paths.workspace.rootRealPath, root);

    const ensured = await runtime.ensureWorkspaceRuntimeDirectories();
    assert.deepEqual(Object.keys(ensured), Object.keys(paths));
    assert.deepEqual(resolveCalls, ["workspace-project", "workspace-project"]);

    const directoryModes = {
      worktreeRoot: 0o755,
      visualRoot: 0o755,
      browserScreenshotRoot: 0o700,
      workflowRoot: 0o700,
      taskRoot: 0o700,
      releaseGateRoot: 0o700,
      observabilityRoot: 0o700,
      repairRoot: 0o700,
      recoveryPolicyRoot: 0o700,
      janitorRoot: 0o700,
    };
    for (const [key, mode] of Object.entries(directoryModes)) {
      const stat = await fs.stat(ensured[key]);
      assert.equal(stat.isDirectory(), true, key);
      assert.ok(mkdirCalls.some(([directory, options]) => directory === ensured[key]
        && options.recursive === true && options.mode === mode), `${key} requested mode`);
      if (process.platform !== "win32") assert.equal(stat.mode & 0o777, mode, `${key} mode`);
    }
    assert.deepEqual(chmodCalls, Object.entries(directoryModes)
      .filter(([, mode]) => mode === 0o700)
      .map(([key]) => [ensured[key], 0o700]));
    assert.deepEqual(appendCalls, [[excludePath, { mode: 0o644 }]]);

    const contents = await fs.readFile(excludePath, "utf8");
    assert.equal(
      contents,
      `# existing local exclusion\n${EXCLUDED_RUNTIME_ENTRIES.join("\n")}\n`,
    );
    assert.equal(contents.includes("/browser-screenshots/"), false);
    if (process.platform !== "win32") assert.equal((await fs.stat(excludePath)).mode & 0o777, 0o644);

    await runtime.ensureWorkspaceRuntimeDirectories();
    assert.equal(await fs.readFile(excludePath, "utf8"), contents);
  });
});

test("workspace runtime propagates non-missing Git-exclude read errors", async () => {
  const workspace = { rootRealPath: "/workspace" };
  const failingFs = {
    ...fs,
    readFile: async () => {
      const error = new Error("permission denied");
      error.code = "EACCES";
      throw error;
    },
  };
  const runtime = createEquinoxLocalWorkspaceRuntime({
    workspaceProjectId: "workspace-project",
    resolveProjectContext: async () => workspace,
    fsImpl: failingFs,
  });

  await assert.rejects(runtime.ensureWorkspaceRuntimeDirectories(), /permission denied/u);
});
