import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;
const COMPANION_IDS = ["nyx", "hemera", "asteria", "selene"] as const;
const isCompanionId = (value: unknown): value is typeof COMPANION_IDS[number] =>
  COMPANION_IDS.some(id => id === value);

// No Electron objects, event handles, generic IPC or arbitrary paths cross this boundary.
if (process.isMainFrame && location.protocol === "equinox:" && location.hostname === "control" && location.pathname === "/") {
  contextBridge.exposeInMainWorld("equinoxShell", Object.freeze({
    getLanguage: () => {
      const language: unknown = ipcRenderer.sendSync("equinox-shell:language-snapshot");
      return language === "tr" ? "tr" : language === "en" ? "en" : null;
    },
    pickFolder: () => ipcRenderer.invoke("equinox-shell:pick-folder"),
    openBrainVault: () => ipcRenderer.invoke("equinox-shell:open-brain-vault"),
    copyText: (value: unknown) => ipcRenderer.invoke("equinox-shell:copy-text", value),
    returnToTask:(taskId:unknown,checkpointRevision:unknown)=>ipcRenderer.invoke("equinox-shell:task-return",{taskId,checkpointRevision}),
    getCommandHistory: () => ipcRenderer.invoke("equinox-shell:command-history-status"),
    setCommandHistory: (value:unknown) => {
      if(typeof value!=="boolean")return Promise.reject(new Error("Invalid history preference."));
      return ipcRenderer.invoke("equinox-shell:command-history-enable",value);
    },
    clearCommandHistory: () => ipcRenderer.invoke("equinox-shell:command-history-clear"),
    getAssistantHome: () => ipcRenderer.sendSync("equinox-shell:assistant-home-snapshot") === "type" ? "type" : "portrait",
    setAssistantHome: (value: unknown) => {
      if (value !== "portrait" && value !== "type") return Promise.reject(new Error("Unsupported Assistant home."));
      return ipcRenderer.invoke("equinox-shell:assistant-home",value);
    },
    getChatIdentity: () => ipcRenderer.invoke("equinox-shell:chat-identity"),
    setChatAgentName: (value: unknown) => ipcRenderer.invoke("equinox-shell:chat-agent-name", value),
    chooseChatAvatar: () => ipcRenderer.invoke("equinox-shell:chat-avatar-choose"),
    removeChatAvatar: () => ipcRenderer.invoke("equinox-shell:chat-avatar-remove"),
    getCompanionId: () => {
      const id: unknown = ipcRenderer.sendSync("equinox-shell:companion-snapshot");
      return isCompanionId(id) ? id : "nyx";
    },
    setChatAccent: (value: unknown) => ipcRenderer.invoke("equinox-shell:chat-accent", value),
    setCompanionId: (id: unknown) => {
      if (!isCompanionId(id)) return Promise.resolve(false);
      return ipcRenderer.invoke("equinox-shell:companion-select", id);
    },
    onCompanionChanged: (callback: unknown) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event: unknown, id: unknown) => {
        if (isCompanionId(id)) callback(id);
      };
      ipcRenderer.on("equinox-shell:companion-changed", listener);
      return () => ipcRenderer.removeListener("equinox-shell:companion-changed", listener);
    },
    onCompanionWorkspaceRequest: (callback: unknown) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event: unknown, destination: unknown) => {
        if (destination === "chat" || destination === "control-center") callback(destination);
      };
      ipcRenderer.on("equinox-shell:companion-workspace", listener);
      return () => ipcRenderer.removeListener("equinox-shell:companion-workspace", listener);
    },
    setAppearance: (value: unknown) => {
      if (value === "system" || value === "light" || value === "dark") {
        void ipcRenderer.invoke("equinox-shell:appearance", value).catch(() => {});
      }
    },
    requestJson: (request: unknown) => ipcRenderer.invoke("equinox-shell:control-request", request),
    setEmbeddedChatBounds: (bounds: unknown) => ipcRenderer.invoke("equinox-shell:embedded-chat-layout", bounds),
    retryEmbeddedChat: () => ipcRenderer.invoke("equinox-shell:embedded-chat-retry"),
    onEmbeddedChatStatus: (callback: unknown) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event: unknown, value: unknown) => {
        if (value === "loading" || value === "ready" || value === "offline" || value === "failed") callback(value);
      };
      ipcRenderer.on("equinox-shell:embedded-chat-status", listener);
      return () => ipcRenderer.removeListener("equinox-shell:embedded-chat-status", listener);
    },
    onNativeTurnBudget: (callback: unknown) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event: unknown, value: unknown) => {
        if (value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 120 * 60_000)) callback(value);
      };
      ipcRenderer.on("equinox-shell:native-turn-budget", listener);
      return () => ipcRenderer.removeListener("equinox-shell:native-turn-budget", listener);
    },
    requestEmbeddedChatMicrophone: () => ipcRenderer.invoke("equinox-shell:embedded-chat-microphone"),
    setLanguage: (language: unknown) => {
      if (language === "en" || language === "tr") {
        void ipcRenderer.invoke("equinox-shell:language", language).catch(() => {});
      }
    },
  }));
}
