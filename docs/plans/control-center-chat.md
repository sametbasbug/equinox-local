# Equinox Local: native Chat workspace

**Status:** Implemented on [Draft PR #354](https://github.com/sametbasbug/equinox-local/pull/354), **not merged or released** (2026-11-21). The remaining installed-platform acceptance gates are listed below.

## Product and trust boundary

The Chat section is an **Equinox-designed, Codex-like native conversation UI** inside the packaged Electron Control Center. It is served from the fixed, read-only `equinox://control/` origin, with its own conversation list, composer, message feed, progress state and optional Task Capsule association. It does **not** embed `chatgpt.com` via `WebContentsView`, iframe or external dashboard. The Nyx/Hemera/Asteria visual companion selector is separate from the ChatGPT backend.

The architectural reference, [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids), also works through an authenticated browser extension rather than an official ChatGPT API. This remains a **browser UI integration** subject to website changes, account restrictions and provider rules. A ChatGPT subscription is not an OpenAI API entitlement. Never extract account cookies, duplicate the Browser automation engine, start another localhost dashboard or runtime owner, or copy provider HTML into Electron.

The renderer talks only to the existing narrowly allowed Control Center IPC endpoints. The backend uses Equinox Browser in the **explicit current-user Chrome context**, with exact extension-instance, tab, conversation and turn identity. Reuse `src/telegram-chat-bridge-controller.ts` for the scoped inspection, delivery, final reading, recent history and new-chat paths. No silent User Browser/Agent Browser fallback or arbitrary Chrome/Local tool access in HTML.

## Implemented behavior on the draft branch

- **Conversation selection:** Lists currently open Chrome ChatGPT conversations, not the provider's entire account history. Detects duplicate tabs for the same conversation and refuses ambiguous selection.
- **Composer and transcript:** Native text composer (up to 4,000 characters for follow-ups), explicit send, waiting/generating/completed/disconnected states, unique delivery receipt, bounded messages, and a three-second refresh that preserves unchanged sidebar/transcript DOM.
- **Recent history:** Browser Chat Bridge v10+ reads up to 12 recently rendered turns / 24 text messages, up to 3,500 Unicode code points per message and 46,000 total. History is only what Chrome currently renders and may be partial due to provider virtualization.
- **Live assistant text:** Browser Chat Bridge v11 (Equinox Browser 1.2.5) can return up to 3,200 code points of the exact currently generating assistant turn. The UI renders a visibly separate, noncommitted preview, replaced by the confirmed final answer. Earlier versions retain coarse generating status.
- **New Chat:** Explicit single-line initial text of 1–1,500 characters opens a new Chrome conversation using the existing guarded Task Chat starter and creates/binds a generic Task Capsule. The opening prompt remains in ChatGPT, **not** in Task Capsule metadata.
- **Safety:** Unique send/creation IDs, one visible editor and send target, exact post-fill text verification, no automatic replay of an uncertain tab creation/click, and fail-closed identity checking. First-turn input uses a single bounded semantic `fill` rather than slow sequential key events. Lost creation acknowledgments are ambiguous.
- **First-turn recovery:** If Chrome publishes the conversation URL before its first user epoch, the backend waits for **complete, exact-conversation recent history containing only the matching initial user text**. It then attaches the existing receipt without sending again; incomplete or mismatched history stays blocked. A definitely pre-submit failure cancels its temporary Task Capsule and restores an editable draft under a new request ID.
- **Task association:** A known Task Capsule's title/status is shown only when both the exact conversation and Browser instance identities match. Companion graphics do not invoke another Equinox agent.

**Not implemented:** Provider-wide account history, attachments, per-chat model/effort controls, direct Nyx/Hemera/Asteria runtime adapters and rich provider tool/result cards. The latter require proven, stable, scoped DOM semantics; never invent activity cards from guessed selectors.

## Verified evidence

| Scope | Evidence | Result |
| --- | --- | --- |
| TypeScript / generated JS / static checks | Typecheck; byte-exact runtime (151), desktop (12), Browser (5) artifacts; static checks (200 JS, 6 shell) | Passed |
| Electron builds | macOS ARM64/x64 and Windows x64/ARM64 development packages, macOS ARM64 strict deep code-signature verification | Passed; temporary outputs removed |
| Installed Browser v11, real ChatGPT | Authenticated current-user Task Chat delivered one message and retrieved the exact final response with matching epoch despite a hidden Stop button | Passed; temporary task and tab removed |
| Real Chrome, long first message | One 1,259-character semantic `fill`, exact visible composer check, one Send click and confirmed assistant reply | Passed for **Browser primitives**, not installed Native Chat |
| Native Electron UI and real ChatGPT answer | Shipped `equinox://control` HTML, preload, branch controller/private dispatcher, and **resident released Factory CLI as a narrow Browser relay**; one user bubble and one real final assistant bubble | Passed for the **hybrid QA harness**, not matching installed feature backend |
| New Chat lifecycle races | Transient controller checks and bundled Electron GUI validated delayed epoch → Completed, single reply, composer unlocked, definite pre-submit draft recovery | Passed against **synthetic Browser** responses |
| Live v11 assistant preview | During real generation, bounded source DOM projection returned 3,200 characters with scoped turn identity | Source DOM proved; **installed worker → GUI** not verified |
| Physical Windows x64 | Real Windows GUI, current-user Browser and private IPC checks | **Not verified** |

No new repository tests, fixtures or smoke suites were added. Real Chrome QA used isolated disposable tabs/tasks; temporary Electron windows and build files were cleaned. The browser transport does not constitute an official provider API or guarantee future compatibility.

## Acceptance and rollout gates

1. **Mac Factory:** The active Source Factory remains on released `main`, not this branch. Verify a **single matching feature backend plus packaged native UI** against authenticated User Browser ChatGPT for selection, send/final, New Chat first response, status and interruption. Current hybrid GUI/Browser checks are insufficient. Preserve Factory identity, settings and private composition; never install public managed packages over it.
2. **Browser lifecycle:** When the ongoing project ChatGPT generation is genuinely idle with empty draft, reload unpacked Browser 1.2.5/v11 and the idle content script if necessary to activate its visibility-aware hidden-Stop fix. Never reload during active generation. Confirm live preview/final through the actual worker and installed UI.
3. **Windows x64:** Reconnect the device and verify the real packaged native Chat interface with current-user Browser bridge, private IPC, no extra runtime/TCP listener, and safe failure handling. Physical Windows ARM64 testing is waived, but packaging remains required.
4. **Publication:** Keep [PR #354](https://github.com/sametbasbug/equinox-local/pull/354) Draft until the installed-platform gates pass. Then merge via the existing signed Main pipeline, deploy through the supported update workflow and verify the **running Mac Source Factory** is on the published SHA after restart. Follow `AGENTS.md` restart/update tool boundaries. Chrome Web Store submission remains with the maintainer.

The Equinox Browser 1.2.5 Chrome Web Store package remains a maintainer-submitted release artifact; publication is not implied by this PR.
