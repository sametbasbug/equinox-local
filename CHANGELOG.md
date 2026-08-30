# Changelog

All notable public changes to Equinox Local will be documented here.

This project follows semantic versioning for public releases.

## [Unreleased]

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

[Unreleased]: https://github.com/sametbasbug/equinox-local/compare/v4.2.1...HEAD
[4.2.1]: https://github.com/sametbasbug/equinox-local/compare/v4.2.0...v4.2.1
[4.2.0]: https://github.com/sametbasbug/equinox-local/releases/tag/v4.2.0
