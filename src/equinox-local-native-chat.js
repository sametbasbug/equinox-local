import { chatGptConversationIdFromUrl } from "./telegram-chat-bridge-controller.js";
const MAX_MESSAGES = 30;
const MAX_TRANSCRIPT_CHARS = 96_000;
const MAX_ASSISTANT_CHARS = 12_000;
const MAX_DELIVERY_IDS = 2_048;
function invalid(message) { const error = new Error(message); error.statusCode = 400; throw error; }
function safeTitle(value) { return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/gu, " ").trim().slice(0, 120) : "ChatGPT conversation"; }
/** Current-user native Chat transport. The browser remains the ChatGPT session authority. */
export function createNativeChatController({ browserBridge, chatBridge }) {
    let selected = null;
    let messages = [];
    let history = [];
    let historyPartial = false;
    let historyNotice = null;
    let pending = null;
    let sending = false;
    let blocked = false;
    const attempts = new Map();
    function appendMessage(message) {
        messages.push(message);
        while (messages.length > MAX_MESSAGES || messages.reduce((sum, item) => sum + item.text.length, 0) > MAX_TRANSCRIPT_CHARS)
            messages.shift();
    }
    const call = (method, args, timeoutMs = 6_000) => browserBridge.call(method, args, { context: "user", timeoutMs });
    const context = () => {
        const c = browserBridge.snapshot()?.contexts?.user;
        const id = c?.extension?.instanceId || c?.host?.instanceId;
        if (!c?.ready || typeof id !== "string" || id.length < 8)
            throw new Error("Your Browser is not connected. Open Chrome with Equinox Browser enabled.");
        if (Number(c?.extension?.capabilityVersions?.chatBridge || 0) < 9)
            throw new Error("Equinox Browser needs the current Chat Bridge capability.");
        return id;
    };
    const list = async () => {
        const browserInstanceId = context();
        const raw = await call("tabs.list", {});
        if (!Array.isArray(raw))
            throw new Error("Connected browser did not return a tab list.");
        const tabs = new Map();
        const duplicated = new Set();
        for (const item of raw.slice(0, 150)) {
            const tabId = Number(item?.id ?? item?.tabId);
            const conversationId = chatGptConversationIdFromUrl(item?.url);
            if (!conversationId || !Number.isSafeInteger(tabId) || tabId < 1)
                continue;
            const canonicalUrl = String(item.url);
            if (tabs.has(conversationId))
                duplicated.add(conversationId);
            else
                tabs.set(conversationId, { tabId, conversationId, title: safeTitle(item.title) || "ChatGPT conversation", canonicalUrl });
        }
        return { browserInstanceId, duplicateCount: duplicated.size,
            threads: [...tabs.values()].filter(t => !duplicated.has(t.conversationId)).slice(0, 35).map(t => ({ conversationId: t.conversationId, tabId: t.tabId, title: t.title, selected: selected?.conversationId === t.conversationId })) };
    };
    const select = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Invalid conversation selection.");
        const object = value;
        if (Object.keys(object).length !== 2 || typeof object.conversationId !== "string" || !Number.isSafeInteger(object.tabId))
            invalid("Invalid conversation selection.");
        if (sending || pending)
            invalid("Cannot change conversation while a message is in flight.");
        const available = await list();
        const tab = available.threads.find(t => t.tabId === object.tabId && t.conversationId === object.conversationId);
        if (!tab)
            invalid("This ChatGPT conversation is no longer available in Your Browser.");
        const next = { browserContext: "user", browserInstanceId: available.browserInstanceId, tabId: tab.tabId, conversationId: tab.conversationId, canonicalUrl: `https://chatgpt.com/c/${tab.conversationId}` };
        // A project-scoped URL may be needed to follow the browser's exact conversation identity.
        // Only the browser bridge, never the UI, supplies the canonical URL.
        const raw = await call("tabs.list", {});
        const source = raw.find(t => Number(t.id ?? t.tabId) === tab.tabId && chatGptConversationIdFromUrl(t.url) === tab.conversationId);
        if (!source?.url)
            invalid("Conversation identity changed during selection.");
        next.canonicalUrl = source.url;
        await chatBridge.inspectTurnIdentity({ binding: next });
        const changed = selected?.conversationId !== next.conversationId || selected?.browserInstanceId !== next.browserInstanceId;
        if (changed) {
            messages = [];
            pending = null;
            blocked = false;
            attempts.clear();
            history = [];
            historyPartial = false;
            historyNotice = null;
        }
        selected = next;
        if (changed) {
            try {
                const value = await chatBridge.readRecent?.({ binding: next });
                if (value && Array.isArray(value.items)) {
                    history = value.items.slice(-24).map((item) => ({ id: String(item.id).slice(0, 220), role: item.role, text: String(item.text).slice(0, 14000), status: "complete", truncated: item.truncated === true }));
                    historyPartial = value.partial === true;
                }
                else
                    historyNotice = "Recent conversation history is not available with this Browser version.";
            }
            catch {
                historyNotice = "Recent history unavailable. You can still send messages in this conversation.";
            }
        }
        return await read();
    };
    const read = async () => {
        if (!selected)
            return { selected: null, items: [], turn: "unbound", blocked: false, limitedHistory: true };
        let turn = "idle";
        let notice = null;
        try {
            const inspected = await chatBridge.inspectTurnIdentity({ binding: selected });
            const current = inspected?.binding;
            if (current && current.conversationId === selected.conversationId && current.browserInstanceId === selected.browserInstanceId)
                selected = current;
            turn = inspected?.generationActive === true ? "generating" : inspected?.status === "waiting" ? "waiting" : "ready";
            if (pending) {
                const receipt = pending;
                const result = await chatBridge.readFinal({ binding: selected, userEpoch: receipt.userEpoch, previousAssistantTurnKey: receipt.previousAssistantTurnKey });
                if (result?.status === "ready") {
                    // Polling and the post-send refresh can complete simultaneously.
                    // Only the first reader that still owns this receipt may append it.
                    if (pending === receipt) {
                        const reply = String(result.text);
                        appendMessage({ id: receipt.deliveryId + "-reply", role: "assistant", text: reply.slice(0, MAX_ASSISTANT_CHARS), status: "complete",
                            truncated: result.truncated === true || reply.length > MAX_ASSISTANT_CHARS });
                        pending = null;
                    }
                    turn = "complete";
                }
                else
                    turn = "generating";
            }
        }
        catch (error) {
            const code = error?.code;
            if (code === "CHAT_BRIDGE_DRIFTED" || code === "CHAT_BRIDGE_READ_FAILED") {
                // A terminal response identity mismatch must never be replayed or
                // silently rebound to a different Chrome conversation.
                pending = null;
                blocked = true;
                turn = "disconnected";
            }
            else if (pending) {
                turn = "waiting";
            }
            else
                turn = "disconnected";
            notice = error instanceof Error ? error.message : "Browser conversation is unavailable.";
        }
        return { selected: { conversationId: selected.conversationId, tabId: selected.tabId, browserInstanceId: selected.browserInstanceId }, items: [...history, ...messages].slice(-54),
            turn, sending, blocked, notice: notice || historyNotice, limitedHistory: historyPartial || !history.length, historyCount: history.length };
    };
    const send = async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            invalid("Invalid chat delivery request.");
        const body = value;
        if (Object.keys(body).length !== 2 || typeof body.deliveryId !== "string" || !/^tgb-[a-f0-9-]{36}$/u.test(body.deliveryId) || typeof body.text !== "string" || !body.text.trim() || body.text.length > 4000 || /[\0]/u.test(body.text))
            invalid("Chat delivery must include a unique id and 1–4000 characters of text.");
        const key = body.deliveryId;
        if (attempts.has(key))
            return attempts.get(key);
        // Retain every delivery identity for the lifetime of this backend.
        // Refuse new sends at the bound rather than evict old IDs and risk replay.
        if (attempts.size >= MAX_DELIVERY_IDS)
            invalid("This Chat session reached its bounded delivery limit. Restart the runtime before sending again.");
        if (sending || pending || blocked || !selected)
            invalid("Select an idle, unblocked ChatGPT conversation before sending. Confirm any uncertain delivery in Chrome.");
        const binding = selected;
        sending = true;
        const attempt = (async () => {
            try {
                const result = await chatBridge.deliverText({ binding, deliveryId: key, text: body.text.trim() });
                if (result?.confirmed !== true) {
                    blocked = true;
                    appendMessage({ id: key, role: "user", text: body.text.trim(), status: "uncertain" });
                    return { confirmed: false, ambiguous: true };
                }
                appendMessage({ id: key, role: "user", text: body.text.trim(), status: "sent" });
                pending = { userEpoch: result.userEpoch, previousAssistantTurnKey: result.previousAssistantTurnKey, deliveryId: key };
                return { confirmed: true, ambiguous: false };
            }
            catch (error) {
                const code = error?.code;
                if (code === "CHAT_BRIDGE_AMBIGUOUS") {
                    blocked = true;
                    appendMessage({ id: key, role: "user", text: body.text.trim(), status: "uncertain" });
                }
                throw error;
            }
            finally {
                sending = false;
            }
        })();
        attempts.set(key, attempt);
        return attempt;
    };
    return Object.freeze({ list, select, read, send });
}
