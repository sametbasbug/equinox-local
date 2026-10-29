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
