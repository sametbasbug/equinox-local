import { createEquinoxLocalControlApi } from "../../src/equinox-local-control-api.js";

const revision = "a".repeat(64);
const config = {
  version: 1,
  defaultProject: "workspace",
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
  replacePersisted: async () => ({
    previousRevision: revision,
    persistedRevision: "b".repeat(64),
    restartRequired: true,
  }),
};

let browser = {
  active: true,
  ready: true,
  connectedAt: new Date().toISOString(),
  extensionVersion: "0.4.0-dev",
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
    extensionVersion: "0.4.0-dev",
    connectedAt: new Date().toISOString(),
    pairing: false,
  },
  contexts: {
    agent: {
      ready: true,
      connectedAt: new Date().toISOString(),
      extensionVersion: "0.4.0-dev",
      consentAccepted: true,
      controlEnabled: true,
      agentCursorEnabled: true,
      agentCursorName: "Agent",
    },
    user: {
      ready: true,
      connectedAt: new Date().toISOString(),
      extensionVersion: "0.4.0-dev",
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
  transportConfigured: false,
  supervisorMode: "local-only",
  connectedThroughTunnel: false,
  needsAttention: false,
  tunnelId: null,
  issue: null,
};

const api = createEquinoxLocalControlApi({
  configManager: manager,
  port: 24892,
  getStatus: async () => ({
    server: { name: "Equinox Local", version: "4.2.0", uptimeSeconds: 9000 },
    health: {
      state: "HEALTHY",
      evaluatedAt: new Date().toISOString(),
      recentEventCount: 3,
      reasonCount: 0,
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
    state: "ATTENTION",
    checkedAt: new Date().toISOString(),
    installationKind: "managed",
    managed: true,
    summary: { pass: 7, attention: 1, optional: 0, total: 8 },
    checks: [
      { id: "runtime", label: "Local runtime", status: "pass", detail: "Equinox Local 4.2.0 and reports healthy." },
      { id: "config", label: "Configuration", status: "pass", detail: "The versioned Equinox Local configuration loaded successfully." },
      { id: "workspace", label: "Equinox Workspace", status: "pass", detail: "The managed workspace directory is available." },
      { id: "installation", label: "Managed installation", status: "pass", detail: "Equinox Local is running from the per-user managed release layout." },
      { id: "launch-agent", label: "LaunchAgent", status: "pass", detail: "The per-user LaunchAgent is installed with private permissions." },
      { id: "native-host", label: "Equinox Browser host", status: "pass", detail: "The Native Messaging host is installed with bounded per-user files." },
      { id: "browser", label: "Equinox Browser", status: "pass", detail: "The first-party Equinox Browser bridge is connected." },
      { id: "chatgpt-connection", label: "ChatGPT connection", status: "attention", detail: "Finish first-time setup by adding the tunnel credentials in Control Center." },
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
      extensionVersion: "0.4.0-dev",
    };
  },
  checkGitHub: async () => ({ ready: true, account: "demo-user" }),
});

await api.start();
console.log("control-center-harness-ready");
