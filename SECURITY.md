# Security Policy

Equinox Local is a local control plane with intentionally security-sensitive boundaries around files, Git, browser automation, management APIs, updates, and optional desktop control.

## Reporting a vulnerability

Please **do not open a public issue for an unpatched vulnerability**.

Report security issues privately through [GitHub Security Advisories](https://github.com/sametbasbug/equinox-local/security/advisories/new) (preferred), or by email to **iletisim@sametbasbug.dev**, with:

- the affected Equinox Local / Equinox Browser version or commit;
- the operating-system and architecture involved;
- the boundary you believe can be bypassed;
- minimal reproduction steps or a proof of concept; and
- any known prerequisites or user interaction required.

Do not include real credentials, private project contents, or unrelated personal data in a report. A synthetic reproduction is strongly preferred.

## High-value security boundaries

Reports are especially useful when they demonstrate a concrete bypass of one of these guarantees:

- Control Center is reachable only through loopback and rejects unsafe Host/origin patterns.
- Control Center mutations require the intended same-origin/CSRF flow and bounded request bodies.
- Agents cannot escape the active Full/selected filesystem boundary through filesystem-root access, protected-secret paths, traversal or symlink tricks.
- Guarded mutations cannot bypass expected revision/SHA checks or mutation ownership rules.
- Equinox Browser cannot perform browser automation before consent/control is enabled.
- Equinox Browser is the only browser transport; Agent Browser and Your Browser remain explicit isolated contexts with no silent fallback, and the retired legacy QA-browser backend cannot reappear as an alternate route.
- Native Messaging cannot be rebound to an unexpected extension/origin or unsafe host path.
- Production Main selectors and native archives cannot be accepted without the trusted Ed25519 signature, pinned HTTPS origin and exact expected artifact SHA-256/source identity.
- An unauthenticated or unhealthy replacement cannot be reported as successfully installed; guarded recovery must preserve the user’s settings and personal state.
- Detached helpers do not inherit provider credentials or arbitrary command arguments.
- Optional desktop control must respect the documented, bounded platform-specific Peekaboo (macOS) or winapp (Windows) automation surface.

## Out of scope

The following are generally not vulnerabilities by themselves:

- a user explicitly granting an agent access to a project that contains sensitive files;
- behavior of a third-party AI provider after the user intentionally connects it;
- attacks requiring prior arbitrary code execution as the same logged-in operating-system user, unless they cross a documented Equinox Local protection boundary;
- denial of service that only terminates a user-owned local process without persistence, privilege escalation, or boundary bypass;
- findings against internal/private release infrastructure that is not shipped in the public source or managed release.

## Automated security scanning

The public repository runs a GitHub CodeQL workflow for JavaScript/TypeScript using the `security-extended` query suite alongside four-target macOS and Windows ARM64/x64 native package validation. Private factory/release infrastructure is kept outside the public source boundary rather than relying on a private-publication staging mode for security coverage.

CodeQL supplements the explicit product security checks, signature verification, and static/type/native-build gates; it cannot by itself prove runtime security.

## Development rules for security-sensitive changes

Security-sensitive changes must preserve security invariants and pass the existing static, type and native distribution checks. The maintainer has removed automated test suites and prohibits adding new ones. Before submitting:

```bash
npm ci
npm run check
npm run typecheck
```

Do not solve a UX problem by adding a generic shell endpoint, broad filesystem root, silent browser fallback, credential-bearing helper environment, or unverified update path.

For the architecture behind these rules, see [docs/security-model.md](docs/security-model.md).
