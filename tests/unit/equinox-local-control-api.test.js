import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createEquinoxLocalControlApi } from "../../src/equinox-local-control-api.js";
import { EQUINOX_LOCAL_CONFIG_ERROR_CODES } from "../../src/equinox-local-config.js";

function fakeConfigManager() {
  const calls = [];
  const config = {
    version: 1,
    defaultProject: "local",
    runtime: { workspaceProject: "local", downloadsRoot: "downloads" },
    projects: { local: { name: "Local", root: "/tmp/local", worktrees: false } },
    fileRoots: { downloads: { name: "Downloads", root: "/tmp/downloads", access: "read-only" } },
    controlCenter: { enabled: true, port: 24891 },
  };
  const revision = "a".repeat(64);
  return {
    calls,
    snapshot: () => ({ configPath: "/tmp/config.json", revision, loadedAt: "2026-08-21T00:00:00.000Z", config }),
    replacePersisted: async (nextConfig, options) => {
      calls.push({ nextConfig, options });
      return {
        previousRevision: revision,
        persistedRevision: "b".repeat(64),
        restartRequired: true,
        config: nextConfig,
      };
    },
  };
}

async function withApi(fn, overrides = {}) {
  const configManager = fakeConfigManager();
  const api = createEquinoxLocalControlApi({
    configManager,
    port: 0,
    getStatus: overrides.getStatus ?? (async () => ({ runtime: "healthy", secret: undefined })),
    getTurnBudget: overrides.getTurnBudget ?? null,
    updateTurnBudget: overrides.updateTurnBudget ?? null,
    getDoctorStatus: overrides.getDoctorStatus ?? (async () => ({ state: "HEALTHY", summary: { attention: 0 } })),
    getDoctorRepairs: overrides.getDoctorRepairs ?? null,
    applyDoctorRepair: overrides.applyDoctorRepair ?? null,
    getActivity: overrides.getActivity ?? (async () => []),
    getUpdateStatus: overrides.getUpdateStatus ?? (async () => ({ currentVersion: "4.2.0", selfUpdateSupported: false })),
    getOnboardingStatus: overrides.getOnboardingStatus ?? (async () => ({ available: false, managed: false })),
    getTasks: overrides.getTasks ?? null,
    getTask: overrides.getTask ?? null,
    updateTask: overrides.updateTask ?? null,
    completeTask: overrides.completeTask ?? null,
    cancelTask: overrides.cancelTask ?? null,
    deleteTask: overrides.deleteTask ?? null,
    cancelTaskContinuation: overrides.cancelTaskContinuation ?? null,
    cancelTaskFreshResume: overrides.cancelTaskFreshResume ?? null,
    abandonTaskFreshResume: overrides.abandonTaskFreshResume ?? null,
    checkForUpdates: overrides.checkForUpdates ?? null,
    applyUpdate: overrides.applyUpdate ?? null,
    configureTunnel: overrides.configureTunnel ?? null,
    pauseAgent: overrides.pauseAgent ?? null,
    resumeAgent: overrides.resumeAgent ?? null,
    restartRuntime: overrides.restartRuntime ?? null,
    scheduleUninstall: overrides.scheduleUninstall ?? null,
    chooseFolder: overrides.chooseFolder ?? null,
    updateBrowserSettings: overrides.updateBrowserSettings ?? null,
    openAgentBrowser: overrides.openAgentBrowser ?? null,
    checkGitHub: overrides.checkGitHub ?? null,
    getPeekabooStatus: overrides.getPeekabooStatus ?? null,
    getTelegramStatus: overrides.getTelegramStatus ?? null,
    getWebImportSettings: overrides.getWebImportSettings ?? null,
    updateWebImportDownloads: overrides.updateWebImportDownloads ?? null,
    updateTelegramRemoteControl: overrides.updateTelegramRemoteControl ?? null,
    updateTelegramDownloads: overrides.updateTelegramDownloads ?? null,
    configureTelegram: overrides.configureTelegram ?? null,
    startTelegramPairing: overrides.startTelegramPairing ?? null,
    pollTelegramPairing: overrides.pollTelegramPairing ?? null,
    confirmTelegramPairing: overrides.confirmTelegramPairing ?? null,
    cancelTelegramPairing: overrides.cancelTelegramPairing ?? null,
    testTelegram: overrides.testTelegram ?? null,
    disconnectTelegram: overrides.disconnectTelegram ?? null,
    getHttpProfiles: overrides.getHttpProfiles ?? null,
    setHttpProfileManagement: overrides.setHttpProfileManagement ?? null,
    upsertHttpProfile: overrides.upsertHttpProfile ?? null,
    testHttpProfile: overrides.testHttpProfile ?? null,
    deleteHttpProfile: overrides.deleteHttpProfile ?? null,
    recordInternalError: overrides.recordInternalError ?? null,
    requestTimeoutMs: overrides.requestTimeoutMs,
  });
  const started = await api.start();
  try {
    await fn({ api, configManager, port: started.port, origin: `http://127.0.0.1:${started.port}` });
  } finally {
    await api.close();
  }
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  return { response, body };
}

test("control API binds loopback and exposes bounded read-only health/config/status", async () => {
  await withApi(async ({ api, port }) => {
    const base = `http://127.0.0.1:${port}`;
    const health = await jsonFetch(`${base}/api/v1/health`);
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.controlCenter.host, "127.0.0.1");
    assert.equal(health.body.controlCenter.port, port);
    assert.equal(health.response.headers.get("access-control-allow-origin"), null);
    assert.match(health.response.headers.get("content-security-policy"), /default-src 'none'/u);

    const config = await jsonFetch(`${base}/api/v1/config`);
    assert.equal(config.body.revision, "a".repeat(64));
    assert.equal(config.body.config.defaultProject, "local");

    const status = await jsonFetch(`${base}/api/v1/status`);
    assert.deepEqual(status.body.status, { runtime: "healthy" });
    const doctor = await jsonFetch(`${base}/api/v1/doctor`);
    assert.equal(doctor.body.doctor.state, "HEALTHY");
    assert.equal(doctor.body.doctor.summary.attention, 0);
    assert.equal(api.snapshot().requestCount, 4);
  });
});

test("background auto-refresh GETs do not inflate the Control Center request counter", async () => {
  await withApi(async ({ api, port }) => {
    const base = `http://127.0.0.1:${port}`;
    assert.equal(api.snapshot().requestCount, 0);

    const background = await jsonFetch(`${base}/api/v1/status`, {
      headers: { "x-equinox-background-refresh": "1" },
    });
    assert.equal(background.response.status, 200);
    assert.equal(api.snapshot().requestCount, 0);

    const normal = await jsonFetch(`${base}/api/v1/status`);
    assert.equal(normal.response.status, 200);
    assert.equal(api.snapshot().requestCount, 1);

    const nonBackgroundPath = await jsonFetch(`${base}/api/v1/session`, {
      headers: { "x-equinox-background-refresh": "1" },
    });
    assert.equal(nonBackgroundPath.response.status, 200);
    assert.equal(api.snapshot().requestCount, 2);
  });
});

test("Doctor repair API exposes bounded plans and requires CSRF plus fixed recipe ids for mutation", async () => {
  const calls = [];
  const incidentId = "inc-peekaboo-transport-failure-abc123";
  await withApi(async ({ api, port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const plan = await jsonFetch(`${base}/api/v1/doctor/repairs`);
    assert.equal(plan.response.status, 200);
    assert.equal(plan.body.repairs.actionableCount, 1);
    assert.equal(plan.body.repairs.incidents[0].incidentId, incidentId);

    const missingGuard = await jsonFetch(`${base}/api/v1/doctor/repair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ incidentId, recipeId: "peekaboo_bridge_restart" }),
    });
    assert.equal(missingGuard.response.status, 403);
    assert.equal(calls.length, 1);

    const session = await jsonFetch(`${base}/api/v1/session`);
    const headers = {
      "content-type": "application/json",
      origin,
      "x-equinox-csrf": session.body.csrfToken,
    };

    for (const body of [
      { incidentId, recipeId: "arbitrary_shell" },
      { incidentId: "invalid", recipeId: "peekaboo_bridge_restart" },
      { incidentId, recipeId: "peekaboo_bridge_restart", command: "rm -rf /" },
    ]) {
      const rejected = await jsonFetch(`${base}/api/v1/doctor/repair`, {
        method: "POST", headers, body: JSON.stringify(body),
      });
      assert.equal(rejected.response.status, 400);
    }
    assert.equal(calls.length, 1);

    const applied = await jsonFetch(`${base}/api/v1/doctor/repair`, {
      method: "POST",
      headers,
      body: JSON.stringify({ incidentId, recipeId: "peekaboo_bridge_restart" }),
    });
    assert.equal(applied.response.status, 200);
    assert.equal(applied.body.result.repair.outcome, "RECOVERED");
    assert.equal(applied.body.result.verification.resolved, true);
    assert.deepEqual(calls.at(-1), ["repair", { incidentId, recipeId: "peekaboo_bridge_restart" }]);
    assert.equal(api.snapshot().mutationCount, 1);
  }, {
    getDoctorRepairs: async () => {
      calls.push(["plan"]);
      return {
        evaluatedAt: "2026-09-12T21:00:00.000Z",
        actionableCount: 1,
        incidents: [{ incidentId, state: "ACTIVE", fixes: [{ id: "peekaboo_bridge_restart" }] }],
      };
    },
    applyDoctorRepair: async (request) => {
      calls.push(["repair", request]);
      return { repair: { outcome: "RECOVERED" }, verification: { resolved: true, incident: null } };
    },
  });
});

test("control API request timeout bounds inbound delivery without timing out slow handler work", async () => {
  await withApi(async ({ port }) => {
    const status = await jsonFetch(`http://127.0.0.1:${port}/api/v1/status`);
    assert.equal(status.response.status, 200);
    assert.deepEqual(status.body.status, { runtime: "slow-but-complete" });
  }, {
    requestTimeoutMs: 10,
    getStatus: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { runtime: "slow-but-complete" };
    },
  });
});

test("control API redacts surfaced errors and maps unexpected backend failures to 500", async () => {
  await withApi(async ({ port }) => {
    const result = await jsonFetch(`http://127.0.0.1:${port}/api/v1/status`);
    assert.equal(result.response.status, 500);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error, "Control Center request failed.");
    assert.doesNotMatch(
      result.body.error,
      /test-user|super-secret|ghp_hidden|123456789:telegram-secret-value-123456/u,
    );
  }, {
    getStatus: async () => {
      const error = new Error(
        "failed /Users/test-user/private/config.json Authorization: Bearer abc.def.ghi token=super-secret ghp_hidden 123456789:telegram-secret-value-123456",
      );
      throw error;
    },
  });
});

test("control API serves the visual Control Center shell and fixed same-origin assets", async () => {
  await withApi(async ({ port }) => {
    const base = `http://127.0.0.1:${port}`;
    const shell = await fetch(`${base}/`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get("content-type"), /^text\/html/u);
    assert.match(shell.headers.get("content-security-policy"), /script-src 'self'/u);
    assert.equal(shell.headers.get("access-control-allow-origin"), null);
    assert.equal(shell.headers.get("x-frame-options"), "DENY");
    const shellText = await shell.text();
    assert.match(shellText, /Equinox Local Control Center/u);
    assert.match(shellText, /Doctor → Fix/u);
    assert.match(shellText, /id="doctor-repair-list"/u);

    const taskDeepLink = await fetch(`${base}/?section=tasks&task=task-abcdef`);
    assert.equal(taskDeepLink.status, 200);
    assert.match(await taskDeepLink.text(), /Equinox Local Control Center/u);

    const invalidTaskDeepLink = await jsonFetch(`${base}/?section=tasks&task=not-a-task`);
    assert.equal(invalidTaskDeepLink.response.status, 400);

    const unsupportedShellQuery = await jsonFetch(`${base}/?section=tasks&task=task-abcdef&extra=1`);
    assert.equal(unsupportedShellQuery.response.status, 400);
    assert.match(shellText, /id="restart-runtime-button"/u);
    assert.match(shellText, /id="language-select"/u);
    assert.match(shellText, /data-theme-value="system"/u);
    assert.match(shellText, /data-theme-value="light"/u);
    assert.match(shellText, /data-theme-value="dark"/u);
    assert.match(shellText, /<option value="en">English<\/option>/u);
    assert.match(shellText, /<option value="tr">Türkçe<\/option>/u);
    assert.equal(
      shellText.includes('href="https://chromewebstore.google.com/detail/equinox-browser/npdneefcobilfkjlihghjgjnknenhfoj"'),
      true,
    );
    assert.match(shellText, /Install Equinox Browser/u);
    assert.match(shellText, /id="section-setup"/u);
    assert.match(shellText, /id="control-center-nav"/u);
    assert.match(shellText, /id="setup-nav"/u);
    assert.match(shellText, /id="setup-uninstall-slot"/u);
    assert.match(shellText, /id="permissions-uninstall-slot"/u);
    assert.match(shellText, /Add Equinox Local to ChatGPT/u);
    assert.match(shellText, /Verify ChatGPT → Mac/u);
    assert.match(shellText, /id="setup-telegram-step"/u);
    assert.match(shellText, /Recommended\. Telegram lets Equinox Local/u);
    assert.match(shellText, /https:\/\/t\.me\/BotFather/u);
    assert.match(shellText, /id="setup-telegram-token"/u);
    assert.match(shellText, /id="setup-telegram-confirm"/u);
    assert.match(shellText, /id="setup-telegram-skip"/u);
    assert.match(shellText, /<span class="setup-step-index">6<\/span>[\s\S]*Verify ChatGPT → Mac/u);
    assert.match(shellText, /Browser Control/u);
    assert.equal(shellText.includes('id="onboarding-card"'), false);
    assert.match(shellText, /id="task-recovery-panel"/u);
    assert.match(shellText, /id="task-abandon-fresh-resume-button"/u);
    assert.match(shellText, /target="_blank" rel="noopener noreferrer"/u);

    const css = await fetch(`${base}/assets/control-center.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /^text\/css/u);
    const cssText = await css.text();
    assert.match(cssText, /\.app-shell/u);
    assert.match(cssText, /\.language-control/u);
    assert.match(cssText, /:root\[data-theme="dark"\]/u);
    assert.match(cssText, /\.theme-switch/u);
    assert.match(cssText, /\.setup-section/u);
    assert.match(cssText, /body\.setup-mode/u);

    const logo = await fetch(`${base}/assets/equinox-local.png`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get("content-type"), "image/png");
    assert.equal((await logo.arrayBuffer()).byteLength > 0, true);

    const script = await fetch(`${base}/assets/control-center.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /^text\/javascript/u);
    const scriptText = await script.text();
    assert.match(scriptText, /\/api\/v1\/config/u);
    assert.match(scriptText, /\/api\/v1\/doctor/u);
    assert.match(scriptText, /\/api\/v1\/doctor\/repairs/u);
    assert.match(scriptText, /\/api\/v1\/doctor\/repair/u);
    assert.match(scriptText, /runDoctorRepair/u);
    assert.equal(scriptText.includes('requestJson("/api/v1/doctor").catch(() => ({ doctor: null }))'), true);
    assert.match(scriptText, /\/api\/v1\/agent\/pause/u);
    assert.match(scriptText, /\/api\/v1\/agent\/resume/u);
    assert.match(scriptText, /\/api\/v1\/runtime\/restart/u);
    assert.match(scriptText, /\/api\/v1\/activity/u);
    assert.match(scriptText, /\/api\/v1\/update/u);
    assert.match(scriptText, /\/api\/v1\/update\/check/u);
    assert.match(scriptText, /\/api\/v1\/update\/apply/u);
    assert.match(scriptText, /\/api\/v1\/onboarding/u);
    assert.match(scriptText, /state\.setupMode/u);
    assert.match(scriptText, /refreshLiveState/u);
    assert.match(scriptText, /refreshMediumState/u);
    assert.match(scriptText, /refreshSlowState/u);
    assert.match(scriptText, /startTelegramPairingUi/u);
    assert.match(scriptText, /refreshTelegramPairing/u);
    assert.match(scriptText, /confirmTelegramPairingUi/u);
    assert.match(scriptText, /changeTelegramDownloadFolder/u);
    assert.match(scriptText, /createWebFileTransferCard/u);
    assert.match(scriptText, /changeWebImportFolder/u);
    assert.match(scriptText, /\/api\/v1\/files\/import-settings/u);
    assert.match(scriptText, /resetTelegramDownloadFolder/u);
    assert.match(scriptText, /\/api\/v1\/integrations\/telegram\/downloads/u);
    assert.match(scriptText, /Incoming Telegram photos and documents are saved here/u);
    assert.match(scriptText, /\/api\/v1\/integrations\/telegram\/pair\/start/u);
    assert.match(scriptText, /\/api\/v1\/integrations\/telegram\/pair\/confirm/u);
    assert.equal(scriptText.includes("Your Telegram ID"), false);
    assert.match(scriptText, /x-equinox-background-refresh/u);
    assert.match(scriptText, /status\.chatgptConnection/u);
    assert.match(scriptText, /MCP runtime connected/u);
    assert.match(scriptText, /previousStatus\.peekaboo/u);
    assert.match(scriptText, /status\.status\?\.peekaboo/u);
    assert.match(scriptText, /AUTO_REFRESH_LIVE_MS = 3_000/u);
    assert.match(scriptText, /AUTO_REFRESH_MEDIUM_MS = 15_000/u);
    assert.match(scriptText, /AUTO_REFRESH_SLOW_MS = 60_000/u);
    assert.match(scriptText, /document\.hidden/u);
    assert.match(scriptText, /window\.addEventListener\("focus", refreshVisibleControlCenter\)/u);
    assert.match(scriptText, /visibilitychange/u);
    assert.match(scriptText, /taskDraftDirty/u);
    assert.match(scriptText, /if \(!state\.taskDraftDirty\)/u);
    assert.equal(scriptText.includes("refreshOnboardingProgress"), false);
    assert.equal(scriptText.includes("refreshTurnBudgetStatus"), false);
    assert.match(scriptText, /setupComplete/u);
    assert.match(scriptText, /browserControlEnabled/u);
    assert.match(scriptText, /agentCommandReceived/u);
    assert.match(scriptText, /\/api\/v1\/onboarding\/tunnel/u);
    assert.match(scriptText, /\/api\/v1\/uninstall/u);
    assert.match(scriptText, /\/api\/v1\/folder-picker/u);
    assert.match(scriptText, /\/api\/v1\/browser\/settings/u);
    assert.match(scriptText, /\/api\/v1\/browser\/agent\/open/u);
    assert.match(scriptText, /Agent Browser/u);
    assert.match(scriptText, /applyInitialNavigationIntent/u);
    assert.match(scriptText, /URLSearchParams\(window\.location\.search\)/u);
    assert.match(scriptText, /params\.get\("section"\)/u);
    assert.match(scriptText, /task-\[a-z0-9-\]/u);
    assert.match(scriptText, /setupComplete/u);
    assert.match(scriptText, /Agent Browser setup is complete and the isolated browser is currently closed/u);
    assert.match(scriptText, /browser-settings-target/u);
    assert.match(scriptText, /npdneefcobilfkjlihghjgjnknenhfoj/u);
    assert.match(scriptText, /control\.rel = "noopener noreferrer"/u);
    assert.match(scriptText, /equinox-local-control-center-language/u);
    assert.match(scriptText, /equinox-local-control-center-theme/u);
    assert.match(scriptText, /task-list-id/u);
    assert.match(scriptText, /setText\("task-detail-id", task\.taskId\)/u);
    assert.match(shellText, /id="task-detail-id" class="task-detail-id"/u);
    assert.match(cssText, /\.task-list-id/u);
    assert.match(cssText, /\.task-detail-id/u);
    assert.match(scriptText, /prefers-color-scheme: dark/u);
    assert.match(scriptText, /localStorage\.setItem\(THEME_STORAGE_KEY/u);
    assert.match(scriptText, /localStorage\.setItem\(LANGUAGE_STORAGE_KEY/u);
    assert.match(scriptText, /navigator\.language/u);
    assert.match(scriptText, /__equinoxNativeLanguage/u);
    assert.match(scriptText, /equinoxNativeLanguage/u);
    assert.match(scriptText, /localizeRuntimeEventMessage/u);
    assert.match(scriptText, /Peekaboo safe tool-surface compatibility check passed\./u);
    assert.match(scriptText, /fresh-resume\/cancel/u);
    assert.match(scriptText, /fresh-resume\/abandon/u);
    assert.match(scriptText, /Delete this task permanently/u);
    assert.match(scriptText, /task-delete-button/u);
    assert.match(scriptText, /Needs attention/u);
    assert.match(scriptText, /\/api\/v1\/integrations\/http-profiles/u);
    assert.match(scriptText, /\/api\/v1\/turn-budget/u);
    assert.match(shellText, /id="turn-budget-badge"/u);
    assert.match(shellText, /id="turn-budget-cutoff"/u);
    assert.match(scriptText, /Authenticated HTTP profiles/u);
    assert.match(scriptText, /write-only/u);
    assert.match(cssText, /\.http-profile-card/u);
    assert.doesNotMatch(scriptText, /\/api\/v1\/integrations\/github(?:\/check)?/u);
    assert.doesNotMatch(scriptText, /GitHub CLI/u);

    const missing = await jsonFetch(`${base}/missing-control-center-route`);
    assert.equal(missing.response.status, 404);
    assert.match(missing.body.error, /endpoint bulunamadı/u);
  });
});

test("Task Control API is bounded, CSRF-protected and maps stale revisions to conflict", async () => {
  const calls = [];
  const task = {
    taskId: "task-abcdef", schemaVersion: 1, title: "Task", objective: "Objective", status: "active",
    checkpointRevision: 3, completed: ["One"], next: ["Two"], references: [],
    createdAt: "2026-09-12T00:00:00.000Z", updatedAt: "2026-09-12T00:01:00.000Z", completedAt: null,
    continuation: { status: "armed", checkpointRevision: 3, target: { browserContext: "user", mode: "task-tab", tabId: 9, title: "ChatGPT" } },
  };
  await withApi(async ({ port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const list = await jsonFetch(`${base}/api/v1/tasks`);
    assert.equal(list.response.status, 200);
    assert.equal(list.body.tasks[0].taskId, task.taskId);

    const detail = await jsonFetch(`${base}/api/v1/tasks/${task.taskId}`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.task.checkpointRevision, 3);

    const missingGuard = await jsonFetch(`${base}/api/v1/tasks/${task.taskId}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 3, title: "Edited", objective: "Objective", completed: [], next: ["Continue"], references: [] }),
    });
    assert.equal(missingGuard.response.status, 403);
    assert.equal(calls.length, 0);

    const session = await jsonFetch(`${base}/api/v1/session`);
    const headers = { "content-type": "application/json", origin, "x-equinox-csrf": session.body.csrfToken };
    const saved = await jsonFetch(`${base}/api/v1/tasks/${task.taskId}`, {
      method: "PUT", headers,
      body: JSON.stringify({ expectedRevision: 3, title: "Edited", objective: "Objective", completed: ["One"], next: ["Continue"], references: [] }),
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.task.title, "Edited");
    assert.equal(calls[0][0], "update");

    for (const [suffix, name] of [["continuation/cancel", "continuation"], ["fresh-resume/cancel", "fresh-cancel"], ["fresh-resume/abandon", "fresh-abandon"], ["complete", "complete"], ["cancel", "cancel"]]) {
      const result = await jsonFetch(`${base}/api/v1/tasks/${task.taskId}/${suffix}`, { method: "POST", headers, body: "{}" });
      assert.equal(result.response.status, 200);
      assert.equal(calls.at(-1)[0], name);
    }

    const deleted = await jsonFetch(`${base}/api/v1/tasks/${task.taskId}/delete`, { method: "POST", headers, body: "{}" });
    assert.equal(deleted.response.status, 200);
    assert.deepEqual(deleted.body.deleted, { taskId: task.taskId, status: "completed", deleted: true });
    assert.equal(calls.at(-1)[0], "delete");

    const retryRoute = await jsonFetch(`${base}/api/v1/tasks/${task.taskId}/fresh-resume/retry`, { method: "POST", headers, body: "{}" });
    assert.equal(retryRoute.response.status, 404);

    const invalidRoute = await jsonFetch(`${base}/api/v1/tasks/${task.taskId}/unexpected`);
    assert.equal(invalidRoute.response.status, 404);
  }, {
    getTasks: async () => [task],
    getTask: async () => task,
    updateTask: async (taskId, body) => { calls.push(["update", taskId, body]); return { ...task, ...body, checkpointRevision: 4 }; },
    completeTask: async (taskId) => { calls.push(["complete", taskId]); return { ...task, status: "completed" }; },
    cancelTask: async (taskId) => { calls.push(["cancel", taskId]); return { ...task, status: "cancelled" }; },
    deleteTask: async (taskId) => { calls.push(["delete", taskId]); return { taskId, status: "completed", deleted: true }; },
    cancelTaskContinuation: async (taskId) => { calls.push(["continuation", taskId]); return { ...task, continuation: { ...task.continuation, status: "cancelled" } }; },
    cancelTaskFreshResume: async (taskId) => { calls.push(["fresh-cancel", taskId]); return { ...task, freshResume: { status: "cancelled", reason: "human_cancelled" } }; },
    abandonTaskFreshResume: async (taskId) => { calls.push(["fresh-abandon", taskId]); return { ...task, freshResume: { status: "cancelled", reason: "human_recovered" } }; },
  });
});

test("Task Control API maps active task deletion to conflict", async () => {
  await withApi(async ({ port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const session = await jsonFetch(`${base}/api/v1/session`);
    const response = await jsonFetch(`${base}/api/v1/tasks/task-active/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "x-equinox-csrf": session.body.csrfToken },
      body: "{}",
    });
    assert.equal(response.response.status, 409);
    assert.match(response.body.error, /completed or cancelled before deletion/u);
  }, {
    deleteTask: async () => {
      const error = new Error("Active Task Capsules must be completed or cancelled before deletion.");
      error.code = "TASK_CAPSULE_TERMINAL_REQUIRED";
      throw error;
    },
  });
});

test("Task Control API exposes stale revision and missing task as 409/404", async () => {
  await withApi(async ({ port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const session = await jsonFetch(`${base}/api/v1/session`);
    const headers = { "content-type": "application/json", origin, "x-equinox-csrf": session.body.csrfToken };
    const conflict = await jsonFetch(`${base}/api/v1/tasks/task-abcdef`, {
      method: "PUT", headers,
      body: JSON.stringify({ expectedRevision: 2, title: "Task", objective: "Objective", completed: [], next: [], references: [] }),
    });
    assert.equal(conflict.response.status, 409);
    assert.match(conflict.body.error, /changed since revision/u);
    const missing = await jsonFetch(`${base}/api/v1/tasks/task-missing`);
    assert.equal(missing.response.status, 404);
  }, {
    getTask: async () => { const error = new Error("Task Capsule not found: task-missing"); error.code = "TASK_CAPSULE_NOT_FOUND"; throw error; },
    updateTask: async () => { const error = new Error("Task Capsule changed since revision 2; current revision is 3. Refresh the task before saving."); error.code = "TASK_CAPSULE_REVISION_CONFLICT"; throw error; },
  });
});

test("config mutation requires same-origin CSRF token and revision envelope", async () => {
  await withApi(async ({ api, configManager, port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const session = await jsonFetch(`${base}/api/v1/session`);
    assert.match(session.body.csrfToken, /^[a-f0-9]{64}$/u);

    const payload = {
      expectedRevision: "a".repeat(64),
      config: configManager.snapshot().config,
    };

    const missingGuard = await jsonFetch(`${base}/api/v1/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    assert.equal(missingGuard.response.status, 403);
    assert.equal(configManager.calls.length, 0);

    const badOrigin = await jsonFetch(`${base}/api/v1/config`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        "x-equinox-csrf": session.body.csrfToken,
      },
      body: JSON.stringify(payload),
    });
    assert.equal(badOrigin.response.status, 403);
    assert.equal(configManager.calls.length, 0);

    const accepted = await jsonFetch(`${base}/api/v1/config`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin,
        "x-equinox-csrf": session.body.csrfToken,
      },
      body: JSON.stringify(payload),
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.body.restartRequired, true);
    assert.equal(accepted.body.persistedRevision, "b".repeat(64));
    assert.equal(configManager.calls.length, 1);
    assert.equal(configManager.calls[0].options.expectedRevision, "a".repeat(64));
    assert.equal(api.snapshot().mutationCount, 1);
  });
});

test("config revision conflicts are exposed as HTTP 409", async () => {
  await withApi(async ({ api, configManager, port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const session = await jsonFetch(`${base}/api/v1/session`);
    configManager.replacePersisted = async () => {
      const error = new Error("Config revision guard eşleşmedi.");
      error.code = EQUINOX_LOCAL_CONFIG_ERROR_CODES.revisionConflict;
      throw error;
    };

    const conflict = await jsonFetch(`${base}/api/v1/config`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin,
        "x-equinox-csrf": session.body.csrfToken,
      },
      body: JSON.stringify({
        expectedRevision: "a".repeat(64),
        config: configManager.snapshot().config,
      }),
    });

    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.ok, false);
    assert.match(conflict.body.error, /revision guard/u);
    assert.equal(api.snapshot().mutationCount, 0);
  });
});

test("update status is read-only while check/apply require same-origin CSRF", async () => {
  const calls = [];
  await withApi(async ({ api, port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const status = await jsonFetch(`${base}/api/v1/update`);
    assert.equal(status.response.status, 200);
    assert.deepEqual(status.body.update, {
      currentVersion: "4.2.0",
      selfUpdateSupported: true,
      updateAvailable: null,
    });

    const rejectedCheck = await jsonFetch(`${base}/api/v1/update/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(rejectedCheck.response.status, 403);

    const session = await jsonFetch(`${base}/api/v1/session`);
    const mutationHeaders = {
      "content-type": "application/json",
      origin,
      "x-equinox-csrf": session.body.csrfToken,
    };
    const acceptedCheck = await jsonFetch(`${base}/api/v1/update/check`, {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    assert.equal(acceptedCheck.response.status, 200);
    assert.equal(acceptedCheck.body.update.latestVersion, "4.3.0");
    assert.equal(acceptedCheck.body.update.updateAvailable, true);

    const rejectedApply = await jsonFetch(`${base}/api/v1/update/apply`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        "x-equinox-csrf": session.body.csrfToken,
      },
      body: "{}",
    });
    assert.equal(rejectedApply.response.status, 403);

    const acceptedApply = await jsonFetch(`${base}/api/v1/update/apply`, {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    assert.equal(acceptedApply.response.status, 202);
    assert.deepEqual(acceptedApply.body.result, {
      scheduled: true,
      currentVersion: "4.2.0",
      targetVersion: "4.3.0",
    });
    assert.deepEqual(calls, [["update-check"], ["update-apply"]]);
    assert.equal(api.snapshot().mutationCount, 1);
  }, {
    getUpdateStatus: async () => ({
      currentVersion: "4.2.0",
      selfUpdateSupported: true,
      updateAvailable: null,
    }),
    checkForUpdates: async () => {
      calls.push(["update-check"]);
      return {
        currentVersion: "4.2.0",
        selfUpdateSupported: true,
        latestVersion: "4.3.0",
        updateAvailable: true,
      };
    },
    applyUpdate: async () => {
      calls.push(["update-apply"]);
      return {
        scheduled: true,
        currentVersion: "4.2.0",
        targetVersion: "4.3.0",
      };
    },
  });
});

test("onboarding status is read-only and tunnel setup requires same-origin CSRF", async () => {
  const calls = [];
  const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
  await withApi(async ({ api, port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const status = await jsonFetch(`${base}/api/v1/onboarding`);
    assert.equal(status.response.status, 200);
    assert.equal(status.body.onboarding.available, true);
    assert.equal(status.body.onboarding.transportConfigured, false);

    const rejected = await jsonFetch(`${base}/api/v1/onboarding/tunnel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tunnelId, runtimeKey: "runtime-secret-value-0123456789" }),
    });
    assert.equal(rejected.response.status, 403);
    assert.equal(calls.length, 0);

    const session = await jsonFetch(`${base}/api/v1/session`);
    const accepted = await jsonFetch(`${base}/api/v1/onboarding/tunnel`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "x-equinox-csrf": session.body.csrfToken,
      },
      body: JSON.stringify({ tunnelId, runtimeKey: "runtime-secret-value-0123456789" }),
    });
    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.body.result.tunnelId, tunnelId);
    assert.equal(accepted.body.result.restartScheduled, true);
    assert.equal(JSON.stringify(accepted.body).includes("runtime-secret-value"), false);
    assert.deepEqual(calls, [{ tunnelId, runtimeKey: "runtime-secret-value-0123456789" }]);
    assert.equal(api.snapshot().mutationCount, 1);
  }, {
    getOnboardingStatus: async () => ({
      available: true,
      managed: true,
      transportConfigured: false,
      supervisorMode: "local-only",
    }),
    configureTunnel: async (body) => {
      calls.push(body);
      return { configured: true, tunnelId: body.tunnelId, restartScheduled: true };
    },
  });
});


test("agent emergency stop and resume require CSRF and return bounded control state", async () => {
  const calls = [];
  await withApi(async ({ api, port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const rejected = await jsonFetch(`${base}/api/v1/agent/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(rejected.response.status, 403);
    assert.deepEqual(calls, []);

    const session = await jsonFetch(`${base}/api/v1/session`);
    const headers = {
      "content-type": "application/json",
      origin,
      "x-equinox-csrf": session.body.csrfToken,
    };

    const invalid = await jsonFetch(`${base}/api/v1/agent/pause`, {
      method: "POST",
      headers,
      body: JSON.stringify({ unexpected: true }),
    });
    assert.equal(invalid.response.status, 400);
    assert.deepEqual(calls, []);

    const paused = await jsonFetch(`${base}/api/v1/agent/pause`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(paused.response.status, 200);
    assert.equal(paused.body.agentControl.state, "PAUSED");
    assert.equal(paused.body.agentControl.activeWork.total, 0);

    const resumed = await jsonFetch(`${base}/api/v1/agent/resume`, {
      method: "POST",
      headers,
      body: "{}",
    });
    assert.equal(resumed.response.status, 200);
    assert.equal(resumed.body.agentControl.state, "ACTIVE");
    assert.deepEqual(calls, ["pause", "resume"]);
    assert.equal(api.snapshot().mutationCount, 2);
  }, {
    pauseAgent: async () => {
      calls.push("pause");
      return { state: "PAUSED", paused: true, activeWork: { terminals: 0, processes: 0, total: 0 } };
    },
    resumeAgent: async () => {
      calls.push("resume");
      return { state: "ACTIVE", paused: false, activeWork: { terminals: 0, processes: 0, total: 0 } };
    },
  });
});

test("managed uninstall requires same-origin CSRF, typed confirmation and explicit data policy", async () => {
  const calls = [];
  await withApi(async ({ api, port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const rejected = await jsonFetch(`${base}/api/v1/uninstall`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "UNINSTALL", removeUserData: false }),
    });
    assert.equal(rejected.response.status, 403);
    assert.equal(calls.length, 0);

    const session = await jsonFetch(`${base}/api/v1/session`);
    const mutationHeaders = {
      "content-type": "application/json",
      origin,
      "x-equinox-csrf": session.body.csrfToken,
    };
    const invalid = await jsonFetch(`${base}/api/v1/uninstall`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ confirm: "uninstall", removeUserData: false }),
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(calls.length, 0);

    const accepted = await jsonFetch(`${base}/api/v1/uninstall`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ confirm: "UNINSTALL", removeUserData: true }),
    });
    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.body.result.scheduled, true);
    assert.equal(accepted.body.result.removeUserData, true);
    assert.deepEqual(calls, [{ removeUserData: true }]);
    assert.equal(api.snapshot().mutationCount, 1);
  }, {
    scheduleUninstall: async (request) => {
      calls.push(request);
      return { scheduled: true, removeUserData: request.removeUserData };
    },
  });
});

test("bounded Control Center actions expose activity, Browser/GitHub controls and Telegram integration", async () => {
  const calls = [];
  await withApi(async ({ api, port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const session = await jsonFetch(`${base}/api/v1/session`);
    const mutationHeaders = {
      "content-type": "application/json",
      origin,
      "x-equinox-csrf": session.body.csrfToken,
    };

    const activity = await jsonFetch(`${base}/api/v1/activity`);
    assert.equal(activity.response.status, 200);
    assert.deepEqual(activity.body.events, [{ timestamp: "2026-08-22T00:00:00.000Z", component: "runtime", message: "Ready" }]);

    const picker = await jsonFetch(`${base}/api/v1/folder-picker`, {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    assert.equal(picker.response.status, 200);
    assert.equal(picker.body.path, "/tmp/chosen");
    assert.equal(picker.body.cancelled, false);

    const restart = await jsonFetch(`${base}/api/v1/runtime/restart`, {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    assert.equal(restart.response.status, 202);
    assert.deepEqual(restart.body.result, { scheduled: true, installationKind: "source" });

    const openedAgentBrowser = await jsonFetch(`${base}/api/v1/browser/agent/open`, {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    assert.equal(openedAgentBrowser.response.status, 200);
    assert.equal(openedAgentBrowser.body.agentBrowser.context, "agent");
    assert.equal(openedAgentBrowser.body.agentBrowser.isolated, true);

    const browser = await jsonFetch(`${base}/api/v1/browser/settings`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({ context: "agent", enabled: false, agentCursorEnabled: true, agentCursorName: "Nyx" }),
    });
    assert.equal(browser.response.status, 200);
    assert.equal(browser.body.settings.context, "agent");
    assert.equal(browser.body.settings.enabled, false);
    assert.equal(browser.body.settings.agentCursorName, "Nyx");

    const removedAgentBrowser = await jsonFetch(`${base}/api/v1/agent-browser`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ action: "connect" }),
    });
    assert.equal(removedAgentBrowser.response.status, 404);

    const githubStatus = await jsonFetch(`${base}/api/v1/integrations/github`);
    assert.equal(githubStatus.response.status, 200);
    assert.deepEqual(githubStatus.body.github, { ready: true, account: "example-user" });

    const peekabooStatus = await jsonFetch(`${base}/api/v1/integrations/peekaboo`);
    assert.equal(peekabooStatus.response.status, 200);
    assert.deepEqual(peekabooStatus.body.peekaboo, {
      available: true,
      active: true,
      ready: true,
      needsAttention: false,
      version: "4.3.0",
      reconnectCount: 0,
    });

    const github = await jsonFetch(`${base}/api/v1/integrations/github/check`, {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    assert.equal(github.response.status, 200);
    assert.deepEqual(github.body.github, { ready: true, account: "example-user" });

    const telegramStatus = await jsonFetch(`${base}/api/v1/integrations/telegram`);
    assert.equal(telegramStatus.response.status, 200);
    assert.deepEqual(telegramStatus.body.telegram, {
      configured: false,
      ready: false,
      needsAttention: false,
      userIdHint: null,
    });

    const telegramConnect = await jsonFetch(`${base}/api/v1/integrations/telegram`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({ botToken: "secret-token", telegramUserId: "123456789" }),
    });
    assert.equal(telegramConnect.response.status, 200);
    assert.deepEqual(telegramConnect.body.telegram, {
      configured: true,
      ready: true,
      needsAttention: false,
      userIdHint: "…6789",
    });
    assert.equal(JSON.stringify(telegramConnect.body).includes("secret-token"), false);

    const telegramTest = await jsonFetch(`${base}/api/v1/integrations/telegram/test`, {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    assert.equal(telegramTest.response.status, 200);
    assert.equal(telegramTest.body.result.sent, true);

    const telegramDisconnect = await jsonFetch(`${base}/api/v1/integrations/telegram/disconnect`, {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    assert.equal(telegramDisconnect.response.status, 200);
    assert.equal(telegramDisconnect.body.result.disconnected, true);

    assert.deepEqual(calls, [
      ["picker"],
      ["restart"],
      ["agent-browser-open"],
      ["browser", { context: "agent", enabled: false, agentCursorEnabled: true, agentCursorName: "Nyx" }],
      ["github"],
      ["peekaboo-status"],
      ["github"],
      ["telegram-status"],
      ["telegram-connect", { botToken: "secret-token", telegramUserId: "123456789" }],
      ["telegram-test"],
      ["telegram-disconnect"],
    ]);
    assert.equal(api.snapshot().mutationCount, 6);

    const invalidBrowser = await jsonFetch(`${base}/api/v1/browser/settings`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({ surprise: true }),
    });
    assert.equal(invalidBrowser.response.status, 400);
    assert.equal(calls.length, 11);
  }, {
    getActivity: async () => [{ timestamp: "2026-08-22T00:00:00.000Z", component: "runtime", message: "Ready" }],
    restartRuntime: async () => {
      calls.push(["restart"]);
      return { scheduled: true, installationKind: "source" };
    },
    chooseFolder: async () => {
      calls.push(["picker"]);
      return "/tmp/chosen";
    },
    openAgentBrowser: async () => {
      calls.push(["agent-browser-open"]);
      return { context: "agent", isolated: true, ready: false, pairing: true };
    },
    updateBrowserSettings: async (settings) => {
      calls.push(["browser", settings]);
      return { ...settings, nativeHostConnected: true, localConnected: true, extensionVersion: "0.3.0" };
    },
    checkGitHub: async () => {
      calls.push(["github"]);
      return { ready: true, account: "example-user" };
    },
    getPeekabooStatus: async () => {
      calls.push(["peekaboo-status"]);
      return {
        available: true,
        active: true,
        ready: true,
        needsAttention: false,
        version: "4.3.0",
        reconnectCount: 0,
      };
    },
    getTelegramStatus: async () => {
      calls.push(["telegram-status"]);
      return { configured: false, ready: false, needsAttention: false, userIdHint: null };
    },
    configureTelegram: async (body) => {
      calls.push(["telegram-connect", body]);
      return { configured: true, ready: true, needsAttention: false, userIdHint: "…6789" };
    },
    testTelegram: async () => {
      calls.push(["telegram-test"]);
      return { sent: true, messageCount: 1 };
    },
    disconnectTelegram: async () => {
      calls.push(["telegram-disconnect"]);
      return { disconnected: true };
    },
  });
});


test("Telegram pairing routes are bounded, CSRF-protected and keep token/user ID write-only", async () => {
  const calls = [];
  await withApi(async ({ api, port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const session = await jsonFetch(`${base}/api/v1/session`);
    const headers = { "content-type": "application/json", origin, "x-equinox-csrf": session.body.csrfToken };

    const start = await jsonFetch(`${base}/api/v1/integrations/telegram/pair/start`, {
      method: "POST", headers, body: JSON.stringify({ botToken: "secret-token" }),
    });
    assert.equal(start.response.status, 200);
    assert.deepEqual(start.body.pairing, { active: true, candidateFound: false, botUsername: "eqxbot", expiresAt: "2026-09-20T19:00:00.000Z", candidateLabel: null, userIdHint: null });
    assert.equal(JSON.stringify(start.body).includes("secret-token"), false);

    const invalidStart = await jsonFetch(`${base}/api/v1/integrations/telegram/pair/start`, {
      method: "POST", headers, body: JSON.stringify({ botToken: "secret-token", telegramUserId: "123" }),
    });
    assert.equal(invalidStart.response.status, 400);

    const poll = await jsonFetch(`${base}/api/v1/integrations/telegram/pair`, {
      headers: { "x-equinox-background-refresh": "1" },
    });
    assert.equal(poll.response.status, 200);
    assert.deepEqual(poll.body.pairing, { active: true, candidateFound: true, botUsername: "eqxbot", expiresAt: "2026-09-20T19:00:00.000Z", candidateLabel: "@samet", userIdHint: "…6789" });
    assert.equal(JSON.stringify(poll.body).includes("123456789"), false);

    const missingCsrf = await jsonFetch(`${base}/api/v1/integrations/telegram/pair/confirm`, {
      method: "POST", headers: { "content-type": "application/json", origin }, body: "{}",
    });
    assert.equal(missingCsrf.response.status, 403);

    const confirm = await jsonFetch(`${base}/api/v1/integrations/telegram/pair/confirm`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(confirm.response.status, 200);
    assert.deepEqual(confirm.body.telegram, { configured: true, ready: true, needsAttention: false, userIdHint: "…6789" });

    const cancel = await jsonFetch(`${base}/api/v1/integrations/telegram/pair/cancel`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(cancel.response.status, 200);
    assert.deepEqual(cancel.body.result, { cancelled: true });

    assert.deepEqual(calls, [
      ["pair-start", { botToken: "secret-token" }],
      ["pair-poll"],
      ["pair-confirm"],
      ["pair-cancel"],
    ]);
    assert.equal(api.snapshot().mutationCount, 3);
  }, {
    startTelegramPairing: async (body) => {
      calls.push(["pair-start", body]);
      return { active: true, candidateFound: false, botUsername: "eqxbot", expiresAt: "2026-09-20T19:00:00.000Z", candidateLabel: null, userIdHint: null };
    },
    pollTelegramPairing: async () => {
      calls.push(["pair-poll"]);
      return { active: true, candidateFound: true, botUsername: "eqxbot", expiresAt: "2026-09-20T19:00:00.000Z", candidateLabel: "@samet", userIdHint: "…6789" };
    },
    confirmTelegramPairing: async () => {
      calls.push(["pair-confirm"]);
      return { configured: true, ready: true, needsAttention: false, userIdHint: "…6789" };
    },
    cancelTelegramPairing: async () => {
      calls.push(["pair-cancel"]);
      return { cancelled: true };
    },
  });
});

test("Web file transfer settings expose default and require CSRF for path changes", async () => {
  const calls = [];
  await withApi(async ({ api, port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const status = await jsonFetch(`${base}/api/v1/files/import-settings`);
    assert.equal(status.response.status, 200);
    assert.equal(status.body.webFileTransfer.path, "/Users/example/Downloads/Equinox Local/Web");
    const session = await jsonFetch(`${base}/api/v1/session`);
    const headers = { "content-type": "application/json", origin, "x-equinox-csrf": session.body.csrfToken };
    const missingCsrf = await jsonFetch(`${base}/api/v1/files/import-settings`, { method: "PUT", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ path: "/tmp/Web" }) });
    assert.equal(missingCsrf.response.status, 403);
    const custom = await jsonFetch(`${base}/api/v1/files/import-settings`, { method: "PUT", headers, body: JSON.stringify({ path: "/Users/example/Web" }) });
    assert.equal(custom.response.status, 200);
    const reset = await jsonFetch(`${base}/api/v1/files/import-settings`, { method: "PUT", headers, body: JSON.stringify({ path: null }) });
    assert.equal(reset.response.status, 200);
    assert.deepEqual(calls, [{ path: "/Users/example/Web" }, { path: null }]);
    assert.equal(api.snapshot().mutationCount, 2);
  }, {
    getWebImportSettings: async () => ({ path: "/Users/example/Downloads/Equinox Local/Web", isDefault: true, autoCleanup: false }),
    updateWebImportDownloads: async (body) => { calls.push(body); return { path: body.path || "/Users/example/Downloads/Equinox Local/Web", isDefault: body.path === null, autoCleanup: false }; },
  });
});

test("Telegram remote-control toggle is CSRF-protected and accepts only a boolean", async () => {
  const calls = [];
  await withApi(async ({ api, port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const session = await jsonFetch(`${base}/api/v1/session`);
    const headers = { "content-type": "application/json", origin, "x-equinox-csrf": session.body.csrfToken };
    const missingCsrf = await jsonFetch(`${base}/api/v1/integrations/telegram/remote-control`, { method: "PUT", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ enabled: false }) });
    assert.equal(missingCsrf.response.status, 403);
    const invalid = await jsonFetch(`${base}/api/v1/integrations/telegram/remote-control`, { method: "PUT", headers, body: JSON.stringify({ enabled: "no" }) });
    assert.equal(invalid.response.status, 400);
    const off = await jsonFetch(`${base}/api/v1/integrations/telegram/remote-control`, { method: "PUT", headers, body: JSON.stringify({ enabled: false }) });
    assert.equal(off.response.status, 200);
    assert.deepEqual(off.body.remoteControl, { enabled: false });
    assert.deepEqual(calls, [{ enabled: false }]);
    assert.equal(api.snapshot().mutationCount, 1);
  }, {
    updateTelegramRemoteControl: async (body) => { calls.push(body); return { enabled: body.enabled }; },
  });
});

test("Telegram download location update is CSRF-protected and accepts only path or null reset", async () => {
  const calls = [];
  await withApi(async ({ api, port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const session = await jsonFetch(`${base}/api/v1/session`);
    const headers = { "content-type": "application/json", origin, "x-equinox-csrf": session.body.csrfToken };

    const missingCsrf = await jsonFetch(`${base}/api/v1/integrations/telegram/downloads`, {
      method: "PUT", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ path: "/Users/example/Downloads" }),
    });
    assert.equal(missingCsrf.response.status, 403);

    const invalid = await jsonFetch(`${base}/api/v1/integrations/telegram/downloads`, {
      method: "PUT", headers, body: JSON.stringify({ path: "/Users/example/Downloads", extra: true }),
    });
    assert.equal(invalid.response.status, 400);

    const custom = await jsonFetch(`${base}/api/v1/integrations/telegram/downloads`, {
      method: "PUT", headers, body: JSON.stringify({ path: "/Users/example/Downloads/Telegram" }),
    });
    assert.equal(custom.response.status, 200);
    assert.deepEqual(custom.body.downloads, { path: "/Users/example/Downloads/Telegram", isDefault: false, autoCleanup: false, knownRoots: ["/Users/example/Downloads/Telegram"] });

    const reset = await jsonFetch(`${base}/api/v1/integrations/telegram/downloads`, {
      method: "PUT", headers, body: JSON.stringify({ path: null }),
    });
    assert.equal(reset.response.status, 200);
    assert.equal(reset.body.downloads.isDefault, true);
    assert.deepEqual(calls, [
      ["downloads", { path: "/Users/example/Downloads/Telegram" }],
      ["downloads", { path: null }],
    ]);
    assert.equal(api.snapshot().mutationCount, 2);
  }, {
    updateTelegramDownloads: async (body) => {
      calls.push(["downloads", body]);
      return body.path === null
        ? { path: "/Users/example/Downloads/Equinox Local/Telegram", isDefault: true, autoCleanup: false, knownRoots: ["/Users/example/Downloads/Telegram", "/Users/example/Downloads/Equinox Local/Telegram"] }
        : { path: body.path, isDefault: false, autoCleanup: false, knownRoots: [body.path] };
    },
  });
});

test("authenticated HTTP Control Center routes are fixed, CSRF-protected and keep credentials write-only", async () => {
  const calls = [];
  const safeProfile = {
    id: "moltbook",
    label: "Moltbook",
    origin: "https://example.com",
    basePath: "/api/v1",
    authType: "bearer",
    authHeader: "authorization",
    allowedMethods: ["GET", "POST"],
    allowedPathPrefixes: ["/posts"],
    allowedAgentHeaders: ["x-client-version"],
    timeoutMs: 10_000,
    ready: true,
    needsCredential: false,
  };

  await withApi(async ({ api, port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const session = await jsonFetch(`${base}/api/v1/session`);
    const mutationHeaders = {
      "content-type": "application/json",
      origin,
      "x-equinox-csrf": session.body.csrfToken,
    };

    const list = await jsonFetch(`${base}/api/v1/integrations/http-profiles`);
    assert.equal(list.response.status, 200);
    assert.equal(list.body.httpProfiles.agentProfileManagementEnabled, true);
    assert.equal(list.body.httpProfiles.profiles[0].id, "moltbook");
    assert.equal(JSON.stringify(list.body).includes("super-http-secret"), false);

    const missingGuard = await jsonFetch(`${base}/api/v1/integrations/http-profiles/management`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(missingGuard.response.status, 403);

    const management = await jsonFetch(`${base}/api/v1/integrations/http-profiles/management`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(management.response.status, 200);
    assert.equal(management.body.httpProfiles.agentProfileManagementEnabled, false);

    const upsert = await jsonFetch(`${base}/api/v1/integrations/http-profiles/profile`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({
        profile: {
          id: "moltbook",
          label: "Moltbook",
          origin: "https://example.com",
          basePath: "/api/v1",
          auth: { type: "bearer" },
          allowedMethods: ["GET", "POST"],
          allowedPathPrefixes: ["/posts"],
          allowedAgentHeaders: ["x-client-version"],
          timeoutMs: 10_000,
        },
        credential: "super-http-secret",
      }),
    });
    assert.equal(upsert.response.status, 200);
    assert.equal(upsert.body.profile.id, "moltbook");
    assert.equal(JSON.stringify(upsert.body).includes("super-http-secret"), false);
    assert.equal(Object.hasOwn(upsert.body.profile, "credential"), false);

    const arbitraryUrl = await jsonFetch(`${base}/api/v1/integrations/http-profiles/test`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        profileId: "moltbook",
        method: "GET",
        path: "/posts",
        url: "https://evil.example/",
      }),
    });
    assert.equal(arbitraryUrl.response.status, 400);

    const tested = await jsonFetch(`${base}/api/v1/integrations/http-profiles/test`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        profileId: "moltbook",
        method: "GET",
        path: "/posts",
        query: { limit: 1 },
        headers: { "x-client-version": "1" },
        timeoutMs: 5000,
      }),
    });
    assert.equal(tested.response.status, 200);
    assert.equal(tested.body.result.status, 200);

    const deleted = await jsonFetch(`${base}/api/v1/integrations/http-profiles/delete`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ profileId: "moltbook" }),
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.result.deleted, true);

    assert.equal(api.snapshot().mutationCount, 4);
    assert.deepEqual(calls.map(([name]) => name), [
      "http-list",
      "http-management",
      "http-upsert",
      "http-test",
      "http-delete",
    ]);
    assert.equal(calls[2][1].credential, "super-http-secret");
    assert.equal(calls[3][1].profileId, "moltbook");
    assert.equal(Object.hasOwn(calls[3][1], "url"), false);
  }, {
    getHttpProfiles: async () => {
      calls.push(["http-list"]);
      return { agentProfileManagementEnabled: true, profiles: [safeProfile] };
    },
    setHttpProfileManagement: async ({ enabled }) => {
      calls.push(["http-management", { enabled }]);
      return { agentProfileManagementEnabled: enabled, profiles: [safeProfile] };
    },
    upsertHttpProfile: async (request) => {
      calls.push(["http-upsert", request]);
      return safeProfile;
    },
    testHttpProfile: async (request) => {
      calls.push(["http-test", request]);
      return { ok: true, status: 200, headers: {}, body: { ok: true }, truncated: false, durationMs: 4 };
    },
    deleteHttpProfile: async (request) => {
      calls.push(["http-delete", request]);
      return { deleted: true, profileId: request.profileId };
    },
  });
});

test("Turn Budget status is readable and settings update is immediate and CSRF-guarded", async () => {
  let current = { enabled: true, cutoffMinutes: 22, active: null };
  const updates = [];
  await withApi(async ({ origin }) => {
    const status = await jsonFetch(`${origin}/api/v1/turn-budget`);
    assert.equal(status.response.status, 200);
    assert.deepEqual(status.body.turnBudget, current);

    const missingGuard = await jsonFetch(`${origin}/api/v1/turn-budget`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, cutoffMinutes: 19 }),
    });
    assert.equal(missingGuard.response.status, 403);

    const session = await jsonFetch(`${origin}/api/v1/session`);
    const headers = {
      "content-type": "application/json",
      origin,
      "x-equinox-csrf": session.body.csrfToken,
    };
    const invalid = await jsonFetch(`${origin}/api/v1/turn-budget`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true, cutoffMinutes: 4 }),
    });
    assert.equal(invalid.response.status, 400);

    const updated = await jsonFetch(`${origin}/api/v1/turn-budget`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: false, cutoffMinutes: 19 }),
    });
    assert.equal(updated.response.status, 200);
    assert.deepEqual(updated.body.turnBudget, { enabled: false, cutoffMinutes: 19, active: null });
    assert.deepEqual(updates, [{ enabled: false, cutoffMinutes: 19 }]);
  }, {
    getTurnBudget: async () => current,
    updateTurnBudget: async (next) => {
      updates.push(next);
      current = { ...next, active: null };
      return current;
    },
  });
});

test("control API refuses CORS preflight, unsupported content types and query-bearing API requests", async () => {
  await withApi(async ({ port, origin }) => {
    const base = `http://127.0.0.1:${port}`;
    const options = await jsonFetch(`${base}/api/v1/config`, {
      method: "OPTIONS",
      headers: { origin },
    });
    assert.equal(options.response.status, 405);
    assert.equal(options.response.headers.get("access-control-allow-origin"), null);

    const queried = await jsonFetch(`${base}/api/v1/health?x=1`);
    assert.equal(queried.response.status, 400);

    const session = await jsonFetch(`${base}/api/v1/session`);
    const wrongType = await jsonFetch(`${base}/api/v1/config`, {
      method: "PUT",
      headers: {
        "content-type": "text/plain",
        origin,
        "x-equinox-csrf": session.body.csrfToken,
      },
      body: "{}",
    });
    assert.equal(wrongType.response.status, 415);
  });
});

test("control API returns a fixed public message for unexpected internal failures", async () => {
  const captured = [];
  await withApi(async ({ port }) => {
    const result = await jsonFetch(`http://127.0.0.1:${port}/api/v1/status`);
    assert.equal(result.response.status, 500);
    assert.equal(result.body.error, "Control Center request failed.");
    assert.doesNotMatch(result.body.error, /Volumes|AUDIT_FIXTURE|report\.txt/u);
  }, {
    getStatus: async () => {
      throw new Error("Unable to open /Volumes/AUDIT_FIXTURE/private/report.txt");
    },
    recordInternalError: (error) => captured.push(error.message),
  });
  assert.deepEqual(captured, ["Unable to open /Volumes/AUDIT_FIXTURE/private/report.txt"]);
});

test("control API rejects DNS-rebinding style Host headers", async () => {
  await withApi(async ({ port }) => {
    const result = await new Promise((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port,
        path: "/api/v1/health",
        method: "GET",
        headers: { Host: `evil.example:${port}` },
      }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        }));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(result.status, 421);
    assert.match(result.body.error, /Host/u);
  });
});

test("control API refuses non-loopback bind configuration", () => {
  const configManager = fakeConfigManager();
  assert.throws(
    () => createEquinoxLocalControlApi({ configManager, host: "0.0.0.0", port: 24891 }),
    /yalnız 127\.0\.0\.1/u,
  );
});
