import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;

// No Electron objects, event handles, generic IPC or arbitrary paths cross this boundary.
if (process.isMainFrame && location.protocol === "equinox:" && location.hostname === "control" && location.pathname === "/") {
  contextBridge.exposeInMainWorld("equinoxShell", Object.freeze({
    getLanguage: () => {
      const language: unknown = ipcRenderer.sendSync("equinox-shell:language-snapshot");
      return language === "tr" ? "tr" : language === "en" ? "en" : null;
    },
    pickFolder: () => ipcRenderer.invoke("equinox-shell:pick-folder"),
    getCompanionId: () => {
      const id: unknown = ipcRenderer.sendSync("equinox-shell:companion-snapshot");
      return id === "nyx" || id === "hemera" || id === "asteria" ? id : "nyx";
    },
    setCompanionId: (id: unknown) => {
      if (id !== "nyx" && id !== "hemera" && id !== "asteria") return Promise.resolve(false);
      return ipcRenderer.invoke("equinox-shell:companion-select", id);
    },
    onCompanionChanged: (callback: unknown) => {
      if (typeof callback !== "function") return () => {};
      const listener = (_event: unknown, id: unknown) => {
        if (id === "nyx" || id === "hemera" || id === "asteria") callback(id);
      };
      ipcRenderer.on("equinox-shell:companion-changed", listener);
      return () => ipcRenderer.removeListener("equinox-shell:companion-changed", listener);
    },
    requestJson: (request: unknown) => ipcRenderer.invoke("equinox-shell:control-request", request),
    setLanguage: (language: unknown) => {
      if (language === "en" || language === "tr") {
        void ipcRenderer.invoke("equinox-shell:language", language).catch(() => {});
      }
    },
  }));
}
