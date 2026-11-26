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
- Phase 3: implemented opt-in, source-backed read-only `brain_search` and manual local index refresh. Exact record reading, new-note creation, guarded note edits, task create/update and receipts are implemented. Retrieval compatibility is currently limited to V3.17.0; connecting other valid V3 vaults does not execute their code.
- Phase 4: basic status, version, location, opt-in and refresh settings implemented. Shared normal/economical/manual profiles and open-folder action implemented. On-demand diagnostics implemented; a future reviewed upstream release is needed to validate a real upgrade path.
- Phase 5: native observed-generation local refresh and explicit profile-aware context retrieval implemented; actual automatic context delivery and controlled memory import remain open.
- Disposable local backend exercises succeeded on macOS and Windows (including Python 3.15 discovery, install, search privacy filtering, disconnect and reconnect). Static checks, generated runtime/desktop parity and typecheck passed. Factory installed native catalog and live MCP capability discovery/disabled-access rejection verified. Connected settings and enabled live MCP execution subsequently verified on Factory; no existing personal vault has been changed.

### Next checkpoint: scoped note tools

- Added `brain_read` (exact record ID, source hash/revision, same upstream privacy gates) and `brain_create` (new internal note only, explicit separate write permission, stable idempotency, source attribution, upstream secret screening without changing vault preferences). Search revocation also revokes writing.
- Manual disposable backend verification passed on macOS and Windows for exact reads, note creation, repeated identical requests, and permission revocation. macOS additionally verified hidden private/untrusted records, conflicting retries, and refusal of synthetic secret-bearing content. All scratch vaults and indexes were removed.
- Factory catalog verified visually and first candidate native builds/CodeQL passed. Native folder picker opened but macOS AX sheet targeting prevented end-to-end connection; still verify connected settings and enabled live MCP with a disposable vault.
- Next: finish narrowly scoped updates/receipts/tasks, preferences, diagnostics, open-folder and upgrade lifecycle; then investigate automatic context.

### Checkpoint: shared workflows and settings

- Added `brain_edit`, `brain_task_create`, `brain_task_update`, and `brain_receipt`, all behind the existing write opt-in. Note edits require current source hash and one unique body anchor, never change frontmatter, and retain upstream locking/backups. Tasks preserve upstream revision and completion checks. Receipts resolve only visible current record IDs and use the neutral manual harness with explicit EL/ChatGPT origin, not a spoofed CLI agent.
- Added a user-confirmed install/connect dialog with manual absolute path and native Browse, an Open vault action, and explicitly loaded shared profile settings. Profiles preserve the upstream secret-filter choice, do not grant MCP access and affect the vault's other agents.
- Disposable Mac and Windows backend exercises passed for edits, task create/update, receipt replay and preference profiles; static/generated parity and typecheck passed. Factory previous exact SHA and live read/create capability discovery verified. Connected settings, new dialogs and enabled live MCP need installed UI verification.
- Next: richer diagnostics and pinned upgrade workflow, then explicit opt-in lifecycle/context investigation.

### Checkpoint: native lifecycle and diagnostics

- Factory 7a9709b verified: actual catalog, manual path connection, dynamically appearing Brain settings, read/write opt-ins, shared preferences load, Finder Open vault, all seven live MCP operations, disconnect and preserved temporary source files. Disposable vault/index and known screenshots cleaned. macOS AX reporting often returned ambiguous despite observed successful UI actions; outcomes were verified by fresh snapshots or tool responses.
- Engine diagnostics: Python, pinned package, compatibility, vault binding, read-only SQLite quick-check, shared preferences and most recent process-local automatic refresh result. Latest official upstream tag remains V3.17.0; no new reviewed upgrade artifact exists. An unsupported shared vault must be upgraded using official upstream instructions and reconnected; do not silently change other agents' installations.
- `brain_context` explicitly retrieves profile-budgeted source-backed context; manual/off mode abstains. Separate optional native lifecycle refresh uses existing authenticated visible conversation/turn observations, deduplicates in memory and uses upstream cadence. Does not inspect prompt text or send memory automatically. No equivalent Chrome lifecycle hook yet.
- Mac and Windows disposable backend checks passed for diagnostics, normal/economical/manual context, lifecycle cadence and revocation; final runtime/desktop builds, parity, typecheck and static checks passed. Actual native generation-triggered refresh and new diagnostic UI need installed validation.
- Next: verify native generation-triggered refresh with synthetic vault, live brain_context and diagnostic UI. Evaluate explicit user-visible context review/delivery in Assistant, bound to the exact conversation and current draft, without hidden injection or arbitrary transcript collection. Chrome integration requires its existing supported extension path and separate review. Do not claim true ChatGPT model hook parity; consider a concise agent usage guide and opt-in import only after this.
