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

## Files and native attachment bridge

Native transfer continues through `files_call`; there is no separate top-level upload/download tool. `file_export` sends a bounded local file to the current ChatGPT conversation and `file_import` saves one native ChatGPT attachment to the Mac. Existing structural protections for credentials, application data, `.git` traversal and symlink escape remain in force.

## Browser companion

Equinox Browser remains Chrome Web Store-owned and is not sideloaded by Local. The matching 5.0 release train uses Equinox Browser 0.6.x, which adds the browser-side continuity primitives required by Auto Continue and Fresh Chat Resume while keeping the production extension identity and Native Messaging bridge protocol stable.

## Rollback

Managed Local updates retain the existing versioned activation and rollback design. If activation health checks fail, the updater restores the previously verified release. A normal successful upgrade does not delete the previous release before health verification.
