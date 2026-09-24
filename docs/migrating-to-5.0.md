# Migrating to Equinox Local 5.0

Equinox Local 5.0 **Continuum** is a major agent-surface release. Existing managed installations upgrade through the normal signed update flow; user projects, Control Center configuration, Telegram credentials, Agent Browser profile data and Task Capsules remain in their existing application-support locations.

## Agent connector change

The intentional breaking change is the top-level MCP surface. Equinox Local 4.x exposed 15 top-level tools, including repeated per-domain `*_tools` discovery tools. Version 5.0 exposes exactly seven top-level tools:

- `capabilities`
- `runtime_call`
- `files_call`
- `browser_call`
- `desktop_call`
- `release_call`
- `integrations_call`

Use `capabilities` with no arguments for domain summaries, with `domain` for the current operation catalog, and with `domain` + `operation` for the exact live input schema. Dynamic operation names remain bounded free-form strings, so new operations do not require another top-level connector expansion.

A ChatGPT conversation that cached the old 4.x connector schema may need one connector **Refresh** after the upgrade. Existing internal Browser operation names remain accepted as compatibility aliases, while agents should prefer the shorter names returned by `capabilities`.

## Continuity features

5.0 adds durable Task Capsules, explicitly armed one-shot Auto Continue, guarded Fresh Chat Resume, Control Center task recovery, and native ChatGPT ↔ Mac single-file transfer. These features are additive and do not require migrating existing project configuration. Auto Continue and Fresh Chat Resume remain human-first and fail closed on target drift, new human input, Emergency Stop or ambiguous browser delivery.

## Telegram Remote Control

Existing paired Telegram credentials continue to work. Version 5.0 turns the paired private chat into a bounded remote-control/task/chat surface without exposing a generic Telegram inbox to agents. `/status`, `/tasks`, `/chat`, `/unbind` and `/help` are scoped to the paired chat. `/tasks` is the Task-chat switcher and also offers **New task**; only that explicit flow creates one new root ChatGPT conversation and binds it to the newly created Task Capsule. Normal unbound Telegram messages do not create chats. `/status` provides short-lived Emergency Stop/Resume and Restart controls with action-specific confirmation for the high-impact actions. Telegram files are downloaded once to the configured local folder only for a bound Task flow; Chat Bridge passes only `task_id` and optional `local_file`. Upgrading does not require re-pairing the bot.

## Files and native attachment bridge

Native transfer continues through `files_call`; there is no separate top-level upload/download tool. `file_export` sends a bounded local file to the current ChatGPT conversation and `file_import` saves one native ChatGPT attachment to the Mac. When `file_import` omits `destination`, it uses the Control Center Web file transfer folder, defaulting to `~/Downloads/Equinox Local/Web/`; an explicit destination still overrides the default. Existing structural protections for credentials, application data, `.git` traversal and symlink escape remain in force.

## Browser companion

Equinox Browser remains Chrome Web Store-owned and is not sideloaded by Local. The matching 5.0 release train uses Equinox Browser 0.6.x, which adds the browser-side continuity primitives required by Auto Continue and Fresh Chat Resume while keeping the production extension identity and Native Messaging bridge protocol stable.

## Rollback

Managed Local updates retain the existing versioned activation and rollback design. If activation health checks fail, the updater restores the previously verified release. A normal successful upgrade does not delete the previous release before health verification.
