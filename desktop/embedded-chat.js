import { BaseWindow, WebContentsView, session } from "electron";
// Explicitly isolated remote browser. No privileged Equinox preload or IPC.
const CHATGPT = "https://chatgpt.com";
const HOSTS = new Set(["chatgpt.com", "auth.openai.com", "accounts.google.com"]);
let host = null;
function admitted(value) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password &&
            !url.port && HOSTS.has(url.hostname);
    }
    catch {
        return false;
    }
}
const STYLE = [
    "::selection { background: rgba(255,79,216,.3) !important; }",
    ":focus-visible { outline-color: #ff4fd8 !important; }",
].join("\n");
export function openEmbeddedChatPilot() {
    if (host && !host.isDestroyed()) {
        host.show();
        host.focus();
        return;
    }
    const isolated = session.fromPartition("persist:equinox-chatgpt-web-pilot");
    isolated.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    isolated.setPermissionCheckHandler(() => false);
    const win = new BaseWindow({
        title: "Equinox · ChatGPT Web (experimental)", width: 1180, height: 790,
        minWidth: 700, minHeight: 520, show: true, backgroundColor: "#17171d",
    });
    const view = new WebContentsView({
        webPreferences: {
            session: isolated, sandbox: true, contextIsolation: true,
            nodeIntegration: false, nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false, webviewTag: false,
            webSecurity: true, allowRunningInsecureContent: false,
            spellcheck: true, devTools: false,
        },
    });
    host = win;
    win.contentView.addChildView(view);
    const fit = () => {
        if (win.isDestroyed())
            return;
        const [width, height] = win.getContentSize();
        view.setBounds({ x: 0, y: 0, width: width ?? 1180, height: height ?? 790 });
    };
    fit();
    win.on("resize", fit);
    // This PoC does not attempt to bypass Google OAuth embedded-login policy.
    // Neither popup navigation nor other hosts get a privileged browsing context.
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("will-navigate", (event, url) => {
        if (!admitted(url))
            event.preventDefault();
    });
    view.webContents.on("will-redirect", (event, url) => {
        if (!admitted(url))
            event.preventDefault();
    });
    view.webContents.on("did-finish-load", () => {
        if (view.webContents.isDestroyed())
            return;
        try {
            if (new URL(view.webContents.getURL()).origin === CHATGPT) {
                void view.webContents.insertCSS(STYLE).catch(() => { });
            }
        }
        catch { /* Ignore intermediate navigation state. */ }
    });
    win.on("closed", () => {
        if (!view.webContents.isDestroyed())
            view.webContents.close();
        if (host === win)
            host = null;
    });
    void view.webContents.loadURL(CHATGPT + "/").catch(() => { });
}
export function closeEmbeddedChatPilot() {
    if (host && !host.isDestroyed())
        host.close();
    host = null;
}
