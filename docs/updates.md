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
