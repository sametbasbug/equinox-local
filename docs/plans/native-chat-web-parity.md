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
| Web search, research and other ChatGPT tools | **Missing** | Provider-available picker and actual tool state |
| Edit prompt, retry, regenerate, branch chat | **Missing** | Exact source-turn actions |
| Rename, archive, delete, pin, move to project, share | **Source partial**: native rename/pin with provider-confirmed target, other actions pending | Exact identity, confirmed provider mutations; explicit destructive confirmation |
| Projects, files and instructions | **Partial** (read-only project catalog/browsing) | Creation, move, project instructions, files and settings |
| Voice, dictation and speech playback | **Missing** | Permission-aware provider-supported flows |
| Personalization, memory, profile, account settings | **Partial** (Equinox theme/language only) | Account-observed native controls, identify provider-only actions |
| Automations, apps/connectors, specialized media | **Missing** | Provider-backed feature discovery without fabricated support |

The public MIT Chat On Steroids repository is a comparison for account model discovery, project grouping and actionable UI, not an authorization to copy its architecture or tests.

## Current source-only implementation

Browser Bridge v13 reads bounded ChatGPT navigation links and project identities from the visible DOM. It never claims this to be full account history, and does not scrape cookies, tokens or undocumented account APIs. Guarded historical selection uses the already-consented Chrome tab, refuses while generating or with a draft/attachment, and re-checks identity. Model discovery obtains the account's choices from the actual model menu; choosing an offered model or adjusting effort requires explicit confirmation. Native Chat groups conversations and exposes those controls over the authenticated private Control Center API. Explicit native Search opens a temporary inactive user Chrome tab, uses the provider's own search dialog, returns bounded matching conversations/excerpts and closes that tab. Similarly a native Project selection can expand its provider sidebar row in a disposable tab to enumerate conversations. These navigation receipts are short-lived and validated against the original Chrome session before the selected conversation can change. New Chat model/effort selections are verified on the newly created provider tab **before any initial prompt content or send**; a failed preflight must not submit the first message. Native conversation actions now use another inactive, disposable user Chrome tab for the exact account-observed conversation. Native pin and rename are read from the real ChatGPT menu, require a fresh title and verified sidebar/search identity, and return success only after the provider UI reflects the requested change. Every mutating request has a unique local action ID and is never blindly replayed. The original active task tab is never used for these mutations. Archive/delete, project move, share and other action menus still require implementation and GUI acceptance.

Browser 1.2.6's earlier CWS ZIP is superseded as a Native Chat candidate; Browser 1.2.7 is **not submitted or published**.

## Release gates

1. Real installed macOS Chrome Browser v13 plus matching signed Source Factory proof: multiple conversations/projects, safe history switching and hydration, model/effort, drafts, blocked states and accessibility.
2. Implement the remaining product features needed for parity, especially uploads, tools, conversation actions, project mutations and account settings; obtain explicit maintainer UX acceptance.
3. Real installed Windows x64 physical acceptance, macOS signed validation; no new repo tests or fixtures.
4. Only afterward approve native publication, verify four signed targets and supply the final CWS ZIP in Downloads for maintainer submission.
