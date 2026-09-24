# AGENTS.md

## Scope

These instructions apply to the entire Equinox Local public repository unless a deeper `AGENTS.md` overrides them.

## Product boundaries

- Equinox Browser is the only public/product browser automation route. It serves two isolated contexts through the same extension/Native Messaging engine: Agent Browser is the default and Your Browser is explicit personal Chrome. Never add silent cross-context fallback, alternate user-Chrome automation paths, generic CDP fallbacks, or a second QA browser backend.
- Control Center extends the existing loopback backend at `127.0.0.1:24891`; do not add a competing local server.
- Management APIs must remain loopback-only, bounded, and same-origin/CSRF protected for mutations. Never turn them into a generic shell or arbitrary-command backend.
- Project and folder access follows the loaded Full/selected Agent Access mode and remains path-contained and fail-closed. Selected mode is limited to configured roots; Full mode may use contained home/absolute folders while filesystem root, protected credential/application-secret areas, traversal and symlink escape remain blocked. Preserve SHA guards, mutation locks, and bounded I/O.
- Never expose credentials, update-signing secrets, runtime keys, private tokens, raw observability storage paths, or sensitive machine details through MCP, APIs, UI, logs, tests, or fixtures.
- Keep product source generic. Machine-specific project names, local paths, personal credentials, and private deployment configuration do not belong in the public repository.
- Optional capabilities must fail independently. Telegram, Peekaboo/Desktop and other optional integrations must not block the core runtime. Equinox Browser is different: it is a required product component for fresh managed onboarding and the supported ChatGPT Web continuity/browser path.
- macOS Screen Recording and Accessibility permissions belong only to the stable `Equinox Local.app` identity (`dev.equinox.local`). Peekaboo is an internal local/no-remote desktop engine; do not create a separate Peekaboo/Bridge/Terminal/Node TCC permission path.
- Telegram must preserve the one-human boundary: pairing accepts only an explicitly confirmed private `/start` user, groups/channels and unpaired users are rejected, the agent cannot select another recipient, update offsets/task-action reservations are restart-safe, and no generic inbox/read operation is exposed to agents. Inbound Telegram chat data may reach ChatGPT only through an explicit exact Task Chat binding. Unbound normal messages must not guess or create a destination. `/tasks` is the chat switcher and may explicitly create a **New task**; only that task-creation flow may open one new root ChatGPT conversation and bind it to the new Task Capsule. Task-bound Chat Bridge messages may include `task_id` and an exact downloaded `local_file` path. Do not add attachment-resolver capability/protocol layers just to hide a path the agent already has Local access to. Task-card replies remain bounded Task Capsule `humanInput`; their attachment reader stays exact-task scoped. Location changes affect only future downloads; preserve historical attachment roots and never silently auto-delete user-visible Telegram downloads. Outbound files must reuse the normal Local file-export access policy. Callbacks must match both route token and message ID, and ambiguous mutations are never auto-replayed.
- Chrome Web Store owns Equinox Browser distribution and updates. The Equinox Local updater must not overwrite or sideload the extension.
- Public Equinox Local installation must not require a paid Apple Developer Program membership, Developer ID certificate, notarization, Mac App Store submission, or `.pkg` installer. Preserve the user-level HTTPS bootstrap model unless the project explicitly changes direction.

## Development workflow

- Inspect `git status` before editing and preserve existing dirty work. Never reset, discard, or overwrite unrelated changes casually.
- Work on `equinox/` branches; do not commit directly to `main`.
- Prefer focused changes and existing modules/APIs over parallel implementations.
- Treat MCP delivery replay as a lifecycle invariant: transport/orchestration redelivery of one exposed tool invocation must reuse the original invocation/result and must not repeat side effects. A genuinely new identical invocation must remain possible.
- When modifying an already-dirty file, inspect its current diff first and preserve unfinished work.
- Do not merge to `main`, create a public release, publish Equinox Browser, or submit Chrome Web Store changes without explicit maintainer authorization.
- Managed install/update work must preserve source-checkout development behavior rather than replacing it in place.

## Validation

- For ordinary local iteration, run `npm run check` and `npm run test:fast`.
- `npm run test:fast` covers recursive unit/browser tests and intentionally leaves release/lifecycle integration coverage to the full suite.
- Run the full `npm test` suite before release/publication, after release/install/update/native-lifecycle changes, or after broad cross-cutting refactors.
- Run `git diff --check` before commit/push.
- Add or update tests for behavior changes, especially security boundaries, updater/rollback behavior, onboarding, Control Center APIs, Telegram recipient isolation, and browser-lane isolation.
- Release-affecting changes must preserve the established release gates: clean public source, CI/CodeQL, native ARM64/x64 validation, signed stable manifests, and production-domain upgrade smoke for real version bumps.
- After a successful Equinox Local runtime restart, do not invoke another Equinox Local tool in the same assistant turn. Send the user the final status response immediately, then perform Doctor/status verification after the connector is available in a new turn.

## Architecture references

- `README.md` describes the supported public product surface.
- `docs/architecture.md` is the public architecture reference.
- `SECURITY.md` defines vulnerability-reporting expectations.
- Historical implementation ideas or private development infrastructure must not be reintroduced merely because similar code or terminology appears in old discussions or commits.
