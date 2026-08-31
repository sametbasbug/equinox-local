# AGENTS.md

## Scope

These instructions apply to the entire Equinox Local public repository unless a deeper `AGENTS.md` overrides them.

## Product boundaries

- Equinox Browser is the only public/product browser automation route. Do not add alternate user-Chrome automation paths or generic CDP fallbacks.
- Control Center extends the existing loopback backend at `127.0.0.1:24891`; do not add a competing local server.
- Management APIs must remain loopback-only, bounded, and same-origin/CSRF protected for mutations. Never turn them into a generic shell or arbitrary-command backend.
- Project and folder access must remain explicit, allowlist-based, path-contained, and fail-closed. Preserve SHA guards, symlink checks, mutation locks, and bounded I/O.
- Never expose credentials, update-signing secrets, runtime keys, private tokens, raw observability storage paths, or sensitive machine details through MCP, APIs, UI, logs, tests, or fixtures.
- Keep product source generic. Machine-specific project names, local paths, personal credentials, and private deployment configuration do not belong in the public repository.
- Optional capabilities must fail independently. Core Equinox Local must remain usable without Telegram, Peekaboo, Equinox Browser, or other optional integrations.
- macOS Screen Recording and Accessibility permissions belong only to the stable `Equinox Local.app` identity (`dev.equinox.local`). Peekaboo is an internal local/no-remote desktop engine; do not create a separate Peekaboo/Bridge/Terminal/Node TCC permission path.
- Telegram delivery must preserve the one-human boundary: one configured positive Telegram user ID, no group/channel target, no agent-selectable recipient, and no inbox/read operation exposed to agents.
- Chrome Web Store owns Equinox Browser distribution and updates. The Equinox Local updater must not overwrite or sideload the extension.
- Public Equinox Local installation must not require a paid Apple Developer Program membership, Developer ID certificate, notarization, Mac App Store submission, or `.pkg` installer. Preserve the user-level HTTPS bootstrap model unless the project explicitly changes direction.

## Development workflow

- Inspect `git status` before editing and preserve existing dirty work. Never reset, discard, or overwrite unrelated changes casually.
- Work on `equinox/` branches; do not commit directly to `main`.
- Prefer focused changes and existing modules/APIs over parallel implementations.
- When modifying an already-dirty file, inspect its current diff first and preserve unfinished work.
- Do not merge to `main`, create a public release, publish Equinox Browser, or submit Chrome Web Store changes without explicit maintainer authorization.
- Managed install/update work must preserve source-checkout development behavior rather than replacing it in place.

## Validation

- After code changes, run `npm run check`.
- Run the full `npm test` suite before considering a coherent checkpoint complete.
- Run `git diff --check` before commit/push.
- Add or update tests for behavior changes, especially security boundaries, updater/rollback behavior, onboarding, Control Center APIs, Telegram recipient isolation, and browser-lane isolation.
- Release-affecting changes must preserve the established release gates: clean public source, CI/CodeQL, native ARM64/x64 validation, signed stable manifests, and production-domain upgrade smoke for real version bumps.
- Runtime restarts may be followed by same-turn read-only Doctor/status verification after the connector reconnects; do not treat restart as a reason to skip post-restart validation.

## Architecture references

- `README.md` describes the supported public product surface.
- `docs/architecture.md` is the public architecture reference.
- `SECURITY.md` defines vulnerability-reporting expectations.
- Historical implementation ideas or private development infrastructure must not be reintroduced merely because similar code or terminology appears in old discussions or commits.
