# Equinox Local: clean replacement updates (v6)

**Current objective:** Any supported installed v6 version must update to the next admitted Main build without carrying forward executable/runtime files from the previous version. User-owned settings and credentials must survive unchanged. This supersedes the abandoned Guardian eight-stage A/B design from draft PR #230. No new release or production activation has been approved.

## Required behavior

1. The existing signed v6.0.4 Stable-to-Main bridge remains backward compatible with the updater shipped in earlier signed Stable installations. Old binaries cannot be fixed by changing Main source; follow `unified-main-update-channel.md` for the one-time bridge.
2. Every regular Main update stages a **fresh full source checkout and full native release payload** for the device's platform/architecture, under a new immutable version/SHA directory. Validate downloaded signed release metadata/artifact hashes and trusted pinned runtimes before selecting it. Never patch or reuse the previous executable, Node modules, WPF files or Native Messaging host. Use the existing detached updater worker and Windows WPF exit/relaunch or macOS LaunchAgent handoff: the application cannot replace its own running executable.
3. Preserve user-owned configuration **in place**. On Windows this includes `%LOCALAPPDATA%\\Equinox Local\\state` (except bounded temporary updater transactions), user browser profile and workspace. On macOS this includes settings, runtime/tunnel credentials and browser data in `~/Library/Application Support/Equinox Local` plus any external workspace. Keep user settings, tunnel IDs/keys, consent, browser data and preferences. **Do not delete the entire application support/LOCALAPPDATA root**, or use an uninstall that destroys user data.
4. Keep the previous VERIFIED release temporarily for rollback. After shutting down the old runtime, atomically select the new installed release and start its freshly installed shell/backend. One exact source-SHA/HEALTHY check decides success. On failure restore the previous release and automatically launch it. Never commit new-version success before health is proved.
5. On successful health, discard old **product-owned** code/build/cache artifacts, but never user settings, workspace, browser profile or credentials. Fail closed on foreign paths, reparse points, unexpected source hashes and duplicate update processes. Do not manufacture separate quarantine/retirement layers, multiple HMAC command protocols, staged PID/SHA sidecar chains or offline writer-lock ceremonies.

## Acceptance before publishing

- Windows x64 and ARM64: real **already-installed old version → new version** using Update & restart, fresh full native and source files, WPF closed/reopened, correct Native Messaging and working tunnel/runtime, preserved user settings; inject failed target and prove previous version launches automatically.
- macOS arm64 and x64: same cross-version upgrade and rollback with verified LaunchAgent relaunch and preserved user state. Include the existing signed old-Stable-to-Main bridge as a separate compatibility gate.
- CI must measure complete workflow wall time; avoid expensive Windows matrices for documentation-only changes. Test the user-facing update flow, not dozens of intermediate implementation steps.

**Status:** Simplification underway on PR #230. The old eight-stage Guardian/failed-B retirement/orphan implementation has been removed from the branch, not released. The clean native update path still needs installed-host end-to-end verification; do not describe this as shipped or production-ready yet.
