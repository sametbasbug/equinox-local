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

- `npm run desktop:dev` starts an Electron 46 window bound only to the existing `http://127.0.0.1:24891/` workspace (path /workspace) through the existing local Control Center server. The existing runtime must be running first. Ctrl/Cmd+2 opens the original Control Center and Ctrl/Cmd+1 returns to the workspace.
- Verify the Electron runtime version, Node version, renderer sandbox flags and the window's actual main-frame URL.
- If the runtime is down, show a nonprivileged retry screen; external HTTPS links open in the system browser, non-HTTPS / unintended file navigation is rejected.
- Existing public install and Factory continue unmodified. This phase is **not** a complete packaged Electron replacement, nor a native conversation UI.

## Human-first workspace increment (checkpoint 3)

- The existing loopback server now serves an exact-path workspace HTML, CSS, and generated TypeScript asset without a competing backend, alternate browser, new renderer permissions or new control endpoints.
- The preview displays real task summaries, searchable filters, goals, remaining and completed steps, and runtime connection state. Task management routes back to the existing Control Center.
- Conversation composer is not yet implemented. We deliberately do not show a deceptive non-functional chat interface. Provider integration and full localization remain future work.
- This is still an opt-in preview, not a signed desktop release, and does not replace existing AppKit/WPF lifecycle ownership.

## Task-bound chat bridge (checkpoint 4)

- The workspace uses the existing Equinox Browser Chat Bridge v9, not a model API or a separate browser automation backend. Sending is explicit and limited to active Task Capsules with verified **Your Browser** conversation bindings.
- Strict one-line text (3800-character limit for the current extension), request-ID deduplication, same-origin CSRF and no unrestricted browser/agent IPC. A failed or ambiguous browser submission is **never** automatically repeated.
- Only the most recent workspace-originated send/answer is kept in process memory; ChatGPT remains the full transcript. Restarting the runtime does not reconstruct pending receipts or full ChatGPT history. Users must inspect uncertain sends in ChatGPT before unlocking.
- This preview cannot start a new conversation or choose a model/provider; these are staged future capabilities. The original Task/CLI/Telegram flows remain available.


## Task creation and conversation binding (checkpoint 5)

- Workspace exposes a two-step human-first flow: a bounded Task Capsule is created explicitly; the user then chooses to start a neutral, task-bound ChatGPT conversation. Task creation does not automatically cause agent/tool execution.
- The bounded task-create and task-chat-start routes reuse the existing same-origin/CSRF-guarded Control Center backend, Task Capsule store and Equinox Browser Chat Bridge. The start route refuses active bindings and concurrent start in the workspace, and the store rejects overwriting a different binding when expectUnbound is requested. Existing CLI/Telegram and Auto Continue rebinding semantics are preserved.
- If a browser-side start may have crossed a mutation boundary, Workspace disables a retry for the current page session and instructs the user to inspect ChatGPT; it never silently opens a duplicate tab.
- A real isolated Chat Bridge check used a temporary task and separate ChatGPT tab: neutral start returned EQL_CLI_READY, explicit send returned the exact requested marker, the tab closed, and the task was finished and deleted. The Factory app was not restarted.


## Checkpoint 6: real UI browser-boundary observation

- Electron source Workspace, served from an isolated QA instance of the existing Control Center API, created a disposable task through the real authenticated CLI/Task Capsule backend. The UI attempted the neutral chat-start action through that same CLI/Chat Bridge.
- The browser tab was created, but the neutral handshake text remained unsent in the ChatGPT composer and no verified task binding was committed. The UI stayed pending longer than acceptable. No send/read success is claimed for this UI path. The orphaned tab and task were explicitly closed/deleted without retrying the browser mutation.
- The Workspace browser requests now have bounded client-side timeouts; uncertainty blocks an implicit retry. The per-runtime Workspace Chat adapter treats a restored/external task binding as uninspected until the user confirms inspecting the exact ChatGPT conversation; a runtime restart therefore cannot turn a lost in-flight receipt into a silently retryable idle state. The successful new-task neutral handshake marks only that freshly confirmed binding ready.
- Next: investigate ChatGPT composer submit-button selector drift. The orphan tab showed a staged prompt and a semantically named Gönder button, while the existing start flow checks narrowly for prior primary button classes. Inspect the actual button type and state in a fresh disposable tab before changing mutation selectors; never click unconfirmed submissions. Then verify new task -> start -> send -> read in one isolated real UI flow before any production rollout; persistent cross-restart delivery receipts remain future work.


## Checkpoint 7: full Workspace to ChatGPT to Workspace validation

- Exact first-party Your Browser inspection ruled out the suspected CSS selector drift: the current send button is enabled, type=submit, aria-label=Gönder, retains bg-composer-primary, and semantic snapshot resolves exactly one Gönder control. No unverified fallback selector/click was added.
- An isolated source Workspace preview with the existing authenticated Factory CLI as its Chat Bridge adapter (port 24892) delivered a message from the actual Electron UI to ChatGPT and displayed the exact response EQL_WORKSPACE_UI_E2E_20261103.
- A second disposable task verified the complete human UI chain: Workspace new-task modal, task creation, explicit ChatGPT conversation start, Workspace send, ChatGPT reply, and Workspace answer display. The exact response EQL_FULL_WORKSPACE_UI_PASS_20261103 was visible in the macOS Electron window and logged by the isolated QA adapter. This does not mean the uninstalled Electron wrapper owns the complete runtime, nor does it independently exercise the new server.ts callbacks in a restarted Factory.
- The previous intermittent failed chat-start remains a separate observation. Its unsent draft appeared in a subsequent blank ChatGPT tab; the later trials succeeded after the orphaned draft was cleared. Causality is unproven; no ambiguous browser mutation is auto-replayed.
- Electron preview background throttling has been disabled so bounded request and poll timers may progress when ChatGPT takes focus. Confirm behavior on both actual platforms before shipping.
- Temporary QA tasks/tabs/profiles must be cleaned up. No new test files.


## Checkpoint 8: background behavior and native lifecycle parity audit

### Verified in a source preview on macOS

- A read-only, isolated Control Center preview was opened through Electron 46 using its own port/profile. With Chrome in the foreground, Workspace task GET polls continued on approximately **20-second intervals**: background throttling was disabled and the unfocused renderer remained active. This does not prove minimized/suspended-window behavior or Windows parity.
- A separate read-only mock task with a simulated bound chat was refreshed while an unsent chat draft had focus. The draft survived a real changing-task-data refresh, including input focus/caret, after renderTasks() was updated to preserve the selected editor or keyboard-selected task row. No chat message was submitted.
- Both checks exercised development Electron and the source renderer, not an installed signed application or a reloaded Factory runtime.

### Installed shells versus the Electron preview

| Concern | Current macOS AppKit host | Current Windows WPF host | Electron 46 preview / migration gate |
| --- | --- | --- | --- |
| Runtime ownership | Stable Equinox Local.app + verified per-user launchd LaunchAgent/runtime-host split; independent login enable state | WPF RuntimeSupervisor owns a Node runtime gate inside a Windows Job Object, with bounded recovery | Electron currently connects to an **already-running** service; no supervision. Preserve existing ownership until a single verified replacement exists on each OS. |
| Resident UI | Native NSStatusItem menu; foreground shell separate from runtime host | Tray controller; closing the window hides rather than shutting down; explicit Exit stops the owned runtime | macOS close leaves preview process alive; Windows closes/quits. Tray, explicit Exit, status and service-start policy are **not equivalent yet**. |
| Login preference | LaunchAgent's persisted per-user enable/disable preference, menu toggle, explicit manual launch semantics | Per-user Run-key command validated against the owned executable (--startup), hidden startup with tray | Preview does not register at login. Do not create duplicate registration or silently enable startup. |
| Identity/permissions | Stable app bundle identity (dev.equinox.local) owns Accessibility/Screen Recording TCC grants and trusted Native Messaging | Signed WPF executable identity, installed WebView2 storage and Native Messaging host under release ownership | Stock Electron preview (com.github.Electron) must **not** request/claim installed macOS TCC grants or own Native Messaging registration. |
| Reconnection/update | Native shell and launchd recover around source/runtime restarts; signed Main installer owns active release | WebView2 waits for the loopback service; Job Object and detached installer preserve correct update/shutdown ownership | Preview has only an offline page and retry; signed Main update, offline reconnect, shell replacement and four-target packaging are unproven. No second updater. |

### Promotion gates (not yet met)

1. Validate actual macOS installed-bundle identity, native permissions, status menu, login toggle on/off, reopen/close and controlled runtime restart *without* permission re-prompt or duplicate LaunchAgent.
2. Validate actual Windows installed shell behavior: true single instance, tray/close-to-tray, startup-on-login without intrusive window, Job Object lifetime/child drainage, crash recovery, and no flashing process windows.
3. Reuse the **existing signed Main installer/verification flow** for both architectures on both OSes, including first install, update, repair and preserved user state. Do not promote source-preview assets alone as a production app.
4. Prove the real source server.ts Workspace callback wiring through the installed single Node runtime. Prior end-to-end UI verification was safely delegated through the existing authorized Factory CLI; it is not evidence that Electron already replaces WPF/AppKit lifecycle.
5. Keep the unreleased preview profile separate from public and Factory state. Do not publish, replace the native hosts, or merge solely on the basis of the macOS renderer-level checks.

## Checkpoint 9: offline recovery and keyboard-first refinements

- CodeQL, JavaScript security and docs checks from checkpoint 8 (8924767) passed.
- The preview Electron shell now retries only its fixed loopback Workspace document while its local runtime is unavailable, using a single bounded GET probe (4-second interval, 2.5-second timeout, no redirects). It does not create/restart an agent, expose IPC, or retry any task/chat POST. The old offline link with a hardcoded 24891 port was removed; a passive Turkish waiting screen replaced it.
- Do not infer a successful navigation from Chromium's did-finish-load alone: the first live attempt revealed the event can also occur for an error document, leaving the offline view stuck. The corrected path clears its retry state only after an awaited successful Workspace loadURL, with the URL checked for an exact match.
- In a separate read-only QA preview on macOS, actual Electron showed the offline screen on a closed port, automatically opened Workspace after the QA service came online, displayed a clear offline banner and disconnected health state when that service stopped, and automatically removed the banner when the service restarted. No task or browser mutation occurred.
- The source Workspace adds an 8-second bounded GET timeout and 5-second retry while disconnected (normal connected cadence remains 20 seconds); mutations are not replayed. Chat send/start are disabled when disconnected and task creation explains the offline state rather than creating ambiguous work.
- ArrowUp/ArrowDown/Home/End navigation between task rows, an ephemeral per-tab remembered task ID and accessible connection announcements are implemented. The macOS 860x620 source preview was inspected; a short-height scrollbar/sidebar spacing change keeps connection status reachable. Exact keyboard-arrow execution and Windows UI behavior remain unverified because the native automation path could not reliably dispatch scrolling inside this Electron view.
- The local QA server used a disposable 24892 preview only; active 24891 Factory/runtime and installed native shells were never restarted or modified.

## Checkpoint 11: source-bound Workspace API contract

- The five existing Workspace callbacks (task creation, new ChatGPT chat, status, send, and acknowledgement) have been moved from inline server.ts closures into createEquinoxWorkspaceActions, with the same injected Task Capsule store, existing Telegram/Equinox Browser Chat Bridge controller, agent mutation gate, and mutation locks. The real server now wires that exact factory to the original Control Center API; there is no new HTTP listener, model gateway, or browser provider in the product.
- An isolated, disposable source-module integration check invoked this exact factory and the original createEquinoxLocalControlApi against a real Task Capsule store with an ephemeral filesystem root. Its browser delivery was simulated, never dispatched to Chrome or the user's ChatGPT conversation. Confirmed: unauthorized task create rejected (403); task creation persisted (201); neutral chat start bound a verified simulated conversation (200); duplicate start refused (409); message send and duplicate request ID resulted in one bridge delivery; response reading succeeded; recreating the in-memory chat controller failed closed until manual inspection acknowledgement. The disposable store and HTTP server were removed in the same process.
- This establishes the source Control API to extracted Workspace actions to real Task Capsule storage to bounded Chat Bridge interface contract, which earlier CLI-adapter UI checks could not prove. It does not prove the full server.ts boot in a separate isolated runtime or real ChatGPT browser delivery through this newly extracted source callback. Those remain deliberate promotion gates; Factory was not restarted.
- PR #332 checkpoint-10 commit b35ca49 CodeQL, JS security and docs gates were green before this refactor. No repo test or QA suite was added.

## Checkpoint 12: exact-conversation navigation and safe full-boot boundary

- Workspace's existing per-task chat-status GET now exposes an optional exact conversationUrl only for an active, verified Your Browser Task Capsule binding. The URL must use HTTPS at chatgpt.com (or www.chatgpt.com), have no credentials, query, fragment, or custom port, and identify precisely the bound conversation ID. Its renderer link uses target=_blank and rel=noopener noreferrer; Electron's existing external navigation handler opens allowed HTTPS URLs in the system browser without injecting commands or adding a new browser automation route.
- Manual inspection after a runtime restart or uncertain response now has a direct Open bound ChatGPT conversation link next to the existing fail-closed acknowledgement; no missing receipt is reconstructed and no message is auto-replayed. Inline source-contract validation confirmed valid standard/GPT-scoped URLs and rejected eight mismatched or unsafe examples.
- A complete standalone createEquinoxLocalRuntime().start() from source has NOT been run against the active Factory machine. Startup owns Equinox Browser IPC, Telegram inbox/command synchronisation, CLI socket registration, runtime janitor/recovery, source CLI installation, health/update timers and Control Center; simply assigning another port or temporary home directory is insufficient evidence that those external effects are isolated. The source Workspace controller, original local API and real disposable Task Capsule storage were already verified together in checkpoint 11 without a duplicate browser/runtime. Do not launch a parallel full server simply to claim a production integration gate has passed.
- Continue native startup/platform parity and eventual single-runtime activation through the existing managed lifecycle, with a verified isolation or handoff plan and no duplicate installed runtime or production restart during user work.
