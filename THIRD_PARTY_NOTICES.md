# Third-party components

Equinox Local downloads and pins third-party runtimes instead of vendoring their source trees.

- **Node.js** — pinned by version and SHA-256; its upstream `LICENSE` is copied from the downloaded distribution into packaged releases.
- **OpenAI tunnel-client** — pinned by version and SHA-256; upstream license/SPDX files are copied from the downloaded release archive.
- **Peekaboo** — pinned by version and SHA-256 on macOS; its upstream license is preserved from the downloaded release archive.
- **Microsoft winapp CLI** — pinned by version and SHA-256 on Windows. Its release archive does not carry the project license, so the upstream MIT license text is kept at `licenses/microsoft-winapp-cli.txt` and copied into the packaged winapp runtime.

Package-manager dependencies and their licenses are described by `package.json` / `package-lock.json` and the corresponding installed packages.
