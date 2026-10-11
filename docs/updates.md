# Updates and rollback

Equinox Local uses a self-hosted, signed stable-update channel. The baseline distribution path does not depend on the Mac App Store, Developer ID, notarization, or a paid Apple Developer Program membership.

## Single Main update stream

**Stable is the signed bootstrap and rollback baseline, not a parallel long-term update channel.** The public installer selects the latest four-target signed Stable build, verifies its manifest and payload, starts and health-checks the native managed installation, and then **automatically enrolls** that healthy installation into the canonical admitted `main-snapshot` stream. Future updates come from exact-SHA Main snapshots after four-target CI and health/rollback admission, not from repeated numbered Stable releases. Equinox Browser stays on its independent Chrome Web Store update channel.

### New installations

Run the normal public Windows or macOS installer **without any special channel flag**. Once Stable is healthy, the installer uses the existing product-owned, pinned Git/Node toolchain and transactional managed-source enrollment; no system-wide Git/Node, user credentials, source changes or side-loaded Browser are needed. The older `--enroll-existing-main`/`-EnrollExistingMain` installer switches remain accepted only for compatibility; opting in is no longer an extra step. If source provenance or managed enrollment fails, the verified signed Stable recovery baseline is preserved rather than deleting configuration or adopting an unverified commit.

### Existing installed Stable users — one-time migration

An already-running historical Stable client **cannot retroactively adopt a policy that its installed update code does not yet implement**. For example, 6.0.3 automatically checks for new signed Stable versions but requires one user-initiated **Update & restart** to install the final transition bridge. Main enrollment then completes automatically; no reinstallation, channel flag or manual enrollment is needed. A final signed migration/bridge release must be delivered through the existing signed Stable updater. After that release has activated and passed health verification, it must automatically enroll the installation in the admitted Main channel and preserve tunnel, workspace, native host and user configuration. If enrollment/health verification fails, keep or restore the healthy signed Stable runtime without a destructive reinstall. This bridge is a separate pending implementation and installed-host acceptance checkpoint; **merging public Main alone does not transition older Stable installations**.

Maintainers can compare `refs/heads/main` and `refs/tags/main-snapshot`; only the latter is admitted for user updates. Documentation-only changes do not advance the runtime snapshot. See the technical source-managed update and rollback sections below.

## First install

The public first-install path is a user-level HTTPS shell bootstrap. It is designed to:

1. refuse root / `sudo`,
2. detect the supported macOS architecture,
3. fetch only from the pinned Equinox Local HTTPS update path,
4. enforce bounded manifest and artifact sizes,
5. verify the expected artifact byte count and SHA-256 before activation,
6. install under the current user's `~/Library/Application Support/Equinox Local/` tree,
7. register the per-user LaunchAgent and Native Messaging host,
8. start Equinox Local in local-only onboarding mode when transport setup is not complete,
9. allow up to 60 seconds for the first managed activation to become healthy.

If a fresh first activation still fails, Local stops the failed LaunchAgent but **preserves the verified release and `current` pointer** so the same install can be retried safely. The terminal error includes bounded LaunchAgent state and the tail of `~/Library/Logs/Equinox Local.error.log` when available. This avoids leaving an installed native app/menu-bar shell with its backend release deleted.

The installer does not disable Gatekeeper and does not require global security-policy changes.

## Canonical `main` updates for source checkouts

Source-managed/factory checkouts have a separate `main` channel alongside the signed Stable release channel. The passive check path reports the exact current Git SHA, canonical public `main` SHA, behind/ahead distance, divergence, and up to five bounded commit summaries. It also distinguishes dirty worktrees, detached HEADs, non-`main` branches, fork remotes, network failures, and an unavailable/deleted canonical branch. A check never mutates the checkout or local Git refs; failed remote inspection is reported as unavailable rather than “up to date.”

The accepted Main update engine is exact-SHA and transactional. An apply stages the selected canonical commit in durable source storage, promotes one source pointer, restarts through the managed lifecycle, verifies exact source/runtime health, and either commits the transaction or restores the previous source. Native state is admitted independently: every product-impacting canonical Main push builds exact-SHA snapshots for macOS ARM64/x64 and Windows ARM64/x64, publishes immutable snapshot objects to the public Main distribution surface, verifies them, and only then advances the tag-only `main-snapshot` pointer. GitHub Releases remain reserved for deliberate numbered Stable releases.

Documentation/metadata-only merges do not advance the admitted Main target: product CI and CodeQL are skipped for the explicit docs-only path allowlist, a lightweight Docs check runs instead, and `main-snapshot` stays on the last accepted executable SHA. The repository `main` branch may therefore be newer than the user-visible Main update target without creating a runtime update.

For operational checks, compare `refs/heads/main` with `refs/tags/main-snapshot`: a gap made only of documentation/metadata commits is intentional and must not be presented to users as an Equinox Local update.

If the installed native runtime contract already matches the selected Main SHA, the updater uses `reuse_native` and downloads no native package. Crossing a native boundary requires the exact host snapshot; failure during native/source activation rolls back to the previously admitted source/native state. Exact-SHA snapshot publication covers Darwin and Windows x64/ARM64, and installed upgrade/rollback acceptance has been established across those four targets for `reuse_native`. That is not four-platform installed-host `artifact_required` acceptance: the real macOS ARM64/x64 replacement-and-rollback gates remain separate, and Windows `artifact_required` acceptance is explicitly deferred until the first useful genuine Windows-native change. Trusted `managed-source` installations apply the admitted Main snapshot from Control Center with **Update & restart**; developer source checkouts remain check-only. Legacy numbered Stable installations retain the old updater only until the signed migration bridge is activated and validated.

M8 enrollment machinery was admitted on Main at `b73de11`; the public installer now invokes that existing trusted enrollment automatically after Stable health. A verified Stable artifact binds its exact clean canonical source SHA in `release.json`; after Stable first becomes healthy, Local provisions the pinned product-owned Dugite Native `v2.53.0-4` and Node `v26.11.1` toolchain, uses only the resulting absolute `gitPath`/`nodePath`/`npmPath` identities to stage that exact source, installs admitted prebuilt dependencies without compiling on the user machine, validates the checkout, and atomically promotes it into the managed source store. The source pointer is written only after the durable checkout exists and `install.json` is written last as the managed-source commit point, so any earlier failure leaves the user on the already healthy numbered Stable installation. Ordinary managed-source discovery, staging, update, recovery and worker execution likewise use product-owned tool paths rather than ambient Git/npm/Node or user `PATH`.

Windows x64 and ARM64 fresh-install acceptance exercise the same path. The Windows native shell supervises its runtime through a product-owned Node gate inside the Job Object lifecycle and requires an explicit bounded child-start acknowledgement before considering startup released; the historical PowerShell gate remains only where older compatibility contracts still require it. A user does not need a separate Git/npm installation, Homebrew, Xcode Command Line Tools, Visual Studio build tools, or a particular `PATH`. Missing admitted native/prebuilt payloads fail closed instead of invoking a local compiler.

## Migration from older Stable installations

Public first installers now request managed Main enrollment by default after signed Stable health, when admitted `sourceSha` exists. Existing signed Stable installations with the **same exact verified source provenance** can use that identical public installer for safe enrollment; historical Stable installs on a different version must first receive an authenticated Stable upgrade. The planned one-time bridge release will then migrate them automatically without manual installer reruns. Old runtime/installer binaries still follow their original channel contracts until replaced with signed updated code.

For same-version migration, the installer forwards the existing internal `--enroll-existing-main` path automatically only when both the currently installed and staged verified Stable release contain **the same exact source SHA**. The installed release, not just the downloaded candidate, must carry that provenance; a legacy 5.2.0/5.2.x layout without it first requires a normal Stable update to a provenance-bearing version. A cross-version reinstall with Main opt-in is rejected in favor of the rollback-capable Stable updater (including Windows x64/ARM64 native-shell ownership). A failed source-health check rolls the Main pointer back and preserves healthy Stable. Ordinary uninstall removes validated product-owned source/update/toolchain state while preserving workspace and configuration; full uninstall removes the explicitly owned application-data boundary.

## Operator-only failed Main rollback recovery (Windows)

When the installed Main source pointer still identifies a healthy original SHA but a native Windows update failed with `rollback_failed`, never retry the update blindly or delete `active.json`. The offline `scripts/diagnostics/recover-windows-main-update.mjs` runs a **read-only audit by default** from a trusted, pinned product-owned Node toolchain. It validates exact source/receipt SHA, managed current-release ownership, installed WPF SHA tree, Native Messaging registry+manifest, no running/uncertain worker, and the loopback `HEALTHY` identity at the original SHA. The CLI itself checks exact Windows architecture, managed current-release parent directory and managed-source ownership before handing off to the deeper receipt/native verifier; it rejects unknown arguments and does not trust a caller-provided release path. Only after a clean audit may an operator use explicit `--apply`: rechecks all identities after cleaning stale worker ownership, archives just the owned lock, and preserves the original `rollback_failed` forensic receipt. No config, tunnel keys, profiles, snapshots or source checkout are removed. This operator path is **not** yet a normal automatic recovery flow and must not be used without live installed-host validation. Further architectural work and test gates are in [the immutable Main update plan](plans/immutable-main-updates.md).

## Main A → B API and transaction acceptance

The Control Center Main `Update & restart` action maps to the same-origin/CSRF-protected `/api/v1/update/check` and `/api/v1/update/apply` routes. Main runtime admission is pinned to the `main-snapshot` SHA and must not mutate source A before the durable worker handoff. A local exact-Git integration acceptance exercises source A and source B as separate commits through the real API and transaction engine; it validates both `reuse_native` and `artifact_required` planning, a separate Node process reading the promoted pointer, and successful B health or forced A rollback. Windows x64 and native ARM64 execute these paths in the runtime CI lanes. This source/HTTP/process-chain test supplements, but does not replace, end-to-end OS native shell and real Control Center installed-machine acceptance required to close M8.

## Optional real installed-host Main smoke

The `Main Installed Upgrade Acceptance` workflow (`.github/workflows/main-installed-acceptance.yml`) is an **opt-in** runner-only acceptance, not a routine PR or push gate. It refuses an existing `dev.equinox.local` LaunchAgent or occupied Control Center port, builds a previously admitted Main A package in the disposable hosted runner, uses the real managed bootstrap and product-owned toolchain, then calls the real loopback Control Center `check`/`apply` to a separately admitted latest `main-snapshot` B. It requires the exact tag to match canonical HEAD, watches the detached worker receipt and checks that the real restarted native-host runtime is `HEALTHY` at B. The test must never run against a developer's active Mac installation; its fixed launchd label and port are intentionally isolated to the GitHub runner. Do not present this initial success-path smoke as coverage of forced-failure rollback or genuine Windows installed-host acceptance: both are independent M8 exit requirements.

## Stable update manifests

Runtime updates use JSON manifests signed with Ed25519. The shipped runtime contains only trusted public keys; release private keys must remain outside the repository.

A stable manifest binds together:

- update schema and channel,
- target architecture,
- version,
- artifact HTTPS URL,
- exact byte count,
- SHA-256 digest,
- publication timestamp,
- signature algorithm and key ID,
- Ed25519 signature.

The runtime validates the signature and the pinned URL shape before accepting an update candidate.

## Activation

A verified update is staged as a versioned release. Activation switches the managed `current` pointer, restarts the managed runtime, and then verifies that the requested version becomes healthy.

For an **upgrade**, if the target version fails its post-restart health check, Equinox Local automatically restores the previous release and verifies the rollback target before reporting failure. A **fresh first install** has no previous release to restore, so it stops the failed LaunchAgent while preserving the verified candidate/current pointer for an explicit retry and diagnostics.

```text
signed manifest
   -> verified download
      -> versioned staging
         -> atomic promotion
            -> restart
               -> health/version check
                  -> success
                  -> or automatic rollback
```

## Separation from Equinox Browser

The Local updater owns only Equinox Local runtime releases. Equinox Browser remains owned by the Chrome Web Store update channel and is never replaced by the Local updater.

## Release tooling

Release helpers live under [`scripts/release/`](../scripts/release/). Private signing material is intentionally not part of this repository.

The release tests under [`tests/release/`](../tests/release/) cover deterministic packaging, signature verification, bootstrap manifest generation, managed installation and rollback behavior. Release smoke also exercises an isolated real macOS `launchctl -> runtime host -> app runtime wrapper -> supervisor -> server` lifecycle rather than stubbing LaunchAgent activation and health success.

## Security expectations for maintainers

- Keep signing private keys outside every Git checkout.
- Store signing keys with restrictive filesystem permissions and a separate backup.
- Never commit a private key, credential, tunnel runtime key, or generated signed release bundle.
- Treat a key rotation as an explicit trust-root change requiring review.
- Publish artifacts only after the source tree, public tests and clean-machine release gates are green.

## Dependency refresh included in Equinox Local 6.0.0

The pre-6.0.0 maintenance branch updates the product's pinned Node.js toolchain to **26.11.1** on all four supported native release targets, MCP SDK to **1.32.1**, PDF.js to **6.4.299**, Tunnel Client to **0.0.16** (macOS/Windows ARM64/x64), and universal macOS Peekaboo to **4.9.0**. Each native artifact's length/checksum remains explicitly pinned against the official release's published distribution metadata. The macOS ARM64 Node/Tunnel/Peekaboo release archives were also downloaded and verified locally, and the new binaries were exercised. No installed client is implicitly migrated to a different update channel.

Dugite Native **2.53.0-4**, Windows WinApp CLI **0.7.1**, Microsoft WebView2 **1.0.4258.31**, and the existing stable GitHub Actions major versions were checked and retained because no newer applicable stable upstream release was found at this checkpoint. `node-pty` remains on **1.2.0-beta.15** (latest beta); npm's generic `latest` dist-tag points to older stable 1.1.0 and should not be used as a downgrade. The dependencies refresh was incorporated into the separately signed and verified Stable Equinox Local **6.0.0** release; Equinox Browser **1.0.0** is distributed separately by the Chrome Web Store.

## Windows interrupted Stable recovery (manual, explicit)

If a Windows Stable upgrade and its automatic rollback both fail (`update-state.json` reports `rollback-failed`) and the ordinary uninstaller is blocked, preserve that state for diagnosis first. The guarded, per-user `scripts/diagnostics/recover-windows-stable-install.ps1` utility defaults to a read-only ownership audit. `-Reset` is a **deliberate fresh-install recovery**: it verifies the active pointer/release, stable shell, Installed Apps registration, Native Messaging registry/manifest, Start Menu shortcut, startup command, and running shell executable; refuses foreign/unverifiable ownership; closes only the owned EquinoxLocal shell; and renames the two owned installation roots to timestamped recovery siblings before clearing exact per-user registrations. It does **not** broadly kill Node processes, touch unrelated Chrome extensions, or delete the quarantined data. It is not a general-purpose uninstaller. This reset intentionally loses the active configuration from the standard location; run the official signed Windows Stable first-install bootstrap only after it reports success. Keep the quarantined roots until a fresh install and tunnel work. An audit/refusal is not authorization to manually remove arbitrary files or HKCU keys.

### Windows WPF runtime cache and browser discovery corrections (next Stable)

Windows Stable's native WebView2 control now writes its mutable browser profile under the owned per-user `Equinox Local/state/webview2` directory instead of alongside `EquinoxLocal.exe`. Some previous native shells already generated `EquinoxLocal.exe.WebView2` and literal `%SystemDrive%` Windows cache trees inside `Programs/Equinox Local`; signed shell identity, upgrade and uninstall checks compare the verified release files while accepting only these known legacy runtime-cache directories, rejecting symlinks, unknown entries and mutated release files. New staged and release shell trees retain fully strict comparison. Agent Browser Chrome discovery also works when the managed native shell strips `ProgramFiles` from its environment: Windows' two standard Program Files roots are derived from the absolute `SystemRoot` drive and never from the ambient PATH or unverified process command lines. Windows Doctor checks the pinned winapp engine, and diagnosis surfaces Agent Browser launch failures independently of the optional macOS Peekaboo bridge.

### Windows tunnel fallback and retry after unexpected disconnect (next Stable)

The Windows native shell owns a bounded Node process gate and a runtime supervisor. A configured tunnel that fails to initialize, unexpectedly exits or loses connectivity may temporarily leave the local Control Center in `local-only` mode. The Windows runtime now keeps that local-only Control Center running while it retries signed product-owned tunnel preflight after 30 seconds, backing off to 10 minutes. It never opens a second competing Control Center on the same port: only after successful preflight does the owned local-only server receive stdin EOF and shut down gracefully, after which the tunnel may start. The native shell logs only recognized fixed transport phase tokens (without raw child stderr or credentials), and explicit stop/restart is not interpreted as a recoverable failure. Missing or invalid credential state remains fail-closed and requires explicit configuration correction.

This improves self-healing but does not claim to have identified why a specific tunnel-client process exited: use bounded, redacted diagnostics from the affected Windows host before deciding whether tunnel-client itself also needs a fix.
