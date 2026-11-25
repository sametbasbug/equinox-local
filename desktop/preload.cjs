"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron = require("electron");
const { contextBridge, ipcRenderer } = electron;
const COMPANION_IDS = ["nyx", "hemera", "asteria", "selene"];
const isCompanionId = (value) => COMPANION_IDS.some(id => id === value);
// No Electron objects, event handles, generic IPC or arbitrary paths cross this boundary.
if (process.isMainFrame && location.protocol === "equinox:" && location.hostname === "control" && location.pathname === "/") {
    contextBridge.exposeInMainWorld("equinoxShell", Object.freeze({
        getLanguage: () => {
            const language = ipcRenderer.sendSync("equinox-shell:language-snapshot");
            return language === "tr" ? "tr" : language === "en" ? "en" : null;
        },
        pickFolder: () => ipcRenderer.invoke("equinox-shell:pick-folder"),
        copyText: (value) => ipcRenderer.invoke("equinox-shell:copy-text", value),
        getChatIdentity: () => ipcRenderer.invoke("equinox-shell:chat-identity"),
        setChatAgentName: (value) => ipcRenderer.invoke("equinox-shell:chat-agent-name", value),
        chooseChatAvatar: () => ipcRenderer.invoke("equinox-shell:chat-avatar-choose"),
        removeChatAvatar: () => ipcRenderer.invoke("equinox-shell:chat-avatar-remove"),
        getCompanionId: () => {
            const id = ipcRenderer.sendSync("equinox-shell:companion-snapshot");
            return isCompanionId(id) ? id : "nyx";
        },
        setChatAccent: (value) => ipcRenderer.invoke("equinox-shell:chat-accent", value),
        setCompanionId: (id) => {
            if (!isCompanionId(id))
                return Promise.resolve(false);
            return ipcRenderer.invoke("equinox-shell:companion-select", id);
        },
        onCompanionChanged: (callback) => {
            if (typeof callback !== "function")
                return () => { };
            const listener = (_event, id) => {
                if (isCompanionId(id))
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
