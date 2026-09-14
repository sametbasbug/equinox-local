# Equinox Browser

Equinox Browser is the only browser-automation transport exposed by Equinox Local.

It is a first-party Chrome extension paired with a per-user Native Messaging host and the local Equinox Browser bridge. The transport serves two explicit product contexts: **Agent Browser** (`target=agent`) is the default isolated Equinox Local Chrome profile, while **Your Browser** (`target=user`) is the user's personal Chrome profile and must be requested explicitly. The contexts never silently fall back to each other. Equinox Local does not use a generic user-Chrome CDP fallback, does not require Chrome remote-debugging flags, and the retired loopback/CDP QA browser is not a second product capability.

## Trust model

Browser control is off on a new extension install until the user accepts the browser-data consent prompt in that profile's extension popup. Consent, on/off state, cookies, logins, tabs, Auto Continue target choice and other extension-local settings remain independent between Agent Browser and Your Browser. The extension keeps its local control channel available while automation itself is disabled, so status and settings remain inspectable without silently inspecting tabs.

The extension can expose bounded browser primitives such as:

- listing and activating tabs,
- opening and closing normal web pages,
- semantic snapshots and element references,
- clicks, typing, scrolling, uploads and downloads,
- screenshots stored inside Equinox Local's bounded workspace,
- popup/new-tab and JavaScript dialog discovery,
- bounded console/network metadata where the browser surface supports it; and
- bounded bookmark management in Agent Browser only. Your Browser bookmark automation is rejected before the bridge and by the extension context guard.

Protected Chrome pages, file URLs, browser interstitials and other restricted contexts fail closed rather than attempting to bypass Chrome protections.

## Auto Continue target

The extension popup exposes a profile-local **Auto Continue target** selector only after browser consent is accepted and control is enabled. **Current task's ChatGPT tab (automatic)** lets Local bind the single conversation that is actively generating at arm time. The human may instead pin one exact open ChatGPT conversation in that profile. A closed pin, navigation away from ChatGPT, conversation drift or conflicting pins fails closed; Local never falls back to another tab/profile.

Auto Continue uses dedicated internal bridge commands for target resolution, inspection and guarded delivery rather than exposing a generic ChatGPT/session automation API. The delivery path verifies the bound conversation, latest user epoch, assistant turn, generation state and empty composer; it claims a bounded extension-local delivery receipt before inserting/submitting the deterministic continuation prompt so ambiguous retries cannot duplicate a turn. Human composing or a new user message wins over the pending continuation.

## Connection path

```text
Agent
  -> Equinox Local capabilities(domain=browser) + browser_call (target=agent|user)
      -> Equinox Browser bridge
          -> per-user Unix socket
              -> Native Messaging host
                  -> Equinox Browser extension in the selected profile
                      -> Agent Browser tab OR Your Browser tab
```

The socket directory is user-specific and private. The bridge authenticates the expected native-host origin and extension identity before routing commands.

## Chrome Web Store updates

Equinox Browser is distributed and updated by the Chrome Web Store. Equinox Local's own updater does **not** overwrite, sideload or replace the extension package.

The source tree under [`extension/`](../extension/) is kept in this repository for auditability and development. Release packaging is deterministic and allowlist-based.

## Visible agent cursor

The extension can show a visible agent cursor and a local display name while an agent interacts with the page. These are user-controlled settings exposed in the popup and Control Center.

## Development

Browser-focused tests live under [`tests/browser/`](../tests/browser/). They cover lifecycle/reconnect behavior, consent, popup settings, Auto Continue automatic/pinned target resolution and duplicate-delivery guards, tab relationships, frame routing, restricted pages, dialogs, downloads and interaction primitives.

Package the extension source with:

```bash
npm run browser:package
```

Generated ZIP files are release artifacts and are intentionally not committed to Git.
