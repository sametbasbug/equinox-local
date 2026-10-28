# Contributing to Equinox Local

Thanks for taking an interest in Equinox Local. The project welcomes focused bug fixes, documentation improvements, and features that preserve its explicit local security boundaries.

## Canonical repository

`sametbasbug/equinox-local` owns the actual product source, platform/native code, installers, CI and CodeQL. Start product changes from this repository, use a focused `equinox/` branch and target `main` here. Outside contributors fork this repository directly. No private factory checkout, public projection/export, duplicate product commit or factory backport is required.

Private factory/ops tooling consumes accepted canonical source for maintainer-authorized publication; its credentials, machine configuration and history are outside this contribution boundary. Source ownership does not itself authorize a release or change users' update channel.

## Before you start

Equinox Local targets macOS and Windows on ARM64/x64. Use the pinned **Node.js 26.11.1** for development (see `src/equinox-local-runtime-versions.js` for release toolchain contracts). Windows native-shell work may additionally require the platform SDKs/tooling exercised in CI; ordinary users do not need those tools installed.

```bash
npm ci
npm run check
```

The maintainer has retired automated tests; do not add or execute test suites. Preserve native package admission, signing and production integrity checks.

Keep changes narrow enough to review. If a proposal changes a major product boundary, opening an issue first is usually more useful than arriving with a large implementation.

## Repository structure

- `src/` — Equinox Local runtime and Control Center source.
- `extension/` — Equinox Browser.
- `scripts/` — installer, packaging, and release tooling.
- `examples/` — generic configuration examples only.
- `docs/` — architecture and security documentation.

Machine-specific paths, credentials, private deployment profiles, and retired/private QA infrastructure do not belong in this repository.

## Pull requests

A pull request should:

1. explain the user-visible or security-relevant behavior being changed;
2. preserve production security and signed-release constraints;
3. keep normal packaging and native build contracts intact;
4. avoid unrelated formatting or refactors; and
5. update documentation when a public contract changes.

Please do not commit generated release archives, runtime secrets, local configuration, `node_modules`, or machine-specific paths.

## Product boundaries that should remain explicit

Contributions must not quietly weaken these rules:

- Equinox Browser is the only product browser transport; Agent Browser is the isolated default, Your Browser is explicit personal Chrome, and neither context may silently fall back to the other.
- Browser automation starts disabled until the user accepts the disclosure and enables control.
- Control Center stays loopback-only and does not expose an arbitrary command backend.
- Filesystem access follows the user's Full/selected Agent Access mode. Selected mode stays on configured roots; Full mode may use a contained home/absolute folder while filesystem root, credential/application-secret areas, traversal, and symlink escape remain blocked.
- Existing path containment, symlink defenses, revision/SHA guards, and mutation locks remain in force beneath both UI and agent operations.
- Stable update artifacts remain pinned to the Equinox Local HTTPS update origin and require a trusted Ed25519 signature.
- Optional integrations fail independently rather than becoming mandatory dependencies for core Local operation.

If a feature appears to require relaxing one of these rules, discuss the design first.

## Continuous integration

Product-impacting releases use exact-SHA native macOS/Windows package construction, production signing and CodeQL analysis. **Documentation/metadata-only changes** use a separate lightweight Docs workflow and do not advance the admitted `main-snapshot` runtime SHA. CI status is visible on each PR; do not publish a numbered Stable release from PR checks alone.

macOS/Windows ARM64 and x64 packages must each be built for the exact target source SHA. Do not reuse artifacts from another commit. See [architecture](docs/architecture.md) and [updates](docs/updates.md) for the detailed admission and rollback model.

## Automated tests

Automated tests, smoke and acceptance jobs have been removed by maintainer decision. Do not add new ones. This does not relax production signature, hash, platform or source-identity verification.

## Security reports

Do not file a public issue for an unpatched vulnerability. Follow [SECURITY.md](SECURITY.md).

## License

By submitting a contribution, you agree that your contribution is licensed under the repository's **AGPL-3.0-only** license.
