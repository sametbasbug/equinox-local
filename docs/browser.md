# Equinox Browser

Equinox Browser is the only browser-automation lane exposed by Equinox Local.

It is a first-party Chrome extension paired with a per-user Native Messaging host and the local Equinox Browser bridge. Equinox Local does not use a generic user-Chrome CDP fallback, does not require Chrome remote-debugging flags, and does not expose the internal release-QA browser as a product capability.

## Trust model

Browser control is off on a new extension install until the user accepts the browser-data consent prompt in the extension popup. The extension keeps its local control channel available while automation itself is disabled, so status and settings remain inspectable without silently inspecting tabs.

The extension can expose bounded browser primitives such as:

- listing and activating tabs,
- opening and closing normal web pages,
- semantic snapshots and element references,
- clicks, typing, scrolling, uploads and downloads,
- screenshots stored inside Equinox Local's bounded workspace,
- popup/new-tab and JavaScript dialog discovery,
- bounded console/network metadata where the browser surface supports it.

Protected Chrome pages, file URLs, browser interstitials and other restricted contexts fail closed rather than attempting to bypass Chrome protections.

## Connection path

```text
Agent
  -> Equinox Local browser_tools / browser_call
      -> Equinox Browser bridge
          -> per-user Unix socket
              -> Native Messaging host
                  -> Equinox Browser extension
                      -> the user's Chrome tab
```

The socket directory is user-specific and private. The bridge authenticates the expected native-host origin and extension identity before routing commands.

## Chrome Web Store updates

Equinox Browser is distributed and updated by the Chrome Web Store. Equinox Local's own updater does **not** overwrite, sideload or replace the extension package.

The source tree under [`extension/`](../extension/) is kept in this repository for auditability and development. Release packaging is deterministic and allowlist-based.

## Visible agent cursor

The extension can show a visible agent cursor and a local display name while an agent interacts with the page. These are user-controlled settings exposed in the popup and Control Center.

## Development

Browser-focused tests live under [`tests/browser/`](../tests/browser/). They cover lifecycle/reconnect behavior, consent, popup settings, tab relationships, frame routing, restricted pages, dialogs, downloads and interaction primitives.

Package the extension source with:

```bash
npm run browser:package
```

Generated ZIP files are release artifacts and are intentionally not committed to Git.
