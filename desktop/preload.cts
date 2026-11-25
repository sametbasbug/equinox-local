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
    copyText: (value: unknown) => ipcRenderer.invoke("equinox-shell:copy-text", value),
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
    requestEmbeddedChatMicrophone: () => ipcRenderer.invoke("equinox-shell:embedded-chat-microphone"),
    setLanguage: (language: unknown) => {
      if (language === "en" || language === "tr") {
        void ipcRenderer.invoke("equinox-shell:language", language).catch(() => {});
      }
    },
  }));
}
