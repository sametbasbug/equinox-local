# Signed Main installation, updates and recovery

Equinox Local uses **one public, production-signed Main installation/update path** for macOS and Windows. Current builds do not require a manually numbered GitHub Release for every source change, a separate Stable-to-Main enrollment, or an Apple Developer Program membership. The presentation version shown by the app may remain unchanged across multiple independently signed Main source commits.

> This guide documents the **current public signed-native Main path**. Older Stable, managed-source, A/B migration, and rollback machinery described in historical commits or older release notes is not an alternative installation method. For design decisions and migration history, see [the consolidation plan](plans/one-main-one-installer-one-repo.md).

## Install or repair

The same public installer handles fresh installation, reinstall/repair and Control Center **Update**. Run as your own signed-in OS user, **not as root or Administrator**.

**macOS (Apple silicon / Intel):**

```bash
curl -fsSL https://local.sametbasbug.dev/downloads/updates/install-equinox-local.sh | /bin/bash
```

**Windows (ARM64 / x64):** download, inspect and run the [official PowerShell script](https://local.sametbasbug.dev/downloads/updates/install-equinox-local.ps1), following the [Windows installation guide](https://local.sametbasbug.dev/install/).

You do not need to install Git, npm, Homebrew, native compilers or Node separately. The verified installer uses pinned bootstrap tooling. On Windows an already installed, byte-for-byte SHA-256-pinned Node executable may be reused; otherwise the official pinned Node ZIP is downloaded and checked before use.

The installer preserves **user-owned configuration, tunnel credentials, workspaces, browser profiles and personal state**. Only product-owned executable/program paths are replaced. First installation has no previous executable release to restore. If installation fails, follow the installer diagnostic/recovery instructions instead of deleting application state or restarting a half-finished update blindly.

## Source SHA and verification

1. CI builds complete native candidates for `darwin-arm64`, `darwin-x64`, `win32-arm64` and `win32-x64` from one canonical Git source commit.
2. The publisher stages immutable, exact-SHA platform archives and produces the **production Ed25519-signed** Main selector. The mutable `latest/main.json` pointer is promoted only after admission and publication of the complete four-target set.
3. The public shell/PowerShell installer downloads the latest signed selector, verifies the pinned signing identity, the selected platform artifact's exact bytes and SHA-256, and its native/source runtime identity **before activation**.
4. The installer stops/replaces only owned program processes/files and requires the new native installation to return a matching, healthy completion receipt.
5. Control Center's Update action runs this same external signed OS installer. The existing running installation does not bypass the first-install verification boundary.

Signed Main is **not the same thing** as the most recent numbered GitHub Release. The README Equinox Local version badge reads the published signed Main selector (`latest/main.json`), while the Equinox Browser version badge reads the separately published Chrome Web Store version; neither badge requires a manual README edit. The app's displayed version, Git commit SHA and published signed-native identity are separately validated. A code change can advance the SHA while retaining the presentation version. A documentation-only commit does not claim a new runtime version; Main publishing follows the existing CI impact gates.

### Retention

Cloudflare R2 keeps the **three most recent complete native SHA snapshots**, while also protecting the current canonical `main`, `main-snapshot` and live production-signed installer SHA references when they differ. Cleanup runs automatically after successful Main CI publishing; a daily scheduled run and manual trigger remain fallback paths. Partially built or ambiguous objects are handled conservatively. The retention policy lives in [`scripts/release/prune-main-r2.mjs`](../scripts/release/prune-main-r2.mjs) and [the release plan](plans/one-main-one-installer-one-repo.md).

## Platform behavior

**macOS:** Native `Equinox Local.app` and its per-user supervised runtime operate through launchd. Factory/source checkouts are a separate development profile and **must not be overwritten** by the public managed installer. The installer requires the native Main identity to agree with the protected signed source SHA before trusting the installed service.

**Windows:** The WPF application and product-owned Node/Guardian/native host are reinstalled using a detached PowerShell installer in the signed-in user session. The pinned Node bootstrap can reuse an independently hashed existing Node executable; there is no broad process kill, external toolchain compilation, or arbitrary user-state deletion. Installer transcripts under the user's private Local logs include elapsed-time markers for troubleshooting; installation may close and reopen the native app.

**Both:** The native Equinox Browser messaging host is product-owned, but **the Chrome extension itself is not**. Chrome Web Store controls extension publication, review and updates. Installing or updating Local does not modify the extension package.

## Checks and troubleshooting

- Open **Control Center → Doctor / Health** to confirm the active runtime, signed Main identity, Secure updates state, tunnel connection and browser host.
- Inspect the native installer's output/private transcript when an update appears to be stuck. Distinguish network download, verified archive extraction, activation and first healthy startup; do not assume an arbitrary timeout proves a failure.
- Use the **same official installer** for a repair/reinstallation. It validates the current trusted artifact again while preserving user state.
- For previous-version legacy Stable installs, consult their original release notes and migration instructions; older updater code cannot adopt the current Main installer behavior retroactively.
- Do not run the managed installer on a live Factory/source checkout or copy developer-only private credentials into the public installation.

Release helpers live under [`scripts/release/`](../scripts/release/); signing material and private publisher credentials are not in the public repository. Review [security model](security-model.md), [architecture](architecture.md), [CLI](cli.md) and the [changelog](../CHANGELOG.md) for details.
