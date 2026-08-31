# Changelog

All notable public changes to Equinox Local will be documented here.

This project follows semantic versioning for public releases.

## [Unreleased]

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
