import { createNativeChatContinuity } from "./native-chat-continuity.js";
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
  --eq-canvas: #f8f9fc;
  --eq-sidebar: #eef0f6;
  --eq-paper: #ffffff;
  --eq-editor: #ffffff;
  --eq-border: #e0e4ed;
  --eq-text: #1d2432;
  --eq-secondary: #687083;
  --eq-muted: #8991a1;
  --eq-accent: color-mix(in srgb, var(--eq-user-accent, #8B6CF0) 76%, #252138);
  --eq-composer-ink: #ffffff;
  --eq-send: color-mix(in srgb, var(--eq-user-accent, #8B6CF0) 73%, #27223c);
  --eq-active: color-mix(in srgb, var(--eq-user-accent, #8B6CF0) 11%, #ffffff);
  --eq-bubble: color-mix(in srgb, var(--eq-user-accent, #8B6CF0) 8%, #ffffff);
  --eq-bubble-text: #222435;
  --eq-composer-shadow: 0 2px 4px #18213b08, 0 16px 36px #18213b0d;
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
  --color-background-composer-surface: var(--eq-editor) !important;
  --color-background-composer-primary: var(--eq-send) !important;
  --color-text-composer-primary: var(--eq-composer-ink) !important;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  html.chatgpt-theme {
    --eq-canvas: #12151c;
    --eq-sidebar: #171b24;
    --eq-paper: #1c212c;
    --eq-editor: #202532;
    --eq-border: #343947;
    --eq-text: #ecedf4;
    --eq-secondary: #b5bbc9;
    --eq-muted: #8893a6;
    --eq-accent: color-mix(in srgb, var(--eq-user-accent, #8B6CF0) 72%, #ffffff);
    --eq-composer-ink: #ffffff;
    --eq-active: color-mix(in srgb, var(--eq-user-accent, #8B6CF0) 18%, #232731);
    --eq-bubble: color-mix(in srgb, var(--eq-user-accent, #8B6CF0) 13%, #272b35);
    --eq-bubble-text: #f0eef8;
    --eq-composer-shadow: 0 2px 7px #0004, 0 12px 30px #0003;
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
/* Accounts with the provider's feature rail get the same single Equinox rail
   beside a conversation sidebar. Reflow the genuine feature buttons and the
   account controls inside the expanded sidebar. Collapsed/mobile layouts and
   any unrecognized provider structure keep the original provider layout. */
@media (min-width: 769px) {
  html.chatgpt-theme [data-app-shell-frame][data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation) {
    --app-shell-left-panel-width: 274px !important;
  }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar > div:has(> nav[data-app-navigation-rail]):has(> .sidebar-navigation) {
    position: relative;
    flex-direction: column !important;
    padding-bottom: 46px;
    min-height: 0;
    background: var(--eq-sidebar);
  }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar > div > nav[data-app-navigation-rail] {
    flex: 0 0 auto !important;
    width: 100% !important;
    min-width: 0;
    position: static !important;
    padding: 7px 9px !important;
    border-bottom: 1px solid var(--eq-border);
  }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > [data-appearance="plain"] {
    flex: 0 0 auto !important;
    flex-direction: row !important;
    flex-wrap: wrap;
    align-items: center !important;
    justify-content: flex-start !important;
    gap: 3px !important;
    margin: 0 !important;
    width: 100%;
    overflow: visible !important;
    mask-image: none !important;
    padding: 0 !important;
  }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > [data-appearance="plain"] > div:not([data-appearance]) { width: auto !important; }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > [data-appearance="plain"] > [data-appearance="plain"] {
    flex-direction: row !important;
    flex-wrap: wrap;
    gap: 3px !important;
    width: auto !important;
  }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] button {
    width: 32px !important;
    height: 32px !important;
    flex: 0 0 32px !important;
  }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > [data-appearance="plain"] > div.border-t {
    width: 1px !important;
    height: 18px;
    margin: 0 1px !important;
    border-top: 0;
    border-inline-start: 1px solid var(--eq-border);
  }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > div:last-child {
    position: absolute !important;
    inset-inline: 0;
    bottom: 0;
    width: auto !important;
    padding: 6px 10px;
    height: 46px;
    border-top: 1px solid var(--eq-border);
    background: var(--eq-sidebar);
    z-index: 2;
  }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > div:last-child > div {
    flex-direction: row !important;
    justify-content: space-between;
  }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > div:last-child > div > div { width: auto !important; }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar > div > .sidebar-navigation {
    border-radius: 0 !important;
    background: var(--eq-sidebar) !important;
  }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) aside[data-app-shell-left-panel-appearance] > div:first-child { width: 274px !important; min-width: 274px !important; max-width: 100% !important; }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar { width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) aside[data-app-shell-left-panel-appearance] > div:first-child > div:has(> #app-shell-sidebar) { width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
}
/* Task-oriented workspace, not a second renderer of the provider conversation.
   The actual conversation tree, menus, streaming and message actions stay intact.
   The native application header above this view owns the Equinox branding. */
html.chatgpt-theme main[data-app-shell-main-surface] {
  --thread-content-max-width: 55rem !important;
  --thread-content-compact-max-width: 48rem !important;
  --thread-content-expanded-max-width: 55rem !important;
  background: var(--eq-canvas) !important;
}
/* Keep the real provider mode and conversation actions, but use a
   compact toolbar rather than a second prominent application header. */
html.chatgpt-theme [data-app-shell-frame] {
  --app-shell-titlebar-height: 44px !important;
}
html.chatgpt-theme [class~="@container/home-mode-toggle"] {
  justify-content: flex-start !important;
  padding-inline: 20px;
}
html.chatgpt-theme [class~="@container/home-mode-toggle"] [role="group"][class~="grid-cols-2"]:has(> button:nth-of-type(2)):not(:has(> button:nth-of-type(3))) {
  width: 160px !important;
  height: 30px !important;
  border-radius: 7px !important;
}
html.chatgpt-theme [class~="@container/home-mode-toggle"] [role="group"][class~="grid-cols-2"] > :is(button,span) {
  border-radius: 6px !important;
}
html.chatgpt-theme [class~="@container/home-mode-toggle"] [role="group"][class~="grid-cols-2"] > span:first-child {
  height: 28px !important;
}
html.chatgpt-theme [class~="@container/home-mode-toggle"] [role="group"][class~="grid-cols-2"] > button {
  padding-inline: 12px !important;
  font-size: 12px;
}
html.chatgpt-theme [data-app-shell-titlebar] {
  border-bottom: 1px solid var(--eq-border);
  background: var(--eq-canvas);
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation {
  background: var(--eq-sidebar) !important;
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation nav {
  padding-inline: 7px;
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation {
  --height-token-row: 32px;
  --height-token-nav-row: 32px;
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation a[href="/"] > span {
  position: relative;
  font-size: 0 !important;
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation a[href="/"] > span > span:has(> svg):not(:has(button,a,input)) {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  overflow: hidden !important;
  clip-path: inset(50%) !important;
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation a[href="/"] > span::after {
  content: "Conversations";
  font-size: 15px;
  letter-spacing: -.025em;
  font-weight: 650;
}
html.chatgpt-theme:lang(tr) #app-shell-sidebar .sidebar-navigation a[href="/"] > span::after {
  content: "Sohbetler";
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation a[href*="/c/"] {
  font-size: 13px;
  line-height: 1.4;
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation [role="heading"] {
  font-size: 11px;
  letter-spacing: .015em;
  font-weight: 600;
}
html.chatgpt-theme :is([data-markdown-text-style="assistant-message"],[data-virtualized-turn-content] .markdown) {
  font-size: 15px;
  line-height: 1.7;
}
/* Preserve the provider's genuine per-turn activity disclosure as a
   compact workspace control. The Local dock is separate, globally scoped
   runtime evidence; no fabricated activity is inserted into the transcript. */
html.chatgpt-theme button[data-turn-disclosure-button] {
  min-height: 28px;
  padding: 3px 8px !important;
  border: 1px solid var(--eq-border) !important;
  border-radius: 6px !important;
  background: var(--eq-paper) !important;
  color: var(--eq-secondary) !important;
  font-size: 12px !important;
}
html.chatgpt-theme button[data-turn-disclosure-button]:hover {
  background: var(--eq-active) !important;
}
html.chatgpt-theme [class~="-ms-2"][class~="ps-2"] > [data-spacing="activity"] {
  border-inline-start: 2px solid var(--eq-border);
  padding-inline-start: 10px;
}
html.chatgpt-theme [data-spacing="activity"] [class~="group/activity-header"] {
  gap: 6px;
}
html.chatgpt-theme [data-spacing="activity"] [class~="group/activity-header"] [class~="text-size-chat"] {
  font-size: 13px;
}
html.chatgpt-theme [data-markdown-text-style="assistant-message"] [data-code-block="true"] {
  background: var(--eq-paper) !important;
  border: 1px solid var(--eq-border) !important;
  border-radius: 9px !important;
}
html.chatgpt-theme [data-markdown-text-style="assistant-message"] [data-code-block="true"] pre {
  font-size: 13px;
  line-height: 1.65;
}
html.chatgpt-theme [data-markdown-text-style="assistant-message"] table {
  font-size: 13px;
  line-height: 1.5;
}
html.chatgpt-theme [data-user-message-bubble="true"] {
  font-size: 15px;
  line-height: 1.65;
}
html.chatgpt-theme [data-virtualized-turn-content] .markdown :is(pre,table) {
  border-radius: 7px;
  border-color: var(--eq-border);
}
html.chatgpt-theme [data-virtualized-turn-content] .markdown pre {
  border: 1px solid var(--eq-border);
  background: var(--eq-paper);
}
html.chatgpt-theme .bg-user-message.text-user-message {
  background: var(--eq-paper) !important;
  color: var(--eq-text) !important;
  border: 1px solid var(--eq-border);
  border-inline-start: 3px solid var(--eq-accent);
  border-radius: 9px !important;
  padding: 13px 16px !important;
  max-width: min(100%, 55rem) !important;
  box-shadow: none !important;
}
/* The provider may align the user turn to the opposite edge. Align its real
   message container to the task column, without moving any React-owned nodes. */
html.chatgpt-theme :is([data-virtualized-turn-content], [class~="group/user-message"]) :is(div,section):has(> .bg-user-message.text-user-message),
html.chatgpt-theme [class~="group/user-message"]:has(> [data-user-message-bubble="true"]) {
  justify-content: flex-start !important;
  align-items: flex-start !important;
}
html.chatgpt-theme [data-message-author-role="user"] {
  align-self: stretch !important;
  max-width: 100% !important;
}
html.chatgpt-theme [data-message-author-role="user"] :is(div,section):has(> .bg-user-message.text-user-message) {
  justify-content: flex-end !important;
  align-items: flex-end !important;
}
/* The same native input, attachment and action controls stay mounted. A
   two-row editor matches the Codex reference in both new and ongoing chats. */
html.chatgpt-theme form[data-chatgpt-composer] [class*="ComposerSurface-"] {
  background: var(--eq-editor) !important;
  border: 1px solid var(--eq-border) !important;
  border-radius: 12px !important;
  box-shadow: var(--eq-composer-shadow) !important;
  --composer-layout-surface-background: var(--eq-editor);
}
html.chatgpt-theme form[data-chatgpt-composer] [data-composer-body]:has([data-composer-footer-responsive][data-composer-rows="responsive"]) {
  height: auto !important;
}
html.chatgpt-theme form[data-chatgpt-composer] [data-composer-footer-responsive][data-composer-rows="responsive"] {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) auto !important;
  grid-template-rows: minmax(68px, auto) auto !important;
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
  min-height: 56px;
}
/* Keep the ongoing composer compact while preserving native attachment,
   expansion and textarea growth. Inline runs stay inside agent messages. */
html.chatgpt-theme form[data-chatgpt-composer]:not([data-composer-placement="home"]) [data-composer-footer-responsive][data-composer-rows="responsive"] {
  grid-template-rows: minmax(36px, auto) auto !important;
  padding-block: 6px !important;
}
html.chatgpt-theme form[data-chatgpt-composer]:not([data-composer-placement="home"]) [data-composer-footer-responsive][data-composer-rows="responsive"] .ProseMirror {
  min-height: 32px;
}
@media (max-height: 520px) {
  html.chatgpt-theme form[data-chatgpt-composer] [data-composer-footer-responsive][data-composer-rows="responsive"] {
    grid-template-rows: minmax(36px, auto) auto !important;
  }
  html.chatgpt-theme form[data-chatgpt-composer] [data-composer-footer-responsive][data-composer-rows="responsive"] .ProseMirror {
    min-height: 32px;
  }
}
html.chatgpt-theme .thread-scroll-container {
  scroll-padding-top: max(12px, var(--app-shell-titlebar-height, 44px));
}
html.chatgpt-theme form[data-chatgpt-composer] [data-composer-markdown] p[data-empty-paragraph="true"][data-placeholder]::before {
  content: "Describe a task or ask a question..." !important;
  color: var(--eq-muted) !important;
}
html.chatgpt-theme:lang(tr) form[data-chatgpt-composer] [data-composer-markdown] p[data-empty-paragraph="true"][data-placeholder]::before {
  content: "Bir görev tarif et veya soru sor..." !important;
}
/* The new-task page is an actual workspace: a focused task heading above
   the same real provider composer, with suggestions kept available. Only the
   non-interactive generic greeting is replaced visually. */
html.chatgpt-theme [class*="Greeting-"]:not(:has(button,a,input,textarea,select,[role="button"],[contenteditable="true"])) {
  position: relative;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 10px;
  padding: 24px 16px !important;
  text-align: center;
}
html.chatgpt-theme [class*="Greeting-"]:not(:has(button,a,input,textarea,select,[role="button"],[contenteditable="true"])) > div {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  overflow: hidden !important;
  clip-path: inset(50%) !important;
}
html.chatgpt-theme [class*="Greeting-"]:not(:has(button,a,input,textarea,select,[role="button"],[contenteditable="true"]))::before {
  content: attr(data-equinox-initial);
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
  margin-bottom: 6px;
  border-radius: 50%;
  color: var(--eq-accent);
  background: var(--eq-active) var(--eq-agent-avatar, none) center / cover no-repeat;
  border: 3px solid var(--eq-canvas);
  box-shadow: 0 0 0 1px var(--eq-border), 0 8px 24px #33224a12;
  font-size: 29px;
  font-weight: 650;
}
html.chatgpt-theme[data-equinox-agent-photo="true"] [class*="Greeting-"]::before { color: transparent; }
html.chatgpt-theme [class*="Greeting-"]:not(:has(button,a,input,textarea,select,[role="button"],[contenteditable="true"]))::after {
  content: attr(data-equinox-greeting);
  color: var(--eq-text);
  font-size: clamp(23px, 2.6vw, 30px);
  line-height: 1.2;
  letter-spacing: -.035em;
  font-weight: 650;
}
html.chatgpt-theme [class*="Greeting-"]:not([data-equinox-greeting]):not(:has(button,a,input,textarea,select,[role="button"],[contenteditable="true"]))::after { content: "Equinox workspace"; }
/* Avatar-led conversation: both sides share a consistent reading column.
   Native message nodes, menus, selections, code and streaming are retained. */
html.chatgpt-theme main [data-equinox-role] {
  position: relative;
  padding-inline-start: 46px !important;
  padding-block-start: 26px !important;
  min-width: 0;
  box-sizing: border-box;
  margin-block: 10px 6px;
}
html.chatgpt-theme main [data-equinox-role]::before {
  content: "";
  position: absolute;
  inset-inline-start: 0;
  top: 0;
  width: 34px;
  height: 34px;
  border: 1px solid var(--eq-border);
  border-radius: 50%;
  background: var(--eq-active) center/cover no-repeat;
}
html.chatgpt-theme main [data-equinox-role="user"]::before { background-image: var(--eq-human-avatar, none); }
html.chatgpt-theme main [data-equinox-role="assistant"]::before { background-image: var(--eq-agent-avatar, none); box-shadow: 0 0 0 2px var(--eq-canvas), 0 0 0 3px var(--eq-border); }
html.chatgpt-theme main [data-equinox-role]::after {
  content: attr(data-equinox-author);
  position: absolute;
  inset-inline-start: 46px;
  top: 1px;
  color: var(--eq-text);
  font-size: 13px;
  font-weight: 650;
  line-height: 20px;
  letter-spacing: -.01em;
}
html.chatgpt-theme main [data-equinox-role="user"] { align-items: stretch !important; }
html.chatgpt-theme main [data-equinox-role="user"] [class~="group/user-message"] { align-items: stretch !important; }
html.chatgpt-theme main [data-equinox-role="user"] [data-user-message-bubble="true"] {
  max-width: 100% !important;
  width: fit-content !important;
  min-width: min(190px,100%);
  border-inline-start: 1px solid var(--eq-border);
  border-radius: 4px 12px 12px 12px !important;
  background: var(--eq-paper) !important;
}
html.chatgpt-theme main [data-equinox-role="assistant"] [data-markdown-text-style="assistant-message"] { line-height: 1.72; }

/* Equinox Chat V2: two distinct people, not two copies of a Web message.
   Provider-owned message nodes, streaming, menus and conversation controls
   remain untouched. Only the existing annotated message wrapper is styled. */
html.chatgpt-theme main [data-equinox-role] {
  margin-block: 16px 27px;
  padding-block-start: 30px !important;
  width: 100%;
  max-width: 100%;
}
html.chatgpt-theme main [data-equinox-role]::before {
  width: 36px;
  height: 36px;
  border: 2px solid var(--eq-canvas);
  box-shadow: 0 0 0 1px var(--eq-border);
}
html.chatgpt-theme main [data-equinox-role]::after {
  top: 3px;
  font-size: 12px;
  font-weight: 680;
  letter-spacing: .012em;
  color: var(--eq-secondary);
}
html.chatgpt-theme main [data-equinox-role="user"] {
  padding-inline-start: 0 !important;
  padding-inline-end: 54px !important;
  display: flex;
  flex-direction: column;
  align-items: flex-end !important;
  text-align: start;
}
html.chatgpt-theme main [data-equinox-role="user"]::before {
  inset-inline-start: auto;
  inset-inline-end: 0;
  background-image: var(--eq-human-avatar, none);
}
html.chatgpt-theme main [data-equinox-role="user"]::after {
  inset-inline-start: auto;
  inset-inline-end: 54px;
  text-align: right;
  color: var(--eq-accent);
}
html.chatgpt-theme main [data-equinox-role="user"] [class~="group/user-message"] {
  align-items: flex-end !important;
  justify-content: flex-end !important;
  width: 100%;
}
html.chatgpt-theme main [data-equinox-role="user"] [data-user-message-bubble="true"] {
  width: fit-content !important;
  max-width: min(690px, 100%) !important;
  min-width: 0;
  margin-inline-start: auto !important;
  padding: 12px 17px !important;
  border: 1px solid color-mix(in srgb, var(--eq-user-accent, #8B6CF0) 18%, var(--eq-border)) !important;
  border-radius: 13px 4px 13px 13px !important;
  background: var(--eq-bubble) !important;
  color: var(--eq-bubble-text) !important;
  text-align: start !important;
  line-height: 1.6;
  box-shadow: 0 2px 8px #080a1005;
}
html.chatgpt-theme main [data-equinox-role="assistant"] {
  padding-inline-start: 54px !important;
  padding-inline-end: 0 !important;
}
html.chatgpt-theme main [data-equinox-role="assistant"]::before { inset-inline-start: 0; }
html.chatgpt-theme main [data-equinox-role="assistant"]::after {
  inset-inline-start: 54px;
  color: var(--eq-text);
}
html.chatgpt-theme main [data-equinox-role="assistant"] [data-response-body] {
  max-width: 100%;
  padding: 14px 18px 15px !important;
  border: 1px solid var(--eq-border);
  border-radius: 4px 13px 13px 13px;
  background: var(--eq-paper);
  box-shadow: 0 2px 8px #080a1006;
}
html.chatgpt-theme main [data-equinox-role="assistant"] [data-markdown-text-style="assistant-message"] {
  line-height: 1.68;
  font-size: 14px;
}
html.chatgpt-theme main [data-equinox-role="assistant"] [data-markdown-text-style="assistant-message"] :is(h1,h2,h3) {
  letter-spacing: -.024em;
  color: var(--eq-text);
}
/* Provider's measured table width (880px) can exceed the padded card
   (788px). Keep the semantic table and constrain its columns to its reader. */
html.chatgpt-theme main [data-equinox-role="assistant"] [class*="TableFrame-"] {
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
  margin-inline: 0 !important;
}
html.chatgpt-theme main [data-equinox-role="assistant"] [class*="TableViewport-"] {
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
  overflow-x: auto !important;
  /* The provider aligns narrower native tables to the right of this
     scrollable viewport. Reverse just the wrapper and restore table text. */
  direction: rtl;
}
html.chatgpt-theme main [data-equinox-role="assistant"] [data-markdown-text-style="assistant-message"] table {
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
  direction: ltr;
}
html.chatgpt-theme main [data-equinox-role="assistant"] [data-markdown-text-style="assistant-message"] :is(th,td) {
  overflow-wrap: anywhere;
}
html.chatgpt-theme main [data-equinox-role="assistant"] [data-markdown-text-style="assistant-message"] [data-code-block="true"] {
  max-width: 100% !important;
  overflow: hidden;
}

/* Clear, quiet reading line for the real per-tool MCP App card. */
html.chatgpt-theme main [data-equinox-role="assistant"] iframe {
  max-width: 100%;
  border-radius: 8px;
}
/* Real sidebar sections: restrained typography and discoverable navigation. */
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation {
  font-size: 12px;
  letter-spacing: -.007em;
}
html.chatgpt-theme #app-shell-sidebar :is(a,button):hover {
  background-color: color-mix(in srgb, var(--eq-user-accent, #8B6CF0) 6%, var(--eq-sidebar));
}
html.chatgpt-theme #app-shell-sidebar :is(a,button)[aria-current="page"] {
  box-shadow: inset 2px 0 0 var(--eq-accent);
}
html.chatgpt-theme form[data-chatgpt-composer] [class*="ComposerSurface-"] {
  border-radius: 15px !important;
  border-color: color-mix(in srgb, var(--eq-user-accent, #8B6CF0) 10%, var(--eq-border)) !important;
}
html.chatgpt-theme form[data-chatgpt-composer]:focus-within [class*="ComposerSurface-"] {
  border-color: color-mix(in srgb, var(--eq-user-accent, #8B6CF0) 45%, var(--eq-border)) !important;
  box-shadow: var(--eq-composer-shadow), 0 0 0 2px color-mix(in srgb, var(--eq-user-accent, #8B6CF0) 9%, transparent) !important;
}
html.chatgpt-theme form[data-chatgpt-composer] [data-composer-trailing-controls] button:enabled:hover {
  filter: brightness(1.08);
}
@media (max-width: 700px) {
  html.chatgpt-theme main [data-equinox-role="user"] { padding-inline-end: 40px !important; }
  html.chatgpt-theme main [data-equinox-role="assistant"] { padding-inline-start: 40px !important; }
  html.chatgpt-theme main [data-equinox-role]::before { width: 30px; height: 30px; }
  html.chatgpt-theme main [data-equinox-role="user"]::after { inset-inline-end: 40px; }
  html.chatgpt-theme main [data-equinox-role="assistant"]::after { inset-inline-start: 40px; }
  html.chatgpt-theme main [data-equinox-role="assistant"] [data-response-body] { padding: 11px 12px !important; }
  html.chatgpt-theme main [data-equinox-role="user"] [data-user-message-bubble="true"] { padding: 10px 12px !important; }
}

@media(max-width:550px) {
  html.chatgpt-theme main [data-equinox-role="assistant"] { padding-inline-start: 37px !important; }
  html.chatgpt-theme main [data-equinox-role="user"] { padding-inline-start: 0 !important; padding-inline-end: 37px !important; }
  html.chatgpt-theme main [data-equinox-role]::before { width: 27px; height: 27px; }
  html.chatgpt-theme main [data-equinox-role="assistant"]::after { inset-inline-start: 37px; }
  html.chatgpt-theme main [data-equinox-role="user"]::after { inset-inline-start: auto; inset-inline-end: 37px; }
}
/* Home suggestions remain real, selectable provider controls. Compact
   only the ordinary small button lists below the composer; never restyle
   a Work/onboarding takeover, attachment picker or arbitrary content. */
html.chatgpt-theme [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover])):has(form[data-composer-placement="home"]) [class*="BelowComposer-"] :is(div,ul):has(> :is(button,a):nth-child(2)):not(:has(> :not(:is(button,a)))):not(:has(> :nth-child(5))) {
  display: flex !important;
  flex-direction: row !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 6px !important;
  padding-block: 3px !important;
}
html.chatgpt-theme [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover])):has(form[data-composer-placement="home"]) [class*="BelowComposer-"] :is(div,ul):has(> :is(div,li):nth-child(2) > :is(button,a)):not(:has(> :not(:is(div,li)))):not(:has(> :nth-child(5))):not(:has(> :is(div,li) > :not(:is(button,a)))) {
  display: flex !important;
  flex-direction: row !important;
  flex-wrap: wrap !important;
  justify-content: center !important;
  gap: 6px !important;
  padding-block: 3px !important;
}
html.chatgpt-theme [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover])):has(form[data-composer-placement="home"]) [class*="BelowComposer-"] :is(button,a):has(> svg):not(:has(input,textarea)) {
  min-height: 30px !important;
  padding-block: 4px !important;
  font-size: 12px !important;
}
html.chatgpt-theme [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover])):has(form[data-composer-placement="home"]) [class*="BelowComposer-"] :is(div,ul):has(> :is(button,a):nth-child(2)):not(:has(> :not(:is(button,a)))):not(:has(> :nth-child(5))) > :is(button,a) {
  width: auto !important;
  min-width: 0;
  min-height: 32px !important;
  padding: 5px 10px !important;
  border: 1px solid var(--eq-border) !important;
  border-radius: 7px !important;
  font-size: 12px !important;
}
@media (min-height: 460px) and (min-width: 640px) {
  html.chatgpt-theme [class~="group/home-composer-layout"]:not(:has([data-composer-expanded])):has(form[data-composer-placement="home"]) [class*="StreamedComposer-"] {
    grid-template-rows: minmax(0,1fr) auto auto !important;
    padding-bottom: 16px;
  }
  html.chatgpt-theme [class~="group/home-composer-layout"]:not(:has([data-composer-expanded])) [class*="GreetingRegion-"] {
    justify-content: center !important;
  }
}

`;
function decorateProviderIdentity(identity, language, accent) {
    const root = document.documentElement;
    document.documentElement.style.setProperty("--eq-user-accent", /^#[0-9a-fA-F]{6}$/u.test(accent) ? accent : "#8B6CF0");
    const agent = identity.name.trim() || "Equinox";
    const human = language === "tr" ? "Sen" : "You";
    const mark = (element, role, name) => {
        if (element.getAttribute("data-equinox-role") !== role)
            element.setAttribute("data-equinox-role", role);
        if (element.getAttribute("data-equinox-author") !== name)
            element.setAttribute("data-equinox-author", name);
    };
    const property = (name, value) => {
        if (root.style.getPropertyValue(name) !== value)
            root.style.setProperty(name, value);
    };
    const url = (value) => "url(" + JSON.stringify(value) + ")";
    const agentImage = identity.avatar && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(identity.avatar) ? url(identity.avatar) : "none";
    property("--eq-agent-avatar", agentImage);
    root.setAttribute("data-equinox-agent-photo", agentImage === "none" ? "false" : "true");
    const sync = () => {
        // Reuse the real signed-in account picture already visible in the
        // provider sidebar, including its data URI; no account API or upload.
        const profile = document.querySelector('#app-shell-sidebar nav[data-app-navigation-rail] button[aria-haspopup="menu"] img')
            || document.querySelector('#app-shell-sidebar button[aria-haspopup="menu"] img[class~="rounded-full"]');
        const src = profile?.currentSrc || profile?.getAttribute("src") || "";
        const validImage = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/u.test(src) || /^https:\/\//u.test(src) || /^blob:https:\/\//u.test(src);
        property("--eq-human-avatar", validImage ? url(src) : "none");
        // One actual provider wrapper per visible user or assistant message.
        // New and virtualized turns are annotated as the provider mounts them.
        for (const element of document.querySelectorAll('main [data-chatgpt-search-unit-key$=":user"]')) {
            if (element.querySelector('[data-user-message-bubble="true"]'))
                mark(element, "user", human);
        }
        for (const element of document.querySelectorAll('main [data-response-body]')) {
            // Not every ChatGPT assistant answer has a search-unit wrapper. The
            // response's immediate parent contains only that answer, unlike its
            // parent turn which can also hold the human's message.
            const assistantUnit = element.closest('[data-content-search-unit-key]') || element.parentElement;
            if (assistantUnit && !assistantUnit.closest('[data-equinox-role]'))
                mark(assistantUnit, "assistant", agent);
        }
        for (const element of document.querySelectorAll('main [data-talvt-turn-state]')) {
            if (!element.querySelector('[data-response-body]') && !element.querySelector('[data-user-message-bubble="true"]'))
                mark(element, "assistant", agent);
        }
        for (const element of document.querySelectorAll('main [data-message-author-role="user"]')) {
            if (!element.closest('[data-equinox-role]'))
                mark(element, "user", human);
        }
        for (const element of document.querySelectorAll('main [data-message-author-role="assistant"]')) {
            if (!element.closest('[data-equinox-role]'))
                mark(element, "assistant", agent);
        }
        for (const element of document.querySelectorAll('main [class*="Greeting-"]')) {
            if (element.querySelector('button,a,input,textarea,select,[role="button"],[contenteditable="true"]'))
                continue;
            element.setAttribute("data-equinox-initial", agent.slice(0, 1).toUpperCase());
            element.setAttribute("data-equinox-greeting", language === "tr" ? agent + " ile çalışmaya başla" : "Work with " + agent);
        }
    };
    const world = window;
    world.__equinoxIdentityObserver?.disconnect();
    if (world.__equinoxIdentityFrame !== undefined)
        cancelAnimationFrame(world.__equinoxIdentityFrame);
    const observer = new MutationObserver(() => {
        if (world.__equinoxIdentityFrame !== undefined)
            return;
        world.__equinoxIdentityFrame = requestAnimationFrame(() => { delete world.__equinoxIdentityFrame; sync(); });
    });
    // React may replace the html element during a route transition or reuse
    // existing message nodes by setting their data attributes. Observing the
    // document survives either operation without touching the provider's DOM.
    observer.observe(document, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["src", "data-chatgpt-search-unit-key", "data-user-message-bubble", "data-response-body", "data-talvt-turn-state"] });
    world.__equinoxIdentityObserver = observer;
    sync();
}
export function createEmbeddedChat(win, initialLanguage = "en", initialIdentity = { name: "", avatar: null }, initialAccent = "#8B6CF0") {
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
    let chatVisible = false;
    win.contentView.addChildView(view);
    const continuity = createNativeChatContinuity(win, view.webContents, () => chatVisible);
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
    let identity = initialIdentity;
    let accent = initialAccent;
    const applyIdentity = () => {
        if (view.webContents.isDestroyed() || !isChatGPTOrigin(view.webContents.getURL()))
            return;
        const code = "(" + decorateProviderIdentity.toString() + ")(" + JSON.stringify(identity) + "," + JSON.stringify(language) + "," + JSON.stringify(accent) + ")";
        void view.webContents.executeJavaScriptInIsolatedWorld(1002, [{ code }]).catch(() => { });
    };
    // Provider SPA navigation may finish before React mounts the new turn
    // nodes. Retry the identity observer at bounded mount intervals; the script
    // is idempotent and does not reconstruct or replace provider messages.
    const identityTimers = new Set();
    const resyncIdentity = () => {
        for (const timer of identityTimers)
            clearTimeout(timer);
        identityTimers.clear();
        applyIdentity();
        for (const ms of [150, 700, 1_800]) {
            const timer = setTimeout(() => { identityTimers.delete(timer); applyIdentity(); }, ms);
            identityTimers.add(timer);
        }
    };
    view.webContents.on("did-navigate-in-page", resyncIdentity);
    view.webContents.on("did-finish-load", () => {
        if (view.webContents.isDestroyed())
            return;
        try {
            if (new URL(view.webContents.getURL()).origin === CHATGPT) {
                void view.webContents.insertCSS(STYLE).then(resyncIdentity).catch(() => { });
            }
        }
        catch { /* Ignore intermediate navigation state. */ }
    });
    let disposed = false;
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        chatVisible = false;
        continuity.dispose();
        for (const timer of identityTimers)
            clearTimeout(timer);
        identityTimers.clear();
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
            chatVisible = Boolean(bounds);
            if (!bounds) {
                view.setVisible(false);
                if (view.webContents.isFocused() && !win.isDestroyed())
                    win.webContents.focus();
                return;
            }
            view.setBounds(bounds);
            view.setVisible(true);
        },
        setLanguage(value) { language = value; applyIdentity(); },
        setIdentity(value) { identity = value; applyIdentity(); },
        setAccent(value) { accent = value; applyIdentity(); },
        async requestMicrophone() {
            const granted = await askMicrophonePermission();
            if (granted && !view.webContents.isDestroyed())
                view.webContents.reload();
            return granted;
        },
        dispose,
    };
}
