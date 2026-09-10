// Local UI fixture only. No real config, credentials, browser settings, messages,
// updates, restarts or uninstall operations are performed by these callbacks.
import { createEquinoxLocalControlApi } from "../../src/equinox-local-control-api.js";

let revision = "a".repeat(64);
const onboardingScenario = process.argv.includes("--onboarding");
const attentionScenario = process.argv.includes("--attention");
let pid = 4242;
let paused = false;
let telegram = { configured: false, ready: false, needsAttention: false };
let update = { currentVersion: "4.7.0", installationKind: "managed", managedInstallation: true, selfUpdateSupported: true, configured: true, updateAvailable: false };
let config = {
  version: 1,
  defaultProject: "workspace",
  agentAccess: { files: "full", terminal: true, desktop: true, browser: true },
  runtime: { workspaceProject: "workspace", downloadsRoot: "downloads" },
  projects: {
    workspace: { name: "Equinox Workspace", root: "/Users/example/Library/Application Support/Equinox Local/workspace", worktrees: false },
    docs: { name: "Docs", root: "/Users/example/Documents/docs", worktrees: false },
  },
  fileRoots: {
    downloads: { name: "Downloads", root: "/Users/example/Downloads", access: "read-only" },
  },
  controlCenter: { enabled: true, port: 24892 },
};

const manager = {
  snapshot: () => ({ revision, loadedAt: new Date().toISOString(), config }),
  replacePersisted: async (next, { expectedRevision }) => {
    if (expectedRevision !== revision) throw new Error("Fixture revision mismatch");
    const previousRevision = revision;
    config = structuredClone(next);
    revision = (revision === "a".repeat(64) ? "b" : "a").repeat(64);
    return { previousRevision, persistedRevision: revision, restartRequired: true };
  },
};

let browser = {
  active: true,
  ready: true,
  connectedAt: new Date().toISOString(),
  extensionVersion: "0.5.2",
  controlEnabled: true,
  agentCursorEnabled: true,
  agentCursorName: "Agent",
  nativeHostConnected: true,
  localConnected: true,
  defaultTarget: "agent",
  agentBrowser: {
    supported: true,
    context: "agent",
    isolated: true,
    ready: true,
    extensionVersion: "0.5.2",
    connectedAt: new Date().toISOString(),
    pairing: false,
    setupComplete: true,
  },
  contexts: {
    agent: {
      ready: true,
      connectedAt: new Date().toISOString(),
      extensionVersion: "0.5.2",
      consentAccepted: true,
      controlEnabled: true,
      agentCursorEnabled: true,
      agentCursorName: "Agent",
    },
    user: {
      ready: true,
      connectedAt: new Date().toISOString(),
      extensionVersion: "0.5.2",
      consentAccepted: true,
      controlEnabled: true,
      agentCursorEnabled: true,
      agentCursorName: "Agent",
    },
  },
};
let onboarding = {
  available: true,
  managed: true,
  transportConfigured: !onboardingScenario,
  supervisorMode: onboardingScenario ? "local-only" : "tunnel",
  connectedThroughTunnel: !onboardingScenario,
  needsAttention: false,
  tunnelId: null,
  issue: null,
};

const api = createEquinoxLocalControlApi({
  configManager: manager,
  port: 24892,
  getStatus: async () => ({
    server: { name: "Equinox Local", version: "4.7.0", uptimeSeconds: 9000, pid },
    agentControl: { paused, state: paused ? "PAUSED" : "ACTIVE", activeWork: { terminals: 0, processes: 0, total: 0 } },
    health: {
      state: attentionScenario ? "DEGRADED" : "HEALTHY",
      evaluatedAt: new Date().toISOString(),
      recentEventCount: 3,
      reasonCount: attentionScenario ? 1 : 0,
    },
    config: {
      version: 1,
      revision,
      defaultProject: "workspace",
      workspaceProject: "workspace",
      projectCount: 2,
      fileRootCount: 1,
    },
    browser,
    peekaboo: { active: true, reconnectCount: 0 },
    capabilities: { operationCount: 135, domains: [] },
  }),
  getDoctorStatus: async () => ({
    state: onboardingScenario || attentionScenario ? "ATTENTION" : "HEALTHY",
    checkedAt: new Date().toISOString(),
    installationKind: "managed",
    managed: true,
    summary: { pass: 8 - Number(onboardingScenario) - Number(attentionScenario), attention: Number(onboardingScenario) + Number(attentionScenario), optional: 0, total: 8 },
    checks: [
      { id: "runtime", label: "Local runtime", status: attentionScenario ? "attention" : "pass", detail: attentionScenario ? "A local capability needs attention." : "Equinox Local 4.7.0 and reports healthy." },
      { id: "config", label: "Configuration", status: "pass", detail: "The versioned Equinox Local configuration loaded successfully." },
      { id: "workspace", label: "Equinox Workspace", status: "pass", detail: "The managed workspace directory is available." },
      { id: "installation", label: "Managed installation", status: "pass", detail: "Equinox Local is running from the per-user managed release layout." },
      { id: "launch-agent", label: "LaunchAgent", status: "pass", detail: "The per-user LaunchAgent is installed with private permissions." },
      { id: "native-host", label: "Equinox Browser host", status: "pass", detail: "The Native Messaging host is installed with bounded per-user files." },
      { id: "browser", label: "Equinox Browser", status: "pass", detail: "The first-party Equinox Browser bridge is connected." },
      { id: "chatgpt-connection", label: "ChatGPT connection", status: onboardingScenario ? "attention" : "pass", detail: onboardingScenario ? "Finish first-time setup by adding the tunnel credentials in Control Center." : "The ChatGPT connection is ready." },
    ],
  }),
  getActivity: async () => [
    {
      timestamp: new Date().toISOString(),
      component: "browser",
      type: "connected",
      severity: "info",
      status: "healthy",
      message: "Equinox Browser bridge is ready.",
    },
    {
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      component: "runtime",
      type: "startup",
      severity: "info",
      status: "healthy",
      message: "Runtime started successfully.",
    },
  ],
  getOnboardingStatus: async () => ({ ...onboarding }),
  configureTunnel: async ({ tunnelId }) => {
    onboarding = {
      ...onboarding,
      transportConfigured: true,
      tunnelId,
    };
    setTimeout(() => {
      onboarding = {
        ...onboarding,
        supervisorMode: "tunnel",
        connectedThroughTunnel: true,
      };
    }, 1_500).unref?.();
    return {
      configured: true,
      tunnelId,
      restartRequired: true,
      restartScheduled: true,
    };
  },
  scheduleUninstall: async ({ removeUserData }) => ({ scheduled: true, removeUserData }),
  chooseFolder: async () => "/Users/example/Code/selected",
  openAgentBrowser: async () => browser.agentBrowser,
  updateBrowserSettings: async (settings) => {
    const context = settings.context === "agent" ? "agent" : "user";
    browser = {
      ...browser,
      contexts: {
        ...browser.contexts,
        [context]: {
          ...browser.contexts[context],
          controlEnabled: settings.enabled,
          agentCursorEnabled: settings.agentCursorEnabled,
          agentCursorName: settings.agentCursorName,
        },
      },
      ...(context === "user" ? {
        controlEnabled: settings.enabled,
        agentCursorEnabled: settings.agentCursorEnabled,
        agentCursorName: settings.agentCursorName,
      } : {}),
    };
    return {
      ...settings,
      nativeHostConnected: true,
      localConnected: true,
      extensionVersion: "0.5.2",
    };
  },
  getUpdateStatus: async () => update,
  checkForUpdates: async () => (update = { ...update, latestVersion: "4.8.0", updateAvailable: true, checkedAt: new Date().toISOString() }),
  applyUpdate: async () => ({ scheduled: true, targetVersion: "4.8.0" }),
  pauseAgent: async () => ({ paused: (paused = true), state: "PAUSED" }),
  resumeAgent: async () => ({ paused: (paused = false), state: "ACTIVE" }),
  restartRuntime: async () => { pid += 1; return { scheduled: true }; },
  getPeekabooStatus: async () => ({ active: true, ready: !attentionScenario, needsAttention: attentionScenario, version: "4.2.1", permissions: { screenRecording: true, accessibility: true } }),
  getTelegramStatus: async () => telegram,
  configureTelegram: async () => (telegram = { configured: true, ready: true, userIdHint: "…789" }),
  testTelegram: async () => ({ sent: true }),
  disconnectTelegram: async () => { telegram = { configured: false, ready: false }; return { disconnected: true }; },
});

await api.start();
console.log("control-center-harness-ready");
