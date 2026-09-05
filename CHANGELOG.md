# Changelog

All notable public changes to Equinox Local will be documented here.

This project follows semantic versioning for public releases.

## [Unreleased]

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

[Unreleased]: https://github.com/sametbasbug/equinox-local/compare/v4.2.4...HEAD
[4.2.4]: https://github.com/sametbasbug/equinox-local/compare/v4.2.3...v4.2.4
[4.2.3]: https://github.com/sametbasbug/equinox-local/compare/v4.2.2...v4.2.3
[4.2.2]: https://github.com/sametbasbug/equinox-local/compare/v4.2.1...v4.2.2
[4.2.1]: https://github.com/sametbasbug/equinox-local/compare/v4.2.0...v4.2.1
[4.2.0]: https://github.com/sametbasbug/equinox-local/releases/tag/v4.2.0
