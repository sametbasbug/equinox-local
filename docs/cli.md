# `eqlocal` — agent-first local CLI (development)

`eqlocal` is a JSON-first command-line client for the **existing running** Equinox Local runtime. It does not launch a second agent or provide a new ChatGPT API. The current implementation is on the development branch; managed-install PATH launcher and real macOS/Windows acceptance are separate pending distribution work. It is not a released user feature yet.

## Contract

- Success: exactly one `{ "ok": true, "result": ... }` JSON object on stdout. Errors: exactly one `{ "ok": false, "error": { "code": ..., "message": ... } }` on stderr and nonzero exit status. `--json` is an explicit supported no-op, because JSON is already the default. `--help` prints usage.
- No interactive prompts, ANSI UI, progress spam, implicit selection of a browser tab, or automatic retry of browser mutations. Supply `--request-id` if a caller needs deterministic retry protection across process crashes.
- It talks to a same-user, token-authenticated local IPC bridge. The descriptor is stored in Equinox Local's **existing private application state**, not in the repository. macOS uses an owner-only Unix socket; Windows uses a randomized named pipe. The running runtime must be available and the ChatGPT browser context must be connected for chat commands.
- Commands are usable by any local process with access to that signed-in user's private EL runtime. Existing EL Agent Access/Emergency Stop/operation guards apply. `--agent NAME` adds an informational ChatGPT message prefix; it is not a separate permission system.

## Tools

```console
$ eqlocal status
$ eqlocal tools list
$ eqlocal tools list runtime
$ eqlocal tools list desktop
$ eqlocal tools describe runtime.terminal_exec
$ eqlocal call runtime.system_doctor
$ eqlocal call runtime.terminal_exec --args '{"project":"home","command":"pwd","shell":"zsh","cwd":".","wait_ms":10000,"max_output_chars":4000}'
$ eqlocal call runtime.task_list --args-file -
```

`tools list <domain>` and `tools describe domain.operation` use the **live** capability catalog, including input JSON Schemas. The generic `call` command delegates to the same tool handler as ChatGPT; operation errors retain their existing boundaries. For cross-platform commands, use the `shell` and argument schema returned by the connected host rather than assuming POSIX syntax on Windows.

## Tasks & Chat

```console
$ eqlocal tasks create --title "Review" --objective "Review the architecture"
$ eqlocal tasks list --status active
$ eqlocal tasks read task-...
$ eqlocal chat start --task task-... --wait
$ eqlocal chat send --task task-... --agent Nyx --message "Selene, feedback?" --wait
$ eqlocal chat send --task task-... --message-file - --request-id 0123456789abcdef
$ eqlocal chat wait --task task-... --receipt '{"userEpoch":"...","previousAssistantTurnKey":"..."}' --timeout 120
$ eqlocal tasks finish task-...
```

New tasks are created first, then explicitly opened with `chat start`; existing bound tasks can be addressed through `chat send`. `chat start` reuses the Telegram Task Chat Browser primitives but does **not** send a Telegram message. Both use exact task/chat bindings.

`chat send` yields a receipt containing `userEpoch` and `previousAssistantTurnKey` upon confirmed delivery. `--wait` polls for the completed assistant response for up to 120 seconds by default (maximum 600). If no answer is ready, it returns a waiting status **with the original receipt**, which the caller can supply to `chat wait` to resume reading. Do not re-send a message simply because reading timed out. On an uncertain send failure, inspect the ChatGPT task conversation before repeating, using the same `--request-id` if an explicit retry is truly warranted; the extension suppresses duplicate delivery IDs.

The Browser response reader currently returns at most 12,000 characters of the latest completed assistant turn; `truncated` signals when the browser output exceeded that limit. This is not a transcript export API.

## Roadmap / acceptance still needed

- Publish platform-specific PATH launchers that invoke **the product-owned pinned Node**, not a user-installed global Node/npm. Include them in the signed OS installers and remove only the owned shims on uninstall.
- Real macOS and Windows managed-install verification: status, dynamic tool catalog, Task Chat create/send/read/wait, refusal on stale identity, no double submit, native shell invocation, and update/reinstall preservation.
- Check the independent browser extension's current Chat Bridge version; do not modify CWS packaging without a separate browser release.
- Later: MCP transport for agent callers may delegate to this same local dispatcher without duplicating feature implementations.
