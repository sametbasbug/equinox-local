import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { createEquinoxLocalControlApi } from "../../src/equinox-local-control-api.js";

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
    getDoctorStatus: overrides.getDoctorStatus ?? (async () => ({ state: "HEALTHY", summary: { attention: 0 } })),
    getActivity: overrides.getActivity ?? (async () => []),
    getUpdateStatus: overrides.getUpdateStatus ?? (async () => ({ currentVersion: "4.2.0", selfUpdateSupported: false })),
    getOnboardingStatus: overrides.getOnboardingStatus ?? (async () => ({ available: false, managed: false })),
    checkForUpdates: overrides.checkForUpdates ?? null,
    applyUpdate: overrides.applyUpdate ?? null,
    configureTunnel: overrides.configureTunnel ?? null,
    scheduleUninstall: overrides.scheduleUninstall ?? null,
    chooseFolder: overrides.chooseFolder ?? null,
    updateBrowserSettings: overrides.updateBrowserSettings ?? null,
    checkGitHub: overrides.checkGitHub ?? null,
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

test("control API serves the visual Control Center shell and fixed same-origin assets", async () => {
  await withApi(async ({ port }) => {
    const base = `http://127.0.0.1:${port}`;
    const shell = await fetch(`${base}/`);
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get("content-type"), /^text\/html/u);
    assert.match(shell.headers.get("content-security-policy"), /script-src 'self'/u);
    assert.equal(shell.headers.get("access-control-allow-origin"), null);
    assert.equal(shell.headers.get("x-frame-options"), "DENY");
    assert.match(await shell.text(), /Equinox Local Control Center/u);

    const css = await fetch(`${base}/assets/control-center.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /^text\/css/u);
    assert.match(await css.text(), /\.app-shell/u);

    const script = await fetch(`${base}/assets/control-center.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /^text\/javascript/u);
    const scriptText = await script.text();
    assert.match(scriptText, /\/api\/v1\/config/u);
    assert.match(scriptText, /\/api\/v1\/doctor/u);
    assert.match(scriptText, /\/api\/v1\/activity/u);
    assert.match(scriptText, /\/api\/v1\/update/u);
    assert.match(scriptText, /\/api\/v1\/update\/check/u);
    assert.match(scriptText, /\/api\/v1\/update\/apply/u);
    assert.match(scriptText, /\/api\/v1\/onboarding/u);
    assert.match(scriptText, /\/api\/v1\/onboarding\/tunnel/u);
    assert.match(scriptText, /\/api\/v1\/uninstall/u);
    assert.match(scriptText, /\/api\/v1\/folder-picker/u);
    assert.match(scriptText, /\/api\/v1\/browser\/settings/u);
    assert.doesNotMatch(scriptText, /agent-browser|Agent Browser/u);
    assert.match(scriptText, /\/api\/v1\/integrations\/github\/check/u);

    const missing = await jsonFetch(`${base}/missing-control-center-route`);
    assert.equal(missing.response.status, 404);
    assert.match(missing.body.error, /endpoint bulunamadı/u);
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

test("bounded Control Center actions expose activity, folder picker, Browser settings and GitHub readiness", async () => {
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

    const browser = await jsonFetch(`${base}/api/v1/browser/settings`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({ enabled: false, agentCursorEnabled: true, agentCursorName: "Nyx" }),
    });
    assert.equal(browser.response.status, 200);
    assert.equal(browser.body.settings.enabled, false);
    assert.equal(browser.body.settings.agentCursorName, "Nyx");

    const removedAgentBrowser = await jsonFetch(`${base}/api/v1/agent-browser`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ action: "connect" }),
    });
    assert.equal(removedAgentBrowser.response.status, 404);

    const github = await jsonFetch(`${base}/api/v1/integrations/github/check`, {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    assert.equal(github.response.status, 200);
    assert.deepEqual(github.body.github, { ready: true, account: "example-user" });

    assert.deepEqual(calls, [
      ["picker"],
      ["browser", { enabled: false, agentCursorEnabled: true, agentCursorName: "Nyx" }],
      ["github"],
    ]);
    assert.equal(api.snapshot().mutationCount, 1);

    const invalidBrowser = await jsonFetch(`${base}/api/v1/browser/settings`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({ surprise: true }),
    });
    assert.equal(invalidBrowser.response.status, 400);
    assert.equal(calls.length, 3);
  }, {
    getActivity: async () => [{ timestamp: "2026-08-22T00:00:00.000Z", component: "runtime", message: "Ready" }],
    chooseFolder: async () => {
      calls.push(["picker"]);
      return "/tmp/chosen";
    },
    updateBrowserSettings: async (settings) => {
      calls.push(["browser", settings]);
      return { ...settings, nativeHostConnected: true, localConnected: true, extensionVersion: "0.3.0" };
    },
    checkGitHub: async () => {
      calls.push(["github"]);
      return { ready: true, account: "example-user" };
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
