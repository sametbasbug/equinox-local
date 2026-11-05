import electron = require("electron");
const { contextBridge, ipcRenderer } = electron;

// No Electron objects, event handles, generic IPC or arbitrary paths cross this boundary.
if (process.isMainFrame && location.origin === "http://127.0.0.1:24891" && location.pathname === "/") {
  contextBridge.exposeInMainWorld("equinoxShell", Object.freeze({
    getLanguage: () => {
      const language: unknown = ipcRenderer.sendSync("equinox-shell:language-snapshot");
      return language === "tr" ? "tr" : language === "en" ? "en" : null;
    },
    pickFolder: () => ipcRenderer.invoke("equinox-shell:pick-folder"),
    setLanguage: (language: unknown) => {
      if (language === "en" || language === "tr") {
        void ipcRenderer.invoke("equinox-shell:language", language).catch(() => {});
      }
    },
  }));
}
