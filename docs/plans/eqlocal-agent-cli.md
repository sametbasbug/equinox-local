# eqlocal — agent-first CLI implementation plan

Decision: `eqlocal` is the single CLI name for Equinox Local. This is a client for the running local service, not another agent runtime, ChatGPT API, browser backend, or user-facing terminal product.

## Interface

- Machine-first default: one JSON object per completed command on stdout; errors as JSON on stderr with nonzero exit status. `--json` is accepted explicitly as a stable option. `help` and `--help` return compact human guidance. No ANSI, progress chatter, hidden retries, or interactive approval prompts. stdin/file JSON accepted for tool arguments.
- `status`, `tools list [domain]`, `tools describe domain.operation`, `call domain.operation [--args JSON|--args-file path]` discover and invoke the **same** guarded runtime capability registry (including external desktop via its existing provider). Do not recreate per-operation handlers.
- `tasks list/read/create/finish/cancel`, `chat start --task ID`, `chat send --task ID --message TEXT [--wait]`, `chat read --task ID --user-epoch E --previous-turn T`, `chat wait --task ID --user-epoch E --previous-turn T` share Task Capsules and the existing Chat Bridge. No implicit selection of a ChatGPT conversation. `chat start` creates a new exact task chat; existing task-bound chats can receive messages. When waiting times out, return a resumable receipt rather than auto-retrying a send.
- Machine-readable schemas, structured errors, bounded output, deterministic IDs, sensible help. Future MCP transport uses the same request dispatcher (not another feature implementation).

## Runtime and transport

1. Add a private local IPC request surface **separate from Control Center's browser/CSRF management routes**. Reuse the active Equinox Local process, existing capability registry, Task Capsule store, Browser Chat Bridge, and Emergency Stop. No HTTP shell endpoint and no new listener on a network interface. Owner-only Unix socket on macOS; per-runtime unpredictable Windows named pipe advertised inside user-private application state. Message and response size caps; never expose raw credentials from the IPC discovery file.
2. Implement a small cross-platform Node CLI client, packaged with the managed install and launched by the pinned runtime Node in a follow-up distribution step. Preserve the existing packaged runtime and source-checkout workflow; do not rely on external npm or system Node in the final managed install.
3. Use task/exact conversation identity, Chat Bridge extension receipts, request IDs, and bounded pending read to prevent ambiguous replay. In the initial integration, make delivery explicit and use polling to retrieve final turn, never guess a reply from another chat.
4. Reuse platform/config policy for all calls. User agent attribution may be carried as untrusted context for clarity, not as a new access-control tier.

## Delivery checkpoints

- A. Plan, CLI transport/service, discovery and generic tools interface.
- B. Tasks and Chat send/read/new-task integration; CLI command parser and JSON protocol.
- C. Distribution on macOS + Windows, documentation, typecheck/build/static validation, real device chat acceptance, then PR/merge/release only after evidence. No new automated tests (maintainer instruction).

Known constraints: browser context must be connected and user-consented, Chrome/ChatGPT active. If request crosses a browser mutation boundary with an uncertain outcome, report ambiguity rather than resending. Agent calls can use all already available Equinox Local capabilities through their existing policy; CLI does not impose duplicate per-call confirmations.

## Progress — first implementation checkpoint (2026-10-29)

- Implemented: shared private IPC JSON protocol, machine-first `scripts/eqlocal.mjs` parser, live tools catalogue/describe/invoke (including desktop via its existing handler), Tasks create/list/read/finish/cancel, exact Task Chat start/send/read/wait, `--request-id`, agent attribution, response receipts and polling, README/architecture/CLI docs, release source packaging inclusion.
- Validated: Node syntax, TypeScript typecheck, generated runtime pairing and static JavaScript/shell source check. No tests were added or run.
- Remaining: signed-install PATH wrappers using pinned Node on macOS/Windows; real device integration and lifecycle checks; source/runtime + browser update acceptance; public PR/release if authorized. The existing live installation has **not** been updated.

## Progress — native launchers implemented (checkpoint 2)

- Main installer now creates an owned `eqlocal` launcher pointing at the pinned Node and bundled CLI entrypoint after the new signed runtime is verified healthy. macOS uses `~/.local/bin/eqlocal` plus a marked zprofile PATH line; Windows uses a current-user PATH registry entry and `eqlocal.cmd` under the product install root. Same reinstall path refreshes launcher; uninstall removes owned entries. CLI launcher failures are reported without invalidating a healthy main runtime.
- Manual temporary-home, isolated IPC proof succeeded for status, tools describe/call, task create, chat start/send/wait and JSON response; temporary artifacts removed.
- Remaining: real macOS and Windows managed install CLI acceptance and live ChatGPT Browser-backed turn, plus runtime/package/Windows PowerShell validation, final docs/commit.

- Final packaging audit: generated `scripts/release/package-managed-release.mjs` was initially stale. Regenerated tooling and verified all 150 signed-release source files include `scripts/eqlocal.mjs`, `src/equinox-local-cli-bridge.js` and `src/equinox-local-cli-installation.js`. Mac temporary-home launcher/reinstall/uninstall proof succeeded; Windows tool session currently unavailable.

## Progress — Windows compatibility audit (checkpoint 3)

- Windows Equinox Local connection returned. Current installed Windows public runtime is not this development build; no `eqlocal` installed, so this is not a signed-release acceptance.
- A real PowerShell 7.6 CLI-shim experiment showed that passing `--args '{"hello":1}'` through `.cmd` loses JSON quote characters. Confirmed PowerShell resolves `eqlocal.ps1` before `.cmd`. Added both launchers: PowerShell `.ps1` forwards `@args` unchanged to the pinned Node; `.cmd` remains available for CMD and accepts `--args-file` stdin for JSON.
- On the Windows device, native `.ps1` argument forwarding retained JSON quote characters and Unicode bytes; observed a nested PowerShell output-decoding artifact, verified original UTF-8 bytes were correct. Confirmed `exit` from `.ps1` does not terminate the calling PowerShell session. All temporary files removed.
- Added task-level serialization for Chat start/send and rejected excess positional CLI arguments. Refined Windows PATH uninstall to avoid adding an empty registry value if user PATH was absent.
- Still required: actual signed native Windows + macOS install, live Browser-backed ChatGPT turn, verify after version update. No publication or live EL restart performed.
- Runtime lifecycle review: CLI IPC now tracks active net sockets and closes them during shutdown, preventing slow/blocked CLI clients from delaying EL restart. Existing browser action outcomes remain ambiguous if shutdown interrupts them; no implicit resend.
- Critical actual-store audit: `tasks.read` intentionally redacts `chatBinding` to context/tab ID; the initial CLI bridge erroneously passed that public projection to Chat Bridge, which requires exact private conversation identity. Chat start/send/initial/read now use Task Capsule `readInternal` solely inside the CLI server; `tasks read/list` still return public/redacted data. Typecheck and runtime generation verification pass. This must be exercised through real Browser-backed acceptance after installation.

## Checkpoint 4 — factory validation preparation

- Confirmed active Mac mini installation is healthy source/factory Equinox Local 6.3.1 with Your Browser connected. Live Factory code comes from this checkout after the prescribed `restart_runtime` operation, not via the public signed installer. We will exercise actual source-backed CLI IPC/ChatGPT task delivery on the next auto-continued turn after safe restart; do not call EL again in the same turn after restart.
- Found and reproduced a real Windows PowerShell 5.1 JSON argument quote-loss despite `.ps1` launcher. Fixed legacy-only native-argument quote escaping while retaining PowerShell 7 behavior. A temporary Windows 5.1 invocation preserved nested JSON quotes when escaping with `\"`; Windows PowerShell 7 already works without escaping. No repo test files added.
- Still pending: live exact-task ChatGPT send/read acceptance, native managed install release acceptance on Windows/macOS, consolidated CI/PR/release and post-release Mac source role verification.
- CLI command validation tightened: invalid `--timeout` now fails before crossing the Chat send/browser-mutation boundary; duplicate-suppressed delivery receipts are surfaced directly instead of being treated as a pollable success.

## Live source Factory ChatGPT acceptance — checkpoint 5

- After approved source restart, real Mac Factory runtime 6.3.1 HEALTHY, CLI IPC descriptor present, `node scripts/eqlocal.mjs status` discovered all 131 live capability operations, including desktop; dynamic schema and `runtime.system_doctor` invocation succeeded.
- Created dedicated Task `task-1319e7ee-e`, and `eqlocal chat start` created and bound a real ChatGPT conversation on an independent exact user tab. Start necessarily prompts the assistant to execute Task objective; it produced a nested temporary task `task-386e4eb9-7`, so we stopped only the originating test assistant to avoid recursive work and verified repo remained clean. This is an important future UX consideration for `chat start`: users should understand it begins the objective, not a blank conversation.
- Initial send while generation was active correctly failed with `CHAT_BRIDGE_NOT_READY`. A subsequent attributed two-line message failed `CHAT_BRIDGE_AMBIGUOUS` at `composer_changed` *before submit*. Read-only live browser DOM confirmed the original staged message remained in two `<p>` nodes; `textContent` erased the newline, causing the extension's exact match to reject. No blind retry; cleared the staged composer by semantic Browser fill in the test tab.
- One-line `eqlocal chat send --request-id eqlive-20261029-02` returned confirmed delivery with user epoch + previous assistant turn key. `eqlocal chat read` returned `ready`, exact response `EQL_CLI_LIVE_OK_20261029`, `truncated:false`, correct tab. Real end-to-end CLI -> ChatGPT Web -> CLI PASSED. Both temporary tasks explicitly completed.
- Follow-up source changes: agent attribution now uses a same-line prefix, retaining immediate compatibility; Browser extension Chat Bridge exact composer comparison reconstructs newlines between sibling `<p>` nodes. Extension source fix will not be live until normal Chrome Web Store distribution; do not claim multiline live acceptance yet.
- Added CLI `tasks delete` over the existing terminal-only Task Capsule store removal path so agents can clean up completed temporary tasks without direct filesystem operations.

## Checkpoint 6 — cleanup and agent-first chat bootstrap

- Restarted Mac Factory/source EL from checkpoint 5 and confirmed `system_doctor` HEALTHY, source commit `261efa2`, `eqlocal status` connected, all 131 capabilities discoverable. Both live acceptance tasks (`task-1319e7ee-e`, `task-386e4eb9-7`) were confirmed `completed`, deleted through the running CLI `tasks delete`, and the real development Task `task-9107c941-3` remained active. No temporary Browser tabs remain.
- Signed Main installer path reviewed: Mac/Windows source release packagers carry `scripts/eqlocal.mjs` and imported bridge modules; native Node is under release `runtime/node/bin` on each platform. New installation writes CLI launcher only after the exact signed runtime health gate; uninstall removes only the owned command/PATH record. Full signed-release native-install acceptance remains pending; the Mac mini is Factory and must not be converted to a public install for QA.
- The CLI was agent-first but `chat start` inherited Telegram's full Task objective auto-execution, which spawned a recursive acceptance agent in the live proof. Introduced an optional, explicitly supplied neutral one-line startup message on the shared Chat Bridge controller; the CLI now selects this by default, returning a brief READY handshake. `eqlocal chat start --task ID --run-task` requests the original full Task objective execution. Telegram callers still get their unchanged task-execution prompt. No new ChatGPT or Browser backend.
- Checks needed at follow-up: verify neutral startup with one bounded real chat once the source runtime is reloaded, retaining no test files. Consolidated signed native macOS/Windows package, CWS Browser multiline extension publication, and public release acceptance have not been executed.

## Native package readiness, checkpoint 6 continuation

- Built an actual unsigned **darwin-arm64 native managed release** from clean commit `7658433b76cc51f8087814d861aaf4fffd597f9e` using the production packager in an OS-temp directory. Packager passed its complete native release validation; 150 source files; archive 145,611,874 bytes; SHA-256 `f55fe6861d939ca986a863610c66ce96f2e7aadda51ed2fc5e23a977a430b507`. Temporary archive and directory deleted automatically. This is NOT a signed release, installed public copy, or macOS clean-install acceptance.
- Examined the existing exact-SHA candidate-only CI path: manually dispatched `ci.yml` on a feature branch can compile all four native targets (darwin-arm64/x64 + win32-arm64/x64) without publishing; production deployment jobs explicitly require a push to `main`. A single consolidated native candidate gate is preferable to running Actions on every change.
- Still pending: actual Windows/macOS signed managed **install** verification (not just packaging), source-restart verification of neutral CLI chat start, CWS extension multiline update, and production publish only after validated delivery.

## Checkpoint 8: live acceptance

- Mac Factory restart verified: 6.3.1 healthy (10/10), 131 capabilities, source SHA `9ae5f46`.
- Isolated task `task-dbe7a19f-5`: `eqlocal chat start --wait` received exact `EQL_CLI_READY`, ready and untruncated; no recursive tasks. The task was finished/deleted and its sole test tab closed.
- From a real unsigned darwin-arm64 native package, bundled Node v26.12.1 successfully ran the CLI launcher. Isolated install, reinstall, uninstall and PATH cleanup passed. All temporary files removed.
- Four-target candidate build #40891590509 passed; production publishers skipped. Draft PR #315 CodeQL/security and docs checks passed.
- Actual signed installer acceptance on both platforms, plus separate Chrome Web Store release of multiline Browser fix, remain outstanding.

## Checkpoint 9 — Windows native CLI launcher acceptance

- Recovered native Windows public product-owned pinned Node v26.12.1 path and cloned only `package.json`, `src/equinox-local-cli-installation.js`, and `scripts/eqlocal.mjs` at exact feature SHA 6415f1c into a temporary Windows checkout. The GitHub Actions candidate ZIP requires a separately authenticated artifact download; a direct Windows transfer attempt was blocked by tool security, and was not forced. This is a source-backed isolated native CLI acceptance, **not** a signed archive installation.
- Invoked actual `installEquinoxLocalCli` on Windows with an isolated product-root and a copy of the product-owned pinned Node, generating real `eqlocal.ps1` / `.cmd` launchers and adding the isolated path to current-user PATH (to be cleaned via product uninstall). Found a significant real bug: with exactly one argument under PowerShell 7, `$nativeArgs = if (...) {...} else {$args}` collapses to a string and `@nativeArgs` splats the characters of `--help` individually.
- Fixed generated PS launcher by initializing `$nativeArgs = @($args)` unconditionally, then applying the legacy PowerShell 5.1 native-quote escaping only in that branch. A patched isolated launcher passed PowerShell 7 zero-argument/default help, single-argument `--help`, and exact PowerShell 7 and Windows PowerShell 5.1 inline JSON and emoji/Unicode forwarding. Follow-up must reinstall using the newly committed generator and confirm cleanup of temporary PATH.
- Real signed Windows public installer upgrade/rollback and Chrome Web Store publication remain pending; no new test files were added to canonical repository.

### Windows generator retest and cleanup (checkpoint 9)

- Pulled committed fix `359b8a5` in the temporary Windows checkout and reran the *actual* `installEquinoxLocalCli` generator. The regenerated `eqlocal.ps1` passed zero args/default help, one arg/`--help`, CMD `--help`, JSON and Turkish/emoji Unicode arguments on PowerShell 7.6.9 and Windows PowerShell 5.1. The target Node binary was a copy of Equinox Local public's pinned Node v26.12.1, not a system npm dependency.
- Invoked the product's actual `removeEquinoxLocalCli` on the Windows temporary installation; confirmed generated CLI launchers removed, HKCU user PATH temporary entry removed, temporary repo and native binary deleted. The existing Windows public EL installation was not upgraded or modified.
- PR #315 CodeQL, security and documentation checks passed on `359b8a5`. The earlier four-platform native CI success was on pre-fix candidate `9ae5f46`; final code requires one consolidated native candidate gate before any release.
- Windows Chrome Default profile currently has Equinox Browser version 1.2.0 installed, matching repo manifest 1.2.0; CWS publisher dashboard version still unverified. To distribute the new multiline fix, prepare a newer CWS version after checking that dashboard, not a replacement ZIP of the same version. No extension publication authorized or performed.

## Checkpoint 11 — signed Main launcher reconciliation integration

- No changes to signed native Guardian, Mac detached worker, A/B transaction engine, journal locks or rollback transitions. Instead the **authenticated managed-main runtime** now schedules an optional, bounded startup reconciliation after 15 seconds: it refuses to write CLI launchers while the canonical `main-update/active.json` owner marker exists; re-runs the signed selector + native pointer resolver using the running process's original release identity; requires the reverified SHA and immutable release directory to match this exact running process; checks the owner marker a second time before writing; then invokes the already-verified `installEquinoxLocalCli` to update product-owned shim and PATH. If a handoff is still active it retries in a bounded cadence; a permanent failure is logged but never aborts or rolls back the healthy app.
- This handles both healthy B startup and a rollback to an A runtime that implements the same reconciliation. During first-time Stable-to-Main recovery, the owner marker prevents premature CLI installation. A rollback to a historical pre-CLI A lacks this hook; avoid claiming that legacy A can repair a launcher it does not know about.
- Confirmed on isolated macOS fake native A and B layouts that invoking the existing launcher installer in A → B → A order rewrites the command to the proper immutable release SHA every time; then uninstall removes the owned symlink and PATH marker, all temp files deleted. Code typecheck/runtime generated JavaScript verification passed. Real signed managed update/rollback has NOT yet been run and remains pending.

## Signed macOS direct-reinstall safety audit — checkpoint 12

- Discovered a **pre-existing production safety defect outside CLI**: original `scripts/install-equinox-local.sh` permanently removed old `current`, `releases`, `runtime`, and `main-update` executable roots after verifying the signed new ZIP but before running the final signed installer and receiving its exact healthy receipt. A failed direct Main reinstall could strand a previously working Mac (Windows direct installer already preserves old program roots and restores them on failed health). This risk is unrelated to the CLI feature but is a release blocker.
- Updated the SAME canonical external signed macOS installer, with no second updater or A/B transaction system. After verified signed preflight, existing user-owned native executable roots and product-owned UI/host components are renamed into `.equinox-main-reinstall-preserved` within the product app-data directory, not deleted. The owned set includes `current`, `releases`, `runtime`, `main-update`, `Equinox Local.app`, the app runtime wrapper, LaunchAgent plist, Browser native host wrapper and Chrome Native Messaging manifest. Settings, config, workspace, downloads and user credentials stay untouched. The prior copy is deleted only after the exact signed healthy Main completion receipt; on failed new activation the EXIT handler attempts to restore all previously owned entries and relaunch the previous service. Existing recovery directory causes fail-closed refusal, and cleanup never takes ownership of an earlier interrupted backup.
- Verified with a real isolated macOS temporary profile and stubbed launchctl (NO live Factory service actions): all nine old executable/host entries were restored after simulating a failed replacement; newer entries were removed for backed-up paths, the previous `current` symlink was restored, and a pre-existing recovery sentinel remained untouched. Temporary acceptance files deleted. Shell syntax passed. **This is an isolated failure-path acceptance, not proof of real signed live-app health/restore after an actual installer failure.**
- Kept `website/site/downloads/updates/install-equinox-local.sh` byte-identical to the original updated installer, preserving Cloudflare Builds origin parity. No website deployment or production signed release has been made.

### Checkpoint 13 — macOS signed reinstall failure cleanup hardening (2026-10-29)

- Follow-up audit of commit `0bee3f9` found two real failure-path gaps: when the private recovery directory could not be created the previous service was already stopped, and a failed new install could leave product-owned files whose paths did not exist in the previous installation. Updated the **same external signed installer**: create and take ownership of the private backup directory before stopping launchd; track service-stop and actual new-install attempt separately; restore all backed-up old entries, remove newly created executable-only entries absent before, and restart an old LaunchAgent only when it actually existed. Previous interrupted recovery evidence is never taken over.
- Revalidation in a disposable macOS home with launchctl stubbed passed four scenarios: fully backed-up A restoration; partial new B-only files cleaned; error before B started without deleting old A-only entries; failed fresh A=null install with no old entry leaves no program files. All temp files removed. This is a manual isolated recovery acceptance, **not a physical signed installation/health proof**. A separately observed link-device check confirmed the macOS `stat -f %d` behavior for `current` symlinks.
- Added pre-stop device-number verification for each existing product-owned executable/host entry, preventing an external-volume copy-and-delete of the old app in lieu of same-volume rename. Older service restart errors are surfaced, not silently swallowed. Canonical Bash and public website installer copy remain byte-identical; no new updater, Guardian, A/B engine or test file.
