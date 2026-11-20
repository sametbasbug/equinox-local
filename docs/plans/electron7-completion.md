# Equinox Local 7.0.0: completing the Electron cutover

Status: **in progress** (2026-11-20). The 7.0.0 signed Main snapshot is **not** a finished official release. This plan supersedes incomplete completion claims in the historical Electron shell migration/handoff plans. The existing product stays the Control Center; no Workspace or native Chat is part of this cutover.

## Outcome

- Both installed macOS and Windows use the same packaged Electron Control Center UI, without a browser-accessible localhost dashboard. Preserve current appearance, localization, settings, persisted data, and explicit Factory composition.
- Electron main is the **only** authority deciding runtime start, stop, restart, recovery, login and Quit. Other workers, secure tunnel connections, OS-native helpers and Windows Job Objects may remain when they provide capabilities rather than a competing supervisor.
- The existing one-Main signed OS installer/update scheme stays intact, including source/managed ownership, exact SHA and signed artifact checks. Factory is a Source role, never overwritten by the public installer.
- The existing Equinox Browser/Native Messaging architecture remains unchanged. One selected companion at a time (Nyx/Hemera/Asteria, later Selene) and a native Chat tab are **later features**, not prerequisites for the 7.0.0 release.

## Current source inventory (2026-11-20, HEAD ca3a9ae)

| Concern | Current owner / source | Required cutover |
| --- | --- | --- |
| Electron window | `desktop/main.ts` `loadURL(CONTROL_ORIGIN)` | Load immutable packaged HTML, CSS, JS, localization and logo via one fixed private application scheme; retain navigation/recovery/window security |
| Control Center API | `src/equinox-local-control-api.ts` loopback server and routes | Keep current validation/authorization and share handlers with desktop transport; retire HTTP asset serving immediately after packaged UI is functional, then retire API loopback if no external consumer remains |
| Frontend API calls | `src/equinox-control-center.ts` centralized `requestJson`/`mutationJson` | Bounded desktop preload/IPC, enumerated request operations; preserve validation, response errors, locking, retries/no-replay behavior; no Node or generic IPC in renderer |
| Native shell operations | `desktop/control-client.ts`, `desktop/preload.cts` | Keep narrow native presentation, folder picker and menu operations; internal transport may temporarily use the existing loopback API but must not re-expose it as a web dashboard |
| Core owner | `desktop/runtime-owner.ts` | Keep its serialized child/Job lifecycle and bounded recovery as sole application policy |
| Factory source startup | `scripts/release/prepare-source-app-host.mts` wrapper and `start-main-source-runtime.sh`/`watch-source-runtime.mts` | Trace actual tunnel process contract, remove duplicate watchdog/launchd-style recovery, preserve private composition and safe shutdown |
| macOS managed / Windows installed | `desktop/runtime-installation.ts`, `desktop/lifecycle-control.ts`, native installer scripts | Trace release-owner gate, helper/Job contracts and exact login/Quit behavior; preserve signed installer and user state |
| CLI / updates / discovery | `src/equinox-local-update-activation.ts`, `src/equinox-local-first-install.ts`, `scripts/eqlocal.mjs`, installer/health files | Inventory actual `24891` callers before retiring or replacing a transport; `eqlocal` already has private authenticated IPC |

## Implementation checkpoints

1. **P1: Package and load the unchanged Control Center.** Ship required assets inside ASAR, make origin/URL navigation and renderer recovery private to the app, connect the centralized frontend requests through strict main/preload IPC. Remove HTTP routes serving HTML/assets once the packaged UI is proven. API backend may temporarily continue listening for management/health while consumers are migrated. Never conceal an unchanged web dashboard behind another URL.
2. **P2: Remove transitional HTTP dependency.** Inventory frontend, CLI, health, updater and installer consumers. Move the existing management operations to shared callable handlers where appropriate, preserving current auth, bounds, revision guards and mutation semantics; remove the loopback API server if no remaining clients need it. No generic request proxy, arbitrary route IPC or second server as the final design.
3. **P3: Single runtime lifecycle.** Trace Factory Source wrapper -> launcher -> tunnel -> watchdog -> backend and the two managed operating systems. Make Electron main the only restart/retry decider; preserve actual tunnel and platform-native helper behavior, close to tray versus Quit, startup preference and installer handoff. Avoid multiple independent recovery authorities.
4. **P4: Real platform verification and removal of leftovers.** Check packaged UI on macOS Source and managed plus ordinary Windows x64/ARM64 where available. Observe real startup, Quit, login, update, crash recovery and current-user ownership. Confirm one backend, no web dashboard, no stale launchd/Windows supervisor and consistent source SHA. Run existing type/build/static gates only (no test files or test suites). Update public architecture/README/update docs, then merge, publish the **official 7.0.0 release**, update the live Factory through its proper Source path, and verify running identity/health.

## Release gates and safety

- Never claim the whole cutover is done merely because Electron launches or health is green. Record each platform's verified and unavailable evidence explicitly.
- Keep source code changes on one `equinox/` branch and the existing worktree; do not proliferate branches, snapshots, rollback engines or alternate installers. Avoid running expensive CI for each incremental change.
- Generated JavaScript and TypeScript must stay in sync; no new automated tests or smoke suites. Changes to signing, native identities and private configuration require actual release/installation proof.
- Updates to version stay **7.0.0** through this work. Hemera/Asteria companion selection and Chat tab are separate later work.

### 2026-11-20 implementation evidence

- Packaged `darwin-arm64` development shell from the current working tree, launched the actual signed-as-development `Equinox Local.app`, and observed the unchanged Control Center Overview with live backend state from the packaged UI. This is a **development attach**, not an installed Source/managed cutover or Windows proof.
- Implemented read-only `equinox://control/` asset loading inside the packaged Electron renderer, strict preload IPC request contract and enumerated management routes. The desktop main process currently forwards authorized requests to the existing API loopback; this **is transitional**, not a claim that the localhost backend transport has been removed.
- **Transition safety:** HTTP HTML/CSS/JS/image serving is temporarily retained because the currently installed Factory shell still loads that document. Removing it before admitting the new Source Electron shell would break Control Center if the live source backend restarted. Remove the web document/assets only after the new installed application is confirmed; the CLI, installer and runtime status API consumers must be migrated in P2.
- Pending gates: installed native app behavior on macOS Source/managed and Windows; old-origin per-window UI preferences (theme/section) migration; actual OS login/restart/Quit; release/Factory SHA identity. The old AppKit/WPF source files remain as migration compatibility references pending platform signoff, not as a reason to keep HTTP dashboard in the finished product.

### Observed Factory process relationships (2026-11-20)

Read-only macOS process/port inspection found the currently installed Source Electron main (`applet`) as a child of PID 1, with a Bash runtime wrapper beneath it. That wrapper owns one Peekaboo helper and one Node watcher, while the tunnel client daemon has been reparented to PID 1 and owns a separate Node backend which listens on `127.0.0.1:24891`. These are observed parent relationships, **not** evidence that every process has an independent restart policy. Source code confirms `start-main-source-runtime.sh` runs `tunnel-client runtimes connect`, then a watcher, and the wrapper stops the tunnel on exit. The next lifecycle pass must establish the tunnel client's native supervision contract before deleting or substituting a watcher. Do not create a guessed foreground tunnel option or replace necessary desktop/Job helpers merely to shrink a process list.

### P2 consumer inventory at this checkpoint

- `desktop/main.ts` and the new enumerated IPC-to-API adapter read/write status and Control Center operations through localhost. The HTML itself is now locally packaged.
- `desktop/runtime-owner.ts` uses the port as a single-backend admission guard.
- `src/equinox-local-update-activation.ts` and `src/equinox-local-main-update-worker.ts` call the status endpoint during signed update activation.
- `src/equinox-local-first-install.ts`, `src/equinox-local-bootstrap.ts`, and the installers retain a Control Center URL/reporting contract. The old AppKit and WPF frontends also still refer to the HTTP document; keep compatibility until replacement is admitted.
- The current `eqlocal` CLI already uses an authenticated private IPC socket via `src/equinox-local-cli-bridge.ts`, so a second unauthenticated transport is not necessary. Assess extending or reusing this authenticated runtime transport for desktop management operations, with shared handler logic and no arbitrary route-proxy capability. Ensure update/installer health has an owner-verifiable replacement before removing the loopback listener.

**Tunnel CLI contract checked:** The installed `tunnel-client 0.0.21` `runtimes connect --help` explicitly describes *managed local runtime supervision* and exposes no supported foreground/attached execution mode. Therefore `connect` intentionally creates its own runtime supervisor; simply dropping the watcher would break Electron-owned recovery/stop observability. P3 must use the supported tunnel contract, keep the tunnel connection working, and clearly distinguish Electron's top-level application policy from tunnel client's process/connection supervision rather than inventing unsupported flags.
