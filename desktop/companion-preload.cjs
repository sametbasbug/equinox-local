"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron = require("electron");
const { contextBridge, ipcRenderer } = electron;
// The main process additionally binds every command to its exact owned document/main frame.
if (process.isMainFrame && location.protocol === "file:" && location.pathname.endsWith("/desktop/companion.html")
    && /^\?surface=(pet|actions|speech)$/u.test(location.search) && !location.hash) {
    contextBridge.exposeInMainWorld("equinoxCompanion", Object.freeze({
        subscribe(callback) {
            if (typeof callback !== "function")
                return () => { };
            const listener = (_event, snapshot) => callback(snapshot);
            ipcRenderer.on("equinox-companion:snapshot", listener);
            return () => ipcRenderer.removeListener("equinox-companion:snapshot", listener);
        },
        action(value) {
            if (value === "new-chat" || value === "control-center" || value === "hide")
                ipcRenderer.send("equinox-companion:action", value);
        },
        pointer(phase) {
            if (phase === "begin" || phase === "move" || phase === "end" || phase === "cancel")
                ipcRenderer.send("equinox-companion:pointer", phase);
        },
        measureSpeech(id, width, height) {
            if (typeof id === "number" && Number.isSafeInteger(id) && id >= 0
                && typeof width === "number" && Number.isSafeInteger(width) && width >= 1 && width <= 360
                && typeof height === "number" && Number.isSafeInteger(height) && height >= 58 && height <= 512) {
                ipcRenderer.send("equinox-companion:measure-speech", id, width, height);
            }
        },
        activate() { ipcRenderer.send("equinox-companion:activate"); },
    }));
}
