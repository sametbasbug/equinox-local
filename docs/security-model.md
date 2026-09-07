# Security Model

Equinox Local is designed around user-controlled local boundaries. A fresh install starts with broad useful Agent Access, while the human can narrow filesystem, Terminal/process, Desktop and Browser capabilities without giving the management API arbitrary command authority.

This document describes product invariants, not a claim that the project is vulnerability-free.

## Trust boundaries

### The human user

The local macOS user is the authority that chooses Agent Access mode, configures convenient project/file-root shortcuts, enables or disables local execution/Desktop/Browser automation, connects AI/services, starts updates, and chooses whether to uninstall local data.

### The AI client

An AI client receives the operation surface exposed by Equinox Local. It does not receive a generic Control Center shell endpoint. Root-aware structured capabilities remain governed by Full/Selected root policy, while ordinary local file/repo/Git/package-manager work is terminal-first. Terminal is a separate Agent Access capability: when enabled, it runs as the logged-in macOS user and is not a selected-root filesystem sandbox after the shell starts. Users who require strict selected-root containment must disable Terminal. Equinox-managed provider credentials are not injected into generic Terminal/process environments. Noninteractive `terminal_exec` commands start under the same managed-process lifecycle used by background processes: a bounded foreground wait never kills or restarts unfinished work, and continuation returns the same process ID/cursor for later logs or explicit stop. Interactive PTY stop/shutdown tracks jobs observed on that private controlling TTY instead of assuming that killing only the shell PID also killed zsh background process groups. This is lifecycle ownership, not a sandbox: commands that deliberately detach outside their owned process group/TTY are outside the generic Terminal cleanup contract and should not be used as the managed background-service path.

### Connected providers

If the user connects an external AI or service provider, task-relevant data may be sent to that provider as part of the requested action. Equinox Local does not make a third-party provider equivalent to the local trust boundary.

## Filesystem containment

Filesystem roots are canonicalized and bounded. Selected mode resolves only through configured projects/file roots; Full mode may resolve `home` or an accessible absolute folder as an ad-hoc root. Security-sensitive filesystem operations defend against:

- direct filesystem-root access;
- protected credential/application-secret areas when using ad-hoc Full roots;
- lexical traversal outside the active root;
- symlinked files/directories where a normal file is required;
- root replacement or duplicate configured roots;
- unsupported writable extra roots;
- oversized reads, transfers, screenshots, archives, or update artifacts; and
- stale writes where an expected content SHA/revision is required.

Recursive file discovery skips protected areas in ad-hoc Full roots rather than traversing through them. A hidden directory is not sensitive merely because its name starts with a dot: agent workspaces such as `.codex`, `.openclaw` and `.claude` remain accessible in Full mode, while their known authentication/credential subpaths stay protected. Explicitly configured roots remain usable even when they live under Equinox Local's own managed Application Support tree.

## Management API

Control Center binds to `127.0.0.1` and exposes fixed management routes. Relevant protections include:

- strict loopback bind validation;
- Host validation against DNS-rebinding-style requests;
- no permissive CORS bridge;
- same-origin mutation checks;
- session CSRF token requirements;
- bounded request bodies and supported content types only;
- no query-bearing mutation shortcuts; and
- revision guards for configuration replacement.

The management API intentionally does not expose a generic command/shell endpoint.

## Browser boundary

Equinox Browser is the only product browser transport. Agent Browser is the isolated default context and Your Browser is explicit personal Chrome; the two contexts never silently fall back to each other.

A fresh extension install keeps automation off until the user accepts the current browser-data disclosure. Turning control off causes browser automation commands to be rejected; the local settings channel may remain connected so status/settings stay manageable.

The Native Messaging path binds the expected host/extension relationship, and browser filesystem handoff is separately checked before Local exposes downloaded/uploaded files to an agent operation.

The legacy separate release/QA Chrome backend is retired. Release/visual QA uses Agent Browser through the same first-party extension/Native Messaging path rather than a hidden alternate browser route.

## Mutation concurrency

Operations that can conflict acquire bounded mutation scopes/locks. Stable gateway calls delegate to the original guarded handler instead of taking a second independent mutation path.

Credential-backed GitHub and release operations additionally use branch, clean-worktree, remote HEAD, check-state, worktree-ownership, and expected-SHA guards where appropriate. Ordinary local Git runs through Terminal and remains subject to repository policy rather than a dedicated wrapper API.

## Detached helpers

Restart, update activation, and uninstall helpers receive small explicitly constructed environments. Provider/API credentials from the parent process are not blindly inherited. Helper arguments are fixed/bounded product operations rather than user-supplied command lines.

## Managed updates

The stable update channel uses Ed25519 signatures. The public key is shipped with Local; the signing private key is external to both the repository and the uninstallable Local application-data root.

Before activation, Local verifies:

1. the stable manifest signature and key ID;
2. the pinned HTTPS update origin/path;
3. the target architecture;
4. artifact byte count and SHA-256;
5. archive/tree safety; and
6. release metadata/runtime expectations.

Activation is versioned and health-checked. If the requested new version fails health/version verification, Local restores the previous release and verifies the rollback target.

Equinox Browser is updated by Chrome Web Store, not by the Local updater.

## Runtime observability

Runtime events are bounded and rotated. Credential-like values and authorization material are redacted before persistence. Public health/status responses summarize bounded state rather than exposing raw secret-bearing process environments or arbitrary log files.

## Automatic repair and recovery

Repair recipes are fixed operations. They re-check incident/current ownership before mutation and verify the result after mutation. Automatic recovery policies are similarly fixed, bounded, and circuit-breaker protected.

Legacy QA-browser repair recipes were retired with that backend; the public product contains no alternate QA-browser recovery path.

## Optional desktop control

Peekaboo is optional. Equinox Local presents a reduced allowlist rather than forwarding its entire downstream tool catalog. Broad/destructive keyboard, browser, clipboard, force-quit, and arbitrary path behavior is intentionally blocked.

## Security regression rule

A change that weakens one of these boundaries should be treated as a product-security change and should include explicit tests plus documentation updates.
