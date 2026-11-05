"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron = require("electron");
const { contextBridge, ipcRenderer } = electron;
// No Electron objects, event handles, generic IPC or arbitrary paths cross this boundary.
if (process.isMainFrame && location.origin === "http://127.0.0.1:24891" && location.pathname === "/") {
    contextBridge.exposeInMainWorld("equinoxShell", Object.freeze({
        getLanguage: () => {
            const language = ipcRenderer.sendSync("equinox-shell:language-snapshot");
            return language === "tr" ? "tr" : language === "en" ? "en" : null;
        },
        pickFolder: () => ipcRenderer.invoke("equinox-shell:pick-folder"),
        setLanguage: (language) => {
            if (language === "en" || language === "tr") {
                void ipcRenderer.invoke("equinox-shell:language", language).catch(() => { });
            }
        },
    }));
}
