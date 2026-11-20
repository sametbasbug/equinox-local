# Equinox Local: in-app Chat after Electron 7.0

Status: **isolated unauthenticated Electron loading proven; interactive login and complete in-app Chat not yet shipped.** Companion character selection is already in Main. Keep the existing Control Center layout, one Electron runtime owner, no localhost dashboard, and the existing signed Main distribution. This page tracks practical implementation decisions, not a promise that the website or a remote agent allows embedding.

## User outcome

A person can open **Chat** inside Equinox Local and talk to their ChatGPT account without opening ChatGPT in a separate Chrome window. Their regular ChatGPT account/conversations remain owned by ChatGPT; Equinox Local does not become a surrogate OpenAI API client, clone an OAuth session, or silently duplicate conversation contents into local storage. The separately running Nyx/Codex, Hemera/Claude Code and Asteria/Antigravity sessions are **not** interchangeable with a ChatGPT website session. Agent-specific chat adapters are a separate explicit integration decision, not something a character selector can impersonate.

## Admission and isolation

1. **Proof first:** use a temporary, isolated Electron development identity to verify `https://chatgpt.com/` actually loads and permits a normal interactive login/ChatGPT session in `WebContentsView` on supported macOS and Windows. Do not request or handle credentials programmatically. Do not publish the Chat tab if sign-in or session continuity cannot work.
2. If viable, give remote ChatGPT a separate persistent, user-private Electron session partition. The bundled `equinox://control/` UI keeps its own locked origin and preload. Remote web content receives **no Node, preload, Equinox IPC, token, local file, native bridge, or Equinox Browser automation**. Use `sandbox`, `contextIsolation`, `webSecurity`, and a denied-by-default permissions/download policy.
3. Only a **fixed ChatGPT destination** may be started from an admitted main-frame action. Evaluate required authentication redirects carefully; refuse arbitrary navigation, pop-ups and unknown protocols, while offering an explicit user-initiated external-browser link where required. Never inject scripts or read chat messages/credentials from the remote renderer.
4. A single `WebContentsView` is attached only while the bundled Chat section is selected, confined to the content pane. The native owner manages resize, hide/show, close-to-tray, Quit and session cleanup. Validate/clamp any renderer-supplied bounds and visibility request; never turn the preload into generic URL or browser-navigation IPC.
5. The normal Equinox Browser **remains the only automation route**; the embedded page is strictly a user-facing chat surface. The Chat tab must not claim access to personal Chrome cookies or automatically copy them. If ChatGPT restricts an embedded login, report the limitation and avoid a fake chat composer or unsafe cookie workaround.

## Actual feasibility checkpoint (2026-11-21)

A separate, temporary Electron 46.0.0-alpha.10 process using `WebContentsView` and an isolated nonpersistent user profile successfully loaded `https://chatgpt.com/`. The full ChatGPT logged-out UI, New chat, Log in and composer were visually observed in the WebContentsView, not in a normal Chrome window. Node integration, preload, downloads and permissions were disabled; no cookie/profile copy or API token was used. The external view was removed, its process exited, and its temporary script/profile/screenshot were deleted. **This proves only logged-out rendering.** No credentials were entered, no ChatGPT login or conversation persistence was tested, and no in-app Control Center integration or backend agent routing was implemented. Do not treat it as working Chat or ship a fake tab.

## Delivery order

- Research/verify a real isolated ChatGPT load and sign-in behavior; retain no test suites or temporary files afterwards.
- Integrate Chat as a native panel in the existing Control Center, with an explicit visible loading/error state and a user-owned login flow. Do not add a second dashboard or an additional localhost server.
- Verify manual macOS and Windows chat opening, account continuity, native window bounds, switching to/from other Control Center sections, runtime restart, no unexpected permissions or access to Local IPC; run existing typecheck/static/security/build gates.
- Consider selected external-agent chat adapters only once their supported interfaces and identity/session behavior are verified. The visual companion preference itself is not permission to start a CLI agent, switch an account, or route a message to another service.

No automated acceptance/smoke tests may be added to the repository.
