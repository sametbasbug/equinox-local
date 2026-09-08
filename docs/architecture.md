# Architecture

Equinox Local is a per-user macOS control plane that exposes bounded local capabilities to AI clients while giving the human a native macOS Control Center backed by a private loopback management service.

## Main surfaces

```mermaid
flowchart TB
    subgraph Human
      APP[Equinox Local.app]
      CC[Control Center\n127.0.0.1:24891]
      APP --> CC
    end

    subgraph Agent
      CLIENT[AI / MCP client]
      GW[Stable MCP gateways]
    end

    CC --> CORE[Shared capability + configuration layer]
    CLIENT --> GW --> CORE

    CORE --> TERM[Terminal / processes]
    CORE --> FILES[Projects / assets]
    CORE --> GIT[GitHub]
    CORE --> WF[Release automation]
    CORE --> OBS[Observability / diagnosis / repair]
    CORE --> DESKTOP[Optional Peekaboo bridge]
    CORE --> TELEGRAM[Optional Telegram Bot API]

    subgraph Browser
      AGENT[Agent Browser\nisolated profile]
      USER[Your Browser\npersonal Chrome]
      EXT[Equinox Browser]
      HOST[Native Messaging host]
      AGENT <--> EXT
      USER <--> EXT
      EXT <--> HOST
    end

    HOST <--> CORE
    CORE --> UPDATER[Managed updater]
```

The human UI and agent surface intentionally converge on the same configuration and operation layer rather than implementing separate privileged backends.

## Configuration

Machine-specific project roots live outside the repository in the user's Equinox Local configuration. The loaded registry defines:

- projects and their filesystem-root shortcuts;
- read-only extra file roots;
- Agent Access (`files: full|selected`, Terminal/process, Desktop and Browser switches);
- the default project;
- the managed workspace project;
- the downloads root; and
- Control Center enablement/port.

Fresh managed configs explicitly seed Full Agent Access. Existing configs that predate `agentAccess` normalize to selected-root filesystem behavior so an update does not silently widen prior boundaries. The configuration parser rejects unknown fields, unsafe IDs, duplicate configured roots, filesystem-root configuration, non-boolean capability switches and unsupported writable extra roots.

## Stable MCP surface

The top-level MCP API stays intentionally small. Each domain exposes discovery plus invocation through a capability registry. Operation schemas are validated at invocation time, while the underlying operation handler retains its original project context, mutation locks, path guards, and error semantics.

This lets the runtime gain new operations without turning every operation into a permanently cached top-level MCP schema.

## Terminal, project discovery, and GitHub

Root-aware structured capabilities resolve through the active Agent Access file mode. Selected mode uses configured roots; Full mode can use configured IDs, `home`, or an accessible absolute folder as the active contained root. Direct filesystem-root access and protected credential/application-secret areas are blocked for ad-hoc Full roots, and traversal/symlink escape is rejected in both modes. The retained Files gateway is limited to project/root discovery. Terminal/process is the terminal-first path for ordinary local file/repo/Git/GitHub/package-manager work and intentionally follows the logged-in macOS user's shell permissions; once a shell starts it is not confined to Selected roots. Generic execution environments are sanitized so Equinox-managed provider credentials are not inherited; GitHub PR/Actions work may use the user’s separately authenticated system-keyring `gh` CLI without token injection. `terminal_exec` starts each noninteractive zsh command once under the managed-process lifecycle: it waits for a bounded foreground response window, preserves stdout/stderr plus observed combined ordering, and returns the same process ID/cursor when work continues instead of killing or restarting it. Explicit long-lived non-PTY servers/watchers may start directly with `process_*`. PTY sessions keep their interactive shell semantics while Local tracks the controlling TTY's owned jobs so explicit stop/shutdown can drain jobs that zsh placed into separate process groups.

Ordinary local Git/worktree commands run through Terminal and follow repository policy rather than a dedicated wrapper surface. The retained GitHub gateway contains credential-backed PR/Actions operations with explicit SHA/branch/check guards. Provider credentials remain outside generic Terminal, and the Control Center management API exposes no arbitrary Git or shell endpoint.

## Equinox Browser

Equinox Browser is the only product browser transport. It serves two explicit Chrome contexts behind the same extension, Native Messaging host and local bridge: **Agent Browser** is the default isolated Equinox Local profile (`target=agent`), while **Your Browser** is the user's personal Chrome profile and must be selected explicitly (`target=user`). The two contexts keep independent Chrome/profile state and Equinox Local never silently falls back from one to the other.

Browser-control consent and the on/off state live independently in each extension profile. Equinox Local cannot silently enable control before the current disclosure has been accepted. Agent Browser bookmark automation is intentionally isolated to `target=agent`; Your Browser bookmark calls fail closed before the bridge and in the extension.

The retired loopback/CDP QA browser is not part of the product architecture. Release and visual QA use the same first-party Agent Browser extension/Native Messaging lane rather than a second isolated browser backend.

## Control Center

The normal human entry point is the native `Equinox Local.app`, a small AppKit + WKWebView shell that renders Control Center from `127.0.0.1:24891`. The loopback URL remains usable for development and diagnostics, while the app keeps the browser address bar out of the product experience. Control Center itself is served by the runtime with fixed routes and same-origin assets; it is not a general static-file server. Mutations use validated JSON, same-origin checks, CSRF protection, and expected-revision guards where configuration changes are involved.

Optional service integrations keep credentials outside the public configuration surface. For Telegram, Control Center can connect, test, or disconnect a bot for exactly one positive Telegram user ID; group/channel IDs are rejected, status exposes only readiness and a masked user-ID hint, and the agent surface receives only the bounded `telegram_send_message` operation with message text. There is no Telegram inbox/read operation, so inbound messages from other Telegram users are not exposed to agents.

## Managed installation

A managed install is per-user and versioned. A `current` pointer selects the active release. The LaunchAgent runs through the stable `Equinox Local.app` identity in explicit runtime-host mode, while the app can also launch a separate foreground Control Center window. The Browser Native Messaging host follows the managed current pointer rather than a developer checkout.

Native app-shell artifacts are versioned with the managed release and synchronized before runtime activation; activation rollback restores the app shell that belongs to the previous release. The first-install bootstrap and updater share the same release validation/activation concepts so the product has one managed lifecycle instead of separate installation and update worlds.

## Observability and recovery

Runtime events are bounded, rotated, and sanitized before persistence. Diagnosis converts correlated evidence into explicit incidents. Repair recipes and automatic recovery policies are fixed operations with ownership/health guards; they are not arbitrary commands generated from model output.

## What is intentionally not part of the public product

- private Equinox deployment profiles;
- maintainer-specific project integration wiring;
- retired legacy QA Chrome backends or alternate browser transports;
- generic shell/command management endpoints;
- a fallback into user Chrome outside Equinox Browser.
