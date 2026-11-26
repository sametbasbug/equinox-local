import { randomUUID } from "node:crypto";
import { exchangeNativeChat } from "./control-client.js";
const ORIGIN = "https://chatgpt.com";
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
/** Fixed isolated-world DOM operation, never a script or selector supplied by
 * the runtime, provider, renderer or MCP caller. Returns only identity/booleans. */
function providerProbe(action, expected) {
    const last = (items) => items.at(-1) ?? null;
    const id = (value) => {
        const token = String(value || "").trim().split(/\s+/u)[0] || "";
        return /^[A-Za-z0-9_:-]{1,200}$/u.test(token) ? token : null;
    };
    const url = new URL(location.href);
    const safe = url.origin === "https://chatgpt.com" && !url.username && !url.password && !url.port;
    const route = safe ? /^\/(?:g\/([A-Za-z0-9_-]{8,160})\/)?c\/([A-Za-z0-9-]{8,160})\/?$/u.exec(url.pathname) : null;
    const project = safe ? /^\/g\/(g-p-[a-f0-9]{32})(?:-[a-z0-9][a-z0-9-]{0,126})?(?:\/project)?\/?$/u.exec(url.pathname) : null;
    const home = safe && !url.search && !url.hash ? url.pathname === "/" ? "root" : project?.[1] ?? null : null;
    const visible = (element) => {
        const r = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return element.isConnected && r.width > 0 && r.height > 0 && element.getClientRects().length > 0
            && style.visibility !== "hidden" && style.display !== "none";
    };
    const nodes = (selector) => [...document.querySelectorAll(selector)];
    const modern = last(nodes("[data-turn-key]"));
    const modernKey = id(modern?.getAttribute("data-turn-key"));
    const modernUser = last(nodes('[data-chatgpt-search-unit-key$=":user"][data-chatgpt-search-message-ids]'));
    const user = last(nodes('[data-message-author-role="user"][data-message-id]'));
    const assistant = last(nodes('[data-message-author-role="assistant"][data-message-id]'));
    const userTurn = last(nodes('section[data-turn="user"][data-testid]'));
    const assistantTurn = last(nodes('section[data-turn="assistant"][data-testid]'));
    const modernAssistant = modern ? last([...modern.querySelectorAll('[data-chatgpt-search-unit-key$=":assistant"][data-chatgpt-search-message-ids]')]) : null;
    const userEpoch = modernKey || id(user?.getAttribute("data-message-id")) || id(userTurn?.getAttribute("data-testid")) || id(modernUser?.getAttribute("data-chatgpt-search-message-ids"));
    const assistantTurnKey = modernKey || id(assistantTurn?.getAttribute("data-testid")) || id(assistant?.getAttribute("data-message-id")) || id(modernAssistant?.getAttribute("data-chatgpt-search-message-ids"));
    const composers = nodes('#prompt-textarea[contenteditable="true"][role="textbox"],[data-composer-markdown][contenteditable="true"][role="textbox"],form[data-chatgpt-composer] .ProseMirror[contenteditable="true"][role="textbox"]').filter(visible);
    const composer = composers.length === 1 ? composers[0] : null;
    const attachments = Boolean(composer?.closest("form")?.querySelector('span[class*="group/composer-attachment"],[data-testid*="attachment-preview"],[data-testid*="file-chip"],[data-testid*="image-preview"]'));
    const modernStop = nodes('[data-composer-body] button.bg-composer-primary').filter(visible).some(button => {
        const path = button.querySelector('svg[viewBox="0 0 20 20"] path');
        if (!path)
            return false;
        try {
            const box = path.getBBox();
            return box.x >= 4 && box.x <= 5.5 && box.y >= 4 && box.y <= 5.5 && box.width >= 10 && box.width <= 12 && box.height >= 10 && box.height <= 12 && Math.abs(box.width - box.height) <= 1;
        }
        catch {
            return false;
        }
    });
    const generationActive = modernStop || nodes('button[data-testid="stop-button"]').some(visible);
    const draft = composer?.textContent || "";
    const canonicalUrl = route && !url.search && !url.hash ? url.origin + url.pathname.replace(/\/$/u, "") : null;
    // Confirm only the latest turn, never a matching prompt in old history.
    const latestUser = modern
        ? last([...modern.querySelectorAll(".bg-user-message.text-user-message")])
            || last([...modern.querySelectorAll('[data-chatgpt-search-unit-key$=":user"][data-chatgpt-search-message-ids]')])
        : last(nodes(".bg-user-message.text-user-message")) || modernUser || user || userTurn;
    const matches = Boolean(expected && latestUser?.textContent?.trim() === expected.prompt);
    const result = { canonicalUrl, conversationId: canonicalUrl ? route?.[2] ?? null : null, home,
        title: (document.title || "ChatGPT").trim().slice(0, 200), userEpoch, assistantTurnKey, generationActive,
        composerReady: Boolean(composer), composerEmpty: Boolean(composer && !draft.trim() && !attachments), lastUserMatches: matches, performed: false };
    if (action === "inspect" || !expected || Date.now() >= expected.expiresAt || !composer || generationActive || attachments
        || (expected.home ? home !== expected.home || canonicalUrl !== null : canonicalUrl !== expected.canonicalUrl)
        || userEpoch !== expected.userEpoch || assistantTurnKey !== expected.assistantTurnKey)
        return result;
    if (action === "brainCapture" || action === "brainAppend") {
        // The exact draft stays in this isolated world only. Never return its
        // contents to the local renderer, runtime or an agent.
        const scope = window;
        if (!expected.reviewId || composer.closest('form')?.hasAttribute('data-logged-out'))
            return result;
        if (action === "brainCapture") {
            if (composer.innerHTML.length > 64000)
                return result;
            const captured = { id: expected.reviewId, html: composer.innerHTML, expiresAt: expected.expiresAt };
            scope.__equinoxBrainReview = captured;
            setTimeout(() => { if (scope.__equinoxBrainReview === captured)
                delete scope.__equinoxBrainReview; }, Math.max(0, captured.expiresAt - Date.now()));
            result.performed = true;
            return result;
        }
        const captured = scope.__equinoxBrainReview;
        delete scope.__equinoxBrainReview;
        if (!captured || captured.id !== expected.reviewId || Date.now() >= captured.expiresAt || captured.html !== composer.innerHTML || !expected.appendText || expected.appendText.length > 12000)
            return result;
        // Synchronous compare-and-insert in the same DOM operation; never submit.
        const before = composer.innerText;
        composer.focus();
        const selection = getSelection();
        if (!selection || document.activeElement !== composer || captured.html !== composer.innerHTML)
            return result;
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        const suffix = (before.trim() ? "\n\n" : "") + expected.appendText;
        const accepted = document.execCommand("insertText", false, suffix);
        const normalized = (value) => value.replace(/\s+/gu, " ").trim();
        result.performed = accepted && normalized(composer.innerText) === normalized(before + suffix);
    }
    else if (action === "return" && result.composerEmpty && expected.returnUrl) {
        const destination = new URL(expected.returnUrl);
        if (destination.origin === url.origin && !destination.username && !destination.password && !destination.search && !destination.hash &&
            /^\/(?:g\/[A-Za-z0-9_-]{8,160}\/)?c\/[A-Za-z0-9-]{8,160}\/?$/u.test(destination.pathname)) {
            location.assign(destination.href);
            result.performed = true;
        }
    }
    else if (action === "fresh" && result.composerEmpty && expected.freshUrl && route) {
        const scope = route[1] ? /^(g-p-[a-f0-9]{32})(?:-[a-z0-9][a-z0-9-]{0,126})?$/u.exec(route[1])?.[1] : "root";
        const destination = scope === "root" ? url.origin + "/" : scope ? url.origin + "/g/" + scope : null;
        // Recheck the empty composer and current turn in the same DOM operation
        // that initiates the navigation. Do not discard a newly entered draft.
        if (destination === expected.freshUrl) {
            location.assign(destination);
            result.performed = true;
        }
    }
    else if (action === "focus" && result.composerEmpty) {
        composer.focus();
        result.performed = document.activeElement === composer;
    }
    else if (action === "submit" && draft === expected.prompt && document.activeElement === composer) {
        const form = composer.closest("form");
        const buttons = [...(form?.querySelectorAll('[data-composer-body] button.bg-composer-primary[type="submit"],button[data-testid="send-button"][type="submit"],button#composer-submit-button[type="submit"]:not([data-testid="stop-button"])') || [])]
            .filter(button => visible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true");
        if (buttons.length === 1) {
            buttons[0].click();
            result.performed = true;
        }
    }
    return result;
}
function routeIdentity(value) {
    try {
        const url = new URL(value);
        if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash)
            return null;
        const match = /^\/(?:g\/([A-Za-z0-9_-]{8,160})\/)?c\/([A-Za-z0-9-]{8,160})\/?$/u.exec(url.pathname);
        if (!match)
            return null;
        const scope = match[1] ? /^(g-p-[a-f0-9]{32})(?:-[a-z0-9][a-z0-9-]{0,126})?$/u.exec(match[1])?.[1] ?? "" : "root";
        return { canonicalUrl: url.origin + url.pathname.replace(/\/$/u, ""), conversationId: match[2],
            scope, freshUrl: scope === "root" ? ORIGIN + "/" : scope ? ORIGIN + "/g/" + scope : "" };
    }
    catch {
        return null;
    }
}
/** Bound to a single owned WebContents, with one outstanding exchange. */
export function createNativeChatContinuity(win, contents, isVisible, onBudget = () => { }) {
    const instanceId = "native-" + randomUUID();
    let stopped = false;
    let timer = null;
    let generation = null;
    let reply;
    const alive = () => !stopped && !win.isDestroyed() && !contents.isDestroyed();
    const aliveVisible = () => alive() && isVisible() && win.isVisible() && !win.isMinimized();
    const inspectable = () => alive() && !contents.isLoadingMainFrame()
        && (() => { try {
            return new URL(contents.getURL()).origin === ORIGIN;
        }
        catch {
            return false;
        } })();
    const usable = () => aliveVisible() && inspectable();
    async function probe(action = "inspect", expected) {
        const available = action === "inspect" || action === "return" ? inspectable : usable;
        if (!available())
            return null;
        const before = contents.getURL();
        try {
            const result = await contents.executeJavaScriptInIsolatedWorld(1001, [{ code: "(" + providerProbe.toString() + ")(" + JSON.stringify(action) + "," + JSON.stringify(expected ?? null) + ")" }]);
            if (!available() || contents.getURL() !== before)
                return (action === "submit" || action === "fresh" || action === "return") && result?.performed ? result : null;
            return result;
        }
        catch {
            return null;
        }
    }
    async function observe() {
        const route = inspectable() ? routeIdentity(contents.getURL()) : null;
        const state = route ? await probe() : null;
        if (!route || !state || state.conversationId !== route.conversationId || state.canonicalUrl !== route.canonicalUrl) {
            generation = null;
            return null;
        }
        const turnKey = state.userEpoch || state.assistantTurnKey;
        const key = turnKey ? JSON.stringify([route.conversationId, turnKey]) : null;
        if (!state.generationActive || !key)
            generation = null;
        else if (generation?.key !== key)
            generation = { key, at: Date.now() };
        return { tabId: contents.id, conversationId: route.conversationId, canonicalUrl: route.canonicalUrl, title: state.title || "ChatGPT",
            userEpoch: state.userEpoch, assistantTurnKey: state.assistantTurnKey, generationActive: state.generationActive,
            composerReady: state.composerReady, composerEmpty: state.composerEmpty, generationStartedAtMs: generation?.at ?? null };
    }
    async function deliver(request) {
        const fail = { id: request.id, confirmed: false };
        const args = request.args;
        const source = routeIdentity(contents.getURL());
        if (!usable() || request.instanceId !== instanceId || !/^[a-f0-9-]{36}$/u.test(request.id) || !Number.isSafeInteger(request.expiresAt)
            || request.expiresAt <= Date.now() || request.expiresAt > Date.now() + 40_000 || !args || args.tabId !== contents.id || !source || source.canonicalUrl !== args.canonicalUrl || source.conversationId !== args.conversationId
            || !args.userEpoch || !args.assistantTurnKey || typeof args.prompt !== "string" || args.prompt.length > 2000
            || !/^Continue task task-[a-z0-9-]{6,80} from checkpoint [1-9][0-9]*(?: in this fresh chat)?\./u.test(args.prompt)
            || !["continuation.deliver", "resume.create"].includes(request.method))
            return fail;
        const fresh = request.method === "resume.create";
        let expected = { canonicalUrl: source.canonicalUrl, userEpoch: args.userEpoch, assistantTurnKey: args.assistantTurnKey, prompt: args.prompt, expiresAt: request.expiresAt };
        const initial = await probe("inspect", expected);
        if (!initial || initial.canonicalUrl !== source.canonicalUrl || initial.userEpoch !== expected.userEpoch || initial.assistantTurnKey !== expected.assistantTurnKey
            || initial.generationActive || !initial.composerReady || !initial.composerEmpty)
            return fail;
        if (fresh) {
            if (!source.freshUrl || Date.now() >= request.expiresAt || !usable())
                return fail;
            // Same owned view and provider account; preserve the source conversation
            // in provider history. A failed transition is ambiguous and never retried.
            const navigation = await probe("fresh", { ...expected, freshUrl: source.freshUrl });
            if (!navigation?.performed)
                return fail;
            expected = { home: source.scope, userEpoch: null, assistantTurnKey: null, prompt: args.prompt, expiresAt: request.expiresAt };
            const homeDeadline = Math.min(request.expiresAt - 5_000, Date.now() + 12_000);
            let ready = false;
            while (Date.now() < homeDeadline) {
                const home = await probe();
                if (home?.home === source.scope && !home.conversationId && !home.userEpoch && !home.assistantTurnKey && !home.generationActive && home.composerReady && home.composerEmpty) {
                    ready = true;
                    break;
                }
                if (home?.conversationId && home.conversationId !== source.conversationId)
                    return fail;
                await delay(150);
            }
            if (!ready)
                return fail;
        }
        if (Date.now() >= request.expiresAt || !usable())
            return fail;
        const focused = await probe("focus", expected);
        if (!focused?.performed || !usable() || Date.now() >= request.expiresAt || (!fresh && routeIdentity(contents.getURL())?.canonicalUrl !== source.canonicalUrl))
            return fail;
        // insertText targets only this WebContents, not an OS-global keyboard.
        await contents.insertText(args.prompt);
        if (!usable() || Date.now() >= request.expiresAt)
            return fail;
        const submitted = await probe("submit", expected);
        if (!submitted?.performed)
            return fail;
        const deadline = Math.min(request.expiresAt - 200, Date.now() + (fresh ? 15_000 : 5_000));
        // After submission, confirm the receipt even if the local view is hidden.
        // This is read-only; never repeat an ambiguous mutation.
        while (Date.now() < deadline && alive()) {
            if (contents.isLoadingMainFrame()) {
                await delay(150);
                continue;
            }
            const state = await probe("inspect", expected);
            const route = routeIdentity(contents.getURL());
            if (state && route && state.conversationId === route.conversationId && state.canonicalUrl === route.canonicalUrl && state.userEpoch && state.userEpoch !== expected.userEpoch && state.lastUserMatches) {
                if (!fresh && route.canonicalUrl === source.canonicalUrl)
                    return { id: request.id, confirmed: true };
                if (fresh && route.conversationId !== source.conversationId && route.scope === source.scope)
                    return { id: request.id, confirmed: true, destinationTabId: contents.id, destinationConversationId: route.conversationId, destinationCanonicalUrl: route.canonicalUrl };
            }
            if (!fresh && route?.canonicalUrl !== source.canonicalUrl)
                return fail;
            if (fresh && route && route.scope !== source.scope)
                return fail;
            await delay(150);
        }
        return fail;
    }
    async function tick() {
        if (stopped)
            return;
        try {
            const state = await observe();
            if (stopped)
                return;
            const result = await exchangeNativeChat({ instanceId, viewVisible: aliveVisible(), state, ...(reply ? { reply } : {}) });
            reply = undefined;
            if (!stopped) {
                const remaining = result.budgetRemainingMs;
                onBudget(usable() && state?.generationActive && state.canonicalUrl === routeIdentity(contents.getURL())?.canonicalUrl
                    && typeof remaining === "number" && Number.isFinite(remaining) && remaining >= 0 && remaining <= 120 * 60_000
                    && !result.request ? remaining : null);
            }
            if (!stopped && result.request) {
                const request = result.request;
                try {
                    reply = await deliver(request);
                }
                catch {
                    reply = { id: request.id, confirmed: false };
                }
            }
        }
        catch {
            onBudget(null); /* Runtime unavailable or exchange lost; never repeat a claimed operation. */
        }
        finally {
            if (!stopped)
                timer = setTimeout(() => { void tick(); }, reply ? 0 : aliveVisible() ? 650 : 1_000);
        }
    }
    void tick();
    return {
        async captureBrainReview(reviewId) {
            if (!usable())
                return null;
            const current = await probe();
            if (!current || current.generationActive || !current.composerReady || (!current.canonicalUrl && !current.home))
                return null;
            const expected = { ...(current.canonicalUrl ? { canonicalUrl: current.canonicalUrl } : { home: current.home }), userEpoch: current.userEpoch, assistantTurnKey: current.assistantTurnKey, prompt: "", expiresAt: Date.now() + 180000, reviewId };
            return (await probe("brainCapture", expected))?.performed ? expected : null;
        },
        async appendBrainReview(expected, text) {
            if (!usable() || !expected.reviewId || Date.now() >= expected.expiresAt)
                return false;
            return (await probe("brainAppend", { ...expected, appendText: text }))?.performed === true;
        },
        async returnToConversation(canonicalUrl, conversationId) {
            const destination = routeIdentity(canonicalUrl);
            if (!destination || destination.conversationId !== conversationId || !inspectable())
                return false;
            if (routeIdentity(contents.getURL())?.canonicalUrl === destination.canonicalUrl)
                return true;
            const current = await probe();
            if (!current || current.generationActive || !current.composerReady || !current.composerEmpty ||
                (!current.canonicalUrl && !current.home))
                return false;
            const result = await probe("return", { ...(current.canonicalUrl ? { canonicalUrl: current.canonicalUrl } : { home: current.home }),
                userEpoch: current.userEpoch, assistantTurnKey: current.assistantTurnKey, prompt: "", expiresAt: Date.now() + 5000, returnUrl: destination.canonicalUrl });
            if (!result?.performed)
                return false;
            for (let i = 0; i < 40 && alive(); i++) {
                if (!contents.isLoadingMainFrame() && routeIdentity(contents.getURL())?.canonicalUrl === destination.canonicalUrl)
                    return true;
                await delay(250);
            }
            return false;
        },
        dispose() { stopped = true; if (timer)
            clearTimeout(timer); onBudget(null); }
    };
}
