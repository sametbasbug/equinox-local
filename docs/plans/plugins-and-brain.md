# Plugins and Equinox Brain

Maintainer-approved direction (2026-11-27). This is the implementation plan, not a claim of shipped functionality.

## Product decisions

- Top-level navigation: Assistant, Control Center, Plugins. Plugins is a curated catalog of supported third-party integrations, not an arbitrary code marketplace or a general plugin SDK.
- First integration: **Equinox Brain**, with visible attribution **Powered by Avenox Beyin** and upstream MIT copyright/license preserved. Keep the upstream Python engine and Markdown/SQLite contracts, rather than porting or forking them.
- Brain is optional and not bundled as an installed service. Support both a new vault created through EL and connecting an existing Avenox vault (including vaults shared by supported CLI agents). Explicit human opt-in; do not silently install Python, change other harness settings, or migrate/delete existing data.
- Installed/connected plugins get their own Control Center settings navigation entry. Catalog links to settings; disconnect/uninstall removes the entry, preserves user vault data by default. Existing integrations retain their current home.
- Brain should work on supported Windows and macOS, with explicit Python 3.11+ prerequisite checks, no extra model calls for basic retrieval, and no Python invocation/download/index scan on EL startup. No additional service when disabled.
- Shared project decisions and knowledge can be shared through a chosen vault; keep agent identity and private context separate. Markdown is source of truth; SQLite is per-vault, machine-local and not synchronized. Do not assume cross-device synchronization.

## Phases (easy to hard)

1. Curated catalog and top-level navigation; installed-only settings sections, local configuration and visible status. No fake installed states or inert install buttons presented as working features.
2. Brain lifecycle: discover a usable Python interpreter, connect/validate an existing vault, install a verified pinned upstream release into a human-selected new vault, update/disconnect safely. Do not execute unverified downloaded code; retain attribution and license, use bounded commands, explicit paths and data-preserving failure handling.
3. Agent-facing MCP operations: scoped search/context, read, write via upstream CLI note operations, receipts and task operations where supported. Validate input and output, preserve provenance, handle revision conflicts and upstream privacy filters. Do not impersonate another harness; use upstream-supported neutral interfaces or seek upstream ChatGPT adapter support.
4. Settings and diagnostics: preferences, status, version, vault location, explicit maintenance and updates, open vault. Respect upstream normal/economical/manual modes; optional failures do not impair EL. Keep personal paths outside product source.
5. ChatGPT Web lifecycle integration: investigate explicit session start / prompt / end signals from EL Assistant and Equinox Browser. Start with agent-requested context through MCP; later prototype opt-in automatic context with actual conversation identity, bounded context, no private/untrusted or stale entries, no hidden transcript collection, no injection of instructions from untrusted memory. Preserve user message semantics and existing Auto Continue, Task Capsule, Telegram and browser boundaries. No claim of native hook parity until observed end to end. Controlled import of existing ChatGPT memory is separate and opt-in.

## Acceptance and checkpoints

- Each phase is independently usable or clearly identified as incomplete; do not expose unfinished actions as available. Record status here as phases land, keep README and architecture in sync.
- Follow existing source/Factory and signed public release workflows. Native build/typecheck/static validation; no new automated tests. Inspect real UI and validate existing/new vault workflows with disposable synthetic data before touching a real shared vault.
- Keep existing startup performance and security admission intact; no network requests or Python processes for the catalog during startup. Do not auto-publish public packages without maintainer authorization.

## Implementation checkpoint (2026-11-27)

- Phase 1: implemented the native catalog, top-level navigation, persistent connection state, and connected-only Brain settings navigation.
- Phase 2: implemented existing V3 vault connection, new empty-folder installation from a pinned V3.17.0 release, Python discovery, and data-preserving disconnection. Upgrade workflow remains open.
- Phase 3: implemented opt-in, source-backed read-only `brain_search` and manual local index refresh. Exact record reading and new-note creation are implemented; edits to existing notes, receipts and task operations remain open. Retrieval compatibility is currently limited to V3.17.0; connecting other valid V3 vaults does not execute their code.
- Phase 4: basic status, version, location, opt-in and refresh settings implemented. Richer upstream preferences, diagnostics, open-folder and version-update workflows remain open.
- Phase 5: automatic lifecycle integration and controlled memory import remain open.
- Disposable local backend exercises succeeded on macOS and Windows (including Python 3.15 discovery, install, search privacy filtering, disconnect and reconnect). Static checks, generated runtime/desktop parity and typecheck passed. Factory installed native catalog and live MCP capability discovery/disabled-access rejection verified. Connected settings and enabled live MCP execution remain unverified; no existing personal vault has been changed.

### Next checkpoint: scoped note tools

- Added `brain_read` (exact record ID, source hash/revision, same upstream privacy gates) and `brain_create` (new internal note only, explicit separate write permission, stable idempotency, source attribution, upstream secret screening without changing vault preferences). Search revocation also revokes writing.
- Manual disposable backend verification passed on macOS and Windows for exact reads, note creation, repeated identical requests, and permission revocation. macOS additionally verified hidden private/untrusted records, conflicting retries, and refusal of synthetic secret-bearing content. All scratch vaults and indexes were removed.
- Factory catalog verified visually and first candidate native builds/CodeQL passed. Native folder picker opened but macOS AX sheet targeting prevented end-to-end connection; still verify connected settings and enabled live MCP with a disposable vault.
- Next: finish narrowly scoped updates/receipts/tasks, preferences, diagnostics, open-folder and upgrade lifecycle; then investigate automatic context.
