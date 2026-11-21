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
| Native conversation search | **Partial** (local filter only) | Search across provider history, not only current visible links |
| Model and reasoning effort selection | **Developing, uninstalled source** | Account-observed options, exact live confirmation, no hardcoded choices |
| New Chat, follow-up send, uncertain-delivery safety | Existing | Preserve receipts/identity |
| Composer attachments, images and multimodal input | **Missing** | Select/preview/remove/send with provider confirmation |
| Web search, research and other ChatGPT tools | **Missing** | Provider-available picker and actual tool state |
| Edit prompt, retry, regenerate, branch chat | **Missing** | Exact source-turn actions |
| Rename, archive, delete, pin, move to project, share | **Missing** | Confirmation for destructive changes, provider state reflected |
| Projects, files and instructions | **Partial** (read-only grouping) | Native project management |
| Voice, dictation and speech playback | **Missing** | Permission-aware provider-supported flows |
| Personalization, memory, profile, account settings | **Partial** (Equinox theme/language only) | Account-observed native controls, identify provider-only actions |
| Automations, apps/connectors, specialized media | **Missing** | Provider-backed feature discovery without fabricated support |

The public MIT Chat On Steroids repository is a comparison for account model discovery, project grouping and actionable UI, not an authorization to copy its architecture or tests.

## Current source-only implementation

Browser Bridge v13 reads bounded ChatGPT navigation links and project identities from the visible DOM. It never claims this to be full account history, and does not scrape cookies, tokens or undocumented account APIs. Guarded historical selection uses the already-consented Chrome tab, refuses while generating or with a draft/attachment, and re-checks identity. Model discovery obtains the account's choices from the actual model menu; choosing an offered model or adjusting effort requires explicit confirmation. Native Chat groups conversations and exposes those controls over the authenticated private Control Center API.

Browser 1.2.6's earlier CWS ZIP is superseded as a Native Chat candidate; Browser 1.2.7 is **not submitted or published**.

## Release gates

1. Real installed macOS Chrome Browser v13 plus matching signed Source Factory proof: multiple conversations/projects, safe history switching and hydration, model/effort, drafts, blocked states and accessibility.
2. Implement the remaining product features needed for parity, especially history search, uploads, tools and conversation/project actions; obtain explicit maintainer UX acceptance.
3. Real installed Windows x64 physical acceptance, macOS signed validation; no new repo tests or fixtures.
4. Only afterward approve native publication, verify four signed targets and supply the final CWS ZIP in Downloads for maintainer submission.
