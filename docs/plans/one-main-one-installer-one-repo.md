# One Main, One Installer, One Public Repository

Status: **approved implementation plan — in progress** (2026-10-27)
Decision owner: maintainer. Canonical public repository: `sametbasbug/equinox-local`.
This plan supersedes the numbered-Stable-vs-Main distribution/independent-A-B-update goals in historical plans. Those documents remain historical evidence, not a parallel roadmap.

## Non-negotiable outcome

- One public GitHub repository owns Equinox Local/Browser source, site, documentation, CI, installation, update and repair.
- **The existing working out-of-process macOS shell / Windows PowerShell installation flows become the *only* product install/update/repair engine.** Control Center Update and the public terminal commands must invoke the same exact installer transaction/verified artifact and have identical semantics. No duplicate UI updater, no alternate Guardian/A-B update machinery. Control Center only launches/monitors the independent installer; it must survive closure/stop of its caller.
- **One distribution stream: the latest accepted signed package built from canonical `main`**. Identify installation/update by exact full commit SHA. Build/verify/sign/publish installable per-architecture binaries for admitted commits without requiring human-numbered GitHub Releases. Never execute unsigned or unaccepted `main` HEAD. The complete set of four supported macOS/Windows architectures remains supported.
- Versions such as `6.2.1` are manually increased for product presentation and occasional GitHub Releases milestones. Control Center shows `6.x.x - abcdef1` (use the actual source SHA); updates compare SHA, not version number, dates or release tags. Manually numbered GitHub Releases are optional and **not** an availability or installation dependency. Keep an exact signed artifact manifest for every published SHA and a current immutable signed manifest/pointer.
- Repair/reinstall/update preserves personal configuration, secrets, workspace, browser/profile data and private factory composition; only replace product executables. On failure roll back the original executable installation; on successful healthy activation delete transaction backups. No user-level Git/npm/developer-tool prerequisite. Chrome Web Store continues to own Browser extension distribution.
- Mac mini's Equinox Local and Equinox Browser **remain private Factory role/installations** using the canonical public product source, with credentials/private composition in user-owned Application Support/Keychain/external private storage. Factory must never be rebranded or converted to a regular public installation.

## Boundaries

- Do **not** copy the private repo or any of its Git history into public. No private composition module, private Browser reviewer state, signer material, credential/config JSON, unpublished staging, local-state archives or machine-specific paths ever enter tracked source. Audit copied files *before* staging and again before push. Signing keys remain off GitHub and outside product install.
- Do **not** use release-number increases as a workaround to publish an ordinary Main update.
- Do **not** delete/archive the two predecessor repositories until the exact site URLs, single installer behavior and both real OS installations are verified end to end. No repository deletion in early migration stages.
- Preserve the established single-branch/single-worktree discipline. One short-lived active feature branch per repo at most; merge/clean it before any new feature branch. Batch CI rather than triggering Actions for every small edit.
- Keep public tracked documents and factory-private operational runbooks accurate while transitioning. Do not import stale historical documents as live instructions.

## Execution stages and acceptance gates

### 1. Record and isolate the migration
- [x] Explicit maintainer architecture approval received.
- [x] Persist this document in public source and create/maintain an Equinox Local Task Capsule with checkpoints.
- [ ] Inventory private-only capabilities, signing/credential dependencies, site origin/Cloudflare configuration and existing bootstrap/update files. Keep a short allowlist of importable non-secret behavior, rather than copying private modules wholesale.

### 2. Consolidate the site without breaking production
- [x] Import *tracked* site source into `website/` in this repository. This parent directory avoids a confusing `site/site/` project root; keep its nested `website/site/` static assets paths unchanged within the project.
- [x] Keep all existing routes and URLs (especially `/downloads/updates/*`, `/privacy/`, browser reviewer, EN/TR), matching security/cache behavior. No copied build output, `.env`, tokens, `.wrangler` state or separate Git history.
- [x] Run fresh `npm ci`, `npm run check`, and Wrangler dry-run from `website/`, plus product gates. Add minimal CI paths/build ownership for website in public repo without running the four-target product gates on website-only changes.
- [x] Migrate Cloudflare Workers Builds production source/root to the **public repo's `website/`**, preserving the existing Worker, Custom Domain, previews where supported and secret bindings. Confirm a real live deployment before cutting the previous site repo. No unverified downtime or duplicate Worker origin.

**Stage 2 acceptance (2026-10-27):** The 53 tracked site files live in the public `website/` (PR #294, merge `3bb440a`). Public website CI, CodeQL, full four-target product CI (26/26) and postmerge snapshot passed. The existing Cloudflare `equinox-local-site` Worker was **preserved**; only its Workers Builds repository connection was switched from `equinox-local-site/main` root `/` to `equinox-local/main` root `website/` (both production and preview). Public Worker build `c48056ca-c22b-4878-b335-0ae4082b6798` succeeded and deployed Worker version `630953c1-ef80-43ae-82e6-0f928c856194` with 100% traffic. The temporary hook used for the controlled first build was deleted. All four live signed manifests and both terminal installer scripts were compared byte-for-byte by SHA-256 to the public website checkout; eleven live EN/TR/privacy/reviewer/browser pages returned HTTP 200 with required security headers. Existing Worker and custom domain stayed online throughout. The two old repositories remain untouched as recoverable sources until later real-device and release-path acceptance.

### 3. Consolidate signed Main publication without exposing private signing
- [ ] Retire factory-only Stable numbered release publication as an update prerequisite. Public CI can build and validate the four platform artifacts for exact `main` SHA, but **private key operations remain on the Mac mini** or another trusted secret-free Git backend. Use the *existing* signing implementation with narrowly scoped invocation, not a new release framework.
- [ ] Publish a signed, SHA-addressed immutable artifact for each admitted Main revision, plus an atomic signed latest/Main pointer and four-target manifests at existing website URLs. Keep existing terminal bootstrap entrypoints/compatibility as transitional aliases.
- [ ] Refactor only required general-purpose non-secret helpers into the public repo. Update docs and dependencies in one place; remove obsolete Stable/Main-snapshot split and duplicated factory release jobs when their replacement is accepted.
- [ ] Prove source SHA integrity, detached signature, four native package hashes, site propagation, rollback metadata, interrupted publish resume and fail-closed behavior. GitHub manual `vX.Y.Z` Releases continue as explicit optional milestones, not update gates.

**Stage 3 cryptographic foundation (2026-10-27, pending PR acceptance):** The existing four Main snapshot JSON manifests, archives and R2 URLs are reusable without any new storage service or package-builder framework. Added one strict signed Main selector contract (`src/equinox-local-main-install-pointer.ts`) using the existing Ed25519 signing key model and existing native SHA/target/size validation, plus one private-key-file signer CLI (`scripts/release/sign-main-install-pointer.mts`) that reuses the current private 0600 externally owned signing-key reader. Offline validation with all four actual public R2 manifests and an **ephemeral disposable test key** passed, including signature tampering and untrusted/off-origin rejection. This is only a source contract and private signing *tool*, NOT a deployed signed latest pointer; the live install/update still uses current Stable bootstrap until the complete signer admission, R2 publication and both real-host acceptance tests pass.

### 4. Unify user-triggered installation/update/repair
- [ ] Audit macOS and Windows existing installers for semantic parity (Windows old Chrome Native Messaging host, stale processes, native executable retirement, user files, bounded cleanup; macOS developer/private identity).
- [ ] Have the Control Center Update action hand off to the same **external** shell/PowerShell installer artifact used by terminal bootstrap. UI displays verified progress/result and must not depend on old running Local runtime after takeover. No arbitrary command API on loopback; only fixed product-owned entrypoint and exact admitted manifest.
- [ ] Remove obsolete internal update coordination, A/B/Guardian update-specific code, unused UI states and retired tests **only after** the single-engine acceptance demonstrates exact safety. Preserve unrelated security services, app runtime and capabilities.
- [ ] Display `manual-version - short SHA` for existing user install and remote current verified SHA. SHA difference (not version number) determines Update availability. Preserve Chrome Web Store Browser extension update ownership.

### 5. Native and real-host acceptance (release gate)
- [ ] CI + CodeQL successful, macOS ARM64/x64 and Windows ARM64/x64 packaging and signed manifest validation. One integrated clean install, in-place update (healthy *and* stopped old version), same-SHA repair, intentionally interrupted/failing update with exact executable rollback, preserved user state, cleaned success backup.
- [ ] Physical user Windows acceptance with pre/post full SHA/version, native host and Chrome health, Control Center, and personal configuration preserved.
- [ ] Mac mini Factory Developer active installation updated via supported source/restart path, actual running PID exact expected SHA and System Doctor HEALTHY; private composition and credentials remain private. Call `restart_runtime` (not ad hoc service restart) and verify on a later turn.

### 6. Retire old repositories only after proof
- [ ] Once the public repo owns and serves the live site and one-engine signed Main updates, freeze old site and factory repos (stop their builds, automations/webhooks/permissions). Archive/export private history and private-only operational material **outside the public repository** for recovery.
- [ ] Verify no live runtime, domain/worker, key, signer or external automation depends on either old repo.
- [ ] Only then, with verified rollback plan, retire/delete predecessor GitHub repositories and obsolete machine checkouts. Keep *local* private Factory composition/Keychain/material and product runtime.
- [ ] Update README, AGENTS, architecture, public docs, private local operations index, task capsule, issues and working URLs. Remove stale references to independent Stable/Main update channels.

## Safe rollback and checkpoints

- Stage 2 **completed**: Cloudflare production now builds `website/` from public `main`, using the *same* existing Worker and domain. Preserve the original site repo (still readable) and an offline copy of the previous Builds connection settings for controlled rollback; do not route production back or delete the old Worker casually.
- Stage 3: existing stable/installer distribution remains the trusted fallback until the exact-SHA Main publish and signing gates are green.
- Stage 4: do not retire old updater entrypoints until single engine successfully updates and repairs both real platforms, then remove duplicate dead code in a bounded change.
- Never bypass the signed manifest identity/trust boundary to meet schedule. If any long process or service restart blocks or fails, checkpoint exact active commit, process and next action and stop safely.
