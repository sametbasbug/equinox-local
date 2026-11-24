import { randomUUID } from "node:crypto";
const ID = /^native-[a-f0-9-]{36}$/u;
const CONVERSATION = /^[A-Za-z0-9-]{8,160}$/u;
const MAX_AGE = 3_000;
const bounded = (value, length) => typeof value === "string" && value.length > 0 && value.length <= length && !value.includes("\0");
function canonical(value, id) {
    if (!bounded(value, 500) || typeof id !== "string" || !CONVERSATION.test(id))
        return false;
    try {
        const url = new URL(value);
        return url.origin === "https://chatgpt.com" && !url.username && !url.password && !url.search && !url.hash
            && /^\/(?:g\/[A-Za-z0-9_-]{8,160}\/)?c\/([A-Za-z0-9-]{8,160})\/?$/u.exec(url.pathname)?.[1] === id;
    }
    catch {
        return false;
    }
}
function projectScope(value) {
    const path = new URL(value).pathname;
    if (path.startsWith("/c/"))
        return "root";
    return /^\/g\/(g-p-[a-f0-9]{32})(?:-[a-z0-9][a-z0-9-]{0,126})?\/c\//u.exec(path)?.[1] ?? null;
}
function normalizeState(value) {
    if (value === null)
        return null;
    if (!value || !Number.isSafeInteger(value.tabId) || value.tabId < 1 || !canonical(value.canonicalUrl, value.conversationId)
        || !bounded(value.title, 200) || ![value.userEpoch, value.assistantTurnKey].every(key => key === null || bounded(key, 200))
        || ![value.generationActive, value.composerReady, value.composerEmpty].every(flag => typeof flag === "boolean"))
        throw new Error("Invalid native conversation state.");
    return { tabId: value.tabId, conversationId: value.conversationId, canonicalUrl: value.canonicalUrl, title: value.title,
        userEpoch: value.userEpoch, assistantTurnKey: value.assistantTurnKey, generationActive: value.generationActive,
        composerReady: value.composerReady, composerEmpty: value.composerEmpty,
        generationStartedAtMs: Number.isSafeInteger(value.generationStartedAtMs) && value.generationStartedAtMs > 0 && value.generationStartedAtMs <= Date.now() ? value.generationStartedAtMs : null };
}
/** Current-user authenticated shell exchange; not an MCP capability or renderer API.
 * A reserved mutation is claimed once, never replayed after a lost acknowledgement. */
export function createNativeChatChannel({ assertMutationAllowed = () => { } } = {}) {
    let closed = false;
    let observed = null;
    let pending = null;
    const current = () => observed && Date.now() - observed.at <= MAX_AGE && observed.state ? { instanceId: observed.instanceId, state: observed.state } : null;
    function finish(error, result) {
        if (!pending)
            return;
        const entry = pending;
        pending = null;
        clearTimeout(entry.timer);
        if (error)
            entry.reject(error);
        else
            entry.resolve(result);
    }
    function exchange(input) {
        if (closed)
            throw new Error("Native Chat channel is closed.");
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["instanceId", "state", "reply"].includes(key))
            || typeof input.instanceId !== "string" || !ID.test(input.instanceId))
            throw new Error("Invalid native exchange envelope.");
        const state = normalizeState(input.state);
        if (observed && observed.instanceId !== input.instanceId && pending)
            finish(new Error("Native view instance changed."));
        observed = { instanceId: input.instanceId, state, at: Date.now() };
        if (input.reply !== undefined && input.reply !== null) {
            const reply = input.reply;
            if (!reply || typeof reply !== "object" || typeof reply.id !== "string" || typeof reply.confirmed !== "boolean")
                throw new Error("Invalid native delivery receipt.");
            if (pending?.claimed && pending.request.id === reply.id && pending.request.instanceId === input.instanceId) {
                const request = pending.request;
                if (request.method === "resume.create" && reply.confirmed) {
                    if (!Number.isSafeInteger(reply.destinationTabId) || !canonical(reply.destinationCanonicalUrl, reply.destinationConversationId)
                        || !state || state.tabId !== reply.destinationTabId || state.conversationId !== reply.destinationConversationId
                        || state.canonicalUrl !== reply.destinationCanonicalUrl || state.conversationId === request.args.conversationId
                        || !projectScope(String(request.args.canonicalUrl)) || projectScope(state.canonicalUrl) !== projectScope(String(request.args.canonicalUrl)))
                        finish(new Error("Native fresh destination was not observed."));
                    else
                        finish(null, { confirmed: true, destinationTabId: state.tabId, destinationConversationId: state.conversationId, destinationCanonicalUrl: state.canonicalUrl });
                }
                else if (reply.confirmed && (!state || state.tabId !== request.args.tabId || state.conversationId !== request.args.conversationId
                    || state.canonicalUrl !== request.args.canonicalUrl || !state.userEpoch || state.userEpoch === request.args.userEpoch))
                    finish(new Error("Native continuation destination was not observed."));
                else
                    finish(null, { confirmed: reply.confirmed });
            }
        }
        if (!pending || pending.claimed || pending.request.instanceId !== input.instanceId)
            return { request: null };
        if (!state || Date.now() >= pending.request.expiresAt) {
            finish(new Error("Native view is unavailable before delivery."));
            return { request: null };
        }
        try {
            assertMutationAllowed();
        }
        catch {
            finish(new Error("Native Chat delivery was stopped by the mutation guard."));
            return { request: null };
        }
        pending.claimed = true;
        return { request: pending.request };
    }
    async function call(method, args, timeoutMs) {
        const target = current();
        if (method === "continuation.target.resolve") {
            const state = target?.state;
            return { mode: "task-tab", status: state?.generationActive && state.userEpoch && state.assistantTurnKey ? "ready" : "idle",
                target: state ? { ...state, autoContinueVersion: 1 } : null };
        }
        if (!target)
            throw new Error("Native Chat is not open on an exact conversation.");
        const state = target.state;
        if (method === "tabs.list")
            return [{ id: state.tabId, url: state.canonicalUrl }];
        if (method === "continuation.inspect") {
            if (args?.tabId !== state.tabId)
                throw new Error("Native Chat view changed.");
            return { ...state, autoContinueVersion: 1 };
        }
        if (method !== "continuation.deliver" && method !== "resume.create")
            throw new Error("Unsupported native Chat operation.");
        assertMutationAllowed();
        if (pending)
            throw new Error("Native Chat already has a delivery in progress.");
        const fresh = method === "resume.create";
        if (args?.browserInstanceId !== target.instanceId || (fresh ? args?.sourceTabId : args?.tabId) !== state.tabId
            || (fresh ? args?.sourceConversationId : args?.conversationId) !== state.conversationId
            || args.userEpoch !== state.userEpoch || args.assistantTurnKey !== state.assistantTurnKey
            || !state.userEpoch || !state.assistantTurnKey || state.generationActive || !state.composerReady || !state.composerEmpty
            || !bounded(args.prompt, 2000) || !/^Continue task task-[a-z0-9-]{6,80} from checkpoint [1-9][0-9]*(?: in this fresh chat)?\./u.test(args.prompt)
            || !bounded(fresh ? args.resumeId : args.continuationId, 100)
            || !new RegExp(fresh ? "^resume-[a-z0-9-]{6,80}$" : "^cont-[a-z0-9-]{6,80}$", "u").test(fresh ? args.resumeId : args.continuationId))
            throw new Error("Native Chat delivery identity or draft changed.");
        const request = { id: randomUUID(), instanceId: target.instanceId, method, args: {
                tabId: state.tabId, conversationId: state.conversationId, canonicalUrl: state.canonicalUrl,
                userEpoch: state.userEpoch, assistantTurnKey: state.assistantTurnKey, prompt: args.prompt,
            }, expiresAt: Date.now() + Math.min(40_000, Math.max(1_000, timeoutMs)) };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => finish(new Error("Native delivery was not confirmed; do not retry.")), request.expiresAt - Date.now());
            timer.unref?.();
            pending = { request, claimed: false, resolve, reject, timer };
        });
    }
    // Only continuity controllers use this adapter. The Chrome/Telegram bridge
    // and public Browser capabilities never receive a synthetic Chrome context.
    function adapt(browser) {
        return {
            snapshot: () => {
                const snapshot = browser.snapshot();
                const native = current();
                return { ...snapshot, contexts: { ...snapshot?.contexts, ...(native ? { native: {
                                ready: true, extension: { instanceId: native.instanceId, capabilityVersions: { autoContinue: 1, freshChatResume: 1 } },
                            } } : {}) } };
            },
            call: (method, args, options) => options.context === "native" ? call(method, args, options.timeoutMs) : browser.call(method, args, options),
        };
    }
    const hasFreshObservation = () => Boolean(observed && Date.now() - observed.at <= MAX_AGE);
    const status = () => {
        const state = current()?.state;
        // Diagnostics do not expose conversation identifiers, titles, prompts or drafts.
        return { connected: hasFreshObservation(), conversationReady: Boolean(state),
            turnIdentityReady: Boolean(state?.userEpoch && state.assistantTurnKey),
            generationActive: state?.generationActive === true, composerReady: state?.composerReady === true,
            composerEmpty: state?.composerEmpty === true, deliveryPending: Boolean(pending) };
    };
    return { exchange, current, hasFreshObservation, status, adapt, close: () => { closed = true; observed = null; finish(new Error("Native channel closed.")); } };
}
