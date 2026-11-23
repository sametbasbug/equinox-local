**Tembellik ve over-engineering kesinlikle yasak. No laziness or over-engineering.**

# Native Chat replacement: Codex-style embedded ChatGPT

**State:** Requirements locked where explicitly ordered; design and shared-bridge boundaries awaiting maintainer answers. **No implementation or visual design decisions are authorized until the questions below are resolved.** This file is the permanent task authority. Read it at the start of every continuation and record actual completed code, review evidence, and next step here. Never replace the fixed requirements with a rewritten checkpoint summary.

## Non-negotiable maintainer requirements (2026-11-24)

1. Completely remove the pre-2026-11-23 old first-party Browser Bridge Native Chat implementation from Equinox Local and the Equinox Browser extension. Avoid orphan routes, controller code, unused UI/CSS, dispatch entries and generated JS; identify shared components before deleting them.
2. Put the existing experimental, real ChatGPT Web experience **inside the existing Control Center Chat tab**. Do not launch or require a separate preview window. Remove the experimental entry point/label once the replacement is integrated.
3. Make the **actual chat interface**, not just an extra toolbar, visually resemble the exact Codex reference approved by the maintainer. No invented assistant-chosen layout, appearance, density, icons or interaction differences.
4. Follow the owner's words literally; ask questions upfront before making choices in unclear areas. No unrequested features, alternate architecture, speculative fixes, repetitive QA checkpoints or work performed merely to advance a checkpoint.
5. Every subsequent work turn must produce a concrete relevant artifact/change or explain a genuine blocker and preserve its exact checkpoint. No new automated tests or suites, as forbidden by repository AGENTS.md. No abandoned branches/worktrees or temporary files. Keep working code and docs synchronized.
6. Preserve the repository's existing security, source/Factory and packaging requirements when moving the preview into a trusted Control Center, including isolated provider session and no privileges granted to the remote ChatGPT page.

## Verified architecture facts (read-only inspection, not new work)

- `src/equinox-control-center.html` currently has a large `section-chat` first-party old UI and a `native-chat-open-embedded` button; the experimental ChatGPT window is `desktop/embedded-chat.ts` invoked from `desktop/main.ts`/preload and the menu.
- The old first-party Native Chat uses `src/equinox-local-native-chat.ts`, `src/server.ts` and private IPC routes, plus Control Center TS/HTML/CSS and `chat_bridge.*` operations in `extension/service-worker.ts`.
- `src/telegram-chat-bridge-controller.ts` **also calls** `chat_bridge.inspect`, `chat_bridge.deliver`, `chat_bridge.read_final` and `chat_bridge.live`. Hence deletion scope is a product decision: deleting every such operation could break Telegram Chat Bridge. Task continuation and Fresh Chat Resume also have their own related extension functions. No deletion until the owner chooses.
- Current remote ChatGPT page CSS customizations in `desktop/embedded-chat.ts` are only selection, focus outline and sidebar border; most of the screen is untouched ChatGPT Web. This is **not** an accepted Codex-style design.

## Decisions the maintainer must answer before implementation

**D1 Reference:** Which Codex UI (macOS desktop application, web, IDE extension, or provided screenshot) is the exact design reference? Which screen and theme should be the baseline? Is pixel-close reproduction required or only specified patterns?

**D2 Visual inventory:** Should the Codex reference govern the navigation rail, conversation/history sidebar, assistant/user bubbles, model/effort selector, composer, tool popovers, header, settings and empty state? Identify deliberate exceptions, if any.

**D3 Real provider UI control:** Is it acceptable to restyle the real ChatGPT page with carefully scoped CSS while retaining all provider controls and DOM, or must provider sidebar/header/composer be hidden and replaced by first-party controls? The second choice involves different engineering and functionality risks.

**D4 Integration viewport:** Should Chat consume the entire existing page content area while retaining the global Equinox navigation rail and Control Center title/window, or replace those too? When switching away and back, should the logged-in provider view stay alive in place?

**D5 Old extension bridge:** Does 'remove old Chat completely' include removing Telegram Chat Bridge message delivery, which currently depends on extension `chat_bridge.*`, or must Telegram messaging continue via a permitted separate shared subset? Preserve normal Agent Browser, Your Browser, Task Capsule auto-continuation and Fresh Chat Resume unless expressly ordered otherwise.

**D6 Account/content:** Should the current separately partitioned ChatGPT Web login persist without re-login and keep all provider projects/history/controls as-is? Any account switching or Chrome-cookie sharing is out of scope unless explicitly authorized.

**D7 Platform acceptance:** Is work to proceed Mac Factory first and then Windows public installation, with no public signed Main/CWS publication until a visually approved result, or does the owner want a different exact order? Existing protected release gates stay active until explicit approval.

**D8 UX verification:** Must the maintainer approve screenshots of the integrated empty/new-chat and populated/conversation screens before it can be called acceptable? Specify window size, responsiveness and dark/light preference, if fixed.

## Locked execution order once D1–D8 are answered

1. **Deletion map and removal:** Identify obsolete first-party Chat UI, controller, IPC and extension methods. Remove the old implementation from source and generated output, respecting the exact D5 decision. Keep unrelated browser/Telegram/Task work only as directed. Validate compilation/static analysis and remove dead references. No new tests.
2. **Same-tab embedding:** Host the existing isolated ChatGPT provider `WebContentsView` as the real content inside the current Control Center `Chat` tab; remove separate preview window, experimental menu/button and redundant toolbar. Preserve exact provider login/session and permission security. Prove Chat tab enter/leave/reenter and layout resizing in installed Mac Factory.
3. **Codex visual implementation:** Implement only the maintainer-approved D1–D4 design in the actual Chat UI, not only an app-owned top bar. Inspect real visual output against the approved reference and fix actual mismatches. Do not invent missing screens, behavior or visual details.
4. **Finalize relevant acceptance:** Check the explicitly approved desktop visual states and core navigation/compose/read behavior on the supported installation paths. Do not waste turns revalidating ChatGPT's inherent feature set. Run static/build validation (no new repo tests), document factual evidence, clear own temporary assets, and follow release gates.

## Progress and immutable change log

- 2026-11-24: Created this file and inventoried the old Native Chat, embedded preview, extension dispatch and Telegram shared Chat Bridge dependency. **Implementation blocked by D1–D8 maintainer clarification.** No application or extension code changed in this step.
