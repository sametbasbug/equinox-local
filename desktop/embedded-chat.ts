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
html:root[data-equinox-surface] {
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
  html:root[data-equinox-surface] {
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
html:root[data-equinox-surface] body { background: var(--eq-canvas) !important; color: var(--eq-text); }
html:root[data-equinox-surface] ::selection { background: color-mix(in srgb, var(--eq-accent) 25%, transparent); }
html:root[data-equinox-surface] :focus-visible { outline-color: var(--eq-accent); }
/* Keep the real search, account, projects, history, and feature actions.
   The provider's own collapse and mobile layout still decide visibility. */
html:root[data-equinox-surface] aside[data-app-shell-left-panel-appearance] {
  background: var(--eq-sidebar) !important;
  border-inline-end: 0 !important;
}
html:root[data-equinox-surface] #app-shell-sidebar,
html:root[data-equinox-surface] #app-shell-sidebar > .bg-surface { background: var(--eq-sidebar) !important; }
@media (min-width: 769px) {
  html:root[data-equinox-surface] [data-app-shell-frame][data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="false"] {
    --app-shell-left-panel-width: var(--eq-sidebar-width) !important;
  }
  html:root[data-equinox-surface] [data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="false"] aside[data-app-shell-left-panel-appearance] > div:first-child {
    width: var(--eq-sidebar-width) !important;
    min-width: var(--eq-sidebar-width) !important;
    max-width: 100% !important;
  }
}
html:root[data-equinox-surface] #app-shell-sidebar :is(button,a)[aria-current="page"],
html:root[data-equinox-surface] #app-shell-sidebar :is(button,a)[data-selected] {
  background-color: var(--eq-active) !important;
}
html:root[data-equinox-surface] #app-shell-sidebar :is(button,a) { border-radius: 7px; }
/* Accounts with the provider's feature rail get the same single Equinox rail
   beside a conversation sidebar. Reflow the genuine feature buttons and the
   account controls inside the expanded sidebar. Collapsed/mobile layouts and
   any unrecognized provider structure keep the original provider layout. */
@media (min-width: 769px) {
  html:root[data-equinox-surface] [data-app-shell-frame][data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation) {
    --app-shell-left-panel-width: var(--eq-sidebar-width) !important;
  }
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar > div:has(> nav[data-app-navigation-rail]):has(> .sidebar-navigation) {
    position: relative;
    flex-direction: column !important;
    padding-bottom: 42px;
    min-height: 0;
    background: var(--eq-sidebar);
  }
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar > div > nav[data-app-navigation-rail] {
    flex: 0 0 auto !important;
    width: 100% !important;
    min-width: 0;
    position: static !important;
    padding: 5px 10px !important;
    border-bottom: 0;
  }
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > [data-appearance="plain"] {
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
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > [data-appearance="plain"] > div:not([data-appearance]) { width: auto !important; }
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > [data-appearance="plain"] > [data-appearance="plain"] {
    flex-direction: row !important;
    flex-wrap: wrap;
    gap: 3px !important;
    width: auto !important;
  }
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] button {
    width: 30px !important;
    height: 32px !important;
    flex: 0 0 30px !important;
  }
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > [data-appearance="plain"] > div.border-t {
    width: 1px !important;
    height: 18px;
    margin: 0 1px !important;
    border-top: 0;
    border-inline-start: 1px solid var(--eq-border);
  }
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > div:last-child {
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
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > div:last-child > div {
    flex-direction: row !important;
    justify-content: space-between;
  }
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar nav[data-app-navigation-rail] > div:last-child > div > div { width: auto !important; }
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar > div > .sidebar-navigation {
    border-radius: 0 !important;
    background: var(--eq-sidebar) !important;
  }
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) aside[data-app-shell-left-panel-appearance] > div:first-child { width: var(--eq-sidebar-width) !important; min-width: var(--eq-sidebar-width) !important; max-width: 100% !important; }
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) #app-shell-sidebar { width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
  html:root[data-equinox-surface] :where([data-app-shell-sidebar-open="true"][data-app-shell-feature-navigation="true"]:has(#app-shell-sidebar > div > nav[data-app-navigation-rail]):has(#app-shell-sidebar > div > .sidebar-navigation)) aside[data-app-shell-left-panel-appearance] > div:first-child > div:has(> #app-shell-sidebar) { width: 100% !important; min-width: 0 !important; max-width: 100% !important; }
}
/* Task-oriented workspace, not a second renderer of the provider conversation.
   The actual conversation tree, menus, streaming and message actions stay intact.
   The native application header above this view owns the Equinox branding. */
html:root[data-equinox-surface] main[data-app-shell-main-surface] {
  --thread-content-max-width: 48rem !important;
  --thread-content-compact-max-width: 48rem !important;
  --thread-content-expanded-max-width: 52rem !important;
  border-radius: 0 !important;
  background: var(--eq-canvas) !important;
}
html:root[data-equinox-surface] [data-app-shell-titlebar] {
  background: var(--eq-chrome);
}
html:root[data-equinox-surface] #app-shell-sidebar .sidebar-navigation {
  --height-token-row: 30px;
  --height-token-nav-row: 30px;
  background: var(--eq-sidebar) !important;
  font-size: 13px;
}
html:root[data-equinox-surface] #app-shell-sidebar .sidebar-navigation nav {
  padding-inline: 10px;
}
html:root[data-equinox-surface] #app-shell-sidebar .sidebar-navigation a[href="/"] > span {
  position: relative;
  font-size: 0 !important;
}
html:root[data-equinox-surface] #app-shell-sidebar .sidebar-navigation a[href="/"] > span > span:has(> svg):not(:has(button,a,input)) {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  overflow: hidden !important;
  clip-path: inset(50%) !important;
}
html:root[data-equinox-surface] #app-shell-sidebar .sidebar-navigation a[href="/"] > span::after {
  content: "Conversations";
  font-size: 14px;
  letter-spacing: -.02em;
  font-weight: 670;
}
html:root[data-equinox-surface]:lang(tr) #app-shell-sidebar .sidebar-navigation a[href="/"] > span::after {
  content: "Sohbetler";
}
html:root[data-equinox-surface] #app-shell-sidebar .sidebar-navigation a[href*="/c/"] {
  font-size: 13px;
  line-height: 1.4;
}
html:root[data-equinox-surface] :is([data-markdown-text-style="assistant-message"],[data-virtualized-turn-content] .markdown) {
  font-size: 15px;
  line-height: 1.7;
}
/* Keep the provider's genuine per-turn activity disclosure compact.
   The inline MCP App renders only data from its originating real tool call. */
html:root[data-equinox-surface] button[data-turn-disclosure-button] {
  min-height: 28px;
  padding: 3px 8px !important;
  border: 1px solid var(--eq-border) !important;
  border-radius: 6px !important;
  background: var(--eq-paper) !important;
  color: var(--eq-secondary) !important;
  font-size: 12px !important;
}
html:root[data-equinox-surface] button[data-turn-disclosure-button]:hover {
  background: var(--eq-active) !important;
}
html:root[data-equinox-surface] [class~="-ms-2"][class~="ps-2"] > [data-spacing="activity"] {
  border-inline-start: 2px solid var(--eq-border);
  padding-inline-start: 10px;
}
html:root[data-equinox-surface] [data-spacing="activity"] [class~="group/activity-header"] {
  gap: 6px;
}
html:root[data-equinox-surface] [data-spacing="activity"] [class~="group/activity-header"] [class~="text-size-chat"] {
  font-size: 13px;
}
html:root[data-equinox-surface] [data-markdown-text-style="assistant-message"] [data-code-block="true"] {
  background: var(--eq-paper) !important;
  border: 1px solid var(--eq-border) !important;
  border-radius: 9px !important;
}
html:root[data-equinox-surface] [data-markdown-text-style="assistant-message"] [data-code-block="true"] pre {
  font-size: 13px;
  line-height: 1.65;
}
html:root[data-equinox-surface] [data-markdown-text-style="assistant-message"] table {
  font-size: 13px;
  line-height: 1.5;
}
html:root[data-equinox-surface] [data-user-message-bubble="true"] {
  font-size: 15px;
  line-height: 1.65;
}
html:root[data-equinox-surface] [data-virtualized-turn-content] .markdown :is(pre,table) {
  border-radius: 7px;
  border-color: var(--eq-border);
}
html:root[data-equinox-surface] [data-virtualized-turn-content] .markdown pre {
  border: 1px solid var(--eq-border);
  background: var(--eq-paper);
}
/* Before identity decoration completes, a provider-owned user bubble
   still has the quiet V2 surface rather than the retired left accent stripe. */
html:root[data-equinox-surface] .bg-user-message.text-user-message {
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
html:root[data-equinox-surface] :is([data-virtualized-turn-content], [class~="group/user-message"]) :is(div,section):has(> .bg-user-message.text-user-message),
html:root[data-equinox-surface] [class~="group/user-message"]:has(> [data-user-message-bubble="true"]) {
  justify-content: flex-start !important;
  align-items: flex-start !important;
}
html:root[data-equinox-surface] [data-message-author-role="user"] {
  align-self: stretch !important;
  max-width: 100% !important;
}
html:root[data-equinox-surface] [data-message-author-role="user"] :is(div,section):has(> .bg-user-message.text-user-message) {
  justify-content: flex-end !important;
  align-items: flex-end !important;
}
/* The same native input, attachment and action controls stay mounted. A
   two-row editor matches the Codex reference in both new and ongoing chats. */
html:root[data-equinox-surface] form[data-chatgpt-composer] [class*="ComposerSurface-"] {
  background: var(--eq-editor) !important;
  border: 1px solid var(--eq-border) !important;
  border-radius: 17px !important;
  box-shadow: var(--eq-editor-shadow) !important;
  --composer-layout-surface-background: var(--eq-editor);
}
html:root[data-equinox-surface] form[data-chatgpt-composer] [data-composer-body]:has([data-composer-footer-responsive][data-composer-rows="responsive"]) {
  height: auto !important;
}
html:root[data-equinox-surface] form[data-chatgpt-composer] [data-composer-footer-responsive][data-composer-rows="responsive"] {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) auto !important;
  grid-template-rows: minmax(47px, auto) auto !important;
  align-items: center;
  gap: 2px 8px !important;
  padding: 9px 10px !important;
  height: auto !important;
}
html:root[data-equinox-surface] [data-composer-footer-responsive][data-composer-rows="responsive"] > [class*="FooterInput-"] {
  grid-column: 1 / -1 !important;
  grid-row: 1 !important;
  align-self: stretch;
  min-width: 0;
  padding: 5px 8px;
}
html:root[data-equinox-surface] [data-composer-footer-responsive][data-composer-rows="responsive"] > [data-composer-leading-controls] {
  grid-column: 1 !important;
  grid-row: 2 !important;
  justify-self: start;
}
html:root[data-equinox-surface] [data-composer-footer-responsive][data-composer-rows="responsive"] > [data-composer-trailing-controls] {
  grid-column: 2 !important;
  grid-row: 2 !important;
  justify-self: end;
  background: transparent !important;
}
html:root[data-equinox-surface] [data-composer-footer-responsive][data-composer-rows="responsive"] > [data-composer-expansion-control] {
  grid-column: 2 !important;
  grid-row: 1 !important;
  align-self: start;
  justify-self: end;
}
html:root[data-equinox-surface] [data-composer-footer-responsive][data-composer-rows="responsive"] .ProseMirror {
  min-height: 40px;
}
/* Keep the ongoing composer compact while preserving native attachment,
   expansion and textarea growth. Inline runs stay inside agent messages. */
html:root[data-equinox-surface] form[data-chatgpt-composer]:not([data-composer-placement="home"]) [data-composer-footer-responsive][data-composer-rows="responsive"] {
  grid-template-rows: minmax(36px, auto) auto !important;
  padding-block: 6px !important;
}
html:root[data-equinox-surface] form[data-chatgpt-composer]:not([data-composer-placement="home"]) [data-composer-footer-responsive][data-composer-rows="responsive"] .ProseMirror {
  min-height: 32px;
}
@media (max-height: 520px) {
  html:root[data-equinox-surface] form[data-chatgpt-composer] [data-composer-footer-responsive][data-composer-rows="responsive"] {
    grid-template-rows: minmax(36px, auto) auto !important;
  }
  html:root[data-equinox-surface] form[data-chatgpt-composer] [data-composer-footer-responsive][data-composer-rows="responsive"] .ProseMirror {
    min-height: 32px;
  }
}
html:root[data-equinox-surface] .thread-scroll-container {
  scroll-padding-top: max(12px, var(--app-shell-titlebar-height, 44px));
}
html:root[data-equinox-surface] form[data-chatgpt-composer] [data-composer-markdown] p[data-empty-paragraph="true"][data-placeholder]::before {
  content: "Describe a task or ask a question..." !important;
  color: var(--eq-muted) !important;
}
html:root[data-equinox-surface]:lang(tr) form[data-chatgpt-composer] [data-composer-markdown] p[data-empty-paragraph="true"][data-placeholder]::before {
  content: "Bir görev tarif et veya soru sor..." !important;
}
/* The form and heading stay in the provider's own layout. These treatments are
   applied only to a recognized, empty home region. */
html:root[data-equinox-surface="home"] [data-equinox-greeting] {
  position: relative;
  isolation: isolate;
  display: grid !important;
  width: min(100%, var(--eq-home-width));
  grid-template-columns: max-content minmax(0, 1fr);
  align-items: center;
  justify-items: start;
  gap: clamp(16px, 3vw, 30px);
  min-height: 136px;
  padding: 10px 0 !important;
  text-align: start;
}
html:root[data-equinox-surface="home"] [data-equinox-greeting] > div {
  position: absolute !important;
  width: 1px !important;
  height: 1px !important;
  overflow: hidden !important;
  clip-path: inset(50%) !important;
}
html:root[data-equinox-surface="home"] [data-equinox-greeting]::before {
  content: attr(data-equinox-initial);
  display: grid;
  place-items: center;
  z-index: 1;
  width: 112px;
  height: 112px;
  border: 1px solid var(--eq-border);
  border-radius: 50%;
  color: var(--eq-accent);
  background: var(--eq-active) var(--eq-agent-avatar, none) center / cover no-repeat;
  font-size: 38px;
  font-weight: 580;
}
html:root[data-equinox-surface="home"][data-equinox-agent-photo="true"] [data-equinox-greeting]::before { color: transparent; }
html:root[data-equinox-surface="home"] [data-equinox-greeting]::after {
  content: attr(data-equinox-greeting);
  z-index: 1;
  color: var(--eq-text);
  font-size: clamp(34px, 4.1vw, 62px);
  line-height: 1.04;
  letter-spacing: -.054em;
  font-weight: 630;
}
html:root[data-equinox-surface="home"] [data-equinox-greeting-heading] {
  row-gap: 0;
}
html:root[data-equinox-surface="home"] [data-equinox-greeting-heading],
html:root[data-equinox-surface="home"] [data-equinox-greeting-heading] > * {
  font-size: 0 !important;
  line-height: 0 !important;
}
html:root[data-equinox-surface="home"] [data-equinox-greeting-heading]::before {
  grid-column: 1;
  grid-row: 1;
  line-height: 1;
}
html:root[data-equinox-surface="home"] [data-equinox-greeting-heading]::after {
  grid-column: 2;
  grid-row: 1;
}
html:root[data-equinox-surface="home"][data-equinox-home-style="type"] [data-equinox-greeting] {
  grid-template-columns: minmax(0, 1fr) max-content;
  min-height: 112px;
}
html:root[data-equinox-surface="home"][data-equinox-home-style="type"] [data-equinox-greeting]::before {
  grid-column: 2;
  grid-row: 1;
  width: 54px;
  height: 54px;
  border-radius: 15px;
  font-size: 23px;
}
html:root[data-equinox-surface="home"][data-equinox-home-style="type"] [data-equinox-greeting]::after {
  grid-column: 1;
  grid-row: 1;
  padding-inline-start: 20px;
  font-family: ui-serif, Georgia, serif;
  font-weight: 500;
}
html:root[data-equinox-surface="home"][data-equinox-home-style="type"] [data-equinox-home] { position: relative; }
html:root[data-equinox-surface="home"][data-equinox-home-style="type"] [data-equinox-home]::before {
  content: "";
  position: absolute;
  inset-inline-start: 0;
  inset-block-start: 50%;
  width: 5px;
  height: 68px;
  transform: translateY(-50%);
  background: repeating-linear-gradient(to bottom, var(--eq-accent) 0 8px, transparent 8px 12px);
  pointer-events: none;
}
@media (max-width: 1020px), (max-height: 640px) {
  html:root[data-equinox-surface="home"] [data-equinox-greeting] { min-height: 82px; }
  html:root[data-equinox-surface="home"] [data-equinox-greeting]::before { width: 64px; height: 64px; font-size: 26px; }
  html:root[data-equinox-surface="home"] [data-equinox-greeting]::after { font-size: clamp(25px, 3.5vw, 42px); }
}
/* The existing turn wrappers carry the original provider messages and activity. */
html:root[data-equinox-surface="thread"] [data-equinox-role] {
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
html:root[data-equinox-surface="thread"] [data-equinox-role]::before {
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
html:root[data-equinox-surface="thread"] [data-equinox-role]::after {
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
html:root[data-equinox-surface="thread"] [data-equinox-role="user"] {
  padding-inline-start: 0 !important;
  padding-inline-end: var(--eq-author-offset) !important;
  display: flex;
  flex-direction: column;
  align-items: flex-end !important;
  text-align: start;
}
html:root[data-equinox-surface="thread"] [data-equinox-role="user"]::before {
  inset-inline-start: auto;
  inset-inline-end: 0;
  background-image: var(--eq-human-avatar, none);
}
html:root[data-equinox-surface="thread"] [data-equinox-role="user"]::after {
  inset-inline-start: auto;
  inset-inline-end: var(--eq-author-offset);
  text-align: right;
  color: var(--eq-accent);
}
html:root[data-equinox-surface="thread"] [data-equinox-role="user"] [class~="group/user-message"] {
  align-items: flex-end !important;
  justify-content: flex-end !important;
  width: 100%;
}
html:root[data-equinox-surface="thread"] [data-equinox-role="user"] :is([data-user-message-bubble="true"],.bg-user-message.text-user-message) {
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
html:root[data-equinox-surface="thread"] [data-equinox-role="assistant"] {
  padding-inline-start: var(--eq-author-offset) !important;
  padding-inline-end: 0 !important;
}
html:root[data-equinox-surface="thread"] [data-equinox-role="assistant"]::before {
  inset-inline-start: 0;
  background-image: var(--eq-agent-avatar, none);
}
html:root[data-equinox-surface="thread"][data-equinox-agent-photo="true"] [data-equinox-role="assistant"]::before,
html:root[data-equinox-surface="thread"][data-equinox-human-photo="true"] [data-equinox-role="user"]::before { color: transparent; }

html:root[data-equinox-surface="thread"] [data-equinox-role="assistant"]::after {
  inset-inline-start: var(--eq-author-offset);
  color: var(--eq-text);
}
/* Plain agent prose, like the approved reference. Only genuine tool
   results receive framed surfaces inside the original assistant turn. */
html:root[data-equinox-surface="thread"] [data-equinox-role="assistant"] [data-response-body] {
  max-width: 100%;
  min-width: 0;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0;
  background: transparent !important;
  box-shadow: none !important;
}
html:root[data-equinox-surface="thread"] [data-equinox-role="assistant"] [data-markdown-text-style="assistant-message"] {
  max-width: 72ch;
  line-height: 1.67;
  font-size: 15px;
}
html:root[data-equinox-surface="thread"] [data-equinox-role="assistant"] [data-markdown-text-style="assistant-message"] :is(h1,h2,h3) {
  letter-spacing: -.024em;
  color: var(--eq-text);
}
/* Provider's measured table width (880px) can exceed the padded card
   (788px). Keep the semantic table and constrain its columns to its reader. */
html:root[data-equinox-surface="thread"] [data-equinox-role="assistant"] [class*="TableFrame-"] {
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
  margin-inline: 0 !important;
}
html:root[data-equinox-surface="thread"] [data-equinox-role="assistant"] [class*="TableViewport-"] {
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
  overflow-x: auto !important;
  /* Native TableFrame aligns a narrow table from the right edge; reverse
     only the scroll container, never the table's own text or columns. */
  direction: rtl;
}
html:root[data-equinox-surface="thread"] [data-equinox-role="assistant"] [data-markdown-text-style="assistant-message"] table {
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
  direction: ltr;
}
html:root[data-equinox-surface="thread"] [data-equinox-role="assistant"] [data-markdown-text-style="assistant-message"] :is(th,td) {
  overflow-wrap: anywhere;
}
html:root[data-equinox-surface="thread"] [data-equinox-role="assistant"] [data-markdown-text-style="assistant-message"] [data-code-block="true"] {
  max-width: 100% !important;
  overflow: hidden;
}

/* Clear, quiet reading line for the real per-tool MCP App card. */
html:root[data-equinox-surface="thread"] [data-equinox-role="assistant"] iframe {
  max-width: 100%;
  border-radius: 8px;
}
html:root[data-equinox-surface] #app-shell-sidebar :is(a,button):hover {
  background-color: color-mix(in srgb, var(--eq-accent) 7%, var(--eq-sidebar));
}
html:root[data-equinox-surface] #app-shell-sidebar :is(a,button)[aria-current="page"] {
  color: var(--eq-text) !important;
}
html:root[data-equinox-surface] #app-shell-sidebar .sidebar-navigation [role="heading"] {
  margin-block: 12px 4px;
  font-size: 11px;
  font-weight: 650;
  letter-spacing: .02em;
  color: var(--eq-secondary);
}
html:root[data-equinox-surface] #app-shell-sidebar .sidebar-navigation nav a[href*="/c/"] {
  min-height: 29px;
  padding-inline: 9px;
}
html:root[data-equinox-surface] #app-shell-sidebar .sidebar-navigation nav :is(a,button):focus-visible {
  outline: 2px solid var(--eq-accent);
  outline-offset: -1px;
}
html:root[data-equinox-surface] form[data-chatgpt-composer]:focus-within [class*="ComposerSurface-"] {
  border-color: color-mix(in srgb, var(--eq-accent) 58%, var(--eq-border)) !important;
}
@media (max-width: 700px) {
  html:root[data-equinox-surface="thread"] [data-equinox-role] { --eq-avatar-size: 26px; --eq-author-offset: 35px; }
}
/* Home suggestions remain real, selectable provider controls. Compact
   only the ordinary small button lists below the composer; never restyle
   a Work/onboarding takeover, attachment picker or arbitrary content. */
html:root[data-equinox-surface] [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover])):has(form[data-composer-placement="home"]) [class*="BelowComposer-"] :is(div,ul):has(> :is(button,a):nth-child(2)):not(:has(> :not(:is(button,a)))):not(:has(> :nth-child(5))) {
  display: flex !important;
  flex-direction: row !important;
  flex-wrap: wrap !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 6px !important;
  padding-block: 3px !important;
}
html:root[data-equinox-surface] [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover])):has(form[data-composer-placement="home"]) [class*="BelowComposer-"] :is(div,ul):has(> :is(div,li):nth-child(2) > :is(button,a)):not(:has(> :not(:is(div,li)))):not(:has(> :nth-child(5))):not(:has(> :is(div,li) > :not(:is(button,a)))) {
  display: flex !important;
  flex-direction: row !important;
  flex-wrap: wrap !important;
  justify-content: center !important;
  gap: 6px !important;
  padding-block: 3px !important;
}
html:root[data-equinox-surface] [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover])):has(form[data-composer-placement="home"]) [class*="BelowComposer-"] :is(button,a):has(> svg):not(:has(input,textarea)) {
  min-height: 30px !important;
  padding-block: 4px !important;
  font-size: 12px !important;
}
html:root[data-equinox-surface] [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover])):has(form[data-composer-placement="home"]) [class*="BelowComposer-"] :is(div,ul):has(> :is(button,a):nth-child(2)):not(:has(> :not(:is(button,a)))):not(:has(> :nth-child(5))) > :is(button,a) {
  width: auto !important;
  min-width: 0;
  min-height: 32px !important;
  padding: 5px 10px !important;
  border: 1px solid var(--eq-border) !important;
  border-radius: 7px !important;
  font-size: 12px !important;
}
@media (min-height: 460px) {
  html:root[data-equinox-surface] [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover], [data-composer-expanded])):has(form[data-composer-placement="home"]) [class*="StreamedComposer-"] {
    grid-template-rows: auto auto auto !important;
    align-content: center;
    row-gap: 15px;
    padding-block: 18px 60px;
  }
  html:root[data-equinox-surface] [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover], [data-composer-expanded])):has(form[data-composer-placement="home"]) [class*="GreetingRegion-"] {
    align-self: end;
    justify-content: center !important;
    justify-self: center;
    width: min(calc(100% - 32px), var(--eq-home-width));
    padding: 0 0 5px !important;
  }
}
html:root[data-equinox-surface] [class~="group/home-composer-layout"]:not(:has([data-homepage-takeover], [data-composer-expanded])):has(form[data-composer-placement="home"]) {
  --thread-content-max-width: var(--eq-home-width) !important;
  --thread-content-compact-max-width: var(--eq-home-width) !important;
  --thread-content-expanded-max-width: var(--eq-home-width) !important;
}

`;

// The provider is a child of the existing trusted Control Center window.
// Its separate session and webPreferences never receive the Control Center preload.
type ChatIdentity = {name:string;avatar:string|null};

type HomeComposition = "portrait" | "type";
export type EmbeddedChatLoadState = "loading" | "ready" | "offline" | "failed";

function decorateProviderIdentity(update: {
  identity: ChatIdentity; language: "en" | "tr"; accent: string; composition: HomeComposition;
  pathname: string;
} | null, generation: number): void {
  const world = window as Window & {__equinoxDecoration?: {generation: number; pathname: string | undefined; dispose: () => void}};
  if (world.__equinoxDecoration && world.__equinoxDecoration.generation > generation) return;
  // A queued update for a previous route must not remove the active decoration.
  if (update && location.pathname !== update.pathname) return;
  const root = document.documentElement;
  const homeRoute = update?.pathname === "/";
  const threadRoute = !!update && /^\/(?:g\/[A-Za-z0-9_-]{8,160}\/)?c\/[A-Za-z0-9-]{8,160}\/?$/u.test(update.pathname);
  let threadRecognized = threadRoute || (homeRoute && world.__equinoxDecoration?.pathname === update?.pathname &&
    root.getAttribute("data-equinox-surface") === "thread");
  world.__equinoxDecoration?.dispose();
  const decoration = { generation, pathname: update?.pathname, dispose: () => {} };
  world.__equinoxDecoration = decoration;
  if (!update || (!homeRoute && !threadRoute)) return;

  const options = update;
  const { identity, language, accent, composition, pathname } = options;
  const agent = identity.name.trim();
  const human = language === "tr" ? "Sen" : "You";
  const agentInitial = Array.from(agent || "E")[0]?.toLocaleUpperCase(language) ?? "E";
  const url = (value: string) => "url(" + JSON.stringify(value) + ")";
  const agentImage = identity.avatar && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/u.test(identity.avatar) ? url(identity.avatar) : "none";
  const userUnit = '[data-chatgpt-search-unit-key$=":user"]';
  const userTurn = '[data-message-author-role="user"],:is(article,section)[data-turn="user"][data-testid]';
  const userBubble = '[data-user-message-bubble="true"],.bg-user-message.text-user-message';
  const userMessage = userTurn + "," + userBubble;
  const assistantMessage = '[data-chatgpt-search-unit-key$=":assistant"],[data-message-author-role="assistant"],:is(article,section)[data-turn="assistant"][data-testid]';
  const responseBody = '[data-response-body],[data-markdown-text-style="assistant-message"]';
  const explicitMessage = [userUnit, userMessage, assistantMessage, responseBody].join(",");
  const speakerHeading = 'h4,[role="heading"][aria-level="4"]';
  const messageSelector = explicitMessage + "," + speakerHeading;
  const turnWrapper = 'article,section,[data-testid^="conversation-turn-"],[data-virtualized-turn-content],[data-content-search-unit-key]';
  const inactiveRegion = 'dialog,[role="dialog"],[role="menu"],[hidden],[aria-hidden="true"],nav,aside';
  const greetingSelector = '[class*="Greeting-"]';
  const headingSelector = 'h1,[role="heading"][aria-level="1"]';
  const formSelector = "form[data-chatgpt-composer]";
  const homeLayoutSelector = '[class~="group/home-composer-layout"]';
  const homeChangeSelector = [greetingSelector, headingSelector, "form", "[data-homepage-takeover]"].join(",");
  // Provider conversation routes sometimes replace the app-shell main with
  // an ordinary <main>. Keep route/identity guards in syncSurface instead of
  // losing all avatars and message styling when that attribute is absent.
  const mainSelector = "[data-app-shell-main-surface], main, [role=main]";
  const profileSelector = '#app-shell-sidebar';
  const marker = '[data-equinox-role],[data-equinox-greeting],[data-equinox-home]';
  const marks = new Set<Element>();
  const changed = new Set<Element>();
  const visited = new Set<Element>();
  let main: Element | null = null;
  let profile: Element | null = null;
  let frame = 0;
  let profileChanged = true;
  let shellChanged = true;
  let discoveringTranscript = false;
  let homeChanged = true;
  let greeting: Element | null = null;
  let greetingRegion: Element | null = null;
  const homeRetries: number[] = [];

  function clearMark(element: Element) {
    for (const attribute of ["role", "author", "initial", "greeting", "greeting-heading", "home"]) element.removeAttribute("data-equinox-" + attribute);
    marks.delete(element);
  }

  function mark(element: Element, role: "user" | "assistant") {
    if (!main?.contains(element) || element === main || element.closest(inactiveRegion)) return;
    const current = element.closest("[data-equinox-role]");
    if (current && current !== element) return;
    const nested = [...element.querySelectorAll("[data-equinox-role]")];
    if (nested.some(turn => turn.getAttribute("data-equinox-role") !== role)) return;
    for (const turn of nested) clearMark(turn);
    element.setAttribute("data-equinox-role", role);
    element.setAttribute("data-equinox-author", role === "assistant" ? (agent || "Equinox") : human);
    element.setAttribute("data-equinox-initial", role === "assistant" ? agentInitial : human.charAt(0));
    marks.add(element);
  }

  function speakerRole(heading: Element) {
    // Some provider renderers supply a visually hidden heading in place of
    // the normal author attributes. Never interpret a visible message heading.
    const rect = heading.getBoundingClientRect();
    if (!heading.getClientRects().length ||
      (rect.width > 4 && rect.height > 4 && !heading.classList.contains("sr-only"))) return null;
    const label = heading.textContent?.trim().replace(/:$/u, "");
    if (label === "You said") return "user";
    if (label === "ChatGPT said") return "assistant";
    return null;
  }

  function syncMessage(evidence: Element) {
    if (!main?.contains(evidence)) return;
    if (evidence.matches(speakerHeading)) {
      const speaker = speakerRole(evidence);
      const wrapper = speaker ? evidence.closest(turnWrapper) : null;
      if (!speaker || !wrapper || wrapper.querySelector(explicitMessage)) return;
      // A common wrapper sometimes owns both sides of the exchange.
      const headings = [...wrapper.querySelectorAll(speakerHeading)].filter(heading => speakerRole(heading));
      if (headings.length === 1) mark(wrapper, speaker);
      return;
    }
    const user = evidence.closest(userUnit);
    if (user && (user.matches(userMessage) || user.querySelector(userMessage))) {
      mark(user, "user");
      return;
    }
    if (evidence.matches(userMessage)) {
      const wrapper = evidence.closest('[data-message-author-role="user"]') ??
        evidence.closest(userTurn) ?? evidence.closest('[class~="group/user-message"]');
      if (wrapper) mark(wrapper, "user");
      else {
        const parent = evidence.parentElement;
        if (parent && !parent.querySelector(assistantMessage + "," + responseBody)) mark(parent, "user");
      }
      return;
    }
    const isResponseBody = evidence.matches(responseBody);
    if (!isResponseBody && !evidence.matches(assistantMessage)) return;
    const attributed = evidence.closest(assistantMessage);
    const response = attributed ?? evidence.closest('[data-content-search-unit-key]') ?? evidence.parentElement;
    // A provider turn can contain both speakers. Only decorate an answer-only wrapper.
    if (response && response !== main && !response.matches(userMessage) && !response.querySelector(userMessage)) {
      mark(response, "assistant");
    } else if (isResponseBody) {
      mark(evidence, "assistant");
    }
  }

  function syncBranch(branch: Element) {
    if (!main?.contains(branch) || visited.has(branch)) return;
    visited.add(branch);
    if (branch.matches(messageSelector)) syncMessage(branch);
    for (const element of branch.querySelectorAll(messageSelector)) syncMessage(element);
  }

  function syncProfile() {
    if (!profile) return; // The sidebar can unmount while the account is still signed in.
    const image = profile?.querySelector<HTMLImageElement>('nav[data-app-navigation-rail] button[aria-haspopup="menu"] img')
      ?? profile?.querySelector<HTMLImageElement>('button[aria-haspopup="menu"] img[class~="rounded-full"]');
    const src = image?.currentSrc || image?.getAttribute("src") || "";
    const valid = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/u.test(src) || /^(?:blob:)?https:\/\//u.test(src);
    root.style.setProperty("--eq-human-avatar", valid ? url(src) : "none");
    root.setAttribute("data-equinox-human-photo", String(valid));
  }

  function syncSurface() {
    if (threadRoute) {
      // The admitted conversation route owns the base theme. Speaker styling
      // still requires message evidence, which may mount in a separate region.
      if (root.getAttribute("data-equinox-surface") !== "thread") {
        root.setAttribute("data-equinox-surface", "thread");
      }
      return;
    }

    // A first turn can mount before the navigation from home to /c/ completes,
    // and can stay on / for temporary chats. Trust the actual transcript.
    if (!homeChanged && (threadRecognized || changed.size === 0)) return;
    const temporary = new URLSearchParams(location.search).get("temporary-chat") === "true";
    const visible = (element: Element) => element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility === "visible" &&
      !element.closest('[hidden],[aria-hidden="true"],dialog,[role="dialog"],nav,aside');
    // Home can keep the last transcript mounted and render the greeting
    // as a sibling of the composer. Resolve the active form and heading
    // from the visible signed-in surface instead of the transcript's root.
    const forms = [...document.querySelectorAll(formSelector)].filter(element =>
      visible(element) && !element.closest("[data-homepage-takeover]") &&
      (element.matches('[data-composer-placement="home"]') || element.closest(homeLayoutSelector)),
    );
    const home = Boolean(profile && forms.length === 1);
    const interactive = 'button,a,input,textarea,select,[role="button"],[contenteditable="true"]';
    const isPlainGreeting = (element: Element) => visible(element) && !element.querySelector(interactive);
    const greetingScope = home && !temporary ? document : null;
    const primaryHeadings = greetingScope ? [...greetingScope.querySelectorAll(greetingSelector)].filter(
      element => Boolean(element.closest('[class*="GreetingRegion-"]') && isPlainGreeting(element)),
    ) : [];
    const alternateHeadings = primaryHeadings.length !== 1 && greetingScope
      ? [...greetingScope.querySelectorAll(headingSelector)].filter(isPlainGreeting) : [];
    const candidate = primaryHeadings.length === 1 ? primaryHeadings[0]
      : alternateHeadings.length === 1 ? alternateHeadings[0] : null;
    // A visible home form and heading are stronger evidence than old turns
    // that the provider leaves mounted during the transition back to home.
    if (!candidate && main?.querySelector(explicitMessage)) {
      if (!threadRecognized) {
        threadRecognized = true;
        changed.add(main);
      }
      root.setAttribute("data-equinox-surface", "thread");
      return;
    }
    if (threadRecognized && !home) return;
    threadRecognized = false;
    if (home) root.setAttribute("data-equinox-surface", "home");
    else root.removeAttribute("data-equinox-surface");

    if (greeting) clearMark(greeting);
    if (greetingRegion) clearMark(greetingRegion);
    greeting = greetingRegion = null;
    if (!candidate) return;
    const region = candidate.closest('[class*="GreetingRegion-"]');
    greeting = candidate;
    greetingRegion = region;
    if (primaryHeadings.length !== 1) candidate.setAttribute("data-equinox-greeting-heading", "");
    candidate.setAttribute("data-equinox-initial", agentInitial);
    candidate.setAttribute("data-equinox-greeting", agent
      ? (language === "tr" ? agent + " ile çalış" : "Work with " + agent)
      : (language === "tr" ? "Nasıl yardımcı olabilirim?" : "How can I help?"));
    marks.add(candidate);
    if (region) {
      region.setAttribute("data-equinox-home", "");
      marks.add(region);
    }
  }

  function flush() {
    frame = 0;
    if (world.__equinoxDecoration?.generation !== generation) return;
    if (!root.isConnected || location.pathname !== pathname) {
      // A same-document navigation can reach the renderer before Electron
      // reports it. Reconcile from this document rather than dropping styling.
      decorateProviderIdentity({ ...options, pathname: location.pathname }, generation);
      return;
    }
    if (shellChanged || (discoveringTranscript && changed.size > 0)) bindRoots();
    if (profileChanged) syncProfile();
    syncSurface();
    if (threadRecognized) {
      for (const branch of changed) syncBranch(branch);
    }
    changed.clear();
    visited.clear();
    shellChanged = profileChanged = homeChanged = false;
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      const target = record.target;
      if (!(target instanceof Element)) { shellChanged = true; continue; }
      if (!main?.isConnected || (profile && !profile.isConnected) || (!main?.contains(target) && !profile?.contains(target))) {
        shellChanged = true;
        continue;
      }
      if (profile?.contains(target)) {
        profileChanged = true;
        continue;
      }
      if (!main?.contains(target)) continue;
      if (record.type === "attributes") {
        const oldMark = target.closest(marker);
        if (oldMark && oldMark.hasAttribute("data-equinox-role")) {
          clearMark(oldMark);
          const parent = oldMark.parentElement;
          // Re-evaluate the reused wrapper, without walking up to the whole thread.
          changed.add(parent?.matches(messageSelector) ? parent : oldMark);
        }
        changed.add(target);
        if (homeRoute && ["data-chatgpt-composer", "data-composer-placement", "data-homepage-takeover"].includes(record.attributeName ?? "")) {
          homeChanged = true;
        }
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(messageSelector) || !node.closest("[data-equinox-role]")) changed.add(node);
        if (homeRoute && (node.matches(homeChangeSelector) || node.querySelector(homeChangeSelector))) homeChanged = true;
      }
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue;
        if (node.matches(marker)) clearMark(node);
        for (const element of node.querySelectorAll(marker)) clearMark(element);
        const wrapper = target.closest('[data-equinox-role]');
        if (wrapper && (node.matches(messageSelector) || node.querySelector(messageSelector))) {
          clearMark(wrapper);
          changed.add(wrapper);
        }
        if (homeRoute && (node.matches(homeChangeSelector) || node.querySelector(homeChangeSelector))) homeChanged = true;
      }
      const wrapper = target.closest('[data-chatgpt-search-unit-key$=":user"],[data-content-search-unit-key],[data-message-author-role]');
      if (wrapper && !wrapper.hasAttribute("data-equinox-role")) changed.add(wrapper);
    }
    if (!frame && (shellChanged || profileChanged || homeChanged || changed.size)) frame = requestAnimationFrame(flush);
  });

  function bindRoots() {
    const shell = document.querySelector("[data-app-shell-main-surface]") ?? document.querySelector(mainSelector);
    const evidence = [...document.querySelectorAll(messageSelector)].find(element =>
      !element.closest(inactiveRegion) &&
      (element.matches(speakerHeading) ? speakerRole(element) : element.getClientRects().length > 0),
    );
    const thread = document.getElementById("thread");
    const nextMain = shell && (!evidence || shell.contains(evidence)) ? shell
      : thread && (!evidence || thread.contains(evidence)) ? thread
      : evidence ? document.body : shell;
    const nextProfile = document.querySelector(profileSelector);
    const nextDiscovery = threadRoute && !evidence;
    if (nextMain === main && nextProfile === profile && nextDiscovery === discoveringTranscript && (main || profile)) return;
    if (main !== nextMain) {
      for (const element of marks) clearMark(element);
      changed.clear();
      if (nextMain) changed.add(nextMain);
      homeChanged = true;
    }
    if (profile !== nextProfile) homeChanged = true;
    main = nextMain;
    profile = nextProfile;
    discoveringTranscript = nextDiscovery;
    profileChanged = true;
    observer.disconnect();
    if (!main || discoveringTranscript) {
      // The first turn can mount beside the shell's main, not inside it.
      // Once the actual transcript is found, narrow the observer
      // back to its subtree and the host's direct wrapper replacements.
      observer.observe(document, {childList: true, subtree: true, attributes: true, attributeFilter: [
        "data-chatgpt-search-unit-key", "data-user-message-bubble", "data-response-body", "data-markdown-text-style",
        "data-message-author-role", "data-turn", "data-testid",
      ]});
      return;
    }
    if (profile) observer.observe(profile, {childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset"]});
    observer.observe(main, {childList: true, subtree: true, attributes: true, attributeFilter: [
      "data-chatgpt-search-unit-key", "data-user-message-bubble", "data-response-body", "data-markdown-text-style",
      "data-message-author-role", "data-turn", "data-testid",
      "data-chatgpt-composer", "data-composer-placement", "data-homepage-takeover",
    ]});
    // Observe wrapper replacement along each ancestry path, not its descendants.
    for (const start of [main, profile]) for (let parent = start?.parentNode; parent; parent = parent.parentNode) {
      if (parent !== main && parent !== profile) observer.observe(parent, {childList: true});
    }
  }

  root.style.setProperty("--eq-user-accent", accent);
  root.style.setProperty("--eq-agent-avatar", agentImage);
  root.setAttribute("data-equinox-agent-photo", String(agentImage !== "none"));
  root.setAttribute("data-equinox-home-style", composition);
  decoration.dispose = () => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    for (const timer of homeRetries) window.clearTimeout(timer);
    for (const element of marks) clearMark(element);
    for (const name of ["surface", "home-style", "agent-photo", "human-photo"]) root.removeAttribute("data-equinox-" + name);
    for (const name of ["user-accent", "agent-avatar", "human-avatar"]) root.style.removeProperty("--eq-" + name);
  };
  flush();
  if (homeRoute && !greeting) {
    // The first DOM commit may still be showing the previous page. These
    // bounded retries cover provider hydration that changes visibility only.
    for (const delay of [150, 600, 1_500, 3_000]) {
      homeRetries.push(window.setTimeout(() => {
        if (greeting || world.__equinoxDecoration !== decoration) return;
        homeChanged = shellChanged = true;
        if (!frame) frame = requestAnimationFrame(flush);
      }, delay));
    }
  }
}

export function createEmbeddedChat(win: BrowserWindow, initialLanguage: "en" | "tr" = "en", initialIdentity: ChatIdentity = {name:"",avatar:null}, initialAccent = "#8B6CF0", composition: HomeComposition = "portrait",
  onLoadState: (value: EmbeddedChatLoadState) => void = () => {}) {
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
  let attached = false;
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
  let bounds: Rectangle | null = null;
  let loadState: EmbeddedChatLoadState = "loading";
  let decorationGeneration = 0;
  let decoratedPath: string | null = null;
  const applyIdentity = (visible = chatVisible, navigationURL?: string) => {
    if (view.webContents.isDestroyed()) return;
    const url = navigationURL ?? view.webContents.getURL();
    if (!isChatGPTOrigin(url)) return;
    decoratedPath = visible ? new URL(url).pathname : null;
    const update = decoratedPath === null ? null : { identity, language, accent, composition, pathname: decoratedPath };
    const code = "(" + decorateProviderIdentity.toString() + ")(" + JSON.stringify(update) + "," + (++decorationGeneration) + ")";
    void view.webContents.executeJavaScriptInIsolatedWorld(1002, [{code}]).catch(() => {});
  };
  view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame && chatVisible && isChatGPTOrigin(url) && new URL(url).pathname !== decoratedPath) applyIdentity(true, url);
  });
  view.webContents.on("dom-ready", () => {
    if (!view.webContents.isDestroyed() && isChatGPTOrigin(view.webContents.getURL())) {
      void view.webContents.insertCSS(STYLE).catch(() => {});
    }
  });
  view.webContents.on("did-finish-load", () => {
    if (view.webContents.isDestroyed() || loadState !== "loading" || !admitted(view.webContents.getURL())) return;
    setLoadState("ready");
  });
  view.webContents.on("did-start-navigation", ({ isMainFrame, isSameDocument }) => {
    if (isMainFrame && !isSameDocument) setLoadState("loading");
  });
  view.webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) setLoadState(errorCode === -106 ? "offline" : "failed");
  });
  view.webContents.on("render-process-gone", () => setLoadState("failed"));
  let disposed = false;
  function syncVisibility() {
    if (disposed || win.isDestroyed() || view.webContents.isDestroyed()) return;
    const wasVisible = chatVisible;
    chatVisible = Boolean(bounds && loadState === "ready" && win.isVisible() && !win.isMinimized());
    if (!chatVisible) {
      const wasFocused = view.webContents.isFocused();
      view.setVisible(false);
      if (attached) {
        win.contentView.removeChildView(view);
        attached = false;
      }
      if (wasVisible) applyIdentity(false);
      if (wasFocused) win.webContents.focus();
      return;
    }
    if (bounds) view.setBounds(bounds);
    if (!attached) {
      win.contentView.addChildView(view);
      attached = true;
    }
    view.setVisible(true);
    if (!wasVisible) applyIdentity();
  }
  function setLoadState(value: EmbeddedChatLoadState) {
    if (loadState === value) return;
    loadState = value;
    syncVisibility();
    onLoadState(value);
  }
  win.on("show", syncVisibility).on("hide", syncVisibility).on("minimize", syncVisibility).on("restore", syncVisibility);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    chatVisible = false;
    continuity.dispose();
    win.removeListener("show", syncVisibility).removeListener("hide", syncVisibility)
      .removeListener("minimize", syncVisibility).removeListener("restore", syncVisibility);
    nativeTheme.removeListener("updated", syncViewBackground);
    microphoneGranted = false;
    microphonePromptOpen = false;
    approvedFileWrites.clear();
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    isolated.removeListener("will-download", onDownload);
    if (attached && !win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  };
  win.once("closed", dispose);
  const openProvider = () => {
    setLoadState("loading");
    void view.webContents.loadURL(CHATGPT + "/").catch((error: NodeJS.ErrnoException) => {
      // did-fail-load owns Chromium's confirmed network errors. An aborted
      // navigation can belong to a newer provider page, e.g. sign-in.
      if (error.code !== "ERR_ABORTED" && loadState === "loading") setLoadState("failed");
    });
  };
  openProvider();
  return {
    setBounds(value: Rectangle | null): EmbeddedChatLoadState {
      bounds = value;
      syncVisibility();
      return loadState;
    },
    retry(): void {
      if (disposed || !bounds || (loadState !== "failed" && loadState !== "offline")) return;
      openProvider();
    },
    setLanguage(value: "en" | "tr"): void { language = value; if (chatVisible) applyIdentity(); },
    setIdentity(value: ChatIdentity): void { identity = value; if (chatVisible) applyIdentity(); },
    setAccent(value: string): void { accent = value; if (chatVisible) applyIdentity(); },
    async requestMicrophone(): Promise<boolean> {
      const granted = await askMicrophonePermission();
      if (granted && !view.webContents.isDestroyed()) view.webContents.reload();
      return granted;
    },
    dispose,
  };
}
