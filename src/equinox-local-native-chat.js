import { chatGptConversationIdFromUrl } from "./telegram-chat-bridge-controller.js";
const MAX_MESSAGES = 40;
function invalid(message) { const error = new Error(message); error.statusCode = 400; throw error; }
function safeTitle(value) { return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/gu, " ").trim().slice(0, 120) : "ChatGPT conversation"; }
/** Current-user native Chat transport. The browser remains the ChatGPT session authority. */
export function createNativeChatController({ browserBridge, chatBridge }) {
    let selected = null;
    let messages = [];
    let pending = null;
    let sending = false;
    let blocked = false;
    const attempts = new Map();
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
        for (const item of raw.slice(0, 150)) {
            const tabId = Number(item?.id ?? item?.tabId);
            const conversationId = chatGptConversationIdFromUrl(item?.url);
            if (!conversationId || !Number.isSafeInteger(tabId) || tabId < 1)
                continue;
            const canonicalUrl = String(item.url);
            if (!tabs.has(conversationId))
                tabs.set(conversationId, { tabId, conversationId, title: safeTitle(item.title) || "ChatGPT conversation", canonicalUrl });
        }
        return { browserInstanceId, threads: [...tabs.values()].slice(0, 35).map(t => ({ conversationId: t.conversationId, tabId: t.tabId, title: t.title, selected: selected?.conversationId === t.conversationId })) };
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
        if (selected?.conversationId !== next.conversationId || selected?.browserInstanceId !== next.browserInstanceId) {
            messages = [];
            pending = null;
            blocked = false;
            attempts.clear();
        }
        selected = next;
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
            turn = inspected?.status === "waiting" ? "waiting" : "ready";
            if (pending) {
                const result = await chatBridge.readFinal({ binding: selected, userEpoch: pending.userEpoch, previousAssistantTurnKey: pending.previousAssistantTurnKey });
                if (result?.status === "ready") {
                    messages.push({ id: pending.deliveryId + "-reply", role: "assistant", text: String(result.text).slice(0, 25000), status: "complete" });
                    messages = messages.slice(-MAX_MESSAGES);
                    pending = null;
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
        return { selected: { conversationId: selected.conversationId, tabId: selected.tabId }, items: messages, turn, sending, blocked, notice, limitedHistory: true };
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
        if (sending || pending || blocked || !selected)
            invalid("Select an idle, unblocked ChatGPT conversation before sending. Confirm any uncertain delivery in Chrome.");
        const binding = selected;
        sending = true;
        const attempt = (async () => {
            try {
                const result = await chatBridge.deliverText({ binding, deliveryId: key, text: body.text.trim() });
                if (result?.confirmed !== true) {
                    blocked = true;
                    messages.push({ id: key, role: "user", text: body.text.trim(), status: "uncertain" });
                    messages = messages.slice(-MAX_MESSAGES);
                    return { confirmed: false, ambiguous: true };
                }
                messages.push({ id: key, role: "user", text: body.text.trim(), status: "sent" });
                messages = messages.slice(-MAX_MESSAGES);
                pending = { userEpoch: result.userEpoch, previousAssistantTurnKey: result.previousAssistantTurnKey, deliveryId: key };
                return { confirmed: true, ambiguous: false };
            }
            catch (error) {
                const code = error?.code;
                if (code === "CHAT_BRIDGE_AMBIGUOUS") {
                    blocked = true;
                    messages.push({ id: key, role: "user", text: body.text.trim(), status: "uncertain" });
                    messages = messages.slice(-MAX_MESSAGES);
                }
                throw error;
            }
            finally {
                sending = false;
            }
        })();
        attempts.set(key, attempt);
        if (attempts.size > 100)
            attempts.delete(attempts.keys().next().value);
        return attempt;
    };
    return Object.freeze({ list, select, read, send });
}
