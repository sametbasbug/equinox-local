# Equinox Local Chat: native conversation workspace

Status: **design corrected 2026-11-21; not implemented or released.** User reference: [Chat On Steroids](https://github.com/totec448-spec/chat-on-steroids). This page supersedes the earlier embedded-ChatGPT-web proposal.

## What the user means

Build an **Equinox-designed, Codex-like chat interface** in the existing Electron Control Center: independent thread list and chat composer, message stream, intermediate progress and native tool/action cards, conversation selection, task association, and clear paused/running/completed states. This is **not** `chatgpt.com` rendered in `WebContentsView`, nor an iframe, nor a link to a browser window. The visual companion selector remains independent from the choice of underlying conversation/agent.

Keep the product's existing authenticated current-user IPC, `equinox://control/` bundled UI, one runtime owner, Browser extension bridge, security policy, Main signing/update gates and source Factory identity. Do not create another localhost web server, extra anonymous agent service, test suites or storage of passwords/session cookies.

## Reference project: what it actually does

As documented by Chat On Steroids, its own Electron UI controls and records ChatGPT conversations through **a browser extension that observes and automates the ChatGPT page**. Its local MCP tools run in the user's environment; Goal/Loop/Compact & Resume and multi-worker features build around that bridge. It uses a ChatGPT account's conversations rather than calling Codex directly or assuming the OpenAI API is bundled with a ChatGPT subscription. The project explicitly states that browser integration **is not a public ChatGPT automation API**, may break as the website changes, and may be restricted by provider terms. Use architectural lessons rather than copy its implementation or make compliance claims.

## Existing Equinox foundation (verify/extend rather than duplicate)

- Equinox Browser already binds exact browser instance, context, tab and ChatGPT conversation identity for Auto Continue and Task Capsules. Its bridge exposes bounded ChatGPT turn inspection and explicit message delivery for the existing Telegram Chat Bridge.
- In `src/telegram-chat-bridge-controller.ts`, `inspectBinding`, `deliverText`, `readFinal` and `startTaskChat` already enforce browser-instance identity, composer readiness, exact task/conversation match, and ambiguous-delivery **no automatic replay**. These are a basis for a **shared native Chat transport adapter**, not a reason to create a second independent DOM automation engine.
- The native UI should use the existing read-only/control-request IPC admission and a small set of narrowly defined chat operations. Only the local backend reaches the Equinox Browser bridge; HTML never receives arbitrary Chrome automation, filesystem or raw Local tool access.
- The browser remains the underlying ChatGPT session authority, with explicit user-owned sign-in in Chrome. Do not copy Chrome login cookies into Electron or pretend a provider account is an official API credential. ChatGPT plan/limits do not equal API entitlement.

## Minimal, usable vertical slice

1. Observe an existing ChatGPT conversation by exact browser context, instance, tab and conversation ID, exposing its title, current turn status and latest authorized visible messages through a bounded existing browser bridge. Handle disconnected, unavailable, refused and stale bindings visibly.
2. Build a **native** Chat section within Control Center: chat list/selection, own composer, conversation feed and streaming/progress/tool indicators with user-friendly states, not a transplanted web page. Reuse the existing visual language rather than adding another application's UI shell.
3. Send text through the shared bounded delivery operation with unique delivery identity, readiness checks, and a clear ambiguous result when the send may have crossed the browser boundary. Never silently retry a potentially committed send. UI reads back exact conversation/turn outcome.
4. Tie a chat to optional Equinox Task Capsule and existing notifications/continuations only on explicit selection. Do not automatically switch between Nyx (Codex), Hemera (Claude Code), Asteria (Antigravity) and ChatGPT just because the companion graphic changes.
5. Later: conversation creation, attachments, per-chat model/effort controls and specialized external agent adapters **only after** confirmed support and manual validation. Unsupported controls must not be decorative or fake.

## Implementation checkpoint (2026-11-21)

A first **unreleased native UI and private transport slice** is implemented on the `equinox/native-chat-tab` branch. The fixed `Chat` section is a bundled HTML/CSS/TypeScript conversation panel, not a ChatGPT web page or `WebContentsView`. The backend reads exact Chrome Your Browser conversation identities, requires an explicit selection, reuses the existing `Telegram Chat Bridge` delivery/read-final safety contract, generates a unique browser delivery ID per new user action and never silently retries ambiguous sends. Only messages initiated from this local UI are shown, in bounded in-memory state; **existing ChatGPT history, model selector, multi-agent messages, tool cards and interim transcript are not yet imported**. There is no extra daemon, localhost listener, private key export or provider API account.

Typecheck, generated runtime/desktop JavaScript parity, root static checks, and darwin-arm64/darwin-x64/win32-x64/win32-arm64 development packaging passed. The real packaged macOS UI visibly showed the Chat section, conversation sidebar, transcript area, status and composer. Its runtime was intentionally still an *older installed Factory SHA*, so the new `/api/v1/chat/*` routes were rejected with an explicit version mismatch; **no real ChatGPT text delivery was performed or verified yet**. An inline, nonpersisted bounded-controller sanity run verified exact selection, one outbound delivery for one idempotency ID, waiting and final read state. This is not end-to-end acceptance. The preview app, isolated data and temporary screenshots were removed.

Do not merge/release or advertise the feature as functional until a matching backend and an authenticated real Chrome ChatGPT conversation pass actual send/read and original conversation identity checks (including uncertain-delivery handling) on macOS and Windows. No automated test files may be added.

## Risks and real acceptance

- ChatGPT UI/browser extension interaction is **not an official service API**. Document account-policy risks and avoid abusive automation or workarounds to provider restrictions. Prefer supported interfaces where available; no promise that one login can power every agent backend.
- Verify actual user-session ChatGPT text send, observable assistant progress and final output, conversation identity, interruption and uncertain-delivery handling on macOS and Windows. Check native UI layout, role-private data, logs, no localhost dashboard, no extra runtime owner, and signed Main gates. No physical Windows ARM64 device test is required.
- The abandoned `WebContentsView` proof established only that logged-out ChatGPT HTML can render. Its uncommitted native-web-embed implementation was **fully reverted**, its temporary QA app shut down and profile/files removed; it is **not** the desired product and must not be revived.

No automated test suites may be added to the repository. This plan is not a shipped feature.
