# Equinox Browser product layout

## Product source of truth

The shipped Chrome extension lives in `extension/`.

Only runtime files belong there:

- `manifest.json`
- `service-worker.js`
- `popup.html`
- `popup.css`
- `popup.js`
- `icons/icon-16.png`
- `icons/icon-32.png`
- `icons/icon-48.png`
- `icons/icon-128.png`

Public regression tests and fixtures live under `tests/browser/` and `tests/fixtures/browser/`; deterministic packaging lives at `scripts/package-browser-extension.sh`. Private reviewer/live-QA helpers remain factory/ops-only and are not required by the shipped extension or ordinary contributor workflows.

## Development unpacked source

The development Chrome profile now loads the keyed unpacked extension directly from `extension/`. The earlier `browser-extension-poc/` compatibility mirror has been removed.

The physical migration was live-proven without changing the permanent production identity: the old mirror and product directory were byte-identical, the old path was temporarily replaced with a symlink to the product directory, `equinox_browser_reload_extension` succeeded, and Chrome canonicalized its stored unpacked path to `extension/`. The temporary symlink and mirror were then removed. Development self-reload now reads product files directly; no copy/sync helper is required.

## Versioning

- Extension product version: Chrome manifest semantic-style `major.minor.patch`. Productization starts at `0.2.0`; the first generic Chrome Web Store release is `0.3.0`; first-class isolated Agent Browser/Your Browser contexts ship in `0.4.0`; the finalized high-efficiency browser surface, Observation v2, device/touch support and Agent Browser bookmark workspace are the `0.5.x` product line; browser-side task continuity begins with `0.6.0`; the `0.7.0` line adds low-overhead ChatGPT turn observation and the browser delivery primitives used by direct Telegram Task chats. The current Chrome Web Store production package is `1.0.0`; the earlier `0.7.x` releases are historical continuity baselines.
- Equinox Browser bridge protocol: integer `BRIDGE_PROTOCOL_VERSION` in the service worker/native bridge. Bump only for incompatible or explicitly versioned transport-contract changes.
- Chrome DevTools protocol attach version: `PROTOCOL_VERSION = "1.3"`; this is a Chrome debugger protocol setting, not the Equinox Browser product version.

## Chrome Web Store identity and distribution

- Normal distribution target is **Chrome Web Store Unlisted**. Enterprise Chrome policy/self-hosted CRX distribution is intentionally not used for ordinary users or testers.
- The Unlisted Chrome Web Store production item uses the permanent extension ID `npdneefcobilfkjlihghjgjnknenhfoj`.
- The Web Store public key is pinned as manifest `key`, so loading the product source unpacked resolves to the same production identity used by the Store item.
- The legacy unpacked ID `kdjmfldngbfaillaamoinegmogfkhdfn` was accepted only during the live identity-switch window. Default bridge and Native Messaging installation are now production-only; explicit dual-ID parameters remain available solely as a controlled rollback/migration aid.
- `0.3.0` was the first Chrome Web Store production release. `0.4.0` is the last confirmed live dual-context Agent Browser/Your Browser Store baseline. `0.5.2` finalized the browser-efficiency baseline. `0.6.0` is the previous continuity baseline. `0.7.0` was an earlier Chrome Web Store production release: it keeps the same permanent production ID, bridge protocol v1 and seven Chrome permissions while adding a narrowly scoped `chatgpt.com` content-script observer for generation/composer readiness, shorter one-shot debugger leases, and reliable guarded ChatGPT delivery for direct Task chats.
- The `1.0.0` package passed Chrome Web Store review and is now the **Unlisted** production item’s live version, retaining the permanent extension ID. The prior `0.7.0` package is historical. Chrome Web Store remains the owner of Browser distribution and updates; Equinox Local never sideloads or overwrites the extension.
- The reviewer-accessible Native Messaging dependency remains the limited public macOS reviewer companion. Bridge protocol v1 remains the current compatibility contract; the existing reviewer lane still exercises the real production Native Messaging bridge/host without requiring an AI-provider account or private repository access and cannot bypass the extension's real first-use consent.
- Shared public visual identity uses `extension/icons/icon-128.png` as the source artwork for the Store icon and the Equinox Local site header/favicon; the public site pins an exact byte-for-byte copy by SHA-256 rather than maintaining a separate logo.
- Store copy, permission/privacy declarations, reviewer instructions, asset requirements and the final package gate live in `EQUINOX_BROWSER_CWS_SUBMISSION.md`.

## Native Messaging install / update / uninstall

- Installation order is: install/update Equinox Local first, install its per-user Native Messaging host, then install Equinox Browser from Chrome Web Store (or load the keyed product source during development).
- `scripts/install-browser-host.sh` copies the host entrypoint and reconnect runtime into `~/Library/Application Support/Equinox Local/`, pins the current Node executable in a small wrapper, and atomically writes the per-user Chrome Native Messaging manifest.
- The default installer permits only the permanent production origin. Passing explicit extension IDs is reserved for a deliberate migration/rollback window.
- Re-running the installer is the update path and is idempotent. It replaces only the known Equinox Browser host runtime files/manifest.
- `scripts/uninstall-browser-host.sh` is idempotent and removes only the known Native Messaging manifest/wrapper/runtime files. It deliberately leaves Equinox Local runtime data and sockets untouched.
- The Native Messaging manifest is installed at the macOS user level; individual Chrome profiles still need the Equinox Browser extension installed/enabled in that profile.

## Agent Browser vs. Your Browser

- Browser operations remain one capability family underneath `browser_call`, with live schemas discovered through the unified top-level `capabilities` tool. Agent-facing operation names are short (`snapshot`, `click`, `wait`, etc.); the internal `equinox_browser_*` registrations remain implementation details/compatibility inputs. They use the Chrome Web Store identity, Native Messaging host and extension bridge described above.
- Product browser operations have an explicit `target`: `agent` is the default isolated **Agent Browser** context; `user` is **Your Browser**, the user's personal Chrome profile and must be selected explicitly when personal sessions/accounts are needed.
- Each Chrome profile persists its own random `browserInstanceId` and `browserContext` in `chrome.storage.local`. `extension.hello` reports both values so Equinox Local can keep concurrent Native Messaging connections routed to the correct context. A first connection may be paired to an expected context and persist that assignment through the bounded `context.set` control-plane command.
- Agent Browser is launched by Equinox Local with a dedicated `~/Library/Application Support/Equinox Local/Agent Browser` Chrome user-data directory and **without any remote-debugging/CDP port**. First setup opens the official Chrome Web Store listing in that isolated profile; the user installs/enables Equinox Browser there exactly as they do in a normal Chrome profile. Because Chrome resolves Native Messaging hosts relative to a custom user-data root, Local prepares a fixed profile-local `NativeMessagingHosts/dev.equinox.browser.json` projection before launch. That file points only to Local's already-installed stable host wrapper and the pinned production extension origin; it is not extension sideloading and does not change Chrome Web Store ownership.
- Your Browser and Agent Browser share the normal tab-automation capabilities but not profile state. Consent, on/off state, cursor settings, cookies, logins, tabs and extension-local storage remain independent. Bookmark management is intentionally asymmetric: product bookmark tools are Agent Browser-only and Local rejects `target=user` before any bridge call; the extension independently rejects bookmark commands unless its persisted context is `agent`. If the requested context is not connected, Equinox Local fails closed and never silently reroutes the command to the other profile.
- The older separate public `agent_browser_*` MCP surface remains removed; dual contexts do not add top-level tools and therefore preserve the stable gateway model.
- The legacy loopback `:9223` **Selene QA Browser** was retired after Agent Browser passed live acceptance. Internal release/visual QA now uses the same first-party Agent Browser extension/Native Messaging path; do not reintroduce a second isolated CDP browser implementation.

## Visible agent cursor

Version `0.2.5` adds an optional page-level Equinox agent cursor for user-visible browser automation. The cursor is injected through the existing `chrome.debugger` / CDP runtime path, follows the exact verified hover/click point used by the real browser input event, moves with a short bounded animation and shows a click pulse after reaching the target. It is `pointer-events: none`, so it cannot intercept the interaction it visualizes.

Version `0.2.6` gives that cursor an explicit Equinox identity instead of imitating the system pointer: the pointer is purple and a compact matching pill displays only the controlling agent name, with no redundant `AI` label. Chrome already supplies its own debugger disclosure infobar while control is attached, so the badge is deliberately limited to presence/identity. The renderer accepts a sanitized bounded `agentName`.

Version `0.2.8` makes the cursor describe the visible human action rather than only literal mouse primitives. Ref-based `fill`, `select` and `check` operations now scroll/hit-test the target, move the agent cursor to the verified point and show the same click pulse before the DOM-backed action runs; ref-scoped scroll moves the cursor without a click pulse. This preserves the safer underlying automation primitive while making form entry visibly read as “the agent clicked here and is working here.” The cursor keeps its last position between actions, resets its hide timer whenever new visible work arrives, then fades after 3.5 seconds of cursor inactivity instead of remaining on the page indefinitely.

Version `0.2.9` moves cursor identity fully into the user's Chrome profile. The popup exposes a local **Agent name** field backed by `chrome.storage.local`; names are whitespace/control-character sanitized and bounded to 32 characters. `0.3.0` removes the private Selene-specific fallback and uses the generic `Agent` default instead. The Browser/Local transport does not need to infer caller identity. Unscoped wheel scrolling also shows the cursor at the exact viewport point used for the wheel event, so page movement no longer appears to happen without visible agent presence. File upload remains intentionally cursor-neutral because real sites commonly hide the underlying file input and moving the cursor to an invisible control would be misleading.

The cursor enabled preference and local agent name are persisted in `chrome.storage.local`. **Agent cursor** defaults on but can be disabled independently of browser control. The feature never moves the macOS/system cursor and adds no new extension permission, content script or `host_permissions` requirement.

## JavaScript dialogs

Version `0.2.7` promotes page `alert`, `confirm` and `prompt` windows to first-class Equinox Browser state instead of coupling them to an optional observation session. While a web tab is debugger-attached, `Page.javascriptDialogOpening` is recorded immediately, the attachment idle timer is suspended, and `equinox_browser_dialog status/accept/dismiss` works without `observe_start`. Child/OOPIF dialogs retain their originating CDP session so handling is routed back to the same session.

Dialog-triggering clicks race the pending Chrome Input command against the dialog event. If the page blocks the input command while the modal is open, the click returns immediately with `dialogOpened` instead of waiting for the outer bridge timeout. Existing open dialogs also block a new click with structured dialog metadata rather than attempting another page interaction. When the dialog closes, normal attachment idle cleanup resumes.

## Manifest permissions

The product manifest intentionally has no `host_permissions` and keeps only the capabilities required by the existing first-party browser architecture:

- `debugger` — bounded CDP attachment to supported user tabs for accessibility snapshot, input, page/runtime/network and frame routing.
- `tabs` — list, activate, navigate, close and relate existing tabs/popups without a second browser abstraction.
- `downloads` — observe downloads created by a user gesture and resolve a Chrome download id; filesystem access remains guarded by Equinox Local.
- `nativeMessaging` — connect the extension to the pinned `dev.equinox.browser` native host.
- `alarms` — wake/retry the MV3 reconnect loop after Native Messaging disconnects.
- `storage` — persist the profile's browser-control consent, on/off, agent-cursor/display-name preferences, profile-local Auto Continue target and bounded delivery receipts, plus its random Equinox Browser instance id and `agent`/`user` context assignment across service-worker and Chrome lifecycle events.
- `bookmarks` — manage saved sites/folders in the isolated Agent Browser profile. The same Web Store extension may also be installed in Your Browser, but Equinox Local's product API and the extension command handler both fail closed there. Bookmark capability v2 keeps list/search bounded, includes readable folder paths (for example `Bookmarks bar / Agent / Docs`) on read and mutation results, and redacts sensitive URL query values before model-facing output.

Not requested: history, scripting, clipboard, webRequest, file URL access or broad host permissions.

## Popup control surface

The toolbar action opens `popup.html`. The popup does not expose generic browser-automation actions. In addition to profile-local status/settings, it has two bounded human controls: **Open Agent Browser** asks the connected Equinox Local runtime to launch the dedicated isolated Agent Browser profile, and **Auto Continue target** chooses between the automatically detected current generating ChatGPT task or one explicitly pinned open ChatGPT conversation in this Chrome profile. The reverse Native Messaging launch path is not a generic command surface; Local accepts only the fixed `agent_browser.open` action with no arguments. In the Agent Browser profile itself the launch button becomes a disabled/current-state indicator instead of launching a duplicate browser. The Auto Continue selector is disabled until current consent exists and browser control is enabled.

- A new install has no accepted browser-control consent version and therefore starts with browser automation **off**, even if an older/stale `browserEnabled=true` value exists without current consent.
- Before browser inspection can start, the popup presents a prominent data-use disclosure covering page/tab content, URLs, screenshots, entered text, the local Equinox Local runtime and the user-selected AI service. The user must press the explicit **Enable browser control** action.
- Consent is versioned in `chrome.storage.local` as `browserControlConsentVersion`. A future material disclosure change can increment the required version and return browser automation to the consent-required state without deleting unrelated preferences.
- The Native Messaging settings channel may connect before consent so Local/Control Center can report setup status, but pre-consent `settings.status` / `status` do not inspect or enumerate tabs and browser-automation methods are rejected.
- Native `settings.update` cannot bypass consent: `enabled=true` is rejected until the affirmative popup consent action has stored the current consent version.
- The on/off switch persists `browserEnabled` in `chrome.storage.local`.
- Turning off detaches debugger-backed browser-control state but **does not disconnect Native Messaging**. The local settings/control-plane channel stays available so the extension popup and Control Center can still read or change Browser settings without silently re-enabling automation.
- While off, browser-automation commands are rejected. Only bounded control-plane methods (`status`, `settings.status`, `settings.update`, `context.set`) remain callable over the native channel; `context.set` changes only the extension profile's Equinox routing role and cannot grant browser-control consent.
- MV3 wake/startup/install recovery keeps the pinned native settings channel connected while consent is pending or automation is off; it must not inspect tabs, attach to tabs or execute browser actions until current consent exists and control is enabled.
- Turning on resumes browser automation over the existing native channel when available rather than requiring the extension to tear the host down and recreate it for every toggle.
- Auto Continue target state is profile-local. Automatic mode resolves exactly one actively generating ChatGPT conversation at arm time. A human pin stores the exact tab/conversation identity; closed, navigated, drifted or ambiguous pins fail closed and never fall back to another profile/tab.
- Auto Continue delivery is available only through the dedicated internal `continuation.target.resolve`, `continuation.inspect` and `continuation.deliver` bridge methods, not the generic model-facing Browser operation catalog. Guarded delivery re-checks conversation/user-epoch/assistant-turn/composer state, persists a bounded delivery receipt before browser mutation, submits at most once and reports ambiguous outcomes without retry.
- Native Host sends `host.status` messages so the popup distinguishes a running host process from a real Equinox Local Unix-socket connection.

## Artwork

The canonical source artwork is `assets/equinox-browser.png` (512×512 PNG with alpha). Shipped icon sizes are generated from that source at 16, 32, 48 and 128 pixels.
