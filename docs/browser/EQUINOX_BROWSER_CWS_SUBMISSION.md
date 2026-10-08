# Equinox Browser — Chrome Web Store review checklist

## Existing Store item

- Item: **Equinox Browser**, Unlisted, extension ID `npdneefcobilfkjlihghjgjnknenhfoj` (do not create a new listing).
- Currently approved live version: `0.7.0`. Next review candidate: **`1.0.0`**.
- Source: canonical public `extension/`; reproducible ZIP: `npm run browser:package` after review-branch merge, from the exact reviewed commit.
- Retain manifest public `key` (same permanent ID), current seven permissions and limited `https://chatgpt.com/*` passive content script, and Native Messaging protocol v1. No new host permissions or remote code.
- Final package contains only allowlisted runtime files, no test credentials, transcripts or fixture data. Verify manifest version 1.0.0 and pinned extension ID with packaging command.

## Reviewer instructions

Equinox Browser communicates with **Equinox Local**, a separate installed desktop companion that provides its authenticated local Native Messaging host. Chrome Web Store reviewers can use the published macOS Equinox Local Reviewer companion linked in existing Store reviewer instructions; it exercises the same constrained native host/extension handshake without an AI provider account. Initial browser control remains off until the user consents through the popup. Browsing is not monitored without consent.

The optional ChatGPT continuity content script on `chatgpt.com` observes bounded generation/composer and conversation turn identifiers to support Auto Continue. It does not read message text. Real webpage manipulation (including Telegram Task chat sends) uses the authenticated local bridge and controlled Chrome debugger input after the user enables browser control. The current UI uses a ProseMirror composer and primary `type=submit` action; voice/stop controls are never selected as the send button.

## Pre-submit gate

1. Public PR/CI and CodeQL pass; `npm run check`, full `npm test`, browser-focused modern ChatGPT DOM tests pass.
2. From exact public `main`, run `npm run browser:package`. Check ZIP SHA-256, `manifest.version === "1.0.0"`, 11-file allowlist, unchanged permissions and stable extension ID.
3. Open [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) with the human's authorized developer account. Choose the **existing** item by exact extension ID, upload `equinox-browser-1.0.0.zip` and inspect warnings, privacy declarations and reviewer-access instructions before submission.
4. Explicitly **submit for review**. Confirm dashboard says *in review/submitted*; an uploaded draft is **not** a review submission. Preserve Unlisted visibility.
5. **Only after approval** coordinate the separate Equinox Local `6.0.0` production-release gate. Do not auto-deploy Local merely because the Browser ZIP was built or submitted.

Never place developer account passwords, 2FA codes, API secrets, or reviewer private tokens in Git/ChatGPT/Telegram. If the dashboard needs human reauthentication, pause at that boundary instead of bypassing login.
