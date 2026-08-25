# Changelog

All notable public changes to Equinox Local will be documented here.

This project follows semantic versioning once the first public release is cut. The current source tree is a release candidate and intentionally uses a development package version until that release boundary is chosen.

## [Unreleased]

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

[Unreleased]: https://github.com/sametbasbug/equinox-local/commits/main
