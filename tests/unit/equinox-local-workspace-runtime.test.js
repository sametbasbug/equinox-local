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

test("workspace runtime passes the opaque project ID only to its injected resolver and never touches files if resolution fails", async () => {
  const opaqueProjectId = "project-id-not-a-filesystem-path/../private";
  const events = [];
  const fsImpl = {
    readFile: async () => { events.push("read"); throw Error("unexpected read"); },
    mkdir: async () => { events.push("mkdir"); throw Error("unexpected mkdir"); },
    appendFile: async () => { events.push("append"); throw Error("unexpected append"); },
    chmod: async () => { events.push("chmod"); throw Error("unexpected chmod"); },
  };
  const denied = Error("workspace access rejected by project context resolver");
  const runtime = createEquinoxLocalWorkspaceRuntime({
    workspaceProjectId: opaqueProjectId,
    resolveProjectContext: async (id) => {
      events.push(["resolve", id]);
      throw denied;
    },
    fsImpl,
  });
  await assert.rejects(runtime.resolveWorkspaceRuntimePaths(), (e) => e === denied);
  await assert.rejects(runtime.ensureWorkspaceRuntimeDirectories(), (e) => e === denied);
  assert.deepEqual(events, [["resolve", opaqueProjectId], ["resolve", opaqueProjectId]]);
});

test("workspace runtime creates missing Git exclude only with fixed entries, preserves existing records, and never inserts browser-screenshot exclusion", async () => {
  await withTempWorkspace(async (root) => {
    const file = path.join(root, ".git", "info", "exclude");
    const runtime = createEquinoxLocalWorkspaceRuntime({
      workspaceProjectId: "local-workspace",
      resolveProjectContext: async () => ({ rootRealPath: root }),
    });
    const paths = await runtime.ensureWorkspaceRuntimeDirectories();
    assert.equal(paths.workspace.rootRealPath, root);
    assert.equal(await fs.readFile(file, "utf8"), `${EXCLUDED_RUNTIME_ENTRIES.join("\n")}\n`);
    assert.equal((await fs.stat(paths.browserScreenshotRoot)).isDirectory(), true);
    assert.equal((await fs.readFile(file, "utf8")).includes("/browser-screenshots/"), false);
    // Preserve pre-existing user-managed entries and avoid adding fixed entries twice.
    await fs.appendFile(file, "# user-managed setting\n");
    await runtime.ensureWorkspaceRuntimeDirectories();
    const finalExclude = await fs.readFile(file, "utf8");
    assert.equal(finalExclude, `${EXCLUDED_RUNTIME_ENTRIES.join("\n")}\n# user-managed setting\n`);
    for (const entry of EXCLUDED_RUNTIME_ENTRIES) assert.equal(finalExclude.split(entry).length - 1, 1);
  });
});

test("workspace runtime aborts on failed Git exclude append before creating runtime roots", async () => {
  const events = [];
  const refusal = Error("exclude path is not writable");
  const root = "/mock/workspace";
  const runtime = createEquinoxLocalWorkspaceRuntime({
    workspaceProjectId: "local-workspace",
    resolveProjectContext: async () => ({ rootRealPath: root }),
    fsImpl: {
      readFile: async () => "/worktrees/\n",
      mkdir: async (directory, options) => { events.push(["mkdir",directory,options]); },
      appendFile: async (file, contents, options) => {
        events.push(["append",file,contents,options]);
        throw refusal;
      },
      chmod: async () => { events.push(["chmod"]); },
    },
  });
  await assert.rejects(runtime.ensureWorkspaceRuntimeDirectories(), (error) => error === refusal);
  assert.deepEqual(events.map((item) => item[0]), ["mkdir", "append"]);
  assert.equal(events[0][1], path.join(root, ".git", "info"));
  assert.equal(events[1][1], path.join(root, ".git", "info", "exclude"));
  assert.equal(events[1][3].mode, 0o644);
  assert.doesNotMatch(events[1][2], /\/worktrees\//u, "existing exclusion must not be duplicated");
});

test("workspace runtime attempts private chmod but preserves successful directory provisioning if the platform refuses chmod", async () => {
  const calls = [];
  const root = "/mock/workspace";
  const runtime = createEquinoxLocalWorkspaceRuntime({
    workspaceProjectId: "local-workspace",
    resolveProjectContext: async () => ({ rootRealPath: root }),
    fsImpl: {
      readFile: async () => EXCLUDED_RUNTIME_ENTRIES.join("\n")+"\n",
      mkdir: async (directory, options) => { calls.push(["mkdir",directory,options.mode]); },
      appendFile: async () => { throw Error("already excluded entries must never be appended"); },
      chmod: async (directory, mode) => {
        calls.push(["chmod",directory,mode]);
        throw Object.assign(Error("permission denied for chmod"), {code:"EPERM"});
      },
    },
  });
  const paths = await runtime.ensureWorkspaceRuntimeDirectories();
  assert.equal(paths.workspace.rootRealPath,root);
  assert.equal(calls.filter(([kind]) => kind === "mkdir").length, 10);
  const chmods = calls.filter(([kind]) => kind === "chmod");
  assert.equal(chmods.length, 8);
  assert.ok(chmods.every(([,directory,mode]) =>
    mode === 0o700 && directory !== paths.worktreeRoot && directory !== paths.visualRoot));
  assert.deepEqual(Object.keys(paths).slice(1), [
    "worktreeRoot", "visualRoot", "browserScreenshotRoot", "workflowRoot", "taskRoot",
    "releaseGateRoot", "observabilityRoot", "repairRoot", "recoveryPolicyRoot", "janitorRoot",
  ]);
});
