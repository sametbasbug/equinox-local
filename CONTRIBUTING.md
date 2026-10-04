# Contributing to Equinox Local

Thanks for taking an interest in Equinox Local. The project welcomes focused bug fixes, tests, documentation improvements, and features that preserve its explicit local security boundaries.

## Canonical repository

`sametbasbug/equinox-local` owns the actual product source, public tests, platform/native code, installers, CI and CodeQL. Start product changes from this repository, use a focused `equinox/` branch and target `main` here. Outside contributors fork this repository directly. No private factory checkout, public projection/export, duplicate product commit or factory backport is required.

Private factory/ops tooling consumes accepted canonical source for maintainer-authorized publication; its credentials, machine configuration and history are outside this contribution boundary. Source ownership does not itself authorize a release or change users' update channel.

## Before you start

Equinox Local currently targets macOS. Use Node.js 26.10.0 or newer.

```bash
npm ci
npm run check
npm run test:fast
```

Use the fast profile for normal local iteration. Run the full `npm test` suite before release/publication and when changing release/install/update/native-lifecycle behavior.

Keep changes narrow enough to review. If a proposal changes a major product boundary, opening an issue first is usually more useful than arriving with a large implementation.

## Repository structure

- `src/` — Equinox Local runtime and Control Center source.
- `extension/` — Equinox Browser.
- `tests/` — public unit/browser/release coverage.
- `scripts/` — installer, packaging, and release tooling.
- `examples/` — generic configuration examples only.
- `docs/` — architecture and security documentation.

Machine-specific paths, credentials, private deployment profiles, and retired/private QA infrastructure do not belong in this repository.

## Pull requests

A pull request should:

1. explain the user-visible or security-relevant behavior being changed;
2. include regression coverage when behavior changes;
3. keep `npm run check` and `npm run test:fast` green during iteration, and the full `npm test` suite green before release/publication;
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

CI and CodeQL run on both pull requests and `main`. The complete macOS test suite, Windows x64 acceptance and native ARM64 acceptance remain enabled for every change; no path-based skips or reuse of a different commit's successful checks is involved.

Native ARM64 runtime, packaged Desktop/UIA and real public-installer acceptance start on independent runners. The package and installer lanes use the same maintained composite preparation action to install locked native dependencies and build and validate their own exact-checkout managed ZIP. A bounded second package build removes the serial artifact dependency and keeps preparation and installation on the same runner; each consumer still checks its prepared ZIP's SHA-256 and byte count before acceptance. No package from another run or previously successful commit is reused.

The existing `Windows ARM64 foundation / Node 26` and `Windows x64 headless / Node 26` check names remain fail-closed aggregate gates: a failed, cancelled or skipped acceptance lane cannot produce a successful aggregate. npm and architecture-scoped NuGet caches save downloads; dependency installation, native builds and smoke tests still execute.

## Tests

Tests intentionally live under `tests/` rather than beside every source file. Add new coverage to the closest existing category:

- `tests/unit/`
- `tests/browser/`
- `tests/release/`
- `tests/fixtures/`

The root test runner discovers `*.test.js` recursively. `npm run test:fast` selects the unit/browser profile; `npm test` includes release coverage as well.

## Security reports

Do not file a public issue for an unpatched vulnerability. Follow [SECURITY.md](SECURITY.md).

## License

By submitting a contribution, you agree that your contribution is licensed under the repository's **AGPL-3.0-only** license.
