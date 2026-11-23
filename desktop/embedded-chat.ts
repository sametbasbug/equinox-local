import { BaseWindow, WebContentsView, dialog, session } from "electron";

// Explicitly isolated remote browser. No privileged Equinox preload or IPC.
const CHATGPT = "https://chatgpt.com";
const HOSTS = new Set(["chatgpt.com", "auth.openai.com"]);
let host: BaseWindow | null = null;
let googleNoticeOpen = false;

function isEmbeddedGoogleAuth(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "accounts.google.com";
  } catch { return false; }
}

function warnGoogleRestriction(win: BaseWindow, language: "en" | "tr"): void {
  if (googleNoticeOpen || win.isDestroyed()) return;
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
  }).catch(() => {}).finally(() => { googleNoticeOpen = false; });
}

function isChatGPTOrigin(value: string): boolean {
  try {
    return new URL(value).origin === CHATGPT;
  } catch {
    return false;
  }
}

function admitted(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.port && HOSTS.has(url.hostname);
  } catch { return false; }
}

// Keep ChatGPT's own theme, model controls and DOM logic intact. Only add
// low-impact Equinox visual affordances that survive Free and paid accounts.
const STYLE = [
  "::selection { background: rgba(105,84,184,.24) !important; }",
  ":focus-visible { outline: 2px solid #8e77da !important; outline-offset: 2px !important; }",
  "aside.app-shell-left-panel { border-inline-end: 1px solid rgba(130,112,191,.22) !important; }",
].join("\n");

const TOOLBAR_ACTIONS = new Set(["back", "forward", "reload", "home"]);
const TOOLBAR_ACTION_ORIGIN = "https://preview.equinox.invalid";

function toolbarMarkup(language: "en" | "tr"): string {
  const labels = language === "tr"
    ? { back: "Geri", forward: "İleri", reload: "Yenile", home: "Ana sayfa", preview: "Deneysel önizleme" }
    : { back: "Back", forward: "Forward", reload: "Reload", home: "Home", preview: "Experimental preview" };
  const link = (action: string, icon: string, label: string): string =>
    `<a class="action" href="${TOOLBAR_ACTION_ORIGIN}/${action}" target="_blank" rel="noopener" aria-label="${label}" title="${label}">${icon}</a>`;
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#19191d;color:#f1f0f5}
header{height:52px;display:flex;align-items:center;gap:14px;padding:0 17px;
  border-bottom:1px solid #41404a;background:linear-gradient(105deg,#26232f 0%,#1b1a20 55%,#19191d 100%)}
.brand{display:flex;gap:10px;align-items:center;min-width:0}
.mark{width:29px;height:29px;display:grid;place-items:center;border-radius:9px;
  background:linear-gradient(145deg,#a58cf4,#6554a8);color:#fff;font-weight:800;font-size:14px;box-shadow:0 2px 12px #9e7dec26}
.name{font-size:12px;font-weight:760;letter-spacing:.115em;color:#f8f6ff}
.separator{height:18px;width:1px;background:#585363;margin-left:2px}
.product{font-size:12px;font-weight:570;color:#d9d5e6;white-space:nowrap}
.preview{font-size:10px;border:1px solid #625677;border-radius:40px;background:#393245;
color:#d6c6ff;padding:4px 8px;white-space:nowrap}
nav{margin-left:auto;display:flex;align-items:center;gap:5px}
.action{width:31px;height:29px;display:grid;place-items:center;border-radius:8px;text-decoration:none;
color:#d1cadd;font-size:18px;line-height:1;border:1px solid transparent;transition:background .12s,border-color .12s}
.action:hover{background:#393643;border-color:#625b71;color:#fff}
.action:focus-visible{outline:2px solid #c3b2fa;outline-offset:2px}
.action:active{background:#544967}
@media(max-width:650px){.preview,.separator{display:none}.product{font-size:11px}header{gap:9px;padding:0 10px}}
@media(prefers-reduced-motion:reduce){.action{transition:none}}
</style></head><body><header>
<div class="brand"><span class="mark" aria-hidden="true">E</span><span class="name">EQUINOX</span></div>
<span class="separator"></span><span class="product">ChatGPT Web</span><span class="preview">${labels.preview}</span>
<nav aria-label="Navigation">
${link("back", "&#x2039;", labels.back)}
${link("forward", "&#x203A;", labels.forward)}
${link("reload", "&#x21bb;", labels.reload)}
${link("home", "&#x2302;", labels.home)}
</nav></header></body></html>`;
}

export function openEmbeddedChatPilot(language: "en" | "tr" = "en"): void {
  if (host && !host.isDestroyed()) { host.show(); host.focus(); return; }
  const isolated = session.fromPartition("persist:equinox-chatgpt-web-pilot");
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
  // Only this exact provider view can request a basic clipboard write or an
  // audio-only microphone grant. No camera, screen capture, clipboard read,
  // notifications, or arbitrary-origin permission escalation is permitted.
  let microphoneGranted = false;
  const isProviderView = (contents: { id: number } | null, origin: string): boolean =>
    contents?.id === view.webContents.id && isChatGPTOrigin(origin);
  isolated.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (!isProviderView(contents, requestingOrigin)) return false;
    if (permission === "clipboard-sanitized-write") return true;
    return permission === "media" && microphoneGranted && details.mediaType === "audio";
  });
  isolated.setPermissionRequestHandler((contents, permission, reply, details) => {
    if (!isProviderView(contents, details.requestingUrl)) { reply(false); return; }
    if (permission === "clipboard-sanitized-write") { reply(true); return; }
    if (permission !== "media") { reply(false); return; }
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    if (!mediaTypes || mediaTypes.length !== 1 || mediaTypes[0] !== "audio") {
      reply(false);
      return;
    }
    if (microphoneGranted) { reply(true); return; }
    void dialog.showMessageBox(win, {
      type: "question",
      title: language === "tr" ? "ChatGPT mikrofon izni" : "ChatGPT microphone access",
      message: language === "tr"
        ? "ChatGPT'nin bu pencerede mikrofonu kullanmasına izin verilsin mi?"
        : "Allow ChatGPT to use your microphone in this window?",
      detail: language === "tr"
        ? "Yalnızca bu ChatGPT oturumuna ve mikrofon sesine izin verilir. Kamera, ekran paylaşımı ve diğer siteler engellenmeye devam eder."
        : "Only this ChatGPT view and microphone audio are permitted. Camera, screen sharing and other sites remain blocked.",
      buttons: language === "tr" ? ["İzin ver", "Şimdi değil"] : ["Allow", "Not now"],
      defaultId: 1, cancelId: 1, noLink: true,
    }).then(({ response }) => {
      microphoneGranted = response === 0 && !win.isDestroyed() && !view.webContents.isDestroyed();
      reply(microphoneGranted);
    }).catch(() => reply(false));
  });

  // A real file chooser can attach files; downloaded ChatGPT attachments must
  // additionally use Electron's native Save dialog rather than a silent path.
  const onDownload = (
    event: Electron.Event, item: Electron.DownloadItem, contents: Electron.WebContents,
  ): void => {
    if (contents.id !== view.webContents.id || !isChatGPTOrigin(item.getInitiatorOrigin())) {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({
      title: language === "tr" ? "ChatGPT dosyasını kaydet" : "Save ChatGPT download",
    });
  };
  isolated.on("will-download", onDownload);

  // Own the chrome, but never mirror or reimplement any of ChatGPT's
  // account-specific model / effort / project / tool controls.
  const bar = new WebContentsView({ webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    webviewTag: false, devTools: false,
  } });
  bar.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.origin === TOOLBAR_ACTION_ORIGIN && TOOLBAR_ACTIONS.has(target.pathname.slice(1))) {
        const action = target.pathname.slice(1);
        if (action === "back" && view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack();
        if (action === "forward" && view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward();
        if (action === "reload") view.webContents.reload();
        if (action === "home") void view.webContents.loadURL(CHATGPT + "/").catch(() => {});
      }
    } catch { /* Toolbar cannot navigate the provider or execute code. */ }
    return { action: "deny" };
  });
  bar.webContents.on("will-navigate", event => event.preventDefault());
  host = win;
  win.contentView.addChildView(bar);
  win.contentView.addChildView(view);
  const fit = () => {
    if (win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    bar.setBounds({ x: 0, y: 0, width: width ?? 1180, height: 52 });
    view.setBounds({ x: 0, y: 52, width: width ?? 1180, height: Math.max(0, (height ?? 790) - 52) });
  };
  fit(); win.on("resize", fit);
  void bar.webContents.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(toolbarMarkup(language))).catch(() => {});
  // The website's Google button must not send credentials through an embedded
  // user agent. Surface the actual OAuth policy limitation instead of evading it.
  // All other popups are denied; remote content never receives Equinox IPC.
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isEmbeddedGoogleAuth(url)) warnGoogleRestriction(win, language);
    return { action: "deny" };
  });
  const authorizeNavigation = (event: { preventDefault(): void }, url: string): void => {
    if (!admitted(url)) {
      event.preventDefault();
      if (isEmbeddedGoogleAuth(url)) warnGoogleRestriction(win, language);
    }
  };
  view.webContents.on("will-navigate", authorizeNavigation);
  view.webContents.on("will-redirect", authorizeNavigation);
  view.webContents.on("did-finish-load", () => {
    if (view.webContents.isDestroyed()) return;
    try {
      if (new URL(view.webContents.getURL()).origin === CHATGPT) {
        void view.webContents.insertCSS(STYLE).catch(() => {});
      }
    } catch { /* Ignore intermediate navigation state. */ }
  });
  win.on("closed", () => {
    microphoneGranted = false;
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    isolated.removeListener("will-download", onDownload);
    if (!view.webContents.isDestroyed()) view.webContents.close();
    if (!bar.webContents.isDestroyed()) bar.webContents.close();
    if (host === win) host = null;
  });
  void view.webContents.loadURL(CHATGPT + "/").catch(() => {});
}

export function closeEmbeddedChatPilot(): void {
  if (host && !host.isDestroyed()) host.close();
  host = null;
}
