<div align="center">
  <img src="assets/equinox-browser.png" alt="Equinox Local" width="128" height="128">

# Equinox Local

**A local control plane for AI agents — powerful enough to do real work, bounded enough to stay understandable.**

**Built to let ChatGPT on the web safely work with your own Mac — through explicit, inspectable local capabilities instead of an unrestricted remote shell.**

[![CI](https://github.com/sametbasbug/equinox-local/actions/workflows/ci.yml/badge.svg)](https://github.com/sametbasbug/equinox-local/actions/workflows/ci.yml)
![macOS](https://img.shields.io/badge/platform-macOS-111111?logo=apple)
![Node.js 24](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)
![Tests](https://img.shields.io/badge/tests-292%20passing-2ea44f)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

[Product site](https://local.sametbasbug.dev/) · [Security](SECURITY.md) · [Architecture](docs/architecture.md) · [Contributing](CONTRIBUTING.md)
</div>

> **Stable releases:** Apple Silicon and Intel macOS builds are published through the signed stable update channel. Every release must pass public-source CI/CodeQL, native architecture validation, managed smoke, signing verification, and live-channel checks before it is promoted from prerelease to stable.

## What is Equinox Local?

Equinox Local runs on your Mac and gives an AI client a deliberately bounded way to work with local projects, Git, browser automation, workflows, diagnostics, and optional desktop control. A native macOS **Equinox Local** app opens Control Center for the human while the management backend remains private on loopback, without requiring source edits or a pile of terminal commands.

The goal is not to turn your computer into an unrestricted remote shell. The goal is to expose useful, inspectable capabilities with explicit roots, fixed operations, guarded mutations, and clear user controls.

### The short version

| Surface | Boundary |
| --- | --- |
| Projects & files | Full access by default on fresh installs or selected-root mode, with credential-area, path, symlink and SHA guards |
| Git | Project-scoped operations with branch/SHA/worktree guards |
| Equinox Browser | The only product route into user Chrome; Native Messaging + visible consent/on-off control |
| Control Center | Native macOS app backed by the loopback-only UI/API on `127.0.0.1:24891` |
| Updates | Ed25519-signed metadata, bounded downloads, verified activation, automatic rollback |
| Desktop | Optional Peekaboo bridge with a deliberately reduced allowlist |
| Telegram | Optional Bot API delivery with a private local credential; agents receive only a send operation |
| Agent API | Stable MCP gateways backed by a dynamic capability registry |

## Why build another local agent runtime?

Agent tooling often optimizes for either **maximum capability** or **maximum safety through limitation**. Equinox Local tries to make the boundary itself a product surface:

- **Agent-friendly:** structured capabilities, persistent workflows, runtime diagnostics, Git and browser primitives.
- **Human-friendly:** a real English/Türkçe Control Center for health, projects, permissions, browser state, updates, and uninstall.
- **Local-first:** project data and runtime state live on the user's machine unless a requested action needs a connected AI/service provider.
- **No arbitrary HTTP command console:** Control Center uses bounded management endpoints rather than a generic shell backend.
- **One user-Chrome route:** Equinox Browser is the only product browser-automation lane. Internal release/QA browsers are not exported as product capabilities.
- **Failure-aware:** health checks, repair recipes, recovery policies, update rollback, and bounded runtime observability are built in rather than bolted on later.

## Architecture

```mermaid
flowchart LR
    H[Human] --> APP[Equinox Local.app]
    APP --> CC[Control Center\n127.0.0.1:24891]
    A[AI client] --> MCP[Stable MCP gateways]
    CC --> CORE[Equinox Local capability layer]
    MCP --> CORE

    CORE --> FILES[Projects & files]
    CORE --> GIT[Git & workflows]
    CORE --> RUNTIME[Diagnostics & recovery]
    CORE --> PEEK[Optional desktop bridge]

    CHROME[User Chrome] <--> EXT[Equinox Browser]
    EXT <--> NM[Native Messaging]
    NM <--> CORE

    CORE --> UPDATE[Signed Local updater\nhealth check + rollback]
```

See [docs/architecture.md](docs/architecture.md) for the longer version.

## Equinox Browser

Equinox Browser is the companion Chrome extension and the **only product path that controls the user's Chrome profile**. Install the unlisted production extension from [Chrome Web Store](https://chromewebstore.google.com/detail/equinox-browser/npdneefcobilfkjlihghjgjnknenhfoj). Control Center also links directly to the same Store listing from onboarding, the Browser page and Integrations so users do not have to hunt through this README. A fresh extension install starts with browser automation disabled until the user accepts the browser-data disclosure and explicitly enables control.

The extension intentionally has no broad `host_permissions`; browser actions are performed through Chrome's documented debugger interface and a local Native Messaging bridge. Turning browser control off rejects browser-automation commands while allowing the bounded settings channel to remain available.

More: [docs/browser.md](docs/browser.md)

## Installation

Install the current stable Equinox Local release as your normal macOS user:

```bash
curl -fsSL https://local.sametbasbug.dev/downloads/updates/install-equinox-local.sh | /bin/bash
```

The public path is a small user-level macOS bootstrap that:

1. refuses `sudo`/root execution;
2. detects Apple Silicon vs Intel;
3. downloads only from the pinned Equinox Local HTTPS update path;
4. verifies exact release byte count and SHA-256 before extraction;
5. installs the self-contained managed runtime under the user's Library;
6. registers the per-user LaunchAgent and Equinox Browser Native Messaging host; and
7. installs the native `Equinox Local.app` shell and opens it for onboarding.

It does **not** require Git, Homebrew, a system Node installation, a separate Peekaboo installation, administrator authentication, or a paid Apple Developer membership. The managed release bundles its verified Peekaboo desktop runtime alongside the pinned Node and tunnel runtimes.

Current installation status is maintained at [local.sametbasbug.dev/install](https://local.sametbasbug.dev/install/).

Fresh managed installs start Agent Access in **Full** mode for normal files/projects, Terminal/processes, Desktop automation and the Equinox Browser lane. Users can narrow file access to selected configured roots or disable individual execution/automation capabilities from Control Center. Full file access is not equivalent to unrestricted secrets access: known credential/application-secret areas, filesystem-root access and symlink escape remain blocked by the structured file surface.

Core structured file create/read/hash/move/delete/write operations work on ordinary non-Git folders in Full mode, so agents do not need to fall back to Terminal just because a working folder is not a Git repository. Git-specific ignore/dirty-worktree protections are added only when the active root is actually a Git repository.

### Connect Equinox Local to ChatGPT

Equinox Local runs on your Mac, while ChatGPT connects to remote MCP endpoints. To bridge the two without exposing a local port to the public internet, Equinox Local uses OpenAI Secure MCP Tunnel.

You need **two separate values** from OpenAI Platform:

1. **Tunnel ID** — open [Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels), create a tunnel for the ChatGPT workspace that should use Equinox Local, then copy its `tunnel_…` identifier.
2. **Runtime API key** — open [Platform → API keys](https://platform.openai.com/settings/organization/api-keys), create a **Restricted** runtime key and grant only **Tunnels: Read + Use**. Do not use an admin key or Tunnels: Manage for the long-lived Local runtime.

After the managed Local install finishes:

1. Open **Equinox Local** from Applications or Spotlight. The app renders Control Center from the private loopback service; `http://127.0.0.1:24891/` remains available as a development/diagnostic fallback.
2. In **Connect to ChatGPT**, paste the Tunnel ID and Runtime API key.
3. Choose **Save & connect**. Equinox Local stores the key only in a private `0600` file on this Mac and schedules a safe restart into tunnel mode.
4. In ChatGPT, enable the custom-app/developer-mode flow available to your plan/workspace, create or edit the MCP app/connector, choose **Connection: Tunnel**, and select or paste the **same Tunnel ID**.
5. Scan/refresh the app tools after the tunnel is connected.

The tunnel client makes an outbound HTTPS connection to OpenAI; Equinox Local does not need an inbound firewall rule or a public MCP port. If the tunnel does not appear in ChatGPT, verify that it was created for the correct workspace and that the relevant principal has **Tunnels Read + Use**. Newly created tunnels may also take a short time to become available.

See [docs/tunnel.md](docs/tunnel.md) for the full setup and troubleshooting path. ChatGPT plan/workspace support for custom MCP apps and write/modify actions is controlled by OpenAI and may change independently of Equinox Local.

### Optional Telegram delivery

Stable Equinox Local releases include an optional Telegram Bot API integration for completion/fallback messages. In Control Center → **Integrations**, enter a bot token and **Your Telegram ID**, then choose **Connect & test**. The ID must identify a private Telegram user account; group, supergroup, and channel targets are deliberately rejected. Open the bot chat and send it a message first so the bot is allowed to contact the account.

The token and fixed recipient ID are stored only on the Mac in Equinox Local's private `secrets` directory with `0600` file permissions. Control Center status, MCP results, and the agent-facing operation never return either secret value. Agents use the existing Services & integrations gateway to invoke `telegram_send_message`; the operation accepts only message text, so an agent cannot choose or override the recipient. Equinox Local exposes no Telegram inbox/read operation, so messages sent to the bot by other Telegram users are not surfaced to agents. Delivery is plain text and long messages are split into bounded Telegram-safe chunks.

## Updates

After first install, Local manages its own update lifecycle. Stable release manifests are signed with an offline/external Ed25519 key whose public half is pinned into the runtime. Before activation Local verifies the download, stages a versioned release, performs a controlled restart, checks the expected version/health, and restores the previous release if activation fails.

Equinox Browser updates remain owned by Chrome Web Store; the Local updater never overwrites or sideloads the extension.

More: [docs/updates.md](docs/updates.md)

## Repository layout

```text
.
├── src/               # Equinox Local runtime and Control Center source
├── extension/         # Equinox Browser Chrome extension
├── tests/             # Unit, browser, fixture, helper, and release tests
├── scripts/           # Local tooling, installer, Browser packaging, release tooling
├── examples/          # Generic configuration examples
├── docs/              # Architecture and security documentation
├── assets/            # Repository artwork
└── .github/           # CI and contribution templates
```

Tests live under `tests/` on purpose: they remain part of the public trust story without turning the repository root into a wall of `*.test.js` files.

## Development

### Requirements

- macOS
- Node.js **24.20.0 or newer**
- npm
- Git

```bash
npm ci
npm run check
npm test
```

The public test suite currently contains **292 passing tests** covering browser consent/lifecycle, Agent Access and credential boundaries, structured file operations, Control Center request boundaries, managed install/update/rollback/uninstall, source-runtime synchronization, workflows, repair/recovery, Native Messaging, and runtime observability.

Source-checkout runtime configuration is intentionally external. Start with [examples/equinox-local-config.example.json](examples/equinox-local-config.example.json) and keep real machine paths/credentials out of the repository. The source restart path synchronizes both the development tunnel client and pinned Peekaboo runtime from the same version/SHA/signing policy used by managed release packaging; System Doctor reports version drift without exposing configured executable paths.

## Security model

Security-sensitive design choices are documented rather than hidden behind implementation detail. Highlights include:

- loopback-only Control Center;
- strict Host/origin/CSRF handling for management mutations;
- user-controlled Full/selected filesystem modes with path containment and protected credential/application-secret areas;
- symlink defenses and expected-SHA guards where mutations need them;
- mutation scopes/locks around competing operations;
- minimal credential-free environments for detached helpers;
- no browser automation before explicit Equinox Browser consent;
- bounded logs/artifacts and redaction before observability persistence;
- signed managed updates with health-verified rollback.

Read [SECURITY.md](SECURITY.md) and [docs/security-model.md](docs/security-model.md) before changing a security boundary.

## Contributing

Issues and focused pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first. Changes that weaken a boundary for convenience — for example adding an arbitrary Control Center command endpoint or a fallback into user Chrome — will not be accepted.

## License

Equinox Local is licensed under the **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`). See [LICENSE](LICENSE).

Copyright © 2026 Samet Başbuğ.
