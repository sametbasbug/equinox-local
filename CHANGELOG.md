# Changelog

All notable public changes to Equinox Local will be documented here.

This project follows semantic versioning for public releases.

## [Unreleased]

## [5.2.0] - 2026-09-26

- Updated the bundled OpenAI `tunnel-client` runtime from `0.0.14` to `0.0.15` for Apple Silicon and Intel managed releases using the upstream release checksums; the verified tunnel bundle carries cloudflared `2026.8.2`.
- Hardened fresh managed installation: first activation now gets a 60-second health budget, preserves the verified `current` release on startup failure instead of deleting the backend underneath an installed native app, stops the failed LaunchAgent cleanly, and reports bounded LaunchAgent/error-log diagnostics so a retry is recoverable and actionable.
- Managed release smoke now exercises a real isolated macOS `launchctl -> runtime host -> app runtime wrapper -> supervisor -> server` lifecycle instead of stubbing both LaunchAgent activation and health verification.
## [5.1.0] - 2026-09-23

- Peekaboo permission probes no longer invalidate active UI snapshots between observation and mutation, and delivered-but-unconfirmed foreground outcomes are surfaced as ambiguous results that require observation instead of hard tool errors.
- Desktop automation now runs the pinned Peekaboo 4.5+ MCP surface with explicit foreground authority, exposing 22 native desktop tools including coordinate input, move/drag, dialogs, paste, capture, clipboard mutation, app/window/Space lifecycle and verify_state while keeping duplicate Peekaboo AI/browser stacks out of the gateway.
- MCP replay suppression now treats transport request IDs as recyclable hints: only in-flight/same-signal redelivery is exact-deduplicated, while a settled ID reused for a new call executes normally.
- Source-restart recovery explicitly forbids `launchctl submit` one-shot wrappers because macOS infers submitted jobs as KeepAlive and can loop successful restarts.
- Source restart now preserves the whitespace-free private Node alias instead of forwarding Node's resolved `process.execPath`, preventing preflight rejection when the real runtime lives under `Application Support`.
- Source-checkout runtime restart is now single-flight, waits for helper spawn acknowledgement, bounds launch/tunnel lifecycle commands, and records the exact failure stage instead of silently stalling after restart scheduling.
- MCP tool delivery is now replay-safe: duplicate transport delivery reuses the original invocation/result instead of re-running side effects, while intentional new identical calls still execute normally.
- Source-checkout restart now automatically prefers the stable whitespace-free developer Node alias at `~/.local/share/equinox-local-developer/bin/node` and rejects whitespace-bearing Node executable paths before tunnel startup, preventing `Application Support/...` command-path splitting from breaking Local.
- Refreshed current runtime dependencies to Node `26.10.0` and Peekaboo `4.5.0`; `fast-uri` now follows the normal compatible `^4.2.1` range instead of an unnecessary exact pin. tunnel-client remains current at `0.0.14`, and `node-pty` remains on `1.2.0-beta.15` because npm's `latest` tag still points to the older `1.1.0` line.
- Fixed native Control Center confirmation actions such as Task **Mark complete** / **Cancel task** by wiring trusted same-origin `window.confirm()` calls to a macOS sheet.

### Added

- Added a default-on **Telegram remote control** switch in Control Center → Services. Turning it off keeps outbound Telegram delivery available while inbound updates are acknowledged and discarded without delayed replay; browser-bound active assistant turns refresh Telegram's short-lived `typing` indicator from the existing Turn Budget signal.
- Fixed Telegram task-card reconciliation so Bot API `message is not modified` responses are treated as idempotent success; Local now refreshes the persisted display key, emits a recovered observability event, and stops repeated Activity/health warnings.
- Hardened Telegram **New task** creation against ChatGPT startup ref/hydration churn: startup composer replacement, empty/missing transient composers, and stale refs are recovered only while the live composer proves no prompt has been submitted; staged prompt text is postcondition-checked before the trusted send-button click, duplicate typing is avoided, and safe pre-submit failure still rolls back the temporary Task/tab. New Task bootstrap uses the real ChatGPT send control instead of relying on Enter; successful creation auto-selects the Task chat and its Task card exposes Unbind. Transitional `/c/` routes are ignored until the URL exposes a conversation id that satisfies the same binding contract as Task Capsule storage.
- Added **Telegram Chat Bridge** round-trip with exact Task chats and local-file handoff. `/tasks` is the interactive Task control hub and includes **➕ New task**; every active Task exposes Continue / Mark complete / Cancel, while verified/current chats add Use for chat / Unbind / Open in ChatGPT; selected/current Task chat cards expose **↗ Open in ChatGPT** and **🔌 Unbind**; only that explicit Task-creation flow opens one new root ChatGPT conversation and binds it to the new Task Capsule. Normal unbound Telegram messages never create chats. Task-bound turns carry only user text + `task_id` + optional `local_file`. The earlier opaque Chat Bridge attachment resolver layer was removed. Chat Bridge v9 supports the new Task conversation's first assistant response with a null previous-assistant key. Browser-side file re-upload remains removed; guarded `Input.insertText`, real send-button submission, exact user-epoch confirmation, unique stale-tab reacquire and fail-closed ambiguity remain.
- Added **Telegram Remote Control** for the paired private user: chat-scoped native `/status`, `/tasks` and `/help` command discovery, with `/tasks` acting as an interactive Task control hub instead of a chat-only selector, a sectioned phone-friendly `/status` card, **Mark complete** plus bounded next-step/terminal-state polish on durable Task Capsule cards, and short-lived `/status` controls for **Emergency Stop / Resume / Restart**. Emergency Stop and Restart use action-specific two-step confirmation with bounded expiry; the controls reuse the same Agent Control/runtime restart services as Control Center and keep restart-ambiguous mutations fail-closed.
- Added generic **Authenticated HTTP Profiles** under `integrations_call`. Agents can discover safe profile metadata, create/update/delete profile structure and issue bounded authenticated requests without receiving credential values. Control Center provides profile CRUD, Ready/Needs credential state, a default-on agent-management toggle and a write-only credential field.
- Added Bearer and validated secret-header authentication profiles with exact HTTPS origin + base-path scoping, allowed HTTP methods/path prefixes, optional allowed agent headers, bounded query/body/response/timeout handling and redirect refusal.
- Added short-lived **HTTP Response Bindings** for multi-step authenticated JSON APIs. A response exposes an opaque `response_id`; preferred chaining keeps reuse metadata outside the body through `response_bindings` with source/target RFC 6901 pointers. Local injects the same-profile/same-trust string only immediately before fetch. The inline `$equinox_response_ref` form remains supported for compatibility.
- Replaced the old dashboard onboarding card with a dedicated **First-time Setup Mode**. Fresh managed installs keep normal Control Center sections locked while guiding Tunnel ID + restricted Runtime API key creation, ChatGPT tunnel connector setup, required Equinox Browser consent/control, and a final real ChatGPT→Mac MCP verification call. Setup completion is persisted privately and later connection failures do not reopen onboarding; pre-milestone managed upgrades are treated as legacy-complete.
- Added layered **Control Center auto-refresh** so task completion, runtime/browser state, activity, onboarding, Doctor/integrations and cached config/update changes appear without pressing Refresh. Polling pauses while hidden, refreshes immediately on focus, suppresses overlap/transient errors and preserves active local edit drafts.
- Fixed three Control Center live-refresh regressions: Overview no longer derives live ChatGPT/MCP connection status from onboarding availability, fast partial status refreshes no longer erase richer Peekaboo version/readiness state, and background auto-refresh GETs and the native menu-bar heartbeat no longer inflate the user-facing Control Center request counter.
- Added secure **Telegram private-user pairing** and first-time Setup guidance. Telegram is optional but marked Recommended; Setup teaches BotFather `/newbot`, token copy, bot `/start`, detected-account confirmation and an explicit Skip for now path. Manual Telegram user-ID entry is no longer required by the UI.
- Added a private bounded Telegram inbound-update foundation with persisted next-update offsets, private-user-only filtering, restart-safe replay prevention and a 50-message local queue. The agent surface still exposes no generic Telegram inbox/read operation.
- Added the **Telegram task inbox** layer: one durable/editable Telegram card per changed Task Capsule, bounded Continue/Cancel/Open-in-ChatGPT controls, reply→Task Capsule `humanInput` routing, private exact ChatGPT task binding and guarded bound Auto Continue for replies/Continue actions. Telegram task-message mappings and action reservations are durable; processing actions interrupted by restart become ambiguous and are never replayed automatically.
- Added bounded **Telegram file/photo exchange**. A photo/document attached to an exact mapped task-card reply is downloaded through Bot API `getFile` and exposed to the task only as opaque attachment metadata; `telegram_attachment_open` requires the exact task + attachment id. Agents can send accessible local files/photos back with `telegram_send_file`, which keeps the paired recipient fixed and reuses Local's normal file-export access policy.
- Telegram inbound files now default to the visible `~/Downloads/Equinox Local/Telegram/` folder. Control Center can switch the destination or reset it to default without restart; prior roots remain known so existing task attachments keep working, and user-visible downloads are not auto-deleted or removed on Telegram disconnect.
- Web file transfer imports now default to the visible `~/Downloads/Equinox Local/Web/` folder when `file_import` has no explicit destination. Control Center can change/reset that default immediately, and user-visible imported files are not auto-deleted.

### Fixed

- Resolved release-gate CodeQL findings in authenticated-HTTP and Telegram tests, and documented the intentionally bounded/private persistence boundary for validated Telegram network state.
- Removed a host-PID collision from the process-manager stop regression test so CI no longer mistakes an unrelated runner process group for a fake managed-process descendant.
- Completed/cancelled Task Capsules no longer remain usable as Telegram Chat Bridge targets. Any already-pending final response may settle first, then Local auto-unbinds the Task; terminal cards keep **Open in ChatGPT** but cannot be rebound, and each new bridged send re-checks Task status before browser mutation.
- Fixed clean first installs spawning two Equinox Local foreground shells (and therefore duplicate menu-bar/Nyx companion instances). The installer now leaves foreground-shell ownership entirely to the LaunchAgent runtime host; a fresh profile defaults the first runtime-host shell to a visible Control Center, while later restarts continue honoring the user's stored window visibility.
- Fixed Turn Budget / Auto Continue passive state checks keeping Chrome's **“Equinox Browser started debugging this browser”** infobar visible throughout long turns. ChatGPT continuity state now comes from a narrowly scoped content-script observer/cache, while `chrome.debugger` remains reserved for actual browser-control and continuation-delivery mutations.
- Fixed the **Turn Budget** elapsed counter continuing after an assistant turn had finished. Browser-bound identity now uses the latest user epoch as its primary turn key, and passive status reads retire finished turns to Idle without starting the next turn's timer before its first Local call.
- Shortened debugger lifetime after one-shot Auto Continue and Fresh Chat Resume delivery mutations: a delivery-acquired attachment now releases after 250 ms, while an already-active normal browser-automation attachment keeps its existing 60-second sliding lease.

### Security

- Authenticated HTTP credentials remain private local data: agent schemas/results never contain the secret, trust-boundary changes clear an existing credential, request validation happens before Local attaches authentication, and the exact credential is redacted from returned response/error material. Emergency Stop blocks authenticated HTTP mutations through the normal mutation gate.
- Response references are memory-only and bounded (10-minute TTL, 64 entries, 16 MiB), bind both profile ID and credential trust identity, capture only valid non-truncated JSON, resolve only strings in V1, and transiently redact resolved opaque values if a downstream service echoes them. Profile credentials are exact-redacted before any internal reference body is cached.

## [5.0.0] - Continuum

### Added

- Added durable bounded **Task Capsules** for long-running agent work. Capsules persist human-readable objective/completed/next/reference state plus monotonic checkpoint revisions without duplicating ChatGPT transcripts. The store retains at most 50 capsules by default, prunes only oldest terminal records under capacity pressure, and Control Center supports bounded inspection, revision-guarded edits, completion/cancellation, pending-continuation cancellation and confirmed permanent deletion of completed/cancelled capsules.
- Added explicitly armed one-shot **Auto Continue** for ChatGPT tasks. Each automatic hop binds the exact Browser/profile/tab/conversation/user-turn identity, has a TTL, survives safe Local restarts while still armed, and must be explicitly re-armed; automatic chains are capped at three hops.
- Added configurable **Turn Budget** guidance for long ChatGPT Web turns. The default-on 22-minute safety cutoff starts on the first Local use, binds to Browser assistant-turn identity when available, emits escalating checkpoint/finalization guidance through the existing seven-tool surface, shortens long blocking waits near the cutoff, and exposes live elapsed/remaining/stage plus immediate settings in Control Center → Safety. It never force-stops a turn or auto-arms continuation.
- Added a profile-local Equinox Browser popup selector for Auto Continue targeting: automatic current generating task by default, or one human-pinned open ChatGPT conversation.
- Added guarded **Fresh Chat Resume** for moving an active Task Capsule into one fresh ChatGPT conversation while preserving root/project scope, durable at-most-once transition state and confirmed destination rebinding without transcript copying.
- Added Task Recovery UX in Control Center for Fresh Chat Resume waiting/cancelled/ambiguous states, including explicit cancel/clear actions and human-readable stop reasons.

### Changed

- Updated runtime dependencies to @modelcontextprotocol/sdk 1.30.1 and fast-uri 4.2.1. node-pty remains on the current 1.2.0 beta line because npm’s stable latest tag still points to the older 1.1.0 release.
- Refreshed the 5.0 runtime baseline to Node `26.8.2`, Peekaboo `4.4.0`, and Zod `4.6.5`; tunnel-client remains current at `0.0.14`, MCP SDK remains current at `1.30.0`, and `node-pty` intentionally stays on the current `1.2.0-beta.15` beta tag rather than regressing to npm's older `1.1.0` stable tag.
- Reduced the agent-facing MCP connector surface from 15 top-level tools to 7 without removing capabilities: one unified read-only `capabilities` discovery tool plus `runtime_call`, `files_call`, `browser_call`, `desktop_call`, `release_call` and `integrations_call`. The empty Git gateway and duplicated `*_tools` catalogs are removed; release QA/deployment share one domain; desktop maintenance is explicit; Browser exposes short operation aliases while retaining internal compatibility.
- Control Center task rows and task details now show the durable `task-...` Task Capsule ID so humans can match a visible task to agent handoff/resume instructions without guessing from the title.
- Control Center navigation now includes Tasks alongside Overview, Projects, Browser, Safety, Services and Activity. Emergency Stop refreshes Task state after retiring pending continuations.
- The public source projection now includes the Task Capsule and Auto Continue runtime modules plus their regression coverage.

### Fixed

- Fixed PTY natural-exit cleanup so background jobs that detach from the controlling TTY remain owned through their kernel POSIX session and are drained before the terminal session finalizes.
- Fixed macOS login/reboot startup so the LaunchAgent runtime host automatically restores one foreground Equinox Local shell when none is registered, bringing back the menu bar and Nyx companion without duplicating an already-running shell.
- Unified native Quit handling so menu-bar Quit, app-menu/Cmd-Q, Dock > Quit, and other normal macOS termination requests all pass through the same verified fail-closed LaunchAgent hard-stop lifecycle. Force Quit remains outside that graceful lifecycle guarantee.

### Security

- Auto Continue is human-first and fail-closed: composing/new user input, Emergency Stop, explicit cancellation, target drift, a closed/navigated pin or an unsafe/non-empty composer prevents the next automatic turn. Stale explicit pins never fall back to another tab/profile. Delivery is reserved before browser mutation, the extension claims a bounded receipt before submission, and ambiguous delivery is never blindly retried.
- Fresh Chat Resume uses the same fail-closed boundary: destination creation/submission is receipt-guarded and at-most-once, only `prepared` work resumes after restart, and ambiguous browser mutation has no automatic or Control Center retry path. Clearing recovery state never replays the uncertain browser action.

## [4.8.0] - 2026-09-10

### Added

- Added a native macOS menu-bar controller with live Active/Paused/Needs Attention state, Local-managed Terminal/process counts, Open Control Center, Agent Browser status/launch, Restart, Emergency Stop/Resume and safe Quit. Closing Control Center now keeps the menu-bar controller alive while removing the Dock icon; reopening restores the normal Dock/window presence.
- Added bounded `image_view` support to the Files gateway so an agent can visually inspect a user-supplied local PNG, JPEG or WebP path as real MCP image content. Files discovery now explicitly routes Mac-local visual-inspection tasks to `image_view` first and warns against using `file_export`/container-copy merely to inspect an image. The capability follows structured Agent Access root rules, blocks protected/sensitive paths and symlinks, and enforces byte, dimension and pixel budgets without restoring generic file-read wrappers.
- Fixed the stable `files_call` connector contract to preserve raw multimodal MCP content instead of advertising a text-only output schema; `image_view` can now reach the model through the gateway as an actual image payload.
- Added Control Center Emergency Stop / Resume with bounded Active Work counts and a global paused-state banner. Emergency Stop immediately marks the agent paused, blocks new mutating MCP operations, stops Equinox Local-managed Terminal/process work, keeps read-only status available, and records metadata-only audit events. Resume never restarts stopped work.

### Changed

- Rebuilt Control Center around clearer workspace/system navigation, a focused runtime overview, explicit ChatGPT-to-Mac connection state, collapsible lower-priority diagnostics and persistent `System / Light / Dark` appearance selection. System mode follows macOS theme changes, and small secondary/metadata text was enlarged for better readability at the native window size.
- Reframed Control Center access around the terminal-first architecture: Local Execution is shown as the core logged-in-user capability; Browser and Desktop remain separate controls; structured Full/Selected scope and Terminal disable stay under Advanced restricted mode instead of being presented as a general sandbox.
- The menu-bar status item uses a compact native `EL` monogram for clear Equinox Local recognition while preserving Active/Paused/Offline opacity and tooltip cues.

### Fixed

- `Quit Equinox Local` now performs a real fail-closed hard stop: it validates the trusted LaunchAgent, boots it out, stops the source-checkout tunnel-owned runtime when applicable, waits boundedly for Control Center to go offline, and only then exits the native app. Reopening the app safely bootstraps the trusted LaunchAgent without starting source and managed runtimes together.

## [4.7.0] - 2026-09-08

### Added

- Added bounded `process_wait` continuation for finite managed Terminal work, allowing agents to wait on the exact promoted process without polling log calls or restarting the command.

### Changed

- Completed the terminal-first second-wave pruning: ordinary GitHub/Actions convenience wrappers, the retired asset inbox, rollback/recovery convenience reads and recipe discovery were removed while special release/deploy/runtime audit capabilities remain explicit. The retained non-Browser surface is 37 operations.
- Raised the supported Node.js floor and bundled managed runtime from Node `24.20.0` to current Node `26.8.1` for Apple Silicon and Intel; public CI, release validation and future reviewer packages now use the same pinned runtime line.
- Updated the bundled universal Peekaboo runtime from `4.3.0` to `4.3.3` with the verified OpenClaw Developer ID/Team ID and new pinned upstream SHA-256.
- Updated the direct `fast-uri` dependency from `3.1.6` to `4.1.4`; `node-pty` intentionally remains on the newer `1.2.0-beta.15` line rather than regressing to the older `1.1.0` npm stable tag.
- Refreshed npm lockfiles and compatible transitive dependencies while retaining current `@modelcontextprotocol/sdk`, `pixelmatch`, `pngjs`, `zod` and `tunnel-client` versions where upstream already matches the repository.

### Fixed

- Fixed fresh-install Control Center launch so the verified native app executable starts directly with a clean detached environment before LaunchServices/browser fallbacks, avoiding first-launch races that could open localhost in Chrome even though the native app was healthy.

## [4.6.3] - 2026-09-08

### Changed

- Finalized the Local-facing Equinox Browser 0.5.x capability contract around Snapshot v9, projection-aware semantic waits, stable ref/action lifecycle recovery, explicit primary-action versus postcondition outcomes, and opt-in web-content privacy redaction.
- Added semantic `range_set` v2 support to the Browser gateway and version negotiation, covering native and ARIA sliders while failing closed against older extension workers.
- Kept Agent Browser capability-gated operations on the normal lazy-start path so bookmark search/mutations and other versioned calls can be the first operation after the isolated browser was shut down.

### Fixed

- Fixed capability checks that could inspect an idle Agent Browser context before lazy-start and incorrectly report that a current extension version was required.
- Improved Browser action/result lifecycle handling for delayed downloads, stale same-page controls, compound readiness and post-action failures so agents can distinguish safe retry, completed primary actions and uncertain outcomes.

## [4.6.2] - 2026-09-07

### Changed

- Simplified ordinary local repository work around a terminal-first surface: file/repo/local-Git/npm/build/test operations now use the generic Terminal path instead of dozens of narrow wrappers, while GitHub, release, credential/deploy, Browser, Desktop and other genuinely special capabilities remain explicit.
- Reduced the non-Browser public operation surface to 56 operations and internalized the generic workflow gateway without removing the durable workflow engine used by release, recovery and maintenance.
- `terminal_exec` now starts work in the managed process lifecycle. `wait_ms` only bounds the foreground MCP response; unfinished work continues under the same process ID for `process_logs` / `process_stop` rather than being killed and restarted.
- Added bounded separate stdout/stderr plus ordered combined output, project/cwd execution metadata and deterministic noninteractive pager/Git-prompt behavior without exposing Equinox-managed provider credentials to generic shells.
- Strengthened source-checkout supervision so a stopped tunnel process releases the stable app host back to launchd only after consecutive confirmed stopped-state observations; network/probe uncertainty does not trigger restart loops.
- Added production-composition regression coverage so missing helper wiring, Browser initialization-order mistakes and workflow/runtime integration regressions fail in the factory suite instead of first appearing during a live source restart.

### Security

- Hardened file creation/replacement races, configuration revision serialization, overlapping mutation ownership, detached-helper startup errors, descendant process-group cleanup and terminal capacity reservation.
- Git worktree/common-dir metadata is now read through bounded `O_NOFOLLOW` file handles with descriptor-level stat checks, closing the path check-to-read race detected by the public CodeQL gate.
- Hardened PTY lifecycle ownership on macOS by tracking jobs observed on the private controlling TTY and draining resistant/disowned background jobs during stop/shutdown instead of assuming shell-PID exit means cleanup is complete.
- Added bounded updater transfers, Browser transport buffering and PNG decode/canvas budgets; stabilized observability reads during rotation and reduced Control Center internal error/detail exposure.
- Preserved the explicit trust boundary: Terminal is a broad logged-in-user shell rather than a selected-root sandbox, generic Terminal/process environments strip secret-like provider variables, and Control Center exposes no arbitrary shell HTTP endpoint.

## [4.6.1] - 2026-09-05

### Changed

- Equinox Browser history navigation now waits for bounded committed/settled tab metadata before returning from back/forward operations, including same-document SPA history changes. The bridge advertises navigation capability v2 so older extension builds fail closed instead of returning stale page metadata.
- Safe semantic ref reacquisition now uses reacquire capability v2 and reports explicit stale-document context metadata (`refContextValid=false`, `freshSnapshotRequired=true`) after cross-document navigation.
- Dense annotated screenshots are capped at 50 labels and avoid overlapping label placements where possible; snapshot/delta/ref stability and bounded `ref_info` behavior are covered by stronger regression tests.
- The macOS `desktop_call` MCP surface now publishes an explicit structured output schema while preserving the original rich Peekaboo content blocks, removing the schema recommendation shown by ChatGPT clients.

### Fixed

- Fixed back/forward calls that could return the previous page URL/title when Chrome had not yet committed the history navigation metadata.

## [4.6.0] - 2026-09-05

### Added

- Expanded the first-party Equinox Browser agent surface with compact Snapshot v3 output, bounded device/mobile emulation, semantic touch tap/swipe gestures, richer click and keyboard input semantics, safer `ref_info`/reacquire workflows, and reusable bounded post-action wait/snapshot chains.
- Added Console/Network Observation v2 with stable cursors, bounded filtering and metadata-only network-response waits, allowing agents to continue long browser tasks without repeatedly replaying large observation buffers.
- Added Agent Browser bookmark management for saved sites and folders, including bounded list/search/create/update/move/remove operations. Bookmark capability v2 returns readable folder paths on reads and mutations so agents can understand nested organization without dumping the full tree. Bookmark tools are intentionally available only in the isolated Agent Browser context; Your Browser bookmark automation is blocked before the bridge and again inside the extension.

### Changed

- Equinox Browser capability negotiation is now versioned across snapshot, navigation, input, click, actionability, observation, emulation, touch gestures and bookmarks so Local rejects unsupported mutations before sending them to an older extension.
- The Equinox Browser extension now requests Chrome's required `bookmarks` permission for the isolated Agent Browser workspace and advances the browser-data consent contract to version 2. Existing consent v1 does not silently carry over; users must accept the updated disclosure before browser automation resumes.
- Browser screenshot/snapshot/ref workflows remain bounded by default, sensitive network/bookmark URL query values are redacted, and request/response bodies, raw auth headers, cookies and credentials remain outside the agent-facing observation surface.

### Fixed

- Browser actions now share stricter semantic actionability and stale-ref failure behavior across nested frames/OOPIF routing, reducing accidental clicks, typing or drags against replaced or obscured targets.

## [4.5.0] - 2026-09-03

### Added

- Added a first-class isolated **Agent Browser** context backed by the same Equinox Browser extension and Native Messaging transport as the user's Chrome. Browser operations now default to `target=agent`, while `target=user` explicitly selects **Your Browser** when a task needs the user's existing Chrome session.
- Control Center now shows Agent Browser and Your Browser as separate contexts, can launch the isolated Agent Browser, and edits Browser settings for either profile without adding a second browser tool family.
- The Equinox Browser toolbar popup now includes a bounded **Open Agent Browser** action so the user can bring up the agent's isolated browser without asking the agent to do it.

### Changed

- Equinox Browser profile identity is persisted per Chrome profile with a random instance ID and explicit `agent` / `user` context. Concurrent contexts route independently and never silently fall back to the other profile.
- Internal release/visual browser QA now uses the first-party Agent Browser path. The legacy loopback `:9223` Selene Chrome backend, its special CDP/profile modules and its diagnosis/repair/recovery hooks have been retired.

### Fixed

- Agent Browser now prepares a validated profile-local Native Messaging host manifest before launching Chrome, allowing custom `--user-data-dir` profiles to connect reliably without extension sideloading or a remote-debugging port.

## [4.4.1] - 2026-09-03

### Changed

- Updated the bundled OpenAI tunnel runtime from `tunnel-client` `0.0.13` to `0.0.14` for Apple Silicon and Intel managed releases, with new pinned upstream SHA-256 metadata.
- Updated the bundled universal Peekaboo runtime from `4.2.2` to `4.3.0`, retaining strict OpenClaw Foundation Developer ID / Team ID verification and source-runtime synchronization.
- Aligned the Desktop bridge with Peekaboo 4.3.0 background authority: foreground-only drag/move/hotkey surfaces are no longer required, while explicit foreground/shared-pointer click and scroll requests remain blocked by Equinox Local.
- Refreshed compatible transitive npm dependencies within their existing semver ranges; Node.js remains pinned to the current `24.20.0` Krypton LTS runtime.

## [4.4.0] - 2026-09-02

### Added

- Managed releases now bundle the pinned, verified Peekaboo `4.2.2` universal runtime and source-checkout restarts synchronize the same private pinned desktop runtime, removing the product dependency on a separately installed system/Homebrew Peekaboo.
- Control Center now supports persistent English/Türkçe UI selection, includes Agent Access controls for files, Terminal/processes, Desktop and Equinox Browser, and links directly to the official Equinox Browser Chrome Web Store listing from onboarding, Browser and Integrations.
- Added an atomic structured `write_file` capability with SHA-256 preconditions for replacement, so agents can create or safely replace UTF-8 files without falling back to Terminal.

### Changed

- Fresh managed installs now start with maximum useful Agent Access: Full normal-file access plus Terminal/process, Desktop and Equinox Browser lanes enabled. Existing pre-Agent-Access configs preserve selected-root filesystem behavior until the user changes it.
- Full file mode can address `home` or another accessible absolute folder without pre-registering every project. Core structured file CRUD now works on ordinary non-Git roots; Git-specific ignore/dirty-worktree checks remain additive only inside actual Git repositories.
- Hidden agent workspaces such as `.codex`, `.openclaw` and `.claude` are accessible in Full mode while known authentication, credential, session-environment and application-secret paths remain protected.
- Persistent runtime/audit messages are now canonical English; Control Center localizes supported Activity messages for the selected UI language.

### Fixed

- Control Center exposes a guarded Restart action for managed installs and source-checkout development runtimes and waits for the replacement runtime before reloading the UI.
- Source-checkout restart lifecycle handling no longer races LaunchAgent teardown/bootstrap, and launch logs are bounded without replacing their stable files.
- Managed release smoke tests use an isolated Equinox Browser Unix-socket namespace, preventing release validation on the same Mac user from removing the live Browser bridge socket and disconnecting the Chrome extension.
- Repeated healthy Peekaboo compatibility checks are deduplicated in runtime activity instead of writing the same informational event on every tool-cache refresh.

## [4.3.1] - 2026-09-01

### Fixed

- Fresh managed installs now package the Control Center brand logo at the path served by the loopback UI, so the logo renders the same way in native and browser views.
- The public first-install bootstrap now opens the native `Equinox Local.app` window after a successful install, with the localhost Control Center URL kept only as a fallback.

## [4.3.0] - 2026-09-01

### Changed

- Control Center now ships as a native macOS `Equinox Local.app` window backed by the existing loopback-only `127.0.0.1:24891` service; the localhost URL remains available for development and diagnostics instead of being the normal user entry point.
- Reworked Control Center into a flatter native-app layout with status strips, separator-based lists and fewer nested cards, and replaced the placeholder AppleScript icon with the Equinox Local product logo.
- Restored the conservative restart turn boundary: after scheduling an Equinox Local runtime restart, agents must return a final status response instead of attempting more Local calls in the same assistant turn.
- Removed the standalone GitHub CLI card from Control Center. GitHub remains an implementation dependency of the guarded Git/GitHub gateway where needed, rather than a user-facing optional integration.

### Fixed

- Source-checkout native app hosting now uses a persistent LaunchAgent (`KeepAlive`) instead of a five-minute interval, so closing the foreground Equinox Local window cannot leave the local runtime offline; Control Center status refreshes now use passive Peekaboo readiness and never invoke the macOS permission probe on page reload.
- Native app-host synchronization now treats a valid same-version app bundle as a stable macOS permission identity and preserves it byte-for-byte until the native shell version explicitly changes; ordinary runtime or release updates no longer re-sign the app and invalidate TCC permissions.
- Source and managed runtime wrappers now monitor native-host parent death and clean their owned children, while restart/install flows drain the existing runtime before reload and no longer use `launchctl kickstart -k`; this prevents orphan wrapper/Peekaboo/supervisor processes from turning `KeepAlive` into a 10-second restart loop without changing the stable native app binary or resetting macOS permissions.
- Peekaboo 4.2.x permission parsing now accepts the current `(Required)` labels, preventing Control Center and System Doctor from reporting missing Screen Recording or Accessibility permissions when they are granted.
- Source-checkout restart waits for asynchronous LaunchAgent teardown and retries `launchctl bootstrap` within a bounded window, avoiding transient macOS `Bootstrap failed: 5: Input/output error` failures.
- The Equinox Browser Native Messaging installer now installs and removes the shared socket-path module together with the host runtime, preventing stale host/runtime path drift.
- Backend GitHub readiness checks now execute inside a valid project context instead of incorrectly reporting a disconnected GitHub CLI session.

## [4.2.4] - 2026-08-31

### Changed

- macOS Screen Recording and Accessibility permissions now belong to one stable `Equinox Local.app` identity (`dev.equinox.local`) that is preserved across updates; users no longer grant those permissions separately to Peekaboo, Peekaboo Bridge, Terminal, Node, or versioned runtime binaries.
- Peekaboo desktop automation is forced into local/no-remote mode beneath the Equinox Local app host, while managed and source-checkout LaunchAgents both start through the same stable app identity.
- Public CI now uses Node.js `24.20.0`, matching the bundled Node 24 LTS runtime shipped by Equinox Local.
- Uninstall removes the owned Equinox Local app host and runtime wrapper while refusing to delete an app at that path with another bundle identity.

### Fixed

- Source-checkout restarts now fail closed unless the Equinox Local server process is actually replaced, preventing a stale in-memory runtime from reporting an older product version after the source checkout advances.
- Control Center integration status now probes GitHub and Peekaboo on refresh instead of showing misleading `Not checked` or `Disconnected` states for working optional integrations.
- Equinox Browser status now distinguishes an unconnected extension from a failed Local bridge, and the duplicate Integrations heading was removed.
- Runtime restart no longer imposes a same-assistant-turn stop; after the connector reconnects, Doctor/status checks can immediately verify the new process and version.

### Diagnostics

- System Doctor now compares the running source-checkout process version against the tracked source version and reports stale-process drift as attention.
- Peekaboo status now reports compatibility and required macOS permission readiness instead of treating lazy bridge startup as a disconnect.

## [4.2.3] - 2026-08-30

### Changed

- Updated the bundled Node.js 24 LTS runtime from `24.19.0` to `24.20.0` for Apple Silicon and Intel managed releases.
- Source-checkout restarts now synchronize the development tunnel runtime from the same pinned tunnel-client version and SHA-256 metadata used by managed releases, installing it into a private per-user developer runtime directory instead of mutating an external package-manager binary.

### Diagnostics

- System Doctor now reports source-checkout tunnel runtime drift as attention with expected/actual versions, without exposing the configured executable path.

## [4.2.2] - 2026-08-30

### Changed

- Updated the bundled tunnel runtime from `tunnel-client` `0.0.12` to `0.0.13` for both Apple Silicon and Intel managed releases.
- Refreshed runtime dependencies to `fast-uri` `3.1.6`, `node-pty` `1.2.0-beta.15`, and `zod` `4.5.4`.

## [4.2.1] - 2026-08-30

### Added

- Optional Telegram Bot API delivery through the stable Services & integrations gateway, fixed to one private Telegram user ID.
- Control Center connect, test, and disconnect controls for the Telegram integration.

### Fixed

- Use a supported mutation-lock scope for agent-initiated Telegram delivery so `telegram_send_message` works through the stable services gateway.

### Security

- Agents can provide only message text and cannot choose or override the Telegram recipient.
- Group, supergroup, and channel targets are rejected, and no Telegram inbox/read operation is exposed to agents.

## [4.2.0] - 2026-08-30

### Added

- Clean public source layout for Equinox Local and Equinox Browser.
- Loopback Control Center for human-readable configuration, health, onboarding, updates, and uninstall.
- Stable MCP gateway surface backed by a dynamic capability registry.
- Explicit project/file-root configuration with path and symlink guards.
- Equinox Browser Native Messaging bridge with user consent and browser-control toggle.
- Managed Local installation, Ed25519-signed update metadata, activation health verification, and automatic rollback.
- Persistent workflow, observability, diagnosis, repair, recovery-policy, and runtime-janitor subsystems.
- Optional bounded Peekaboo desktop bridge.
- Public test, CI, security, architecture, contribution, and release documentation.

### Security

- Internal release/QA browser surfaces are excluded from the public product capability registry.
- Private Orbit/deployment configuration and machine-specific development infrastructure are excluded from the public source projection.

[Unreleased]: https://github.com/sametbasbug/equinox-local/compare/v5.1.0...HEAD
[5.1.0]: https://github.com/sametbasbug/equinox-local/compare/v5.0.0...v5.1.0
[5.0.0]: https://github.com/sametbasbug/equinox-local/compare/v4.8.0...v5.0.0
[4.8.0]: https://github.com/sametbasbug/equinox-local/compare/v4.7.0...v4.8.0
[4.7.0]: https://github.com/sametbasbug/equinox-local/compare/v4.6.3...v4.7.0
[4.6.3]: https://github.com/sametbasbug/equinox-local/compare/v4.6.2...v4.6.3
[4.6.2]: https://github.com/sametbasbug/equinox-local/compare/v4.6.1...v4.6.2
[4.6.1]: https://github.com/sametbasbug/equinox-local/compare/v4.6.0...v4.6.1
[4.6.0]: https://github.com/sametbasbug/equinox-local/compare/v4.5.0...v4.6.0
[4.5.0]: https://github.com/sametbasbug/equinox-local/compare/v4.4.1...v4.5.0
[4.4.1]: https://github.com/sametbasbug/equinox-local/compare/v4.4.0...v4.4.1
[4.4.0]: https://github.com/sametbasbug/equinox-local/compare/v4.3.1...v4.4.0
[4.3.1]: https://github.com/sametbasbug/equinox-local/compare/v4.3.0...v4.3.1
[4.3.0]: https://github.com/sametbasbug/equinox-local/compare/v4.2.4...v4.3.0
[4.2.4]: https://github.com/sametbasbug/equinox-local/compare/v4.2.3...v4.2.4
[4.2.3]: https://github.com/sametbasbug/equinox-local/compare/v4.2.2...v4.2.3
[4.2.2]: https://github.com/sametbasbug/equinox-local/compare/v4.2.1...v4.2.2
[4.2.1]: https://github.com/sametbasbug/equinox-local/compare/v4.2.0...v4.2.1
[4.2.0]: https://github.com/sametbasbug/equinox-local/releases/tag/v4.2.0
