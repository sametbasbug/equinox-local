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
    requestJson: (request: unknown) => ipcRenderer.invoke("equinox-shell:control-request", request),
    setLanguage: (language: unknown) => {
      if (language === "en" || language === "tr") {
        void ipcRenderer.invoke("equinox-shell:language", language).catch(() => {});
      }
    },
  }));
}
