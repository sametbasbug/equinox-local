# Native Chat workspace

**Status (2026-11-21):** Native Chat transport is published on Main at commit 0fc8bf8, but the initial user interface **failed the maintainer's product-quality review** against Codex desktop and Chat On Steroids. The replacement workspace lives on feature branch equinox/native-chat-workspace and is NOT published or accepted.

## Product boundary

This is a first-party Electron conversation workspace served from the fixed read-only equinox://control/ origin, not an embedded copy of chatgpt.com. Current-user Chrome and Equinox Browser 1.2.5/v11 are the only ChatGPT session/browser automation route. The renderer communicates through the narrow current-user authenticated Control Center IPC.

The shared Telegram Chat Bridge controller retains exact Browser instance, tab, conversation, user epoch and turn identities. Unique send IDs, bounded text, no automatic ambiguous retry, fail-closed conversation selection, separate User/Agent Browser contexts, and no account cookie extraction remain mandatory.

Chat On Steroids (https://github.com/totec448-spec/chat-on-steroids) and Codex are the visual and interaction references. Their rich tool-event and worker timelines have separate recorded event data, whereas the current Equinox Browser Chat Bridge v11 supplies only bounded displayed messages, generating/final status, and scoped live previews. Do not fabricate provider tool events or model selectors.

## Released baseline versus quality candidate

- **Main and Source Factory:** 0fc8bf8 (7.0.0). Signed Main CI 44920887272 attempt 2, four target builds, snapshot and signed publication succeeded. The active Mac mini Source Factory has this SHA, valid signature and healthy runtime.
- **Installed macOS transport evidence:** One new Native Chat message and a follow-up each reached one authenticated Chrome conversation once; assistant final messages, real live preview and Task Capsule binding appeared in the packaged Electron window. These prove transport, not design quality.
- **UX redesign:** equinox/native-chat-workspace. Full-height Chat workspace with compact icon rail only on Chat, open-Chrome-only conversation list and filter, centered readable transcript, better text/code presentation, and a docked growing composer. Existing dashboard, settings and setup retain their layouts.
- **Task Capsule context:** A drawer appears only for a task associated with the exact selected conversation. Authenticated, read-only task detail includes the real objective, checkpoint revision, completed and next steps. Public Browser context and tab binding are checked again before display; closing or switching invalidates stale reads.
- **Keyboard behavior:** Enter and Ctrl/Cmd+Enter send, Shift+Enter adds a newline. New Chat first messages must be single line with at most 1,500 characters, follow-ups at most 4,000. No ambiguous transmission replay.
- **Rendering:** Safe DOM text nodes for headings, lists, inline emphasis and code fences, not unsanitized innerHTML. User-requested Copy works on displayed complete messages and code blocks; it never writes to the clipboard without a click. Live preview is labeled as uncommitted and final delivery is strictly verified.
- **Confirmed content-formatting gap:** Read-only inspection of the current real Chrome ChatGPT assistant selection showed actual semantic H3, P, UL, LI, STRONG, CODE and A elements. Browser v11 currently flattens these with innerText in its readRecent/readFinal/live paths, so renderer-side Markdown parsing alone cannot restore rich semantics. A future first-party Browser version must project only verified, bounded semantic text/blocks with exact turn identity. Do not guess Markdown structure from flat text or copy remote HTML into Electron.

## Quality gates still open

1. **Design review:** Source HTML/CSS static previews were rendered with Chrome at 1180×760 and 1920×960, including light and dark task-detail states. An actual grid-versus-flex layout defect that had left a huge empty wide-screen region was found and fixed. These are previews, not installed feature-branch Electron acceptance. Inspect real empty, long-history, pending, blocked and live states, focus/scroll and accessibility.
2. **Real installed Electron:** The supported Source Factory updater requires a clean main. Moving the candidate to main starts CI publication, so retain a draft quality gate and control any release workflow before installing into the single Source Factory. Never start a second backend owner or install a public managed package over Factory. Respect update_runtime/restart_runtime turn boundaries.
3. **Tool/activity provenance:** The present ChatGPT browser DOM does not expose a verified stable provider tool-event schema. Native Chat must not invent tool results, command logs, diffs or independent workers. Extend first-party event transport only after reliable scoped provenance is established. The genuine Task Capsule drawer is a plan/checkpoint surface, not a provider tool trace.
4. **Unimplemented:** Provider-wide account history, attachments, per-conversation model/effort controls and direct Nyx/Hemera/Asteria runtime adapters remain unavailable. Do not show inert controls for unsupported actions.
5. **Windows x64:** Real packaged, current-user Chrome and private IPC acceptance is pending while the Windows PC is offline. Windows ARM64 physical hardware is waived, but CI packages all four targets.

The maintainer rejected the old UX despite successful CI; do not call the redesign finished based on static checks. Keep the new branch isolated until real visual and functional quality is acceptable. Do not add tests, fixtures or smoke suites to the repository. Preserve at most two branches and two worktrees. Remove temporary screenshot, browser profile and preview artifacts after review. Chrome Web Store submission remains with the maintainer.
