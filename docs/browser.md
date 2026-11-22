# Equinox Browser

**Chrome Web Store channel:** [Equinox Browser](https://chromewebstore.google.com/detail/equinox-browser/npdneefcobilfkjlihghjgjnknenhfoj) has a permanent Unlisted listing. Chrome Web Store alone delivers extension updates; Equinox Local does not replace or sideload Store-managed installs.

**Versions:** The Chrome Web Store version is the authoritative **installed/public extension** version (and appears automatically in the [README badge](../README.md)). The repository's [`extension/manifest.json`](../extension/manifest.json) contains the **source candidate** version, which may be ahead of the Store while a submission is pending review. Equinox Local publishes its own signed Main separately and does not sideload extensions. The maintainer handles Store review/submission.

**Historical source candidate 1.2.2 (superseded by 1.2.4):** fixes trusted Send focus for CLI/Telegram Chat Bridge. The ZIP is prepared for maintainer-led CWS review; it is not an installed Store update until publication.

**Source candidate 1.2.3 (superseded by 1.2.4):** fixes a modern ChatGPT page that renders both a hidden and a visible contenteditable composer. The previous Chat Bridge delivery receipt was correctly marked ambiguous and never replayed. The new bridge and Auto Continue composer focus select exactly one connected, nonzero-size, visible editor; no unique visible editor means no delivery. The ChatGPT continuation observer applies the same readiness rule. A CWS review/upload and live validated update are still required before calling 1.2.3 public.

Equinox Browser is the only browser-automation transport exposed by Equinox Local.

It is a first-party Chrome extension paired with a per-user Native Messaging host and the local Equinox Browser bridge. The transport serves two explicit product contexts: **Agent Browser** (`target=agent`) is the default isolated Equinox Local Chrome profile, while **Your Browser** (`target=user`) is the user's personal Chrome profile and must be requested explicitly. The contexts never silently fall back to each other. Equinox Local does not use a generic user-Chrome CDP fallback, does not require Chrome remote-debugging flags, and the retired loopback/CDP QA browser is not a second product capability.

## Trust model

Browser control is off on a new extension install until the user accepts the browser-data consent prompt in that profile's extension popup. Consent, on/off state, cookies, logins, tabs, Auto Continue target choice and other extension-local settings remain independent between Agent Browser and Your Browser. The extension keeps its local control channel available while automation itself is disabled, so status and settings remain inspectable without silently inspecting tabs.

The extension can expose bounded browser primitives such as:

- listing and activating tabs,
- opening and closing normal web pages,
- semantic snapshots and element references,
- clicks, typing, scrolling, uploads and downloads,
- screenshots stored inside Equinox Local's bounded workspace,
- popup/new-tab and JavaScript dialog discovery,
- bounded console/network metadata where the browser surface supports it; and
- bounded bookmark management in Agent Browser only. Your Browser bookmark automation is rejected before the bridge and by the extension context guard.

Protected Chrome pages, file URLs, browser interstitials and other restricted contexts fail closed rather than attempting to bypass Chrome protections.

## Auto Continue target

The extension popup exposes a profile-local **Auto Continue target** selector only after browser consent is accepted and control is enabled. **Current task's ChatGPT tab (automatic)** lets Local bind the single conversation that is actively generating at arm time. The human may instead pin one exact open ChatGPT conversation in that profile. A closed pin, navigation away from ChatGPT, conversation drift or conflicting pins fails closed; Local never falls back to another tab/profile.

Auto Continue uses dedicated internal bridge commands for target resolution, inspection and guarded delivery rather than exposing a generic ChatGPT/session automation API. The delivery path verifies the bound conversation, latest user epoch, assistant turn, generation state and empty composer; it claims a bounded extension-local delivery receipt before inserting/submitting the deterministic continuation prompt so ambiguous retries cannot duplicate a turn. Human composing or a new user message wins over the pending continuation.

Telegram Chat Bridge uses separate internal capabilities instead of pretending bridge messages are Auto Continue turns. `chat_bridge.deliver` reuses exact-conversation/user-epoch/assistant-turn/composer guards with a separate bounded receipt namespace; `chat_bridge.inspect` stays text-free and bridge debugger leases receive short detach cleanup. Attachments remain local and are never uploaded again through the ChatGPT UI. The bridge message itself carries only the user text plus `task_id` for Task-bound chats and optional `local_file` for a downloaded Telegram file. There is no attachment-resolver Browser/Local protocol in the Chat Bridge path.

Chat Bridge v9 keeps normal Telegram chat Task-scoped. Existing bound-chat delivery uses guarded CDP `Input.insertText`, focus of the exact, enabled ChatGPT Send button followed by a trusted Enter key, with debugger-backed user-epoch confirmation. Stale tab ids may be refreshed only through a unique exact-conversation match in the same Browser instance; ambiguity still fails closed. The only fresh-chat path is explicit **New task** creation from Telegram: Local uses existing generic Browser primitives (`tabs.create`, `snapshot`, `type_text`, `tabs.list`) to create one root ChatGPT conversation for the new Task, confirms its conversation id, binds it to that Task Capsule, and then uses the same `chat_bridge.read_final` lane for the first assistant response; a null previous-assistant key is valid only for that first Task turn.

## Connection path

```text
Agent
  -> Equinox Local capabilities(domain=browser) + browser_call (target=agent|user)
      -> Equinox Browser bridge
          -> per-user IPC (macOS Unix socket / Windows named pipe)
              -> Native Messaging host
                  -> Equinox Browser extension in the selected profile
                      -> Agent Browser tab OR Your Browser tab
```

The transport endpoint belongs to the signed-in user: a private Unix socket on macOS or a scoped named pipe on Windows. The bridge authenticates the expected native-host origin and extension identity before routing commands.

## Chrome Web Store updates

Equinox Browser is distributed and updated by the Chrome Web Store. Equinox Local's own updater does **not** overwrite, sideload or replace the extension package.

The source tree under [`extension/`](../extension/) is kept in this repository for auditability and development. Release packaging is deterministic and allowlist-based.

## Visible agent cursor

The extension can show a visible agent cursor and a local display name while an agent interacts with the page. These are user-controlled settings exposed in the popup and Control Center.

## Development

Automated browser tests were retired by maintainer decision. Browser releases still use an exact-file packaging allowlist. Readable Chrome PDF snapshots use the same bounded `pdfjs-dist` text extractor on macOS and Windows; raw PDF bytes are not exposed in tool results.

Package the extension source with:

```bash
npm run browser:package
```

Generated ZIP files are release artifacts and are intentionally not committed to Git.

**Source candidate 1.2.4 (superseded by 1.2.5):** adds `chat_bridge.recent` v10, a read-only, exact-conversation scoped recent transcript projection for the first-party Equinox Local Chat. This reads only the currently rendered user/assistant text within the selected Chrome tab, at most 12 turns, 24 messages, ~46,000 characters total, and no HTML, arbitrary page content or cookies. The existing v9 send/final capabilities remain backward compatible. 1.2.4 incorporates the 1.2.3 hidden composer focus fix. CWS submission/review remains maintainer-operated.

**Historical source candidate 1.2.5 (superseded by 1.2.6):** supersedes 1.2.4 and preserves all of its composer focus and recent-history protections. Adds `chat_bridge.live` v11: a separately labeled, ephemeral **read-only live assistant text preview** for the exact selected ChatGPT conversation/turn while generation is active. It reads at most 3,200 rendered Unicode code points and never labels partial output as a complete response or invents tool/result cards. Existing v9/v10 capabilities remain backward compatible. The Chrome Web Store ZIP must be submitted by the maintainer; developer unpacked extension verification is not Store approval.

**Native Chat installed-QA correction (2026-11-22):** In a real macOS Source Factory / current-user Chrome session, earlier Browser projections sometimes included ChatGPT's screen-reader-only H4 speaker heading in recent/live/final assistant text, including the in-progress placeholder `ChatGPT dedi:ChatGPT`. The current v12 source candidate excludes only a verified H4.sr-only speaker label when the remaining extracted text agrees with subsequent rendered child content. It does not blindly strip genuine assistant prose. Native Chat also restores existing Task Capsule associations after a restart from trusted internal data, checking the full Browser instance, tab and conversation identity. These source fixes are merged in main `a009015`, but the final fix has **not yet been verified in the reloaded developer extension**, and this is not a claim about the Chrome Web Store listing.

**Unreleased source candidate 1.2.6 / Chat Bridge v12 (ZIP prepared for maintainer submission):** Adds an optional, read-only semantic message projection to existing chat_bridge.recent, chat_bridge.live and chat_bridge.read_final responses. The v11 text, turn ids and delivery semantics remain unchanged. For a single trustworthy rendered Markdown root, the extension derives bounded Markdown TEXT for headings, emphasis, lists, code and quotes; it never sends remote HTML, external link URLs, or provider tool records. Complex DOM, media cards, multiple render roots, inconsistent or truncated content falls back to original text with richText: null. The Local bridge validates lengths (4,000 live, 5,000 per recent item with 46,000 total additional recent characters, 14,000 final), and the native renderer uses safe DOM text APIs. The previously prepared 1.2.5 ZIP remains unchanged. The new 1.2.6 CWS ZIP is staged for the maintainer; Store submission, approval and user installation are separate actions. Modern recent-history reads also refuse ambiguous multiple user/assistant units within a turn, marking the visible transcript partial rather than assigning the first reply an incorrect identity. No public release is implied by the source candidate.

**2026-11-21 live verification correction:** During the first real v11 generation, Chrome retained a hidden Stop button after the completed answer. The older ChatGPT continuation observer treated that hidden control as active generation, blocking final-answer completion and poll readiness. Source 1.2.5 now checks element visibility (connected, nonzero rectangle, non-hidden computed style) for both modern and legacy Stop controls. This is part of the same not-yet-submitted 1.2.5 candidate, not a separate Store update. The exact 3,200-character bounded assistant projection was read during a genuinely active QA turn.

**Source Factory acceptance (2026-11-22):** The installed macOS Source Factory has been verified at `a009015` with a valid deep code signature and a healthy single runtime. Authentic user-Chrome v12 transport delivered bounded semantic `richText` for completed replies and live previews, and the packaged Electron UI rendered headings, emphasis, lists and code. The exact Task Capsule drawer, keyboard focus/activation, conversation scrolling, light/dark layouts at normal and wide widths, English/Turkish labels, and Copy with restoration of the original clipboard were checked against the real GUI. **Still open:** reload the updated developer extension only after the exact ChatGPT conversation finishes generating, confirm the speaker-label fix through the newly loaded live worker, and verify selected-text Quote insertion while the composer is enabled. Continuous same-conversation Auto Continue generation has prevented a safe reload interval; these unverified items remain release blockers. Four native candidates for `a009015` passed but public Main publishing remains behind the required `native-chat-qa-gate` review. Do not equate the developer extension, prepared 1.2.6 ZIP or CI pass with a Chrome Web Store or signed public release.

**Native Chat source candidate (2026-11-22):** Browser 1.2.8 / Chat Bridge v13 adds visible ChatGPT sidebar conversations, guarded historical selection and account-verified model/effort controls. This is not installed in Source Factory or released to CWS. The earlier 1.2.6 ZIP is not a final Native Chat submission. See [Native Chat parity](plans/native-chat-web-parity.md).

**Native Chat source progress (2026-11-22, still unreleased):** Browser 1.2.8 / Chat Bridge v13 now includes provider-backed search of conversation history, explicit provider project browsing and New Chat model/effort preflight prior to first-message submission. All operations remain coupled to the consented Your Browser context. Search/project reads use temporary inactive Chrome tabs that are closed, with short-lived exact-link receipts to authorize historical navigation. Existing source code was compiled and selective read-only DOM logic observed in real Chrome; the installed Factory has not yet accepted this revision. See [Native Chat parity](plans/native-chat-web-parity.md).

**Native Chat conversation actions (unreleased source, 2026-11-22):** Provider-backed conversation menu inspection, rename and pin/unpin are wired to the first-party Native Chat UI. Exact browser instance/tab/conversation/title evidence and unique local mutation receipts prevent accidental replay or cross-thread changes; a separate temporary inactive Chrome tab is used for each action and then closed. Actual pin/rename mutations are not yet physically accepted in the installed Factory; neither archive/delete nor final release are enabled. See [Native Chat parity](plans/native-chat-web-parity.md).

**Native Chat source actions progress (2026-11-22, not shipped):** Provider-scoped Project move and Archive join rename/pin. Move verifies target Project name and ID both before and after provider interaction; Archive requires explicit Native Chat confirmation and stable provider sidebar absence. The active task-bound chat is protected from movement/archive. Browser/GUI installed mutation QA is pending.

**Unreleased conversation delete source (2026-11-22):** Native Chat now has an explicitly confirmed destructive Delete action that additionally requires and interacts with ChatGPT's own distinct Delete confirmation dialog. Without an unambiguous provider confirmation and verified sidebar removal it never reports success, and action IDs are single-use. No actual account conversation was deleted as a test; installed Factory acceptance remains open.

**Composer capability discovery (2026-11-22, unreleased):** The Browser Bridge has a read-only temporary-tab chat_bridge.tools_catalog command that projects real ChatGPT composer tool/app names without selecting any action. The live account DOM projected 7 native options and 3 apps; native UI tool selection and safe delivery are not yet built.

**First native tool send source (2026-11-22, unreleased):** The dynamic composer picker now allows only the account-observed Web Search inline hint. The Browser Bridge selects it in the exact bound conversation, checks the provider's inline selection pill and the unchanged user message before using the existing single-use delivery receipt. Other tool/app names remain discoverable but disabled; they are not misrepresented as sending features. Actual installed tool-augmented send has not been accepted.

**Source Native Chat attachments (2026-11-22, unreleased):** User explicitly selects one local regular file (up to 100 MiB) through the trusted Electron file picker. Existing-chat message delivery can stage that file with Chrome DOM.setFileInputFiles using the sole generic composer file input; requires stable ChatGPT named attachment card and remove control before a single-use send. Captions are optional. No cookies/API uploads or arbitrary provider endpoints. A synthetic 61-byte disposable manual Chrome upload showed the real card and its removal worked; no account conversation message was submitted and all test artifacts were cleaned. Actual installed Factory file-send acceptance is open.

**Attachment safety correction:** Provider attachment cards are not always identified by data-testid. The ChatGPT observer now considers those real cards as nonempty composer state, so Native Chat history switching, model changes and unselected file sends cannot silently reuse an unsent human file.

**Provider-specific tool modes (2026-11-22, unshipped):** The first-party Native Chat picker recognizes actual provider system-hint pills for Web Search and Image Creation, and native provider app-mention nodes for Deep Research, Gmail and Equinox Local. It revalidates exact account-visible label and mark before composing and submitting. Drawing is a separate editor and not treated as a text tool. Source-generated selection expressions were verified in disposable real Chrome tabs without submitting user messages; installed multi-tool sends remain open.

**Native file picker admission (2026-11-22):** Electron main ties each private IPC Native Chat attachment send to exactly one recent user-confirmed native file dialog selection. Other paths, stale names/sizes and expired picks are rejected before browser mutation. A selected-but-unsent local file blocks Native Chat navigation until removed.

**Delivery pre-submit outcomes (2026-11-22):** A one-shot Chat Bridge delivery distinguishes a definitive pre-keyboard failure from an uncertain submit after Enter dispatch starts. The renderer retains the unsent draft; the provider composer may need manual clearing. Neither outcome is automatically retried. Account tool discovery is lazily loaded once per browser session and can be manually refreshed.

**New Chat first-turn staging (2026-11-22, unreleased):** Browser v13 adds a fresh-home-only command for one account-offered tool or one explicitly OS-picked file. It stages the exact provider hint/app mention or file card with user prompt but never submits; the existing task-chat starter verifies model/effort first, then checks the staged marker/file and exact text before its single Send. Removing a draft file or cancelling a New Chat revokes Electron main's one-use file authorization. User Chrome manual source staging was non-submitting; Source Factory remains on the older build.

**Fresh Home hydration:** The first-turn tool/file stage operation waits for an exact completed ChatGPT Home tab and bounded provider composer hydration before touching UI controls. It fails closed on route changes, existing turns or unsent drafts.

**Public share links (2026-11-22, source only):** The provider Share button can create a public URL on the first click, so account-inspection must never click it. Equinox Native Chat uses an additional explicit public-sharing confirmation and one-time mutation receipt before opening the exact conversation in a disposable Your Browser tab and reading the provider-owned readonly share link. If readback fails, the link may already exist: no auto-retry. The historical disposable QA share link inadvertently created during provider discovery was revoked immediately; the account shared-link manager was verified empty afterward. Full Native UI link revocation remains future work.

**Bounded rich table projection:** Provider v13 assistant richText now supports a visible table only when it has 1–80 real HTML rows, 2–12 consistent cells, no cell pipe/newline ambiguity, no media siblings and full visible text equality. Unsupported/complex tables fall back to plain text. The first-party renderer creates safe DOM table nodes, never injects raw provider HTML. Ephemeral actual Chrome DOM checks verified table projection and fail-closed fallback, but did not send messages.

**Native Chat edit candidate (2026-11-22, source only):** The v13 message-edit command verifies one exact visible user message UUID plus old full text in the selected provider conversation, requires an empty composer and idle reply, opens the real provider inline ProseMirror editor and inserts a replacement, verifies the Edit Submit affordance, and consumes a persistent one-time mutation receipt before the first mutation. The source never auto-replays a post-submit ambiguity; status remains blocked for manual Chrome inspection. Native-created task chats are admitted if no active continuation is armed; independent automation tasks are not historically editable. Browser real-DOM preflight worked; actual provider mutation after Send is not yet acceptance-tested.

**Retry/branch discovery:** Assistant message menus in the authenticated Chrome account show direct Retry, and a branch submenu containing Work-mode branch and New-chat branch. No branch or Retry was invoked during DOM inspection; these distinct actions are still missing from the native UI.

**Assistant Retry source candidate:** Browser Chat Bridge v13 can Retry a known exact completed assistant UUID through ChatGPT's visible Other actions menu only after a first-party user confirmation and a browser-persisted one-use receipt. It refuses when the full provider text differs or the composer is busy; it never duplicates the user's prompt. Post-click generation or UUID replacement must be observed. Source read-only preflight succeeded against a genuine assistant message; the Retry item itself was NOT clicked. Source candidate not physically accepted.

**New-chat Branch source candidate:** Browser Chat Bridge v13 separately exposes an exact assistant-turn Branch in new chat action, distinct from Retry and Work-mode branching. After an explicit native user confirmation and browser-persisted unique receipt, it verifies source assistant ID/text, opens the real two-level provider menu, clicks only the account-offered New-chat option and waits for one newly committed conversation ID on the same Chrome window. Unknown provider effects are ambiguous and never retried. The compiled source read-only identity preflight succeeded in an isolated Chrome tab; the live mutation has NOT been accepted and no branch was created during inspection.

**Provider QA correction, 2026-11-22:** Editing a real user turn in a disposable authenticated chat rotates the turn UUID. The updated Edit proof requires a new UUID at the same history position and matches exact replacement text; compiled proof passed against the genuine edited chat. Retry also rotates the assistant response UUID, confirming the designed change-detection path. New-chat Branch initially navigates the SAME tab to a temporary encoded local-chatgpt path, which becomes a durable /c/UUID only after sending the first message. The branch command now takes one explicitly user-confirmed first prompt, stages and sends it once in the verified local-branch composer, then accepts only a durable new conversation UUID plus echoed prompt. No actual source extension was activated. All three operations' embedded CDP scripts use String.raw, and 16 generated JavaScript expressions passed syntax inspection. Exact disposable chats were deleted and the QA tab removed.


**Checkpoint 54 source-only new-chat file attachment:** A disposable signed-in Chrome Home tab genuinely accepted a 57-byte text file using its unique generic file input, with an empty typed composer and enabled provider Send. Submitting the file alone created a durable ChatGPT conversation and an assistant acknowledgment. Native Chat now permits the first turn to contain a verified file without a caption at every admission layer; a late user-turn receipt can match the new conversation's unique file card. The exact QA conversation and local test file were deleted. Installed-source QA remains open. Native sidebar enumeration is partial: Chrome exposed 21 rows, and scrolling did not load older history; provider Search remains the account-grounded way to access older conversations.

**Home-only current-user history source candidate:** Native Chat now observes the provider's real sidebar when the user's only Chrome ChatGPT tab is exactly https://chatgpt.com/. This lets the first-party historical list, account Search, and project picker work without requiring the user to pre-open a conversation. Historical opening from Home retains exact visible-link validation and rejects an unsent composer, attached file, active generation or changed Chrome tab identity. The 21-row current provider sidebar remains partial, not full account enumeration. Source candidate uninstalled.

**Work Branch source candidate, checkpoint 55:** Browser Chat Bridge v13 has a separate `chat_bridge.branch_work_chat` command with strict per-mode provider submenu matching, verified Work ProseMirror editor label (`ChatGPT ile çalış`), local-placeholder route admission, single-use `mwr-` receipt, one first-message Send after explicit Native Chat confirmation and durable new-chat UUID plus sent-prompt proof. It is NOT the New-chat Branch command and cannot silently fall back to it. In an authenticated disposable real Chrome chat, the Work submenu created a same-tab temporary local-chatgpt Work composer; an unsent draft displayed one enabled Gönder button. The test draft was abandoned and its exact source conversation deleted. This does NOT establish installed end-to-end acceptance or forbid account-approved Work tools after the actual user's first prompt.

**Checkpoint 56 response-version discovery and reading:** `chat_bridge.response_versions` is a source-only current-user browser operation. An exact provider assistant UUID/text plus real `Sürümleri görüntüle` action is required; the browser temporarily opens `Sürümler`, enumerates a maximum of 12 distinct provider reply IDs using the provider's original Previous/Next controls, bounds text and closes the dialog, then verifies unchanged conversation identity. An older preview is NOT a switch to the active conversation; provider instead offers `Yeni sohbette dallandır`. The exact compiled provider read script returned two different real QA version IDs, current flag and full short texts, with modal closed and current main reply untouched. Disposable QA conversation deleted and temporary tab closed. Browser candidate v13/1.2.8 not installed or released; no integrated Mac/Windows acceptance.


**Checkpoint 57 historical source Branch candidate:** chat_bridge.branch_version_new is separate from New/Work Branch and requires original assistant UUID/full text plus selected old-version UUID/full text, a current exact conversation, one-use mbv- receipt and explicit first-message send. It navigates the real 'Sürümler' dialog, verifies the selected older reply before clicking 'Yeni sohbette dallandır', then proves the correct older version survives in the local-chatgpt placeholder and a new durable conversation is created after one real Send. The actual compiled provider click expression selected the historical UUID in disposable authenticated Chrome; the resulting branch persisted after one QA prompt and both QA conversations were deleted. No installed-source acceptance yet.


**Checkpoint 58 mixed-file batch candidate:** Existing conversation chat_bridge.deliver also accepts exact ordered filePaths/fileNames/fileSizes arrays (2–4) without bypassing legacy single-file and tool prohibitions. Browser only uses ChatGPT's observed generic multiple file input, verifies exactly one provider name button and matching removal for every selected attachment plus one real document-card/image-thumbnail per file, stable no-busy state and a final pre-Send recheck. One-off in-memory compiled command inspection confirmed the exact batch paths at DOM.setFileInputFiles and a fail-closed no-send error boundary. Actual personal Chrome accepted two separate TXT cards plus PNG thumbnail without a send; all removed and QA tab closed. Browser source v13 still not installed/published; physical Mac/Windows E2E remains the release gate.


**Checkpoint 60 source New Chat first-turn batches:** chat_bridge.stage_new now accepts one selected file or exact ordered 2-4 file path/name/size arrays, total max 100 MiB, and handles mixed document/image cards. Before any Send, actual provider DOM must prove each document filename button or image alt, one matching Remove action, exact visible attachment count, and stable no-busy status; the Task Chat starter repeats the proof immediately before one real button click. The read-only recent-history result now carries exact document-card filenames and a separate bounded image-preview count for user turns. The provider strips original image filenames after Send; do not infer them from generic preview labels. Real provider file-only first-turn mixed-image QA created a disposable durable chat and was then deleted. Bridge v13 remains an uninstalled SOURCE candidate; no CWS submission or Factory update.


**Browser extension version admission, checkpoint 61 (2026-11-22):** The Chrome Web Store user installation is still Browser 1.2.7 / Chat Bridge v12. The separate unreleased **source** candidate now uses manifest version **1.2.8 / Chat Bridge v13**, fixing a same-version collision that would prevent a future Chrome Web Store submission. This source-only version bump is NOT a Chrome install, Web Store upload, installed Factory update, or integrated end-to-end acceptance. The owner reviews/submits any CWS package only when the release gate permits it.


**Browser v1.2.8 review-only package (checkpoint 61):** A uniquely SHA-tagged zip of the source manifest, five compiled JavaScript files, popup HTML/CSS and four icon assets was prepared in the maintainer's Mac Downloads folder, verified byte-for-byte against this branch and checked for archive validity; TypeScript source files, credentials and development files are excluded. The package is for maintainer-controlled CWS review with **automatic publishing off**. It is NOT uploaded, published or installed, and must not be treated as acceptance of Bridge v13 on personal Chrome.
