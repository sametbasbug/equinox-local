import { BaseWindow, WebContentsView, dialog, session } from "electron";
// Explicitly isolated remote browser. No privileged Equinox preload or IPC.
const CHATGPT = "https://chatgpt.com";
const HOSTS = new Set(["chatgpt.com", "auth.openai.com"]);
let host = null;
let googleNoticeOpen = false;
function isEmbeddedGoogleAuth(value) {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname === "accounts.google.com";
    }
    catch {
        return false;
    }
}
function warnGoogleRestriction(win, language) {
    if (googleNoticeOpen || win.isDestroyed())
        return;
    googleNoticeOpen = true;
    void dialog.showMessageBox(win, {
        type: "info",
        title: language === "tr" ? "Google ile giriş burada desteklenmiyor" : "Google sign-in is unavailable here",
        message: language === "tr"
            ? "Google hesabıyla giriş bu gömülü pencerede desteklenmiyor."
            : "Google sign-in is not supported inside this embedded window.",
        detail: language === "tr"
            ? "Google, uygulama içindeki gömülü tarayıcılarda OAuth girişine izin vermiyor. Bu önizleme Chrome'dan ayrı bir oturum kullanır. ChatGPT hesabın doğrudan e-posta girişini destekliyorsa o yöntemi deneyebilirsin."
            : "Google disallows OAuth authorization in embedded browsers. This preview uses an isolated session, so signing in through Chrome will not sign in here automatically. If your ChatGPT account supports direct email sign-in, use that method instead.",
        buttons: ["OK"],
        defaultId: 0,
        noLink: true,
    }).catch(() => { }).finally(() => { googleNoticeOpen = false; });
}
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
export function openEmbeddedChatPilot(language = "en") {
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
    // The website's Google button must not send credentials through an embedded
    // user agent. Surface the actual OAuth policy limitation instead of evading it.
    // All other popups are denied; remote content never receives Equinox IPC.
    view.webContents.setWindowOpenHandler(({ url }) => {
        if (isEmbeddedGoogleAuth(url))
            warnGoogleRestriction(win, language);
        return { action: "deny" };
    });
    const authorizeNavigation = (event, url) => {
        if (!admitted(url)) {
            event.preventDefault();
            if (isEmbeddedGoogleAuth(url))
                warnGoogleRestriction(win, language);
        }
    };
    view.webContents.on("will-navigate", authorizeNavigation);
    view.webContents.on("will-redirect", authorizeNavigation);
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
