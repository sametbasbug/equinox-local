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
