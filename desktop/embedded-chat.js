import { WebContentsView, dialog, nativeTheme, session, shell } from "electron";
import path from "node:path";
// Explicitly isolated remote browser. No privileged Equinox preload or IPC.
const CHATGPT = "https://chatgpt.com";
const HOSTS = new Set(["chatgpt.com", "auth.openai.com"]);
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
            ? "Google, uygulama içindeki gömülü tarayıcılarda OAuth girişine izin vermiyor. Chat görünümü Chrome'dan ayrı bir oturum kullanır. ChatGPT hesabın doğrudan e-posta girişini destekliyorsa o yöntemi deneyebilirsin."
            : "Google disallows OAuth authorization in embedded browsers. This Chat view uses an isolated session, so signing in through Chrome will not sign in here automatically. If your ChatGPT account supports direct email sign-in, use that method instead.",
        buttons: ["OK"],
        defaultId: 0,
        noLink: true,
    }).catch(() => { }).finally(() => { googleNoticeOpen = false; });
}
function isChatGPTOrigin(value) {
    try {
        return new URL(value).origin === CHATGPT;
    }
    catch {
        return false;
    }
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
// Only open real web URLs from provider links. The remote page cannot ask the
// host to open local files, custom URI schemes or loopback services.
function permittedExternalLink(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.port)
            return null;
        if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
            return null;
        if (!url.hostname.includes("."))
            return null;
        return url.href;
    }
    catch {
        return null;
    }
}
// Appearance only. These selectors use observed provider layout attributes and
// semantic class names; no provider action is replaced or programmatically invoked.
const STYLE = String.raw `
html.chatgpt-theme {
  --eq-canvas: #fafafb;
  --eq-sidebar: #f5f5f7;
  --eq-paper: #ffffff;
  --eq-border: #e1e0e5;
  --eq-text: #242329;
  --eq-secondary: #66646d;
  --eq-muted: #82808a;
  --eq-accent: #6954b8;
  --eq-active: #eae6f3;
  --eq-bubble: #eeebf5;
  --eq-bubble-text: #30283e;
  --eq-composer-shadow: 0 2px 5px #19151d08, 0 7px 28px #19151d06;
  --color-surface: var(--eq-canvas) !important;
  --color-surface-secondary: var(--eq-canvas) !important;
  --color-surface-tertiary: var(--eq-sidebar) !important;
  --color-surface-canvas: var(--eq-sidebar) !important;
  --color-surface-elevated: var(--eq-paper) !important;
  --color-surface-elevated-secondary: var(--eq-paper) !important;
  --color-surface-card: var(--eq-paper) !important;
  --color-border: var(--eq-border) !important;
  --color-border-subtle: color-mix(in srgb, var(--eq-border) 65%, transparent) !important;
  --color-text: var(--eq-text) !important;
  --color-text-emphasis: var(--eq-text) !important;
  --color-text-secondary: var(--eq-secondary) !important;
  --color-text-tertiary: var(--eq-muted) !important;
  --color-background-user-message: var(--eq-bubble) !important;
  --color-text-user-message: var(--eq-bubble-text) !important;
  --color-background-composer-surface: var(--eq-paper) !important;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  html.chatgpt-theme {
    --eq-canvas: #1c1c20;
    --eq-sidebar: #202025;
    --eq-paper: #27272d;
    --eq-border: #38363f;
    --eq-text: #eeedf2;
    --eq-secondary: #b6b3bf;
    --eq-muted: #96939f;
    --eq-accent: #b9a7f3;
    --eq-active: #383143;
    --eq-bubble: #363040;
    --eq-bubble-text: #f0eaf9;
    --eq-composer-shadow: 0 2px 5px #0003, 0 7px 28px #0002;
    color-scheme: dark;
  }
}
html.chatgpt-theme body { background: var(--eq-canvas) !important; color: var(--eq-text); }
html.chatgpt-theme ::selection { background: color-mix(in srgb, var(--eq-accent) 25%, transparent); }
html.chatgpt-theme :focus-visible { outline-color: var(--eq-accent); }
/* Keep the real search, account, projects, history, and feature actions.
   The provider's own collapse and mobile layout still decide visibility. */
html.chatgpt-theme aside[data-app-shell-left-panel-appearance] {
  background: var(--eq-sidebar) !important;
  border-inline-end: 1px solid var(--eq-border) !important;
}
html.chatgpt-theme #app-shell-sidebar,
html.chatgpt-theme #app-shell-sidebar > .bg-surface { background: var(--eq-sidebar) !important; }
@media (min-width: 769px) {
  html.chatgpt-theme [data-app-shell-frame][data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="false"] {
    --app-shell-left-panel-width: 244px !important;
  }
  html.chatgpt-theme [data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="false"] aside[data-app-shell-left-panel-appearance] > div:first-child {
    width: 244px !important;
    min-width: 244px !important;
    max-width: 100% !important;
  }
}
html.chatgpt-theme #app-shell-sidebar :is(button,a)[aria-current="page"],
html.chatgpt-theme #app-shell-sidebar :is(button,a)[data-selected] {
  background-color: var(--eq-active) !important;
}
html.chatgpt-theme #app-shell-sidebar :is(button,a) { border-radius: 7px; }
/* Real conversation content, not a projected second message tree. */
html.chatgpt-theme .bg-user-message.text-user-message {
  background: var(--eq-bubble) !important;
  color: var(--eq-bubble-text) !important;
  border-radius: 14px !important;
}
html.chatgpt-theme [data-virtualized-turn-content] .markdown :is(pre,table) {
  border-radius: 9px;
}
html.chatgpt-theme [data-app-shell-titlebar] { border-bottom: 1px solid var(--color-border-subtle); }
/* The same native input, attachment and action controls stay mounted. A
   two-row editor matches the Codex reference in both new and ongoing chats. */
html.chatgpt-theme form[data-chatgpt-composer] [class*="ComposerSurface-"] {
  background: var(--eq-paper) !important;
  border: 1px solid var(--eq-border) !important;
  border-radius: 19px !important;
  box-shadow: var(--eq-composer-shadow) !important;
  --composer-layout-surface-background: var(--eq-paper);
}
html.chatgpt-theme form[data-chatgpt-composer] [data-composer-body]:has([data-composer-footer-responsive][data-composer-rows="responsive"]) {
  height: auto !important;
}
html.chatgpt-theme form[data-chatgpt-composer] [data-composer-footer-responsive][data-composer-rows="responsive"] {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) auto !important;
  grid-template-rows: minmax(48px, auto) auto !important;
  align-items: center;
  gap: 2px 8px !important;
  padding: 8px 9px !important;
  height: auto !important;
}
html.chatgpt-theme [data-composer-footer-responsive][data-composer-rows="responsive"] > [class*="FooterInput-"] {
  grid-column: 1 / -1 !important;
  grid-row: 1 !important;
  align-self: stretch;
  min-width: 0;
  padding: 5px 8px;
}
html.chatgpt-theme [data-composer-footer-responsive][data-composer-rows="responsive"] > [data-composer-leading-controls] {
  grid-column: 1 !important;
  grid-row: 2 !important;
  justify-self: start;
}
html.chatgpt-theme [data-composer-footer-responsive][data-composer-rows="responsive"] > [data-composer-trailing-controls] {
  grid-column: 2 !important;
  grid-row: 2 !important;
  justify-self: end;
  background: transparent !important;
}
html.chatgpt-theme [data-composer-footer-responsive][data-composer-rows="responsive"] > [data-composer-expansion-control] {
  grid-column: 2 !important;
  grid-row: 1 !important;
  align-self: start;
  justify-self: end;
}
html.chatgpt-theme [data-composer-footer-responsive][data-composer-rows="responsive"] .ProseMirror {
  min-height: 40px;
}
/* Position the new-chat composer toward the bottom, while retaining real
   greeting/suggestion regions and their scroll/expanded-state behavior. */
@media (min-height: 460px) and (min-width: 640px) {
  html.chatgpt-theme [class~="group/home-composer-layout"]:not(:has([data-composer-expanded])):has(form[data-composer-placement="home"]) [class*="StreamedComposer-"] {
    grid-template-rows: minmax(0,1fr) auto auto !important;
    padding-bottom: 16px;
  }
  html.chatgpt-theme [class~="group/home-composer-layout"]:not(:has([data-composer-expanded])) [class*="GreetingRegion-"] { justify-content: center !important; }
  html.chatgpt-theme [class~="group/home-composer-layout"] [class*="Greeting-"] { align-items: center; }
}
`;
// The provider is a child of the existing trusted Control Center window.
// Its separate session and webPreferences never receive the Control Center preload.
export function createEmbeddedChat(win, initialLanguage = "en") {
    let language = initialLanguage;
    const isolated = session.fromPartition("persist:equinox-chatgpt-web-pilot");
    // Electron's default UA adds a non-browser product token to the actual
    // Chromium build. Use that Chromium build's normal browser UA for this
    // single provider-only partition, including service-worker requests.
    // No OS, Chromium version, credentials or request header is invented.
    const providerUserAgent = isolated.getUserAgent().replace(/\sElectron\/[^\s]+(?=\s|$)/, "");
    isolated.setUserAgent(providerUserAgent);
    const view = new WebContentsView({
        webPreferences: {
            session: isolated, sandbox: true, contextIsolation: true,
            nodeIntegration: false, nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false, webviewTag: false,
            webSecurity: true, allowRunningInsecureContent: false,
            spellcheck: true, devTools: false,
        },
    });
    // Only this exact provider view can request a basic clipboard write or an
    // audio-only microphone grant. No camera, screen capture, clipboard read,
    // notifications, or arbitrary-origin permission escalation is permitted.
    let microphoneGranted = false;
    let microphonePromptOpen = false;
    const approvedFileWrites = new Set();
    const askMicrophonePermission = async () => {
        if (microphoneGranted)
            return true;
        if (microphonePromptOpen || win.isDestroyed())
            return false;
        microphonePromptOpen = true;
        try {
            const { response } = await dialog.showMessageBox(win, {
                type: "question",
                title: language === "tr" ? "ChatGPT mikrofon izni" : "ChatGPT microphone access",
                message: language === "tr"
                    ? "ChatGPT'nin bu pencerede mikrofonu kullanmasına izin verilsin mi?"
                    : "Allow ChatGPT to use your microphone in this window?",
                detail: language === "tr"
                    ? "Yalnızca bu pencerede geçerlidir. İzin verirsen ChatGPT sayfası yenilenir ve sesli görüşme başlattığında mikrofon etkinleşebilir. Kamera ve ekran paylaşımı engelli kalır."
                    : "This applies only to this window. The ChatGPT page reloads after approval and may use your microphone when you start voice. Camera and screen capture remain blocked.",
                buttons: language === "tr" ? ["İzin ver", "Vazgeç"] : ["Allow", "Cancel"],
                defaultId: 1, cancelId: 1, noLink: true,
            });
            microphoneGranted = response === 0 && !win.isDestroyed() && !view.webContents.isDestroyed();
            return microphoneGranted;
        }
        catch {
            return false;
        }
        finally {
            microphonePromptOpen = false;
        }
    };
    const isProviderView = (contents, origin) => contents?.id === view.webContents.id && isChatGPTOrigin(origin);
    isolated.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
        if (!isProviderView(contents, requestingOrigin))
            return false;
        if (permission === "clipboard-sanitized-write")
            return true;
        if (permission === "fileSystem") {
            return details.fileAccessType === "writable" && !details.isDirectory &&
                !!details.filePath && approvedFileWrites.has(details.filePath);
        }
        return permission === "media" && microphoneGranted && details.mediaType === "audio";
    });
    isolated.setPermissionRequestHandler((contents, permission, reply, details) => {
        if (!isProviderView(contents, details.requestingUrl)) {
            reply(false);
            return;
        }
        if (permission === "clipboard-sanitized-write") {
            reply(true);
            return;
        }
        if (permission === "fileSystem") {
            const request = details;
            const file = request.filePath;
            if (request.fileAccessType !== "writable" || request.isDirectory ||
                !file || !path.isAbsolute(file)) {
                reply(false);
                return;
            }
            if (approvedFileWrites.has(file)) {
                reply(true);
                return;
            }
            // Chromium's File System Access API has its own permission gate,
            // distinct from Electron's ordinary will-download Save dialog.
            void dialog.showMessageBox(win, {
                type: "question",
                title: language === "tr" ? "ChatGPT dosya kaydetme izni" : "ChatGPT save-file permission",
                message: language === "tr"
                    ? "ChatGPT'nin seçilen dosyaya yazmasına izin verilsin mi?"
                    : "Allow ChatGPT to write to the selected file?",
                detail: file,
                buttons: language === "tr" ? ["İzin ver", "Vazgeç"] : ["Allow", "Cancel"],
                defaultId: 1, cancelId: 1, noLink: true,
            }).then(({ response }) => {
                const accepted = response === 0 && !win.isDestroyed() && !view.webContents.isDestroyed();
                if (accepted)
                    approvedFileWrites.add(file);
                reply(accepted);
            }).catch(() => reply(false));
            return;
        }
        if (permission !== "media") {
            reply(false);
            return;
        }
        const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
        if (!mediaTypes || mediaTypes.length !== 1 || mediaTypes[0] !== "audio") {
            reply(false);
            return;
        }
        void askMicrophonePermission().then(reply).catch(() => reply(false));
    });
    // A real file chooser can attach files; downloaded ChatGPT attachments must
    // additionally use Electron's native Save dialog rather than a silent path.
    const onDownload = (event, item, contents) => {
        // CDN/blob download URLs may differ from the provider's origin. Electron
        // explicitly documents getInitiatorOrigin() as the security identity.
        // Never trust top-level WebContents alone: untrusted subframes could
        // otherwise initiate their own file downloads under ChatGPT's page.
        if (contents.id !== view.webContents.id || !isChatGPTOrigin(contents.getURL()) ||
            item.getInitiatorOrigin() !== CHATGPT) {
            event.preventDefault();
            return;
        }
        item.setSaveDialogOptions({
            title: language === "tr" ? "ChatGPT dosyasını kaydet" : "Save ChatGPT download",
        });
    };
    isolated.on("will-download", onDownload);
    view.setVisible(false);
    win.contentView.addChildView(view);
    const syncViewBackground = () => {
        if (!view.webContents.isDestroyed())
            view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#242429" : "#f7f7f5");
    };
    syncViewBackground();
    nativeTheme.on("updated", syncViewBackground);
    // A provider link opens inside this webview if it is a supported provider
    // origin; otherwise open the person's normal browser only after an explicit
    // native confirmation. Never grant remote content shell/OS or Equinox IPC.
    let externalPromptOpen = false;
    const offerExternalLink = (value) => {
        if (externalPromptOpen || win.isDestroyed())
            return;
        const destination = permittedExternalLink(value);
        if (!destination)
            return;
        externalPromptOpen = true;
        void dialog.showMessageBox(win, {
            type: "question",
            title: language === "tr" ? "Bağlantıyı tarayıcıda aç" : "Open link in browser",
            message: language === "tr"
                ? "Bu bağlantı varsayılan tarayıcıda açılsın mı?"
                : "Open this link in your default browser?",
            detail: destination.slice(0, 512),
            buttons: language === "tr" ? ["Aç", "Vazgeç"] : ["Open", "Cancel"],
            defaultId: 1, cancelId: 1, noLink: true,
        }).then(({ response }) => {
            if (response !== 0 || win.isDestroyed())
                return;
            void shell.openExternal(destination).catch(() => { });
        }).catch(() => { }).finally(() => { externalPromptOpen = false; });
    };
    view.webContents.setWindowOpenHandler(({ url }) => {
        if (isEmbeddedGoogleAuth(url))
            warnGoogleRestriction(win, language);
        else if (admitted(url))
            void view.webContents.loadURL(url).catch(() => { });
        else
            offerExternalLink(url);
        return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
        if (admitted(url))
            return;
        event.preventDefault();
        if (isEmbeddedGoogleAuth(url))
            warnGoogleRestriction(win, language);
        else
            offerExternalLink(url);
    });
    // A redirect is not an intentional external-link click. Block it without
    // showing an external-launch prompt.
    view.webContents.on("will-redirect", (event, url) => {
        if (!admitted(url)) {
            event.preventDefault();
            if (isEmbeddedGoogleAuth(url))
                warnGoogleRestriction(win, language);
        }
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
    let disposed = false;
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        nativeTheme.removeListener("updated", syncViewBackground);
        microphoneGranted = false;
        microphonePromptOpen = false;
        approvedFileWrites.clear();
        isolated.setPermissionCheckHandler(() => false);
        isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
        isolated.removeListener("will-download", onDownload);
        if (!win.isDestroyed())
            win.contentView.removeChildView(view);
        if (!view.webContents.isDestroyed())
            view.webContents.close();
    };
    win.once("closed", dispose);
    void view.webContents.loadURL(CHATGPT + "/").catch(() => { });
    return {
        setBounds(bounds) {
            if (disposed || view.webContents.isDestroyed())
                return;
            if (!bounds) {
                view.setVisible(false);
                if (view.webContents.isFocused() && !win.isDestroyed())
                    win.webContents.focus();
                return;
            }
            view.setBounds(bounds);
            view.setVisible(true);
        },
        setLanguage(value) { language = value; },
        async requestMicrophone() {
            const granted = await askMicrophonePermission();
            if (granted && !view.webContents.isDestroyed())
                view.webContents.reload();
            return granted;
        },
        dispose,
    };
}
