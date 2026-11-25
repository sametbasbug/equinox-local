import { createNativeChatContinuity } from "./native-chat-continuity.js";
import { WebContentsView, dialog, nativeTheme, session, shell } from "electron";
import type { BrowserWindow, Rectangle } from "electron";
import path from "node:path";

// Explicitly isolated remote browser. No privileged Equinox preload or IPC.
const CHATGPT = "https://chatgpt.com";
const HOSTS = new Set(["chatgpt.com", "auth.openai.com"]);
let googleNoticeOpen = false;

function isEmbeddedGoogleAuth(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "accounts.google.com";
  } catch { return false; }
}

function warnGoogleRestriction(win: BrowserWindow, language: "en" | "tr"): void {
  if (googleNoticeOpen || win.isDestroyed()) return;
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

// Appearance only. These selectors use observed provider layout attributes and
// semantic class names; no provider action is replaced or programmatically invoked.
const STYLE = String.raw`
html.chatgpt-theme {
  --eq-canvas: #f9fbff;
  --eq-sidebar: #f0f3f9;
  --eq-chrome: #f9fbff;
  --eq-paper: #ffffff;
  --eq-editor: #ffffff;
  --eq-border: #e1e6f0;
  --eq-text: #181a29;
  --eq-secondary: #4d536a;
  --eq-muted: #61677b;
  --eq-accent: oklch(from var(--eq-user-accent, #8b6cf0) clamp(.32, l, .48) calc(c * .85) h);
  --eq-send: oklch(from var(--eq-user-accent, #8b6cf0) clamp(.32, l, .49) calc(c * .85) h);
  --eq-active: color-mix(in srgb, var(--eq-accent) 10%, var(--eq-sidebar));
  --eq-bubble: color-mix(in srgb, var(--eq-accent) 7%, var(--eq-canvas));
  --eq-bubble-text: var(--eq-text);
  --eq-sidebar-width: 256px;
  --eq-home-width: 42rem;
  --eq-editor-shadow: 0 2px 5px #19264a09, 0 12px 30px #19264a08;
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
  --color-text-composer-primary: #fff !important;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  html.chatgpt-theme {
    --eq-canvas: #161822;
    --eq-sidebar: #1b1d29;
    --eq-chrome: #161822;
    --eq-paper: #1e2130;
    --eq-editor: #212435;
    --eq-border: #303548;
    --eq-text: #eeeff8;
    --eq-secondary: #bdc3d8;
    --eq-muted: #a1a9c1;
    --eq-accent: oklch(from var(--eq-user-accent, #8b6cf0) clamp(.73, l, .84) calc(c * .8) h);
    --eq-active: color-mix(in srgb, var(--eq-accent) 12%, var(--eq-sidebar));
    --eq-bubble: color-mix(in srgb, var(--eq-accent) 9%, var(--eq-paper));
    --eq-editor-shadow: 0 2px 7px #0b0c1455;
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
  border-inline-end: 0 !important;
}
html.chatgpt-theme #app-shell-sidebar,
html.chatgpt-theme #app-shell-sidebar > .bg-surface { background: var(--eq-sidebar) !important; }
@media (min-width: 769px) {
  html.chatgpt-theme [data-app-shell-frame][data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="false"] {
    --app-shell-left-panel-width: var(--eq-sidebar-width) !important;
  }
  html.chatgpt-theme [data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="false"] aside[data-app-shell-left-panel-appearance] > div:first-child {
    width: var(--eq-sidebar-width) !important;
    min-width: var(--eq-sidebar-width) !important;
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
    --app-shell-left-panel-width: var(--eq-sidebar-width) !important;
  }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar > div:has(> nav[data-app-navigation-rail]):has(> .sidebar-navigation) {
    position: relative;
    flex-direction: column !important;
    padding-bottom: 42px;
    min-height: 0;
    background: var(--eq-sidebar);
  }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar > div > nav[data-app-navigation-rail] {
    flex: 0 0 auto !important;
    width: 100% !important;
    min-width: 0;
    position: static !important;
    padding: 5px 10px !important;
    border-bottom: 0;
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
    width: 30px !important;
    height: 32px !important;
    flex: 0 0 30px !important;
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
    padding: 4px 10px;
    height: 42px;
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
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) aside[data-app-shell-left-panel-appearance] > div:first-child { width: var(--eq-sidebar-width) !important; min-width: var(--eq-sidebar-width) !important; max-width: 100% !important; }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar { width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
  html.chatgpt-theme :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) aside[data-app-shell-left-panel-appearance] > div:first-child > div:has(> #app-shell-sidebar) { width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
}
/* Task-oriented workspace, not a second renderer of the provider conversation.
   The actual conversation tree, menus, streaming and message actions stay intact.
   The native application header above this view owns the Equinox branding. */
html.chatgpt-theme main[data-app-shell-main-surface] {
  --thread-content-max-width: 48rem !important;
  --thread-content-compact-max-width: 48rem !important;
  --thread-content-expanded-max-width: 52rem !important;
  border-radius: 0 !important;
  background: var(--eq-canvas) !important;
}
/* Keep the real provider mode and conversation actions, but use a
   compact toolbar rather than a second prominent application header. */
html.chatgpt-theme [data-app-shell-frame] {
  --app-shell-titlebar-height: 48px !important;
}
html.chatgpt-theme [class~="@container/home-mode-toggle"] {
  justify-content: flex-start !important;
  padding-inline: clamp(14px, 2.2vw, 32px);
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
  background: var(--eq-chrome);
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation {
  --height-token-row: 30px;
  --height-token-nav-row: 30px;
  background: var(--eq-sidebar) !important;
  font-size: 13px;
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation nav {
  padding-inline: 10px;
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
  font-size: 14px;
  letter-spacing: -.02em;
  font-weight: 670;
}
html.chatgpt-theme:lang(tr) #app-shell-sidebar .sidebar-navigation a[href="/"] > span::after {
  content: "Sohbetler";
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation a[href*="/c/"] {
  font-size: 13px;
  line-height: 1.4;
}
html.chatgpt-theme :is([data-markdown-text-style="assistant-message"],[data-virtualized-turn-content] .markdown) {
  font-size: 15px;
  line-height: 1.7;
}
/* Keep the provider's genuine per-turn activity disclosure compact.
   The inline MCP App renders only data from its originating real tool call. */
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
/* Before identity decoration completes, a provider-owned user bubble
   still has the quiet V2 surface rather than the retired left accent stripe. */
html.chatgpt-theme .bg-user-message.text-user-message {
  background: var(--eq-bubble) !important;
  color: var(--eq-bubble-text) !important;
  border: 1px solid var(--eq-border);
  border-radius: 12px !important;
  padding: 12px 16px !important;
  max-width: min(100%, 34rem) !important;
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
  border-radius: 17px !important;
  box-shadow: var(--eq-editor-shadow) !important;
  --composer-layout-surface-background: var(--eq-editor);
}
html.chatgpt-theme form[data-chatgpt-composer] [data-composer-body]:has([data-composer-footer-responsive][data-composer-rows="responsive"]) {
  height: auto !important;
}
html.chatgpt-theme form[data-chatgpt-composer] [data-composer-footer-responsive][data-composer-rows="responsive"] {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) auto !important;
  grid-template-rows: minmax(47px, auto) auto !important;
  align-items: center;
  gap: 2px 8px !important;
  padding: 9px 10px !important;
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
/* The start screen groups the agent identity with the real composer. */
html.chatgpt-theme [data-equinox-greeting] {
  position: relative;
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 13px;
  padding: 0 !important;
  text-align: center;
}
html.chatgpt-theme [data-equinox-greeting] > div {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  overflow: hidden !important;
  clip-path: inset(50%) !important;
}
html.chatgpt-theme [data-equinox-greeting]::before {
  content: attr(data-equinox-initial);
  display: grid;
  place-items: center;
  width: 50px;
  height: 50px;
  border-radius: 16px;
  color: var(--eq-accent);
  background: var(--eq-active) var(--eq-agent-avatar, none) center / cover no-repeat;
  font-size: 21px;
  font-weight: 650;
}
html.chatgpt-theme[data-equinox-agent-photo="true"] [data-equinox-greeting]::before { color: transparent; }
html.chatgpt-theme [data-equinox-greeting]::after {
  content: attr(data-equinox-greeting);
  color: var(--eq-text);
  font-size: clamp(26px, 2.7vw, 38px);
  line-height: 1.12;
  letter-spacing: -.043em;
  font-weight: 650;
}
/* The existing turn wrappers carry the original provider messages and activity. */
html.chatgpt-theme main [data-equinox-role] {
  position: relative;
  box-sizing: border-box;
  min-width: 0;
  --eq-avatar-size: 30px;
  --eq-author-offset: 43px;
  margin-block: 9px 18px;
  padding-block-start: 24px !important;
  width: 100%;
  max-width: 100%;
}
html.chatgpt-theme main [data-equinox-role]::before {
  content: attr(data-equinox-initial);
  position: absolute;
  inset-inline-start: 0;
  top: 0;
  display: grid;
  place-items: center;
  width: var(--eq-avatar-size);
  height: var(--eq-avatar-size);
  border: 1px solid var(--eq-border);
  color: var(--eq-secondary);
  font-size: 12px;
  font-weight: 650;
  border-radius: 50%;
  background: var(--eq-active) center / cover no-repeat;
}
html.chatgpt-theme main [data-equinox-role]::after {
  content: attr(data-equinox-author);
  position: absolute;
  inset-inline-start: var(--eq-author-offset);
  top: 3px;
  font-size: 12px;
  line-height: 20px;
  font-weight: 680;
  letter-spacing: .012em;
  color: var(--eq-secondary);
}
html.chatgpt-theme main [data-equinox-role="user"] {
  padding-inline-start: 0 !important;
  padding-inline-end: var(--eq-author-offset) !important;
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
  inset-inline-end: var(--eq-author-offset);
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
  max-width: min(34rem, 100%) !important;
  min-width: 0;
  margin-inline-start: auto !important;
  padding: 9px 13px !important;
  border: 1px solid color-mix(in srgb, var(--eq-accent) 12%, var(--eq-border)) !important;
  border-radius: 15px 6px 15px 15px !important;
  background: var(--eq-bubble) !important;
  color: var(--eq-bubble-text) !important;
  text-align: start !important;
  line-height: 1.58;
  box-shadow: none;
}
html.chatgpt-theme main [data-equinox-role="assistant"] {
  padding-inline-start: var(--eq-author-offset) !important;
  padding-inline-end: 0 !important;
}
html.chatgpt-theme main [data-equinox-role="assistant"]::before {
  inset-inline-start: 0;
  background-image: var(--eq-agent-avatar, none);
}
html.chatgpt-theme[data-equinox-agent-photo="true"] main [data-equinox-role="assistant"]::before,
html.chatgpt-theme[data-equinox-human-photo="true"] main [data-equinox-role="user"]::before { color: transparent; }

html.chatgpt-theme main [data-equinox-role="assistant"]::after {
  inset-inline-start: var(--eq-author-offset);
  color: var(--eq-text);
}
/* Plain agent prose, like the approved reference. Only genuine tool
   results receive framed surfaces inside the original assistant turn. */
html.chatgpt-theme main [data-equinox-role="assistant"] [data-response-body] {
  max-width: 100%;
  min-width: 0;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0;
  background: transparent !important;
  box-shadow: none !important;
}
html.chatgpt-theme main [data-equinox-role="assistant"] [data-markdown-text-style="assistant-message"] {
  max-width: 72ch;
  line-height: 1.67;
  font-size: 15px;
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
  /* Native TableFrame aligns a narrow table from the right edge; reverse
     only the scroll container, never the table's own text or columns. */
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
html.chatgpt-theme #app-shell-sidebar :is(a,button):hover {
  background-color: color-mix(in srgb, var(--eq-accent) 7%, var(--eq-sidebar));
}
html.chatgpt-theme #app-shell-sidebar :is(a,button)[aria-current="page"] {
  color: var(--eq-text) !important;
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation [role="heading"] {
  margin-block: 12px 4px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: .02em;
  color: var(--eq-secondary);
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation nav a[href*="/c/"] {
  min-height: 29px;
  padding-inline: 9px;
}
html.chatgpt-theme #app-shell-sidebar .sidebar-navigation nav :is(a,button):focus-visible {
  outline: 2px solid var(--eq-accent);
  outline-offset: -1px;
}
html.chatgpt-theme form[data-chatgpt-composer]:focus-within [class*="ComposerSurface-"] {
  border-color: color-mix(in srgb, var(--eq-accent) 58%, var(--eq-border)) !important;
}
@media (max-width: 700px) {
  html.chatgpt-theme main [data-equinox-role] { --eq-avatar-size: 26px; --eq-author-offset: 35px; }
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
@media (min-height: 460px) {
  html.chatgpt-theme [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover], [data-composer-expanded])):has(form[data-composer-placement="home"]) [class*="StreamedComposer-"] {
    grid-template-rows: auto auto auto !important;
    align-content: center;
    row-gap: 15px;
    padding-block: 18px 60px;
  }
  html.chatgpt-theme [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover], [data-composer-expanded])):has(form[data-composer-placement="home"]) [class*="GreetingRegion-"] {
    align-self: end;
    justify-content: center !important;
    justify-self: center;
    width: min(calc(100% - 32px), var(--eq-home-width));
    padding: 0 0 5px !important;
  }
}
html.chatgpt-theme [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover], [data-composer-expanded])):has(form[data-composer-placement="home"]) {
  --thread-content-max-width: var(--eq-home-width) !important;
  --thread-content-compact-max-width: var(--eq-home-width) !important;
  --thread-content-expanded-max-width: var(--eq-home-width) !important;
}

`;

// The provider is a child of the existing trusted Control Center window.
// Its separate session and webPreferences never receive the Control Center preload.
type ChatIdentity = {name:string;avatar:string|null};

function decorateProviderIdentity(identity: ChatIdentity, language: "en" | "tr", accent: string): void {
  const root = document.documentElement;
  document.documentElement.style.setProperty("--eq-user-accent",
    /^#[0-9a-fA-F]{6}$/u.test(accent) ? accent : "#8B6CF0");
  const agent = identity.name.trim() || "Equinox";
  const human = language === "tr" ? "Sen" : "You";
  const agentInitial = Array.from(agent)[0]?.toLocaleUpperCase(language) ?? "";
  const mark = (element: Element, role: "user" | "assistant", name: string) => {
    if (element.getAttribute("data-equinox-role") !== role) element.setAttribute("data-equinox-role",role);
    if (element.getAttribute("data-equinox-author") !== name) element.setAttribute("data-equinox-author", name);
    const initial = role === "assistant" ? agentInitial : human.charAt(0);
    if (element.getAttribute("data-equinox-initial") !== initial) element.setAttribute("data-equinox-initial", initial);
  };
  const property = (name: string, value: string) => {
    if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name,value);
  };
  const url = (value: string) => "url(" + JSON.stringify(value) + ")";
  const agentImage = identity.avatar && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(identity.avatar) ? url(identity.avatar) : "none";
  property("--eq-agent-avatar",agentImage);
  root.setAttribute("data-equinox-agent-photo",agentImage === "none" ? "false" : "true");
  const sync = () => {
    // Reuse the real signed-in account picture already visible in the
    // provider sidebar, including its data URI; no account API or upload.
    const profile = document.querySelector<HTMLImageElement>('#app-shell-sidebar nav[data-app-navigation-rail] button[aria-haspopup="menu"] img')
      || document.querySelector<HTMLImageElement>('#app-shell-sidebar button[aria-haspopup="menu"] img[class~="rounded-full"]');
    const src = profile?.currentSrc || profile?.getAttribute("src") || "";
    const validImage = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/u.test(src) || /^https:\/\//u.test(src) || /^blob:https:\/\//u.test(src);
    property("--eq-human-avatar", validImage ? url(src) : "none");
    root.setAttribute("data-equinox-human-photo", String(validImage));
    // One actual provider wrapper per visible user or assistant message.
    // New and virtualized turns are annotated as the provider mounts them.
    for (const element of document.querySelectorAll('main [data-chatgpt-search-unit-key$=":user"]')) {
      if (element.querySelector('[data-user-message-bubble="true"]')) mark(element,"user",human);
    }
    for (const element of document.querySelectorAll('main [data-response-body]')) {
      // Not every ChatGPT assistant answer has a search-unit wrapper. The
      // response's immediate parent contains only that answer, unlike its
      // parent turn which can also hold the human's message.
      const assistantUnit = element.closest('[data-content-search-unit-key]') || element.parentElement;
      const marked = assistantUnit?.closest('[data-equinox-role]');
      if (assistantUnit && (!marked || marked === assistantUnit)) mark(assistantUnit, "assistant", agent);
    }
    for (const element of document.querySelectorAll('main [data-talvt-turn-state]')) {
      if (!element.querySelector('[data-response-body]') && !element.querySelector('[data-user-message-bubble="true"]')) mark(element,"assistant",agent);
    }
    for (const element of document.querySelectorAll('main [data-message-author-role="user"]')) {
      if (!element.closest('[data-equinox-role]')) mark(element,"user",human);
    }
    for (const element of document.querySelectorAll('main [data-message-author-role="assistant"]')) {
      if (!element.closest('[data-equinox-role]')) mark(element,"assistant",agent);
    }
    for (const element of document.querySelectorAll('main [class*="Greeting-"]')) {
      if (element.querySelector('button,a,input,textarea,select,[role="button"],[contenteditable="true"]')) continue;
      element.setAttribute("data-equinox-initial", agentInitial);
      element.setAttribute("data-equinox-greeting", language === "tr" ? agent + " ile çalış" : "Work with " + agent);
    }
  };
  const world = window as Window & {__equinoxIdentityObserver?: MutationObserver; __equinoxIdentityFrame?: number};
  world.__equinoxIdentityObserver?.disconnect();
  if (world.__equinoxIdentityFrame !== undefined) cancelAnimationFrame(world.__equinoxIdentityFrame);
  const observer = new MutationObserver(() => {
    if (world.__equinoxIdentityFrame !== undefined) return;
    world.__equinoxIdentityFrame = requestAnimationFrame(() => { delete world.__equinoxIdentityFrame; sync(); });
  });
  // React may replace the html element during a route transition or reuse
  // existing message nodes by setting their data attributes. Observing the
  // document survives either operation without touching the provider's DOM.
  observer.observe(document,{childList:true,subtree:true,attributes:true,
    attributeFilter:["src","data-chatgpt-search-unit-key","data-user-message-bubble","data-response-body","data-talvt-turn-state"]});
  world.__equinoxIdentityObserver = observer;
  sync();
}

export function createEmbeddedChat(win: BrowserWindow, initialLanguage: "en" | "tr" = "en", initialIdentity: ChatIdentity = {name:"",avatar:null}, initialAccent = "#8B6CF0") {
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
  view.setBorderRadius(15);
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

  view.setVisible(false);
  let chatVisible = false;
  win.contentView.addChildView(view);
  const continuity = createNativeChatContinuity(win, view.webContents, () => chatVisible);
  const syncViewBackground = () => {
    if (!view.webContents.isDestroyed()) view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#161822" : "#f9fbff");
  };
  syncViewBackground();
  nativeTheme.on("updated", syncViewBackground);
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
  let identity = initialIdentity;
  let accent = initialAccent;
  const applyIdentity = () => {
    if (view.webContents.isDestroyed() || !isChatGPTOrigin(view.webContents.getURL())) return;
    const code = "(" + decorateProviderIdentity.toString() + ")(" + JSON.stringify(identity) + "," + JSON.stringify(language) + "," + JSON.stringify(accent) + ")";
    void view.webContents.executeJavaScriptInIsolatedWorld(1002, [{code}]).catch(() => {});
  };
  // Provider SPA navigation may finish before React mounts the new turn
  // nodes. Retry the identity observer at bounded mount intervals; the script
  // is idempotent and does not reconstruct or replace provider messages.
  const identityTimers = new Set<ReturnType<typeof setTimeout>>();
  const resyncIdentity = () => {
    for (const timer of identityTimers) clearTimeout(timer);
    identityTimers.clear();
    applyIdentity();
    for (const ms of [150, 700, 1_800]) {
      const timer = setTimeout(() => { identityTimers.delete(timer); applyIdentity(); }, ms);
      identityTimers.add(timer);
    }
  };
  view.webContents.on("did-navigate-in-page", resyncIdentity);
  view.webContents.on("did-finish-load", () => {
    if (view.webContents.isDestroyed()) return;
    try {
      if (new URL(view.webContents.getURL()).origin === CHATGPT) {
        void view.webContents.insertCSS(STYLE).then(resyncIdentity).catch(() => {});
      }
    } catch { /* Ignore intermediate navigation state. */ }
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    chatVisible = false;
    continuity.dispose();
    for (const timer of identityTimers) clearTimeout(timer);
    identityTimers.clear();
    nativeTheme.removeListener("updated", syncViewBackground);
    microphoneGranted = false;
    microphonePromptOpen = false;
    approvedFileWrites.clear();
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    isolated.removeListener("will-download", onDownload);
    if (!win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  };
  win.once("closed", dispose);
  void view.webContents.loadURL(CHATGPT + "/").catch(() => {});
  return {
    setBounds(bounds: Rectangle | null): void {
      if (disposed || view.webContents.isDestroyed()) return;
      chatVisible = Boolean(bounds);
      if (!bounds) {
        view.setVisible(false);
        if (view.webContents.isFocused() && !win.isDestroyed()) win.webContents.focus();
        return;
      }
      view.setBounds(bounds);
      view.setVisible(true);
    },
    setLanguage(value: "en" | "tr"): void { language = value; applyIdentity(); },
    setIdentity(value: ChatIdentity): void { identity = value; applyIdentity(); },
    setAccent(value: string): void { accent = value; applyIdentity(); },
    async requestMicrophone(): Promise<boolean> {
      const granted = await askMicrophonePermission();
      if (granted && !view.webContents.isDestroyed()) view.webContents.reload();
      return granted;
    },
    dispose,
  };
}
