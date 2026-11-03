# Unified Equinox Local desktop — Electron 46 transition

Status: **Phase 1 in development** (2026-11-03). Architecture decision: build a genuinely human-first cross-platform app, not a second MCP implementation.

## Product goal

One approachable, polished desktop workspace on macOS and Windows. Make conversations, projects, agent work, approvals and history visible without requiring terminal or coding expertise. Power users can reveal terminal, code/diff and debugging details when needed. ChatGPT Web remains an optional integration, not the ultimate interface.

## Architecture constraints

- Preserve **one canonical repository, one local Node runtime, one Control Center API, one MCP capability registry**, one Equinox Browser transport. Do not add an alternative browser automation backend, duplicate local management server or privileged renderer-to-OS bridge.
- Electron 46 prerelease is a deliberate maintainer choice. Pin an exact prerelease until further verification; upgrade promptly to security-fix builds. Do not imply it is stable.
- Electron's renderer is untrusted. Use sandbox, context isolation, no Node integration, deny arbitrary navigation/windows/permissions, and keep all privileged operations behind existing localhost same-origin/CSRF and bounded-capability checks. Future application IPC must be an explicit least-privilege API, never a generic command or file path escape hatch.
- Existing AppKit/WKWebView and WPF/WebView2 shells remain the **installed products** until the new lifecycle is independently validated on macOS and Windows. Keep signed Main verification, update/reinstall semantics, original native desktop automation permissions, TCC continuity, Chrome Web Store extension ownership, installer identity and per-user data. Avoid a speculative side-by-side installed runtime.
- Do not invent support for invoking ChatGPT subscription models outside supported user-access routes. ChatGPT browser integration may remain supported while first-party/model-provider APIs are evaluated for a native conversation flow.
- Do not add test files (maintainer rule). Perform typechecks, static checks, native/package builds and observable OS acceptance before promoting.

## Staged delivery

1. **Foundation (this branch):** Pin Electron 46 alpha; add a secure optional desktop entry point using the *already-running* loopback Control Center; refuse unsafe navigation and permissions, provide a gentle offline/retry surface. No alteration to the current installer, native wrappers, runtime lifecycle or production release. This is an integration seam, not yet the final workspace.
2. **Runtime and packaging:** Give Electron the platform-specific, single-instance/background-process lifecycle currently handled by the native shells, preserve startup toggle and update/restart ownership, and package four signed native Main targets. Replace existing WPF/AppKit shell only after real macOS and Windows install/update/reinstall, source-Factory, crash, shutdown and permission behavior are proven. No second updater.
3. **Human-first workspace:** Single shared design system: sidebar for conversations/projects/tasks, clear composer, main conversation timeline, expandable task plan/tool actions, action confirmations and a right-hand optional inspector. Start with guided language and progressive disclosure; terminal/code-diff are optional, never prerequisites. Design for keyboard and accessibility, localized copy, good small-window handling.
4. **Conversation engine:** Define a provider-neutral, permission-aware conversation/agent interface backed by existing task/workflow services. Integrate supported model/provider APIs independently of ChatGPT Web; maintain the existing ChatGPT/Equinox Browser lane as a separate explicitly chosen connection mode. Keep each provider's auth, usage and capabilities visible.
5. **Unified rollout:** Roll out only after platform parity and security checks; update README/architecture/user docs and remove obsolete native UI code/packaging *after* migration. Release notes must be based on actual commits and proven deployment.

## Phase 1 acceptance and limitations

- `npm run desktop:dev` starts an Electron 46 window bound only to the existing `http://127.0.0.1:24891/` Control Center. The existing runtime must be running first.
- Verify the Electron runtime version, Node version, renderer sandbox flags and the window's actual main-frame URL.
- If the runtime is down, show a nonprivileged retry screen; external HTTPS links open in the system browser, non-HTTPS / unintended file navigation is rejected.
- Existing public install and Factory continue unmodified. This phase is **not** a complete packaged Electron replacement, nor a native conversation UI.
