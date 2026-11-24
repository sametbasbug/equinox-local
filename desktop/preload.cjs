"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron = require("electron");
const { contextBridge, ipcRenderer } = electron;
// No Electron objects, event handles, generic IPC or arbitrary paths cross this boundary.
if (process.isMainFrame && location.protocol === "equinox:" && location.hostname === "control" && location.pathname === "/") {
    contextBridge.exposeInMainWorld("equinoxShell", Object.freeze({
        getLanguage: () => {
            const language = ipcRenderer.sendSync("equinox-shell:language-snapshot");
            return language === "tr" ? "tr" : language === "en" ? "en" : null;
        },
        pickFolder: () => ipcRenderer.invoke("equinox-shell:pick-folder"),
        getCompanionId: () => {
            const id = ipcRenderer.sendSync("equinox-shell:companion-snapshot");
            return id === "nyx" || id === "hemera" || id === "asteria" ? id : "nyx";
        },
        setCompanionId: (id) => {
            if (id !== "nyx" && id !== "hemera" && id !== "asteria")
                return Promise.resolve(false);
            return ipcRenderer.invoke("equinox-shell:companion-select", id);
        },
        onCompanionChanged: (callback) => {
            if (typeof callback !== "function")
                return () => { };
            const listener = (_event, id) => {
                if (id === "nyx" || id === "hemera" || id === "asteria")
                    callback(id);
            };
            ipcRenderer.on("equinox-shell:companion-changed", listener);
            return () => ipcRenderer.removeListener("equinox-shell:companion-changed", listener);
        },
        setAppearance: (value) => {
            if (value === "system" || value === "light" || value === "dark") {
                void ipcRenderer.invoke("equinox-shell:appearance", value).catch(() => { });
            }
        },
        requestJson: (request) => ipcRenderer.invoke("equinox-shell:control-request", request),
        setEmbeddedChatBounds: (bounds) => ipcRenderer.invoke("equinox-shell:embedded-chat-layout", bounds),
        requestEmbeddedChatMicrophone: () => ipcRenderer.invoke("equinox-shell:embedded-chat-microphone"),
        setLanguage: (language) => {
            if (language === "en" || language === "tr") {
                void ipcRenderer.invoke("equinox-shell:language", language).catch(() => { });
            }
        },
    }));
}
