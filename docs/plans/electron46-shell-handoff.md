# Electron 46 shell migration — current delivery handoff

**Status: 7.0.0 LIVE / FACTORY SOURCE ELECTRON CUTOVER VERIFIED, 2026-11-06 (+03).** PR #333 merged as `358ffa151fe5e6cc4cad9b6097db409b59f732fa`; all four native builds and protected signed publication succeeded. The public Ed25519 selector, four artifact sizes, and maintained Windows installer/verifier bytes were read back. Factory now runs a genuine Source-role Electron shell25 with one main owner and a healthy7.0.0 backend. Source follow-up PR #334 includes the explicit Source producer and the native-observed temporary-directory correction; its final ordinary merge/publication must still be read back separately. Historical development-only/no-authority statements below are superseded for the approved rollout, not retroactively rewritten as execution evidence.

**Previous status: SOURCE / DEVELOPMENT CHECKPOINT READY, 2026-11-05 (+03).** The maintainer explicitly resumed after the second quota pause; its historical stop instructions are superseded. Reported source findings are repaired and independently reviewed. Installed conversion, authenticated managed production and publication are NOT complete or authorized by this checkpoint. The chronological history—including both pauses—is retained in `electron46-shell-migration.md`.

## Read this before further work

- Current follow-up branch is **`equinox/factory-electron-cutover-v7`**. Installed Source code revision is **`c40f86fb6dba2df5a2ec08f54666126d384ad214`**; subsequent documentation-only commits may follow. Do not restore the old baseline or run the public managed installer over Factory.
- Read current `AGENTS.md` and latest plan checkpoints; load `equinox-local-refactor`, `equinox-factory-refactor`, `requesting-code-review` for relevant work.
- **No tests, fixtures, smoke/acceptance suites or disguised harnesses.** Permitted static/type/generated-output checks and genuine builds/observations are recorded below; installed/OS operations need separate scope.
- No implementation child remains. The installed resident Electron application is intentionally running; do not terminate it as a leftover development capture. No recurring automation was created.
- Preserve the original product/UI and the now-verified Source owner. Finish ordinary follow-up merge/publication readback and retain the platform limitations below, not another migration framework.

## Installed rollout evidence — current, 2026-11-06

- Initial CodeQL evaluation found four filesystem-race patterns. FD-first no-follow/nonblocking corrections retained private ownership, identity and bounded-read checks. Independent review passed; a genuine sealed-bundle roundtrip with umask077 and strict signature verification passed. New CodeQL evaluation passed before ordinary exact-head merge; no finding was dismissed or protection bypassed.
- Added genuine `packageSourceDesktopShell` / `buildSourceMacDesktopPayload` through the same shared packager and sealed synchronizer. ASAR and Info.plist say `source` before signing/sealing; managed source admission and development attach-only behavior remain unchanged. Native ARM64 Source package, extraction, installed version/role/shell identity and deep/strict signatures passed.
- Explicit `prepare-source-app-host --electron-source` admits the exact configured legacy Source plist **and private Source wrapper**, refuses managed-profile conflicts, and checks canonical applet/job/port quiescence before replacement. It does not recreate KeepAlive. Current Source wrappers must match exactly; the legacy predecessor may match only the exact known body without the two subsequently added hardening headers. Missing wrappers or stale Source plists alongside managed wrappers do not admit conversion. Independent corrective review passed.
- Old Swift owners and backend were observed exited, and port24891 was free before installation. The normal Source preparation CLI used the existing external configuration and deliberately isolated Node; no private composition or credentials were copied into tracked source. Source configuration bytes and credential-file metadata remained unchanged.
- Genuine installed Source startup and reopen reported7.0.0, `HEALTHY`, zero health reasons, the unchanged capability/domain set and one canonical Electron main process. Actual backend environment retained desktop-owner/native-helper admission and the configured private composition module/root.
- Legacy companion visibility **false**, language and position were durably preserved; AppKit-to-Electron coordinates were checked against the real primary display. Pending GUI transfer retired only after persistence. An actual installed Control Center screenshot at1456×938 was inspected; original design retained. Local ignored evidence: `artifacts/desktop/electron46-source-cutover-20261106/factory-control-center.png`.
- The real finite login helper initially refused a fresh custom-TMPDIR profile before initialization. Native Foundation inspection demonstrated a different temporary directory from Node. The validator now uses canonical Node `os.tmpdir()` like its parent; UID/private-mode/prefix/ancestor/freshness/userData/sessionData checks remain. Independent review passed. After genuine rebuild/reinstall, **enabled plus separate readback both passed** under the original custom TMPDIR. This proves registration/readback, not an actual OS logout/login cycle.
- Real acknowledged Source Quit drained the exact main, backend and associated processes and released port24891, with **no manual tunnel-stop assist**. Normal reopen produced one new owner and healthy backend; preferences, private configuration and credential metadata were rechecked unchanged.
- Latest source checks: root no-emit; normal149 runtime /11 desktop /25 tooling generation equality;196 JavaScript /6 shell syntax checks; whitespace checks. No tests, fixtures, smoke/acceptance suites or fake runtime data were created.
- Open qualifications: physical Windows desktop/Job Object/first legacy migration is maintainer verification; Intel GUI execution is not established by native CI builds; managed macOS first-cutover/recovery, repeated-signature `changed:false` idempotence, approval-pending and full OS-login/TCC scenarios remain distinct unexecuted gates. Desktop engine reported Ready in the real Source UI; this is not an exhaustive TCC acceptance.

The remainder is the **historical November5 source/development checkpoint**, retained for implementation provenance; its earlier claims that no publication or installed action occurred do not describe the current rollout.

## Immutable product decisions

- Exact **Electron46.0.0-alpha.5**, actually observed bundled **Node26.13.0**; root npm version remains `0.0.0-development`, not a published release declaration.
- Same existing private-loopback Control Center and backend, no second dashboard/server/provider/native-chat product.
- One Electron main owner on installed macOS/Windows and the explicitly admitted macOS Source role; necessary macOS process-session and Windows Job Object/current-user IPC helpers retained. Legacy Swift schema1/version24 preparation and historical signed WPF reads remain compatibility paths, never supervisors for the new shell. The live Factory no longer uses the legacy owner.
- Same Nyx companion/atlas on **both platforms**, new installed profile default **ON**, saved false/position/language respected. Development attaches with separate storage, no automatic duplicate pet or live Factory-default read.
- First legacy→Electron migration uses the maintained external installer **once**. Candidate inspection rejects old immutable callers before their stop/move path. There is no bridge release/self-updater/registry. Website and compatible signed Main must be rolled out in the right order.
- Generic normal-tree symlink rejection, Ed25519/source/target/archive/ownership and exact-clean source guards are intact. No installation/publication workaround via a fabricated clean checkout or unauthorized commit.

## Latest implementation and independent reviews

### Companion

`desktop/companion.ts`, renderer/preload/local HTML/CSS, `shell-preferences.ts`, main/preload/readonly CC language bridge and explicit package allowlist.

- Original atlas bytes unchanged:3261692, SHA256 `0058c087b76b6205a615bc80f7330ff64ee0992199f340dc3425cb676ea3833c`; original animation maps/timings/three-cycle fallback/reduced-motion/hover/drag/actions/speech retained in source. Native materials/icons are cosmetic approximations.
- Minimal public snapshot only, dedicated sandbox/context-isolated Node-off local session, exact sender/mainframe/full document/surface authority, bounded geometry/measurement and fixed actions. No renderer network/chat input/microphone/new backend/poller/owner.
- Initial `deleg_a3767dc7` NOT PASS findings were confirmed and fixed: one changed pending point/fixed500ms save timer; monotonic100ms begin/activation and16ms move admission; no stationary-click disk writes; flush on hide/dispose/failure. One current-intent load completion/window, no growing per-request listeners; localized hidden aria-describedby state replaces unsupported button aria-valuetext.
- Fresh companion `deleg_836e11b1` **PASS**; later combined pending-transfer/live-companion review `deleg_07b01957/task-0` **PASS**, no blocking findings. Failed persisted writes now retain pending motion; refresh occurs before flush, and a failed flush prevents importing over that motion. Live saved-bounds application restores visible display fallback without rewriting saved coordinates.

### Reliable legacy preference and login transfer

`src/equinox-local-macos-installer.ts`, `desktop/main.ts`, `desktop/shell-preferences.ts`, narrow main-only `companion.applySavedPreferences()`.

- Initial `deleg_e5a55ae3` NOT PASS correctly found argv-only early-launch loss and transient-I/O loss. Both are repaired, not merely documented.
- Only after admitted managed legacy owner/service exit, refresh the exact three original GUI keys. Atomically persist one private/no-follow bounded2KiB `state/electron/private-shell/legacy-shell-pending.json` BEFORE replacement exposure. Never write old defaults or read them from dev/source/finite maintenance.
- Admitted managed initial startup, second-instance and macOS activation consume/retry the same record. Existing private fields—including false—win; AppKit coordinates convert only in main. Invalid storage is never overwritten and optional UI failure does not block core runtime.
- Store `write()` returns explicit persistence success, updates memory only after atomic write/fsync/readback, and `refresh()` recovers transient storage errors. Full bounded reads check FD stability. Pending retirement requires persisted merge and unchanged owned file identity, not health success or memory-only application.
- Parent additionally fixed failed-install→restored legacy→changed old settings→retry staleness: a newly re-admitted stopped legacy snapshot refreshes an older valid pending record only after identity recheck. Electron stops do not invoke that producer, so unconsumed records survive later candidates. Narrow `deleg_8fa099a8` **PASS**, no findings.
- Fresh/default-enabled or legacy-preserved login intent uses existing independently admitted finite helper modes read/cleanup/enabled/disabled BEFORE ordinary app opening, not GUI argv. Existing Electron reinstall/recovery skips mutation. Enabled requires confirmed OS enabled; disabled/cleanup require confirmed unregistered; approval-pending is not success.
- Finite helper still selects unique private userData/sessionData before readiness, no lock/UI/backend/socket initialization; exact spawned child/output/deadline/TERM/KILL/observed-close handling and owned-profile cleanup retained. GUI/live persistence and finite-login/direct recovery `deleg_07b01957/task-0,task-1` both **PASS**, source only.

### Core installer/package boundaries retained

- Mac schema2/kind electron/shell25 uses authenticated `desktop-app.tar.gz`; full payload identity/signature/plist preserved, contained framework links only inside sealed helper. Generic walkers unchanged. Earlier real umask077 extract/signature/reseal/extract/signature passed; installed managed repeat-signing/changed:false remains unexecuted.
- Actual macOS release path is `installRoot/main-update/native-store/...`; Windows has its separate state path. Mac default S2 bootstrap returns null LaunchAgent path; no new KeepAlive owner. Matching desktop socket `Equinox Local/state/desktop-control.sock` is deliberately distinct.
- Read-only `--desktop-lifecycle electron-v1` negotiation and candidate-bound stopped context remain; `stopRequested` is recovery intent, `stopCompleted` follows observed exit. Fresh admission independently rechecks owner/service absence. Protocol review `deleg_1e594163` PASS; preserve every signed/ownership gate.
- Windows current publisher is complete Electron tree, old WPF compatibility is read-only. TS/Guardian Snapshot match actual19required files. Restored-shell cap uses existing450MiB471859200; four Node200000000 guards unchanged (`deleg_dc89035f` PASS).
- Existing direct installer preservation/recovery only: exact replacement exit before restoration, complete restore before predecessor restart; retain diagnostic residue when unconfirmed. No new updater/rollback engine.
- Native notifications retain bounded baseline/dedupe/fixed-origin task click and correct `^task-[a-z0-9-]{6,80}$`; dev duplication suppressed.

## Latest real checks — passed

After source writers stopped and the final producer refresh patch:

- `npm run typecheck`
- Normal `build:typed-runtime`, `build:typed-desktop`, `build:typed-tooling`
- Exact generated outputs **149 runtime /11 desktop /25 tooling**
- `npm run check`: **196 JavaScript modules /6 shell scripts**, syntax only
- `git diff --check`; additional **41 untracked text files** whitespace-clean
- Original/source/built website bytes identical for both OS installers and pinned verifier; earlier real Astro build passed, no deploy
- CI workflow/composite YAML parsed with Psych; no PowerShell/native CI execution
- Targeted added-code secret-pattern scan reported no matches (not a comprehensive security proof)

No suite/fixture or installer/helper/defaults/login/permission mutation ran. A source PASS is not native acceptance.

## Durable current development artifacts — ALL FOUR targets

**Repository-relative ignored directory:**

`artifacts/desktop/electron46-source-candidate-20261105/`

Contains `Equinox Local-darwin-arm64`, `Equinox Local-darwin-x64`, `Equinox Local-win32-x64`, `Equinox Local-win32-arm64`, build-manifest.json, artifact-inventory.json, renderer-observation.json and four PNGs. Three artifacts were preserved from scratch zX1BKV with verbatim framework links; Intel Mac was then genuinely cross-packaged into the delivery directory. Copied outputs were re-inventoried; no fabricated artifacts or source guard bypass.

- Programmatic manifest/inventory count **4 unique targets**, each **11 byte-exact compiled modules** plus exact companion HTML/CSS/original atlas; static dependency closure present. Computed imports in main/runtime-installation remain explicitly deferred to admitted installed runtime, not claimed bundled.
- Both Mac bundles pass actual deep/strict codesign. Intel main is actual x86_64 Mach-O; **not executed**. Actual ARM64 dev icon plist resolves to normal nonempty electron.icns; optional new .icon-format warning is nonblocking.
- Windows x64 tree386648346bytes/73files; ARM64 tree382090538bytes/73files. Both19required files normal/nonempty and under unchanged450MiB cap. Actual EXEs257642496/236460032bytes, PE0x8664/0xaa64; **not executed**.
- Actual ARM64 packaged-ASAR main rendered the original CC and pet/actions/speech using real existing status and isolated dev profile. All four PNGs inspected. Surfaces132×142/188×124/252×58logical; sandbox/contextIsolation=true, NodeIntegration=false, renderer process undefined, pet-state description present/no aria-valuetext. Foreground dev instance exited; backend listener identity unchanged.
- renderer-observation.json retains original scratch run paths as provenance; the identical captures are copied here. This proves development rendering, not installed owner/login/permissions/Windows/Intel/animation/drag execution.

## Historical pre-rollout authority/native gates

1. Clean authenticated managed-source build: dirty checkout cannot satisfy exact SHA guard. A maintainer-authorized scoped commit and native candidate build path are required; do not manufacture clean provenance. No commit/push/CI dispatch is currently implied.
2. Native Windows compiler/Guardian/JobObject/pipe/desktop/uninstall and PS5 behavior; actual Intel execution. Cross-packages/PE/source checks are not those proofs.
3. Native macOS managed first cutover, disabled/enabled login and approval behavior, exact shutdown/failure recovery, GUI transfer retries, retained stable TCC permission identity. Do not run managed installer on this live Source/Factory merely for evidence.
4. Installed S2 repeated signing/full-payload idempotent changed:false. Development bundle signatures and source comparison cannot prove signature determinism.
5. Coordinated signed Main/website promotion and separate publication approval. New-site→old-signed-candidate window intentionally refuses; repository mirrors do not make deployment atomic.

These were the pre-rollout gates. The current evidence above supersedes clean build/publication and Source installed-operation portions only; do not extend it to unexecuted managed, Windows desktop, Intel GUI, approval or idempotence cases. Earlier detailed chronology and both quota pauses remain in `electron46-shell-migration.md`.
