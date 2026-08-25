# Contributing to Equinox Local

Thanks for taking an interest in Equinox Local. The project welcomes focused bug fixes, tests, documentation improvements, and features that preserve its explicit local security boundaries.

## Before you start

Equinox Local currently targets macOS. Use Node.js 24.19.0 or newer.

```bash
npm ci
npm run check
npm test
```

Keep changes narrow enough to review. If a proposal changes a major product boundary, opening an issue first is usually more useful than arriving with a large implementation.

## Repository structure

- `src/` — Equinox Local runtime and Control Center source.
- `extension/` — Equinox Browser.
- `tests/` — public unit/browser/release coverage.
- `scripts/` — installer, packaging, and release tooling.
- `examples/` — generic configuration examples only.
- `docs/` — architecture and security documentation.

Machine-specific paths, credentials, private deployment profiles, and internal QA infrastructure do not belong in this repository.

## Pull requests

A pull request should:

1. explain the user-visible or security-relevant behavior being changed;
2. include regression coverage when behavior changes;
3. keep `npm run check` and `npm test` green;
4. avoid unrelated formatting or refactors; and
5. update documentation when a public contract changes.

Please do not commit generated release archives, runtime secrets, local configuration, `node_modules`, or machine-specific paths.

## Product boundaries that should remain explicit

Contributions must not quietly weaken these rules:

- Equinox Browser is the only product route into the user's Chrome profile.
- Browser automation starts disabled until the user accepts the disclosure and enables control.
- Control Center stays loopback-only and does not expose an arbitrary command backend.
- Filesystem access starts from configured allowlisted roots.
- Existing path containment, symlink defenses, revision/SHA guards, and mutation locks remain in force beneath both UI and agent operations.
- Stable update artifacts remain pinned to the Equinox Local HTTPS update origin and require a trusted Ed25519 signature.
- Optional integrations fail independently rather than becoming mandatory dependencies for core Local operation.

If a feature appears to require relaxing one of these rules, discuss the design first.

## Tests

Tests intentionally live under `tests/` rather than beside every source file. Add new coverage to the closest existing category:

- `tests/unit/`
- `tests/browser/`
- `tests/release/`
- `tests/fixtures/`

The root test runner discovers `*.test.js` recursively.

## Security reports

Do not file a public issue for an unpatched vulnerability. Follow [SECURITY.md](SECURITY.md).

## License

By submitting a contribution, you agree that your contribution is licensed under the repository's **AGPL-3.0-only** license.
