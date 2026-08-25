# Security Policy

Equinox Local is a local control plane with intentionally security-sensitive boundaries around files, Git, browser automation, management APIs, updates, and optional desktop control.

## Reporting a vulnerability

Please **do not open a public issue for an unpatched vulnerability**.

Report security issues to **iletisim@sametbasbug.dev** with:

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
- Agents cannot escape configured project/file roots through traversal or symlink tricks.
- Guarded mutations cannot bypass expected revision/SHA checks or mutation ownership rules.
- Equinox Browser cannot perform browser automation before consent/control is enabled.
- User Chrome is controlled only through Equinox Browser; internal development/QA browser infrastructure is not a product fallback.
- Native Messaging cannot be rebound to an unexpected extension/origin or unsafe host path.
- Managed update manifests cannot be accepted without a trusted Ed25519 signature and pinned update origin.
- A failed managed update cannot silently replace the last verified healthy release.
- Detached helpers do not inherit provider credentials or arbitrary command arguments.
- Optional desktop control cannot escape the documented reduced Peekaboo allowlist.

## Out of scope

The following are generally not vulnerabilities by themselves:

- a user explicitly granting an agent access to a project that contains sensitive files;
- behavior of a third-party AI provider after the user intentionally connects it;
- attacks requiring prior arbitrary code execution as the same macOS user, unless they cross a documented Equinox Local protection boundary;
- denial of service that only terminates a user-owned local process without persistence, privilege escalation, or boundary bypass;
- findings against internal/private release infrastructure that is not shipped in the public source or managed release.

## Automated security scanning

The public repository includes a GitHub CodeQL workflow for JavaScript/TypeScript using the `security-extended` query suite. The workflow is intentionally skipped while the publication-staging repository is private and becomes active when the repository is public, in addition to the normal macOS CI/test suite.

CodeQL is a supplement to the explicit security-boundary tests in this repository, not a replacement for them.

## Development rules for security-sensitive changes

Security-boundary changes should include regression coverage. Before submitting:

```bash
npm ci
npm run check
npm test
```

Do not solve a UX problem by adding a generic shell endpoint, broad filesystem root, silent browser fallback, credential-bearing helper environment, or unverified update path.

For the architecture behind these rules, see [docs/security-model.md](docs/security-model.md).
