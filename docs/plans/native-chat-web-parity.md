# Native Chat feature parity with ChatGPT Web

**Status:** active development, NOT published or accepted. This inventory prevents confusing code compilation with finished product acceptance.

## Product contract

Native Chat is a full-featured desktop client for the person's real signed-in ChatGPT account, not an open-tab preview. Equinox owns the desktop layout, history, composer and tools. Equinox Browser bridges the consented user Chrome session, not a second API subscription, credential extractor, or quota bypass. Controls must reflect account-observed availability. All mutations bind exact browser instance, tab, conversation and provider state; uncertain sends are never replayed.

## Feature inventory

| Area | Current status (2026-11-22) | Acceptance requirement |
| --- | --- | --- |
| Rich transcript, live stream, code, copy, quote, task identity | Previously verified in installed Factory | Retain across navigation |
| ChatGPT sidebar conversations | **Developing, uninstalled Browser 1.2.7 source** | All observed visible chats, grouped, partial/virtualized states |
| Open history without a pre-existing tab | **Developing, uninstalled source** | Guard unsent drafts, attachments and generation; verify post-navigation identity |
| Native conversation search | **Source implemented, uninstalled** (actual provider dialog) | Search beyond visible history with bounded results, excerpts and explicit empty states |
| Model and reasoning effort selection | **Source implemented, uninstalled** for existing and new Chat | Account-observed options and exact installed per-chat/first-message confirmation |
| New Chat, follow-up send, uncertain-delivery safety | Existing; **source new model/effort preflight** | Preserve receipts/identity, verify first-turn model before submit |
| Composer attachments, images and multimodal input | **Missing** | Select/preview/remove/send with provider confirmation |
| Web search, research and other ChatGPT tools | **Source partial**: dynamic Native picker and provider-confirmed inline Web Search selection on existing-chat send; other tools/apps are discoverable only | Installed live send confirmation, Deep Research, images, app attachments and first-message tool selection |
| Edit prompt, retry, regenerate, branch chat | **Missing** | Exact source-turn actions |
| Rename, archive, delete, pin, move to project, share | **Source partial**: rename, pin, move, archive and double-confirmed delete; share pending | Exact identity and real installed provider mutation confirmation; destructive actions require explicit two-step confirmation |
| Projects, files and instructions | **Partial** (read-only project catalog/browsing) | Creation, move, project instructions, files and settings |
| Voice, dictation and speech playback | **Missing** | Permission-aware provider-supported flows |
| Personalization, memory, profile, account settings | **Partial** (Equinox theme/language only) | Account-observed native controls, identify provider-only actions |
| Automations, apps/connectors, specialized media | **Missing** | Provider-backed feature discovery without fabricated support |

The public MIT Chat On Steroids repository is a comparison for account model discovery, project grouping and actionable UI, not an authorization to copy its architecture or tests.

## Current source-only implementation

Browser Bridge v13 reads bounded ChatGPT navigation links and project identities from the visible DOM. It never claims this to be full account history, and does not scrape cookies, tokens or undocumented account APIs. Guarded historical selection uses the already-consented Chrome tab, refuses while generating or with a draft/attachment, and re-checks identity. Model discovery obtains the account's choices from the actual model menu; choosing an offered model or adjusting effort requires explicit confirmation. Native Chat groups conversations and exposes those controls over the authenticated private Control Center API. Explicit native Search opens a temporary inactive user Chrome tab, uses the provider's own search dialog, returns bounded matching conversations/excerpts and closes that tab. Similarly a native Project selection can expand its provider sidebar row in a disposable tab to enumerate conversations. These navigation receipts are short-lived and validated against the original Chrome session before the selected conversation can change. New Chat model/effort selections are verified on the newly created provider tab **before any initial prompt content or send**; a failed preflight must not submit the first message. Native conversation actions now use another inactive, disposable user Chrome tab for the exact account-observed conversation. Native pin and rename are read from the real ChatGPT menu, require a fresh title and verified sidebar/search identity, and return success only after the provider UI reflects the requested change. Every mutating request has a unique local action ID and is never blindly replayed. The original active task tab is never used for these mutations. Project move now validates the actual destination Project ID and unique name against the provider's sidebar and menu, and requires the provider's project-scoped URL to be observed after clicking. Archive requires a separate affirmative action in the Native Chat dialog and stable provider sidebar removal before reporting confirmation; active task-bound conversations cannot be moved or archived. Delete now requires explicit Native Chat confirmation AND the provider's own distinct destructive dialog. Provider confirmation must be unambiguous, followed by stable disappearance from the authenticated sidebar; no implicit retry after an uncertain result. Share and additional action menus still require implementation. None of the mutating actions have yet passed actual installed Factory acceptance, so this is not shipped or verified end to end.

The new read-only chat_bridge.tools_catalog method opens an inactive temporary ChatGPT home tab, inspects the provider's visible composer Add Files and More menu and closes that tab. On the user's signed-in account, this projected 7 provider tools and 3 connected apps, including Web Search, Deep Research, image creation, file attachment, Equinox Local and Gmail. The catalog is account-observed and bounded, not static or exhaustive. **Source-only progress:** Native Chat now displays the dynamic tool/app list in a first-party picker. Existing-chat messages can request the account-offered Web Search option; the bridge selects it in the actual provider composer and verifies exactly one matching inline tool pill before filling/sending the original message through a single durable receipt. Other tool/app options are shown but disabled until their distinct provider composer behaviors are implemented; they are not silently treated as Web Search. This source flow is compiled but has not yet been proven by a real installed sent turn. New Chat first-turn tool choice and all file/image upload workflows remain open.

Browser 1.2.6's earlier CWS ZIP is superseded as a Native Chat candidate; Browser 1.2.7 is **not submitted or published**.

## Release gates

1. Real installed macOS Chrome Browser v13 plus matching signed Source Factory proof: multiple conversations/projects, safe history switching and hydration, model/effort, drafts, blocked states and accessibility.
2. Implement the remaining product features needed for parity, especially uploads, tools, conversation actions, project mutations and account settings; obtain explicit maintainer UX acceptance.
3. Real installed Windows x64 physical acceptance, macOS signed validation; no new repo tests or fixtures.
4. Only afterward approve native publication, verify four signed targets and supply the final CWS ZIP in Downloads for maintainer submission.
