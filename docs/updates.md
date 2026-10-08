# Updates and rollback

Equinox Local uses a self-hosted, signed stable-update channel. The baseline distribution path does not depend on the Mac App Store, Developer ID, notarization, or a paid Apple Developer Program membership.

## Stable or Main: explicit user choice

**Stable is the default** for fresh installs and routine installer reruns, even when a verified release has `sourceSha`. It follows the latest published numbered release. **Main is opt-in**, follows admitted exact-SHA canonical snapshots, and uses the existing managed-source toolchain/enrollment/update/rollback transaction—not another update server or browser transport. Factory means Main plus explicitly configured private diagnostics/composition, not another product lineage; private state/configuration is not enrollment consent and must remain external and preserved.

With the downloaded public installer, choose:

```sh
# macOS: Stable (default)
/bin/bash install-equinox-local.sh
# macOS: explicit Main, fresh or eligible existing Stable
/bin/bash install-equinox-local.sh --enroll-existing-main
/bin/bash install-equinox-local.sh --help
```

```powershell
# Windows: Stable (default)
.\install-equinox-local.ps1
# Windows: explicit Main, fresh or eligible existing Stable
.\install-equinox-local.ps1 -EnrollExistingMain
.\install-equinox-local.ps1 -Help
```

The existing `--enroll-existing-main` opt-in deliberately also covers **fresh** installs; its trusted JavaScript API is `allowExistingStableToMainMigration: true` (default `false`). Main first installs and health-checks the verified Stable baseline, then enrolls the exact source SHA. Fresh explicit Main without source provenance fails before activation rather than silently ignoring the choice. Existing same-version migration additionally requires identical provenance in the installed and staged release; different-version migration requires the Stable updater first. A routine rerun does not undo a previously selected Main channel or remove private composition/configuration.

These are development installer semantics, not a publication announcement: production Local `5.2.0` and Browser `0.7.0` are unchanged; Local `5.2.1` and Browser `0.7.1` remain unpublished.

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

If the installed native runtime contract already matches the selected Main SHA, the updater uses `reuse_native` and downloads no native package. Crossing a native boundary requires the exact host snapshot; failure during native/source activation rolls back to the previously admitted source/native state. Exact-SHA snapshot publication covers Darwin and Windows x64/ARM64, and installed upgrade/rollback acceptance has been established across those four targets for `reuse_native`. That is not four-platform installed-host `artifact_required` acceptance: the real macOS ARM64/x64 replacement-and-rollback gates remain separate, and Windows `artifact_required` acceptance is explicitly deferred until the first useful genuine Windows-native change. Trusted `managed-source` installations can apply the admitted Main snapshot from Control Center with **Update & restart**; developer source checkouts remain check-only, and ordinary numbered Stable installations remain on the Stable updater.

M8 enrollment machinery was admitted on Main at `b73de11`; M9 makes its use conditional on explicit Main opt-in. A verified Stable artifact binds its exact clean canonical source SHA in `release.json`; after Stable first becomes healthy, Local provisions the pinned product-owned Dugite Native `v2.53.0-4` and Node `v26.10.0` toolchain, uses only the resulting absolute `gitPath`/`nodePath`/`npmPath` identities to stage that exact source, installs admitted prebuilt dependencies without compiling on the user machine, validates the checkout, and atomically promotes it into the managed source store. The source pointer is written only after the durable checkout exists and `install.json` is written last as the managed-source commit point, so any earlier failure leaves the user on the already healthy numbered Stable installation. Ordinary managed-source discovery, staging, update, recovery and worker execution likewise use product-owned tool paths rather than ambient Git/npm/Node or user `PATH`.

Windows x64 and ARM64 fresh-install acceptance exercise the same path. The 5.2.1 Windows shell also supervises its runtime through a product-owned Node gate inside the Job Object lifecycle and requires an explicit bounded child-start acknowledgement before considering startup released; the historical PowerShell gate remains only where older compatibility contracts still require it. A user does not need a separate Git/npm installation, Homebrew, Xcode Command Line Tools, Visual Studio build tools, or a particular `PATH`. Missing admitted native/prebuilt payloads fail closed instead of invoking a local compiler.

## Existing Stable 5.2.x migration boundary

A first install with admitted `sourceSha` stays Stable by default; only explicit Main opt-in enrolls managed-source after Stable activation becomes healthy. An **existing** numbered Stable installation stays on Stable if the installer is run again; the downloaded candidate's `sourceSha` is not proof that a historical 5.2.x installation opted into Main.

For deliberate same-version migration, the installer accepts `--enroll-existing-main` only with explicit operator intent and only when both the currently installed and staged verified Stable release contain **the same exact source SHA**. The installed release, not just the downloaded candidate, must carry that provenance; a legacy 5.2.0/5.2.x layout without it first requires a normal Stable update to a provenance-bearing version. A cross-version reinstall with Main opt-in is rejected in favor of the rollback-capable Stable updater (including Windows x64/ARM64 native-shell ownership). A failed source-health check rolls the Main pointer back and preserves healthy Stable. Ordinary uninstall removes validated product-owned source/update/toolchain state while preserving workspace and configuration; full uninstall removes the explicitly owned application-data boundary.

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
