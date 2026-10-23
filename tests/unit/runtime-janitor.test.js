import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRuntimeJanitor } from "../../src/runtime-janitor.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

async function withTempDir(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-janitor-"));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function setTreeMtime(target, ms) {
  const stat = await fs.lstat(target);
  if (stat.isDirectory()) {
    const children = await fs.readdir(target);
    for (const child of children) await setTreeMtime(path.join(target, child), ms);
  }
  const date = new Date(ms);
  await fs.utimes(target, date, date);
}

function managers({ terminals = [], processes = [], workflows = [] } = {}) {
  const terminalMap = new Map(terminals.map((item) => [item.sessionId, { ...item }]));
  const processMap = new Map(processes.map((item) => [item.processId, { ...item }]));
  const workflowMap = new Map(workflows.map((item) => [item.workflowId, { ...item }]));
  const removedWorkflows = [];
  return {
    terminalManager: {
      list: () => [...terminalMap.values()],
      stop: async ({ sessionId, remove }) => {
        const item = terminalMap.get(sessionId);
        if (!item) throw new Error("missing terminal");
        if (item.running) throw new Error("active terminal");
        if (remove) terminalMap.delete(sessionId);
        return item;
      },
    },
    processManager: {
      list: () => [...processMap.values()],
      stop: async ({ processId, remove }) => {
        const item = processMap.get(processId);
        if (!item) throw new Error("missing process");
        if (item.running) throw new Error("active process");
        if (remove) processMap.delete(processId);
        return item;
      },
    },
    workflowManager: {
      list: () => [...workflowMap.values()],
      removeTerminalRecord: async (workflowId) => {
        const item = workflowMap.get(workflowId);
        if (!item) throw new Error("missing workflow");
        if (!["completed", "failed", "cancelled"].includes(item.status)) throw new Error("active workflow");
        workflowMap.delete(workflowId);
        removedWorkflows.push(workflowId);
        return item;
      },
    },
    removedWorkflows,
  };
}

async function buildJanitor(root, {
  nowMs = Date.UTC(2026, 7, 5, 12, 0, 0),
  terminals = [],
  processes = [],
  workflows = [],
  worktrees = [],
  pruneManagedWorktrees = async (items) => ({ pruned: items.map((item) => item.id) }),
  runExclusive = async (task) => task(),
  maintenanceIntervalMs = 6 * 60 * 60 * 1000,
  startupDelayMs = 10_000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const workspaceRoot = path.join(root, "workspace");
  const roots = {
    workspaceRoot,
    workflowRoot: path.join(workspaceRoot, "workflows"),
    visualRoot: path.join(workspaceRoot, "visual-regression"),
    browserScreenshotRoot: path.join(workspaceRoot, "browser-screenshots"),
    releaseGateRoot: path.join(workspaceRoot, "release-gates"),
    observabilityRoot: path.join(workspaceRoot, "observability"),
    rootDir: path.join(workspaceRoot, "janitor"),
  };
  await Promise.all(Object.values(roots).map((item) => fs.mkdir(item, { recursive: true })));
  for (const child of ["runs", "baselines", "candidates", "snapshots"]) {
    await fs.mkdir(path.join(roots.releaseGateRoot, child), { recursive: true });
  }
  const mgr = managers({ terminals, processes, workflows });
  const events = [];
  const janitor = createRuntimeJanitor({
    ...roots,
    ...mgr,
    observability: { record: async (event) => { events.push(event); return event; } },
    listManagedWorktrees: async () => worktrees,
    pruneManagedWorktrees,
    runExclusive,
    maintenanceIntervalMs,
    startupDelayMs,
    setTimeoutImpl,
    clearTimeoutImpl,
    now: () => nowMs,
    randomId: () => "testid1234",
  });
  await janitor.initialize();
  return { janitor, roots, mgr, events, nowMs };
}

async function writeReleaseFixture({ roots, nowMs }) {
  const projectId = "status";
  const currentWorkflow = "wf-current-release-1";
  const oldWorkflow = "wf-old-release-run-1";
  const currentHead = "1".repeat(40);
  const oldHead = "2".repeat(40);
  const currentSet = "set-current";
  const oldSet = "set-old";
  const baselineProject = path.join(roots.releaseGateRoot, "baselines", projectId);
  const setsRoot = path.join(baselineProject, "sets");
  await fs.mkdir(path.join(setsRoot, currentSet), { recursive: true });
  await fs.mkdir(path.join(setsRoot, oldSet), { recursive: true });
  await fs.writeFile(path.join(setsRoot, currentSet, "desktop.png"), "current");
  await fs.writeFile(path.join(setsRoot, oldSet, "desktop.png"), "old");
  await fs.writeFile(path.join(baselineProject, "current.json"), JSON.stringify({
    schemaVersion: 1,
    projectId,
    setId: currentSet,
    sourceWorkflowId: currentWorkflow,
    headSha: currentHead,
    createdAt: new Date(nowMs - 60 * DAY).toISOString(),
    viewports: {},
  }));
  await setTreeMtime(path.join(setsRoot, currentSet), nowMs - 60 * DAY);
  await setTreeMtime(path.join(setsRoot, oldSet), nowMs - 60 * DAY);

  const candidateRoot = path.join(roots.releaseGateRoot, "candidates", projectId);
  await fs.mkdir(candidateRoot, { recursive: true });
  const oldCandidate = {
    schemaVersion: 1,
    candidateId: "rc-old",
    projectId,
    workflowId: oldWorkflow,
    headSha: oldHead,
    createdAt: new Date(nowMs - 50 * DAY).toISOString(),
  };
  const latestCandidate = {
    schemaVersion: 1,
    candidateId: "rc-latest",
    projectId,
    workflowId: currentWorkflow,
    headSha: currentHead,
    createdAt: new Date(nowMs - 40 * DAY).toISOString(),
  };
  await fs.writeFile(path.join(candidateRoot, "rc-old.json"), JSON.stringify(oldCandidate));
  await fs.writeFile(path.join(candidateRoot, "rc-latest.json"), JSON.stringify(latestCandidate));
  await setTreeMtime(path.join(candidateRoot, "rc-old.json"), nowMs - 50 * DAY);
  await setTreeMtime(path.join(candidateRoot, "rc-latest.json"), nowMs - 40 * DAY);

  const runRoot = path.join(roots.releaseGateRoot, "runs");
  await fs.mkdir(path.join(runRoot, currentWorkflow), { recursive: true });
  await fs.mkdir(path.join(runRoot, oldWorkflow), { recursive: true });
  await fs.writeFile(path.join(runRoot, currentWorkflow, "desktop.png"), "current-run");
  await fs.writeFile(path.join(runRoot, oldWorkflow, "desktop.png"), "old-run");
  await setTreeMtime(path.join(runRoot, currentWorkflow), nowMs - 50 * DAY);
  await setTreeMtime(path.join(runRoot, oldWorkflow), nowMs - 50 * DAY);

  const snapshotRoot = path.join(roots.releaseGateRoot, "snapshots", projectId);
  await fs.mkdir(snapshotRoot, { recursive: true });
  for (const [headSha, createdAt, body] of [
    [oldHead, nowMs - 50 * DAY, "old-bundle"],
    [currentHead, nowMs - 40 * DAY, "current-bundle"],
  ]) {
    await fs.writeFile(path.join(snapshotRoot, `${headSha}.bundle`), body);
    await fs.writeFile(path.join(snapshotRoot, `${headSha}.json`), JSON.stringify({
      schemaVersion: 1,
      projectId,
      headSha,
      createdAt: new Date(createdAt).toISOString(),
      bundlePath: `snapshots/${projectId}/${headSha}.bundle`,
    }));
    await setTreeMtime(path.join(snapshotRoot, `${headSha}.bundle`), createdAt);
    await setTreeMtime(path.join(snapshotRoot, `${headSha}.json`), createdAt);
  }

  return { currentWorkflow, oldWorkflow, currentHead, oldHead, currentSet, oldSet };
}

test("visual regression dry-run returns a stable token and cleanup removes only old runtime artifacts", async () => {
  await withTempDir(async (root) => {
    const { janitor, roots, nowMs } = await buildJanitor(root);
    const oldDir = path.join(roots.visualRoot, "old-visual");
    const youngDir = path.join(roots.visualRoot, "young-visual");
    await fs.mkdir(oldDir); await fs.mkdir(youngDir);
    await fs.writeFile(path.join(oldDir, "a.png"), "1234567890");
    await fs.writeFile(path.join(youngDir, "b.png"), "young");
    await setTreeMtime(oldDir, nowMs - 20 * DAY);
    await setTreeMtime(youngDir, nowMs - 2 * DAY);

    const report = await janitor.report({ category: "visual_regression", includeProtected: true });
    const category = report.categories[0];
    assert.equal(category.reclaimableCount, 1);
    assert.equal(category.items[0].id, "old-visual");
    assert.match(category.cleanupToken, /^jt-[a-f0-9]{64}$/u);
    assert.equal(category.protected.some((item) => item.id === "young-visual" && item.reason === "RETENTION_WINDOW"), true);

    const result = await janitor.cleanup({ category: "visual_regression", cleanupToken: category.cleanupToken });
    assert.equal(result.outcome, "CLEANED");
    assert.equal(result.cleanedCount, 1);
    await assert.rejects(fs.access(oldDir));
    await fs.access(youngDir);
  });
});

test("browser screenshot janitor reclaims capture directories after one hour", async () => {
  await withTempDir(async (root) => {
    const { janitor, roots, nowMs } = await buildJanitor(root);
    const oldDir = path.join(roots.browserScreenshotRoot, "capture-old");
    const youngDir = path.join(roots.browserScreenshotRoot, "capture-young");
    await fs.mkdir(oldDir); await fs.mkdir(youngDir);
    await fs.writeFile(path.join(oldDir, "old.png"), "old");
    await fs.writeFile(path.join(youngDir, "young.png"), "young");
    await setTreeMtime(oldDir, nowMs - 2 * HOUR);
    await setTreeMtime(youngDir, nowMs - 30 * 60 * 1000);

    const report = await janitor.report({ category: "browser_screenshots", includeProtected: true });
    const category = report.categories[0];
    assert.equal(category.retentionMs, HOUR);
    assert.equal(category.reclaimableCount, 1);
    assert.equal(category.items[0].id, "capture-old");
    assert.equal(category.protected.some((item) => item.id === "capture-young" && item.reason === "RETENTION_WINDOW"), true);

    const result = await janitor.cleanup({ category: "browser_screenshots", cleanupToken: category.cleanupToken });
    assert.equal(result.outcome, "CLEANED");
    await assert.rejects(fs.access(oldDir));
    await fs.access(youngDir);
  });
});

test("cleanup refuses a stale preview token after artifact state changes", async () => {
  await withTempDir(async (root) => {
    const { janitor, roots, nowMs, events } = await buildJanitor(root);
    const oldDir = path.join(roots.visualRoot, "mutable-old");
    await fs.mkdir(oldDir);
    await fs.writeFile(path.join(oldDir, "a.png"), "before");
    await setTreeMtime(oldDir, nowMs - 20 * DAY);
    const report = await janitor.report({ category: "visual_regression" });
    const token = report.categories[0].cleanupToken;

    await fs.writeFile(path.join(oldDir, "a.png"), "after-change");
    const result = await janitor.cleanup({ category: "visual_regression", cleanupToken: token });
    assert.equal(result.outcome, "REFUSED_STALE_PREVIEW");
    const refusal = events.find((event) => event.type === "janitor.cleanup_refused");
    assert.equal(refusal?.severity, "warn");
    assert.equal(refusal?.status, "healthy");
    await fs.access(oldDir);
  });
});

test("release retention protects current baseline/latest candidate/provenance and reclaims only old superseded artifacts", async () => {
  await withTempDir(async (root) => {
    const { janitor, roots, nowMs } = await buildJanitor(root);
    const fixture = await writeReleaseFixture({ roots, nowMs });

    const baselines = (await janitor.report({ category: "release_baseline_sets", includeProtected: true })).categories[0];
    assert.deepEqual(baselines.items.map((item) => item.id), [fixture.oldSet]);
    assert.equal(baselines.protected.some((item) => item.id === fixture.currentSet && item.reason === "CURRENT_BASELINE_SET"), true);

    const candidates = (await janitor.report({ category: "release_candidates", includeProtected: true })).categories[0];
    assert.deepEqual(candidates.items.map((item) => item.id), ["rc-old"]);
    assert.equal(candidates.protected.some((item) => item.id === "rc-latest" && item.reason === "LATEST_CANDIDATE"), true);

    const runs = (await janitor.report({ category: "release_runs", includeProtected: true })).categories[0];
    assert.equal(runs.items.some((item) => item.id === fixture.oldWorkflow), true);
    assert.equal(runs.protected.some((item) => item.id === fixture.currentWorkflow && item.reason === "CURRENT_RELEASE_PROVENANCE"), true);

    const snapshots = (await janitor.report({ category: "rollback_bundles", includeProtected: true })).categories[0];
    assert.equal(snapshots.items.some((item) => item.id === fixture.oldHead), true);
    assert.equal(snapshots.protected.some((item) => item.id === fixture.currentHead && item.reason === "CURRENT_RELEASE_HEAD"), true);
  });
});

test("active terminal/process and resumable workflow are never reclaimable", async () => {
  await withTempDir(async (root) => {
    const nowMs = Date.UTC(2026, 7, 5, 12, 0, 0);
    const oldIso = new Date(nowMs - 5 * DAY).toISOString();
    const { janitor } = await buildJanitor(root, {
      nowMs,
      terminals: [
        { sessionId: "term-active", running: true, projectId: "local", label: "active", exitedAt: null, bufferedChars: 100 },
        { sessionId: "term-old", running: false, projectId: "local", label: "old", exitedAt: oldIso, bufferedChars: 200, cursor: 200, droppedChars: 0, cwd: "/tmp" },
      ],
      processes: [
        { processId: "proc-active", running: true, projectId: "local", label: "active", exitedAt: null, bufferedChars: 100 },
        { processId: "proc-old", running: false, projectId: "local", label: "old", exitedAt: oldIso, bufferedChars: 300, cursor: 300, droppedChars: 0, cwd: "/tmp", pid: 123 },
      ],
      workflows: [
        { workflowId: "wf-paused-test1", projectId: "local", status: "paused", createdAt: oldIso, updatedAt: oldIso, completedAt: null },
      ],
    });
    const terminals = (await janitor.report({ category: "terminal_records", includeProtected: true })).categories[0];
    assert.deepEqual(terminals.items.map((item) => item.id), ["term-old"]);
    assert.equal(terminals.protected.some((item) => item.id === "term-active" && item.reason === "ACTIVE_TERMINAL"), true);
    const processes = (await janitor.report({ category: "process_records", includeProtected: true })).categories[0];
    assert.deepEqual(processes.items.map((item) => item.id), ["proc-old"]);
    assert.equal(processes.protected.some((item) => item.id === "proc-active" && item.reason === "ACTIVE_PROCESS"), true);
    const workflows = (await janitor.report({ category: "workflow_records", includeProtected: true })).categories[0];
    assert.equal(workflows.reclaimableCount, 0);
    assert.equal(workflows.protected.some((item) => item.id === "wf-paused-test1" && item.reason === "ACTIVE_OR_RESUMABLE_WORKFLOW"), true);
  });
});

test("workflow retention keeps newest 20 and cleanup delegates only old terminal record removal", async () => {
  await withTempDir(async (root) => {
    const nowMs = Date.UTC(2026, 7, 5, 12, 0, 0);
    const workflows = [];
    for (let index = 0; index < 21; index += 1) {
      const timestamp = nowMs - (40 + index) * DAY;
      const workflowId = `wf-old-${String(index).padStart(4, "0")}-abc`;
      workflows.push({
        workflowId,
        projectId: "local",
        status: "completed",
        createdAt: new Date(timestamp).toISOString(),
        updatedAt: new Date(timestamp).toISOString(),
        completedAt: new Date(timestamp).toISOString(),
      });
    }
    const { janitor, roots, mgr } = await buildJanitor(root, { nowMs, workflows });
    for (const item of workflows) {
      await fs.writeFile(path.join(roots.workflowRoot, `${item.workflowId}.json`), JSON.stringify(item));
      await fs.writeFile(path.join(roots.workflowRoot, `${item.workflowId}.log`), "log");
      await setTreeMtime(path.join(roots.workflowRoot, `${item.workflowId}.json`), Date.parse(item.updatedAt));
      await setTreeMtime(path.join(roots.workflowRoot, `${item.workflowId}.log`), Date.parse(item.updatedAt));
    }
    const report = await janitor.report({ category: "workflow_records" });
    const category = report.categories[0];
    assert.equal(category.reclaimableCount, 1);
    const oldest = workflows.at(-1).workflowId;
    assert.equal(category.items[0].id, oldest);
    const result = await janitor.cleanup({ category: "workflow_records", cleanupToken: category.cleanupToken });
    assert.equal(result.outcome, "CLEANED");
    assert.deepEqual(mgr.removedWorkflows, [oldest]);
  });
});

test("observability cleanup never selects current segment and only reclaims old rotated segments", async () => {
  await withTempDir(async (root) => {
    const { janitor, roots, nowMs } = await buildJanitor(root);
    const current = path.join(roots.observabilityRoot, "events-current.jsonl");
    const old = path.join(roots.observabilityRoot, "events-1700000000000-abcdef.jsonl");
    const young = path.join(roots.observabilityRoot, "events-1800000000000-fedcba.jsonl");
    await fs.writeFile(current, "current\n");
    await fs.writeFile(old, "old\n");
    await fs.writeFile(young, "young\n");
    await setTreeMtime(current, nowMs - 30 * DAY);
    await setTreeMtime(old, nowMs - 10 * DAY);
    await setTreeMtime(young, nowMs - DAY);
    const report = await janitor.report({ category: "observability_segments", includeProtected: true });
    const category = report.categories[0];
    assert.deepEqual(category.items.map((item) => item.id), [path.basename(old)]);
    assert.equal(category.protected.some((item) => item.id === "events-current.jsonl" && item.reason === "ACTIVE_EVENT_SEGMENT"), true);
  });
});

test("stale worktree cleanup accepts only managed prunable missing paths and delegates metadata prune", async () => {
  await withTempDir(async (root) => {
    const prunedCalls = [];
    const worktrees = [
      {
        projectId: "status",
        managed: true,
        prunable: true,
        locked: false,
        activeTerminal: false,
        activeProcess: false,
        pathExists: false,
        workspaceRelativePath: "worktrees/status/stale",
        path: path.join(root, "workspace", "worktrees", "status", "stale"),
        head: "a".repeat(40),
        branch: "equinox/stale",
        pruneReason: "gitdir file points to non-existent location",
      },
      {
        projectId: "status",
        managed: true,
        prunable: false,
        locked: true,
        activeTerminal: false,
        activeProcess: false,
        pathExists: true,
        workspaceRelativePath: "worktrees/status/live",
        path: path.join(root, "workspace", "worktrees", "status", "live"),
        head: "b".repeat(40),
        branch: "equinox/live",
      },
      {
        projectId: "status",
        managed: false,
        prunable: true,
        locked: false,
        activeTerminal: false,
        activeProcess: false,
        pathExists: false,
        workspaceRelativePath: null,
        path: "/tmp/unmanaged",
      },
    ];
    const { janitor } = await buildJanitor(root, {
      worktrees,
      pruneManagedWorktrees: async (items) => {
        prunedCalls.push(items);
        return { pruned: items.map((item) => item.id) };
      },
    });
    const report = await janitor.report({ category: "stale_worktrees", includeProtected: true });
    const category = report.categories[0];
    assert.equal(category.reclaimableCount, 1);
    assert.equal(category.items[0].workspaceRelativePath, "worktrees/status/stale");
    assert.equal(category.protected.some((item) => item.reason === "NOT_GIT_PRUNABLE"), true);
    assert.equal(category.protected.some((item) => item.reason === "UNMANAGED_WORKTREE"), true);
    const result = await janitor.cleanup({ category: "stale_worktrees", cleanupToken: category.cleanupToken });
    assert.equal(result.outcome, "CLEANED");
    assert.equal(prunedCalls.length, 1);
    assert.equal(prunedCalls[0].length, 1);
  });
});

test("janitor history records cleaned and refused operations without arbitrary paths", async () => {
  await withTempDir(async (root) => {
    const { janitor, roots, nowMs } = await buildJanitor(root);
    const oldDir = path.join(roots.visualRoot, "audit-old");
    await fs.mkdir(oldDir);
    await fs.writeFile(path.join(oldDir, "x"), "x");
    await setTreeMtime(oldDir, nowMs - 20 * DAY);
    const report = await janitor.report({ category: "visual_regression" });
    await janitor.cleanup({ category: "visual_regression", cleanupToken: report.categories[0].cleanupToken });
    const history = await janitor.history({ category: "visual_regression" });
    assert.equal(history[0].outcome, "CLEANED");
    assert.equal(history[0].itemIds.includes("audit-old"), true);
    assert.equal(JSON.stringify(history[0]).includes(root), false);
  });
});

test("autonomous maintenance cycle uses exclusive mutation wrapper and scheduler status", async () => {
  await withTempDir(async (root) => {
    let exclusiveCalls = 0;
    let scheduled = null;
    let cleared = null;
    const { janitor, roots, nowMs } = await buildJanitor(root, {
      runExclusive: async (task) => {
        exclusiveCalls += 1;
        return task();
      },
      maintenanceIntervalMs: 60_000,
      startupDelayMs: 500,
      setTimeoutImpl: (fn, delay) => {
        scheduled = { fn, delay, unref() {} };
        return scheduled;
      },
      clearTimeoutImpl: (timer) => {
        cleared = timer;
      },
    });

    const oldDir = path.join(roots.visualRoot, "auto-old");
    await fs.mkdir(oldDir);
    await fs.writeFile(path.join(oldDir, "probe.txt"), "autonomous-cleanup");
    await setTreeMtime(oldDir, nowMs - 20 * DAY);

    const cycle = await janitor.runMaintenanceCycle({ trigger: "test" });
    assert.equal(cycle.outcome, "COMPLETED");
    assert.equal(cycle.cleanedCount, 1);
    assert.equal(exclusiveCalls, 11);
    await assert.rejects(fs.access(oldDir));

    const started = await janitor.startMaintenance();
    assert.equal(started.enabled, true);
    assert.equal(started.active, false);
    assert.equal(started.intervalMs, 60_000);
    assert.equal(scheduled.delay, 500);
    assert.ok(started.nextRunAt);

    janitor.stopMaintenance();
    assert.equal(janitor.status().enabled, false);
    assert.equal(janitor.status().nextRunAt, null);
    assert.equal(cleared, scheduled);
  });
});

test("janitor refuses storage root outside workspace before touching any files",async()=>{
  await withTempDir(async root=>{
    const workspaceRoot=path.join(root,"workspace");
    const foreign=path.join(root,"private-user-documents");
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(foreign);
    const marker=path.join(foreign,"keep.txt");
    await fs.writeFile(marker,"PRIVATE-SYNTHETIC-MARKER");
    const valid={
      rootDir:path.join(workspaceRoot,"janitor"),
      workspaceRoot,
      workflowRoot:path.join(workspaceRoot,"workflows"),
      visualRoot:foreign,
      browserScreenshotRoot:path.join(workspaceRoot,"screenshots"),
      releaseGateRoot:path.join(workspaceRoot,"release-gates"),
      observabilityRoot:path.join(workspaceRoot,"observability"),
      ...managers(),
      observability:{record:async()=>{}},
    };
    assert.throws(()=>createRuntimeJanitor(valid),/storage kökü workspace dışında/u);
    assert.equal(await fs.readFile(marker,"utf8"),"PRIVATE-SYNTHETIC-MARKER");
    assert.equal(await fs.readdir(foreign).then(x=>x.length),1);
  });
});

test("janitor never follows nested or top-level symlinks to private files",async()=>{
  await withTempDir(async root=>{
    const {janitor,roots,nowMs}=await buildJanitor(root);
    const outside=path.join(root,"private-user-documents");
    await fs.mkdir(outside);
    const privateFile=path.join(outside,"keep.txt");
    await fs.writeFile(privateFile,"PRIVATE-SYNTHETIC-MARKER");
    const nested=path.join(roots.visualRoot,"old-symlinked");
    await fs.mkdir(nested);
    await fs.symlink(privateFile,path.join(nested,"escape"));
    await fs.symlink(outside,path.join(roots.visualRoot,"top-level-link"));
    await setTreeMtime(nested,nowMs-20*DAY);
    const scanned=(await janitor.report({category:"visual_regression",includeProtected:true})).categories[0];
    assert.equal(scanned.reclaimableCount,0);
    assert.ok(scanned.protected.some(x=>x.id==="old-symlinked"&&x.reason==="UNSAFE_TREE_SYMLINK"));
    assert.ok(scanned.protected.some(x=>x.id==="top-level-link"&&x.reason==="UNRECOGNIZED_OR_NON_DIRECTORY"));
    const result=await janitor.cleanup({category:"visual_regression",cleanupToken:scanned.cleanupToken});
    assert.equal(result.outcome,"SKIPPED_ALREADY_CLEAN");
    assert.equal(await fs.readFile(privateFile,"utf8"),"PRIVATE-SYNTHETIC-MARKER");
    assert.equal((await fs.lstat(nested)).isDirectory(),true);
  });
});

test("janitor refuses previously eligible tree replaced with foreign symlink between dry-run and cleanup",async()=>{
  await withTempDir(async root=>{
    const {janitor,roots,nowMs}=await buildJanitor(root);
    const external=path.join(root,"private-user-documents");
    await fs.mkdir(external);
    const sentinel=path.join(external,"keep.txt");
    await fs.writeFile(sentinel,"PRIVATE-SYNTHETIC-MARKER");
    const previous=path.join(roots.visualRoot,"old-preview");
    await fs.mkdir(previous);
    await fs.writeFile(path.join(previous,"screenshot.png"),"synthetic");
    await setTreeMtime(previous,nowMs-20*DAY);
    const token=(await janitor.report({category:"visual_regression"})).categories[0].cleanupToken;
    const parked=path.join(root,"parked-owned-preview");
    await fs.rename(previous,parked);
    await fs.symlink(external,previous);
    const result=await janitor.cleanup({category:"visual_regression",cleanupToken:token});
    assert.equal(result.outcome,"REFUSED_STALE_PREVIEW");
    assert.equal(await fs.readFile(sentinel,"utf8"),"PRIVATE-SYNTHETIC-MARKER");
    assert.equal((await fs.lstat(previous)).isSymbolicLink(),true);
    await fs.access(path.join(parked,"screenshot.png"));
  });
});

test("janitor fails closed when release current baseline pointer disappears",async()=>{
  await withTempDir(async root=>{
    const {janitor,roots,nowMs}=await buildJanitor(root);
    const fixture=await writeReleaseFixture({roots,nowMs});
    const original=(await janitor.report({category:"release_baseline_sets",includeProtected:true})).categories[0];
    assert.ok(original.items.some(x=>x.id===fixture.oldSet));
    const pointer=path.join(roots.releaseGateRoot,"baselines","status","current.json");
    await fs.rm(pointer);
    const rejected=await janitor.cleanup({category:"release_baseline_sets",cleanupToken:original.cleanupToken});
    assert.equal(rejected.outcome,"REFUSED_STALE_PREVIEW");
    const current=(await janitor.report({category:"release_baseline_sets",includeProtected:true})).categories[0];
    assert.equal(current.reclaimableCount,0);
    assert.ok(current.protected.every(x=>x.reason==="CURRENT_POINTER_UNAVAILABLE_FAIL_CLOSED"));
    for(const set of [fixture.oldSet,fixture.currentSet]){
      await fs.access(path.join(roots.releaseGateRoot,"baselines","status","sets",set,"desktop.png"));
    }
  });
});
