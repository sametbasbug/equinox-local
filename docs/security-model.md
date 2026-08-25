# Security Model

Equinox Local is designed around explicit local boundaries rather than an assumption that an agent should inherit everything the logged-in user can do.

This document describes product invariants, not a claim that the project is vulnerability-free.

## Trust boundaries

### The human user

The local macOS user is the authority that configures project roots, enables browser automation, connects AI/services, starts updates, and chooses whether to uninstall local data.

### The AI client

An AI client receives the operation surface exposed by Equinox Local. It does not receive a generic Control Center shell endpoint or automatic access to arbitrary filesystem roots.

### Connected providers

If the user connects an external AI or service provider, task-relevant data may be sent to that provider as part of the requested action. Equinox Local does not make a third-party provider equivalent to the local trust boundary.

## Filesystem containment

Configured projects and file roots are canonicalized and bounded. Security-sensitive filesystem operations defend against:

- lexical traversal outside the selected root;
- symlinked files/directories where a normal file is required;
- root replacement or duplicate configured roots;
- unsupported writable extra roots;
- oversized reads, transfers, screenshots, archives, or update artifacts; and
- stale writes where an expected content SHA/revision is required.

The whole home directory is not implicitly an agent root.

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

Equinox Browser is the only product route into user Chrome.

A fresh extension install keeps automation off until the user accepts the current browser-data disclosure. Turning control off causes browser automation commands to be rejected; the local settings channel may remain connected so status/settings stay manageable.

The Native Messaging path binds the expected host/extension relationship, and browser filesystem handoff is separately checked before Local exposes downloaded/uploaded files to an agent operation.

Internal release/QA Chrome profiles are not a fallback and are excluded from the public capability surface.

## Mutation concurrency

Operations that can conflict acquire bounded mutation scopes/locks. Stable gateway calls delegate to the original guarded handler instead of taking a second independent mutation path.

Git operations additionally use branch, clean-worktree, remote HEAD, worktree ownership, and expected-SHA guards where appropriate.

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

The public product does not expose internal QA-browser repair recipes.

## Optional desktop control

Peekaboo is optional. Equinox Local presents a reduced allowlist rather than forwarding its entire downstream tool catalog. Broad/destructive keyboard, browser, clipboard, force-quit, and arbitrary path behavior is intentionally blocked.

## Security regression rule

A change that weakens one of these boundaries should be treated as a product-security change and should include explicit tests plus documentation updates.
