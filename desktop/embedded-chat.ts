import { BaseWindow, WebContentsView, dialog, nativeTheme, session, shell } from "electron";
import path from "node:path";

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

// Only open real web URLs from provider links. The remote page cannot ask the
// host to open local files, custom URI schemes or loopback services.
function permittedExternalLink(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return null;
    if (!url.hostname.includes(".")) return null;
    return url.href;
  } catch {
    return null;
  }
}

// Keep ChatGPT's own theme, model controls and DOM logic intact. Only add
// low-impact Equinox visual affordances that survive Free and paid accounts.
const STYLE = [
  "::selection { background: rgba(105,84,184,.24) !important; }",
  ":focus-visible { outline: 2px solid #8e77da !important; outline-offset: 2px !important; }",
  "aside.app-shell-left-panel { border-inline-end: 1px solid rgba(130,112,191,.22) !important; }",
].join("\n");

const TOOLBAR_ACTIONS = new Set(["back", "forward", "reload", "home", "microphone"]);
const TOOLBAR_ACTION_ORIGIN = "https://preview.equinox.invalid";

function toolbarMarkup(language: "en" | "tr"): string {
  const labels = language === "tr"
    ? { back: "Geri", forward: "İleri", reload: "Yenile", home: "Ana sayfa", microphone: "Mikrofon izni", preview: "Deneysel önizleme" }
    : { back: "Back", forward: "Forward", reload: "Reload", home: "Home", microphone: "Microphone permission", preview: "Experimental preview" };
  const link = (action: string, icon: string, label: string): string =>
    `<a class="action" href="${TOOLBAR_ACTION_ORIGIN}/${action}" target="_blank" rel="noopener" aria-label="${label}" title="${label}">${icon}</a>`;
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
*{box-sizing:border-box}html,body{margin:0;height:100%;overflow:hidden}
:root{color-scheme:light;--eq-surface:#fff;--eq-line:#e5e3e9;--eq-text:#282432;
--eq-muted:#615d6c;--eq-accent:#6954b8;--eq-soft:#f0ecfa}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--eq-surface:#242429;--eq-line:#41404a;
--eq-text:#f0edf5;--eq-muted:#c4bdce;--eq-accent:#c3b2fa;--eq-soft:#3b3252}}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--eq-surface);color:var(--eq-text)}
header{height:52px;display:flex;align-items:center;gap:13px;padding:0 17px;
  border-bottom:1px solid var(--eq-line);
  background:linear-gradient(100deg,color-mix(in srgb,var(--eq-accent) 5%,var(--eq-surface)),var(--eq-surface) 46%)}
.brand{display:flex;gap:9px;align-items:center;min-width:0}
.mark{width:28px;height:28px;display:grid;place-items:center;border-radius:9px;
  background:linear-gradient(145deg,#9076d7,#6954b8);color:#fff;font-weight:800;font-size:13px;box-shadow:0 1px 5px #6954b826}
.name{font-size:12px;font-weight:760;letter-spacing:.105em;color:var(--eq-text)}
.separator{height:18px;width:1px;background:var(--eq-line);margin-left:2px}
.product{font-size:12px;font-weight:570;color:var(--eq-muted);white-space:nowrap}
.preview{font-size:10px;border:1px solid color-mix(in srgb,var(--eq-accent) 25%,var(--eq-line));
  border-radius:40px;background:var(--eq-soft);color:var(--eq-accent);padding:4px 8px;white-space:nowrap}
nav{margin-left:auto;display:flex;align-items:center;gap:5px}
.action{width:31px;height:29px;display:grid;place-items:center;border-radius:8px;text-decoration:none;
color:var(--eq-muted);font-size:18px;line-height:1;border:1px solid transparent;transition:background .12s,border-color .12s}
.action:hover{background:var(--eq-soft);border-color:color-mix(in srgb,var(--eq-accent) 22%,var(--eq-line));color:var(--eq-accent)}
.action:focus-visible{outline:2px solid var(--eq-accent);outline-offset:2px}
.action:active{background:var(--eq-soft);color:var(--eq-accent)}
.action svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
nav .action:last-child{margin-left:7px;border-left:1px solid var(--eq-line);border-radius:0 8px 8px 0;padding-left:7px;width:38px}
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
${link("microphone", '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 17v5m-4 0h8"/></svg>', labels.microphone)}
</nav></header></body></html>`;
}

export function openEmbeddedChatPilot(language: "en" | "tr" = "en"): void {
  if (host && !host.isDestroyed()) { host.show(); host.focus(); return; }
  const isolated = session.fromPartition("persist:equinox-chatgpt-web-pilot");
  // Electron's default UA adds a non-browser product token to the actual
  // Chromium build. Use that Chromium build's normal browser UA for this
  // single provider-only partition, including service-worker requests.
  // No OS, Chromium version, credentials or request header is invented.
  const providerUserAgent = isolated.getUserAgent().replace(/\sElectron\/[^\s]+(?=\s|$)/, "");
  isolated.setUserAgent(providerUserAgent);
  const win = new BaseWindow({
    title: "Equinox · ChatGPT Web (experimental)", width: 1180, height: 790,
    minWidth: 700, minHeight: 520, show: true, backgroundColor: nativeTheme.shouldUseDarkColors ? "#242429" : "#f7f7f5",
  });
  // The provider and toolbar react to theme changes automatically, but a
  // BaseWindow's backing color is fixed unless we update it explicitly.
  // Keep the exposed window background aligned during system auto-switches.
  const syncWindowBackground = () => {
    if (!win.isDestroyed()) {
      win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#242429" : "#f7f7f5");
    }
  };
  nativeTheme.on("updated", syncWindowBackground);
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
  const approvedFileWrites = new Set<string>();
  const askMicrophonePermission = async (): Promise<boolean> => {
    if (microphoneGranted) return true;
    if (microphonePromptOpen || win.isDestroyed()) return false;
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
    } catch {
      return false;
    } finally {
      microphonePromptOpen = false;
    }
  };
  const isProviderView = (contents: { id: number } | null, origin: string): boolean =>
    contents?.id === view.webContents.id && isChatGPTOrigin(origin);
  isolated.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (!isProviderView(contents, requestingOrigin)) return false;
    if (permission === "clipboard-sanitized-write") return true;
    if (permission === "fileSystem") {
      return details.fileAccessType === "writable" && !details.isDirectory &&
        !!details.filePath && approvedFileWrites.has(details.filePath);
    }
    return permission === "media" && microphoneGranted && details.mediaType === "audio";
  });
  isolated.setPermissionRequestHandler((contents, permission, reply, details) => {
    if (!isProviderView(contents, details.requestingUrl)) { reply(false); return; }
    if (permission === "clipboard-sanitized-write") { reply(true); return; }
    if (permission === "fileSystem") {
      const request = details as Electron.FilesystemPermissionRequest;
      const file = request.filePath;
      if (request.fileAccessType !== "writable" || request.isDirectory ||
          !file || !path.isAbsolute(file)) { reply(false); return; }
      if (approvedFileWrites.has(file)) { reply(true); return; }
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
        if (accepted) approvedFileWrites.add(file);
        reply(accepted);
      }).catch(() => reply(false));
      return;
    }
    if (permission !== "media") { reply(false); return; }
    const mediaTypes = "mediaTypes" in details ? details.mediaTypes : undefined;
    if (!mediaTypes || mediaTypes.length !== 1 || mediaTypes[0] !== "audio") {
      reply(false);
      return;
    }
    void askMicrophonePermission().then(reply).catch(() => reply(false));
  });

  // A real file chooser can attach files; downloaded ChatGPT attachments must
  // additionally use Electron's native Save dialog rather than a silent path.
  const onDownload = (
    event: Electron.Event, item: Electron.DownloadItem, contents: Electron.WebContents,
  ): void => {
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
        if (action === "microphone") {
          void askMicrophonePermission().then(granted => {
            if (granted && !view.webContents.isDestroyed()) view.webContents.reload();
          });
        }
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
  // A provider link opens inside this webview if it is a supported provider
  // origin; otherwise open the person's normal browser only after an explicit
  // native confirmation. Never grant remote content shell/OS or Equinox IPC.
  let externalPromptOpen = false;
  const offerExternalLink = (value: string): void => {
    if (externalPromptOpen || win.isDestroyed()) return;
    const destination = permittedExternalLink(value);
    if (!destination) return;
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
      if (response !== 0 || win.isDestroyed()) return;
      void shell.openExternal(destination).catch(() => {});
    }).catch(() => {}).finally(() => { externalPromptOpen = false; });
  };
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isEmbeddedGoogleAuth(url)) warnGoogleRestriction(win, language);
    else if (admitted(url)) void view.webContents.loadURL(url).catch(() => {});
    else offerExternalLink(url);
    return { action: "deny" };
  });
  view.webContents.on("will-navigate", (event, url) => {
    if (admitted(url)) return;
    event.preventDefault();
    if (isEmbeddedGoogleAuth(url)) warnGoogleRestriction(win, language);
    else offerExternalLink(url);
  });
  // A redirect is not an intentional external-link click. Block it without
  // showing an external-launch prompt.
  view.webContents.on("will-redirect", (event, url) => {
    if (!admitted(url)) {
      event.preventDefault();
      if (isEmbeddedGoogleAuth(url)) warnGoogleRestriction(win, language);
    }
  });
  view.webContents.on("did-finish-load", () => {
    if (view.webContents.isDestroyed()) return;
    try {
      if (new URL(view.webContents.getURL()).origin === CHATGPT) {
        void view.webContents.insertCSS(STYLE).catch(() => {});
      }
    } catch { /* Ignore intermediate navigation state. */ }
  });
  win.on("closed", () => {
    nativeTheme.removeListener("updated", syncWindowBackground);
    microphoneGranted = false;
    microphonePromptOpen = false;
    approvedFileWrites.clear();
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
