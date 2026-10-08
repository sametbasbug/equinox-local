# Updates and rollback

Equinox Local uses a self-hosted, signed stable-update channel. The baseline distribution path does not depend on the Mac App Store, Developer ID, notarization, or a paid Apple Developer Program membership.

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

If the installed native runtime contract already matches the selected Main SHA, the updater uses `reuse_native` and downloads no native package. Crossing a native boundary requires the exact host snapshot; failure during native/source activation rolls back to the previously admitted source/native state. Main snapshot publication and rollback acceptance are complete across Darwin and Windows x64/ARM64. Trusted `managed-source` installations can apply the admitted Main snapshot from Control Center with **Update & restart**; developer source checkouts remain check-only, and ordinary numbered Stable installations remain on the Stable updater.

M8 fresh-install enrollment is now admitted on Main at `b73de11`. A verified Stable artifact binds its exact clean canonical source SHA in `release.json`; after Stable first becomes healthy, Local provisions the pinned product-owned Dugite Native `v2.53.0-4` and Node `v26.10.0` toolchain, uses only the resulting absolute `gitPath`/`nodePath`/`npmPath` identities to stage that exact source, installs admitted prebuilt dependencies without compiling on the user machine, validates the checkout, and atomically promotes it into the managed source store. The source pointer is written only after the durable checkout exists and `install.json` is written last as the managed-source commit point, so any earlier failure leaves the user on the already healthy numbered Stable installation. Ordinary managed-source discovery, staging, update, recovery and worker execution likewise use product-owned tool paths rather than ambient Git/npm/Node or user `PATH`.

Windows x64 and ARM64 fresh-install acceptance exercise the same path. The 5.2.1 Windows shell also supervises its runtime through a product-owned Node gate inside the Job Object lifecycle and requires an explicit bounded child-start acknowledgement before considering startup released; the historical PowerShell gate remains only where older compatibility contracts still require it. A user does not need a separate Git/npm installation, Homebrew, Xcode Command Line Tools, Visual Studio build tools, or a particular `PATH`. Missing admitted native/prebuilt payloads fail closed instead of invoking a local compiler.

## Existing Stable 5.2.x migration boundary

A first install with admitted `sourceSha` enrolls managed-source only after Stable activation becomes healthy. An **existing** numbered Stable installation stays on Stable if the installer is run again; the downloaded candidate's `sourceSha` is not proof that a historical 5.2.x installation opted into Main.

For deliberate same-version migration, the installer accepts `--enroll-existing-main` only with explicit operator intent and only when both the currently installed and staged verified Stable release contain **the same exact source SHA**. The installed release, not just the downloaded candidate, must carry that provenance; a legacy 5.2.0/5.2.x layout without it first requires a normal Stable update to a provenance-bearing version. A cross-version reinstall with Main opt-in is rejected in favor of the rollback-capable Stable updater (including Windows x64/ARM64 native-shell ownership). A failed source-health check rolls the Main pointer back and preserves healthy Stable. Ordinary uninstall removes validated product-owned source/update/toolchain state while preserving workspace and configuration; full uninstall removes the explicitly owned application-data boundary.

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
