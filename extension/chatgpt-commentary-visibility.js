"use strict";
// Shared MAIN-world document_start script for Browser and native Assistant.
// Only exact ChatGPT conversation stream and history responses are eligible.
// Only previously rendered public commentary is retained in a bounded
// profile-local cache; no tokens, request bodies or hidden content.
(() => {
    if (location.origin !== "https://chatgpt.com" || window.top !== window)
        return;
    const nativeFetch = window.fetch;
    const encoder = new TextEncoder();
    const MAX_FRAME = 1024 * 1024;
    const STORAGE_KEY = "equinox.public-progress.v1";
    const MAX_SAVED_BYTES = 512 * 1024, MAX_SAVED_ITEMS = 240, MAX_AGE = 30 * 24 * 60 * 60 * 1000;
    const messageId = /^[a-f0-9-]{36}$/iu;
    const publicIds = new Map();
    let sequence = 0, scanPending = false, flushTimer = 0;
    const pending = new Map();
    const revoked = new Set();
    const keyOf = (r) => JSON.stringify([r.owner, r.id]);
    function validSaved(r) {
        if (!r || typeof r !== "object")
            return false;
        const v = r;
        if (typeof v.id !== "string" || !messageId.test(v.id) ||
            (v.providerId !== undefined && (typeof v.providerId !== "string" || !messageId.test(v.providerId))) ||
            typeof v.owner !== "string" || v.owner.length > 200 ||
            typeof v.text !== "string" || !v.text.trim() || v.text.length > 12000 ||
            !Number.isSafeInteger(v.order) || v.order < 0 || !Number.isSafeInteger(v.at) ||
            v.at < Date.now() - MAX_AGE || v.at > Date.now() + 60000)
            return false;
        try {
            const keys = JSON.parse(v.owner);
            return Array.isArray(keys) && keys.length === 3 && keys.every(k => typeof k === "string" && messageId.test(k));
        }
        catch {
            return false;
        }
    }
    function readSaved() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw || raw.length > MAX_SAVED_BYTES)
                return [];
            const list = JSON.parse(raw);
            return Array.isArray(list) ? list.filter(validSaved).slice(-MAX_SAVED_ITEMS) : [];
        }
        catch {
            return [];
        }
    }
    let saved = new Map(readSaved().map(r => [keyOf(r), r]));
    function flush() {
        if (flushTimer) {
            window.clearTimeout(flushTimer);
            flushTimer = 0;
        }
        if (!pending.size && !revoked.size)
            return;
        const merged = new Map(readSaved().map(r => [keyOf(r), r]));
        for (const [k, v] of pending)
            merged.set(k, v);
        for (const [k, v] of merged)
            if (v.providerId && revoked.has(v.providerId))
                merged.delete(k);
        const list = [...merged.values()].filter(validSaved).sort((a, b) => a.at - b.at).slice(-MAX_SAVED_ITEMS);
        let bytes = 2 + list.reduce((n, r) => n + encoder.encode(JSON.stringify(r)).byteLength + 1, 0);
        while (list.length && bytes > MAX_SAVED_BYTES)
            bytes -= encoder.encode(JSON.stringify(list.shift())).byteLength + 1;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
            saved = new Map(list.map(r => [keyOf(r), r]));
            pending.clear();
            revoked.clear();
        }
        catch { /* keep the verified, bounded in-memory presentation */ }
    }
    function queueFlush() {
        if (!flushTimer)
            flushTimer = window.setTimeout(flush, 400);
    }
    function rememberPublicId(id) {
        if (!messageId.test(id) || revoked.has(id))
            return;
        if (!publicIds.has(id))
            publicIds.set(id, ++sequence);
        while (publicIds.size > 240) {
            const first = publicIds.keys().next().value;
            if (first === undefined)
                break;
            publicIds.delete(first);
        }
        scheduleProgress();
    }
    function revokePublicId(id) {
        if (!publicIds.delete(id) && ![...saved.values()].some(r => r.providerId === id))
            return;
        revoked.add(id);
        for (const [key, r] of saved)
            if (r.providerId === id) {
                saved.delete(key);
                pending.delete(key);
            }
        queueFlush();
        scheduleProgress();
    }
    const proseSelector = '[data-markdown-text-style="assistant-message"]';
    const retainedSelector = '[data-equinox-retained-progress]';
    const normalized = (text) => text.replace(/\s+/gu, " ").trim();
    function visible(node) {
        const rect = node.getBoundingClientRect();
        return rect.width > 4 && rect.height > 4 && !node.closest('[hidden],[aria-hidden="true"],[inert],.sr-only') &&
            getComputedStyle(node).visibility === "visible" &&
            node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const localRoutes = new Map();
    function ownerOf(node, admitLocal = false) {
        const conversation = /\/c\/([a-f0-9-]{36})\/?$/iu.exec(location.pathname)?.[1];
        const turn = node.closest("[data-turn-key]"), scope = node.closest("[data-content-search-turn-key]");
        const transcript = node.closest("[data-chatgpt-conversation-selection-target]");
        const user = turn?.querySelectorAll('[data-chatgpt-search-unit-key$=":user"]');
        const turnId = turn?.getAttribute("data-turn-key"), scopeId = scope?.getAttribute("data-content-search-turn-key");
        if (!conversation || !transcript || !turnId || !scopeId || !messageId.test(turnId) || !messageId.test(scopeId) ||
            !turn?.contains(scope ?? null) || user?.length !== 1 ||
            user[0]?.getAttribute("data-chatgpt-search-message-ids") !== turnId)
            return null;
        const transcriptId = transcript.getAttribute("data-chatgpt-conversation-selection-target");
        if (transcriptId !== conversation) {
            // Newly created ChatGPT conversations can keep their local render
            // identity for the lifetime of the document, even after the canonical
            // route is assigned. Accept only the observed local UUID namespace
            // in a unique transcript with consistent selection ownership.
            if (!transcriptId?.startsWith("local-chatgpt:") ||
                !messageId.test(transcriptId.slice("local-chatgpt:".length)) ||
                document.querySelectorAll("[data-chatgpt-conversation-selection-target]").length !== 1 ||
                !transcript.contains(turn))
                return null;
            const selections = turn.querySelectorAll("[data-chatgpt-selection-conversation-id]");
            if (!selections.length || [...selections].some(e => e.getAttribute("data-chatgpt-selection-conversation-id") !== transcriptId))
                return null;
            const previous = localRoutes.get(transcriptId);
            if (previous !== undefined && previous !== conversation)
                return null;
            if (previous === undefined) {
                if (!admitLocal || localRoutes.size >= 240)
                    return null;
                localRoutes.set(transcriptId, conversation);
            }
        }
        return JSON.stringify([conversation, turnId, scopeId]);
    }
    const nodeRows = new WeakMap();
    function captureProgress() {
        const active = document.querySelectorAll('[data-talvt-turn-state="in_progress"]');
        for (const turn of active) {
            const used = new Set();
            const nodes = turn.querySelectorAll('[data-spacing="activity"] ' + proseSelector);
            for (const node of nodes) {
                // Some public commentary roots gain a selection identity; accept
                // it only when the same message was explicitly classified public.
                // Ignore final responses, tool portals, headers and hidden roots.
                if (node.closest(retainedSelector + ', [data-response-body] > [data-mcp-app-portal-target], [class~="group/activity-header"]') ||
                    node.parentElement?.closest(proseSelector) || !visible(node))
                    continue;
                const unit = node.closest("[data-chatgpt-search-message-ids]");
                const selection = node.closest("[data-chatgpt-selection-message-id]");
                const rawId = selection?.getAttribute("data-chatgpt-selection-message-id") ??
                    unit?.getAttribute("data-chatgpt-search-message-ids") ?? "";
                const providerId = publicIds.has(rawId) && !revoked.has(rawId) ? rawId : undefined;
                if (selection && !providerId)
                    continue;
                // The provider alternates between a live message unit and a direct
                // public prose child of its activity stack. No arbitrary DOM text.
                if (!node.parentElement?.matches('[data-spacing="activity"]') &&
                    !(providerId && selection && selection.querySelectorAll(proseSelector).length === 1) &&
                    !(unit && unit.querySelectorAll(proseSelector).length === 1 && messageId.test(rawId)))
                    continue;
                if (rawId && revoked.has(rawId))
                    continue;
                const owner = ownerOf(node, true), text = node.innerText.trim();
                if (!owner || !text || text.length > 12000)
                    continue;
                const rows = [...saved.values()].filter(r => r.owner === owner).sort((a, b) => a.order - b.order);
                const compatible = (r) => r.owner === owner && !used.has(keyOf(r)) &&
                    (!providerId || !r.providerId || providerId === r.providerId);
                let old = saved.get(nodeRows.get(node) ?? "");
                if (old && !compatible(old))
                    old = undefined;
                old ??= rows.find(r => compatible(r) && providerId !== undefined && r.providerId === providerId);
                old ??= rows.find(r => compatible(r) && normalized(r.text) === normalized(text));
                // A remount may show a shorter prefix while Markdown catches up.
                // Reuse an unambiguous existing row, never invent its missing text.
                if (!old) {
                    const prefix = rows.filter(r => compatible(r) && normalized(text).length >= 12 &&
                        (normalized(r.text).startsWith(normalized(text)) || normalized(text).startsWith(normalized(r.text))));
                    if (prefix.length === 1)
                        old = prefix[0];
                }
                const item = { id: old?.id ?? crypto.randomUUID(), owner,
                    text: old && normalized(old.text).startsWith(normalized(text)) ? old.text : text,
                    order: old?.order ?? (rows.at(-1)?.order ?? 0) + 1, at: old?.at ?? Date.now(),
                    ...(providerId || old?.providerId ? { providerId: providerId ?? old.providerId } : {}) };
                const key = keyOf(item);
                nodeRows.set(node, key);
                used.add(key);
                if (old?.text === item.text && old.providerId === item.providerId)
                    continue;
                saved.set(key, item);
                pending.set(key, item);
                while (saved.size > MAX_SAVED_ITEMS) {
                    const first = saved.keys().next().value;
                    if (first === undefined)
                        break;
                    saved.delete(first);
                    pending.delete(first);
                }
                queueFlush();
            }
        }
    }
    const restored = new Map();
    function restoreProgress() {
        const wanted = new Set();
        for (const scope of document.querySelectorAll("[data-content-search-turn-key]")) {
            const owner = ownerOf(scope);
            if (!owner)
                continue;
            const rows = [...saved.values()].filter(r => r.owner === owner && validSaved(r) && (!r.providerId || !revoked.has(r.providerId))).sort((a, b) => a.order - b.order);
            if (!rows.length)
                continue;
            const complete = scope.querySelectorAll('[data-talvt-turn-state="complete"]');
            if (complete.length !== 1)
                continue;
            // Completed provider disclosures use a single activity stack of
            // public markdown nodes. Require at least one exact original text
            // anchor before restoring anything; never insert into an unknown turn.
            const groups = [...complete[0].querySelectorAll('[data-spacing="activity"]')].filter(g => visible(g) && [...g.children].some(n => n.matches(proseSelector) && !n.matches(retainedSelector) &&
                !n.closest("[data-response-body]") && rows.some(r => normalized(r.text) === normalized(n.innerText))));
            if (groups.length !== 1)
                continue;
            const group = groups[0];
            wanted.add(group);
            const originals = [...group.children].filter((n) => n instanceof HTMLElement && n.matches(proseSelector) && !n.matches(retainedSelector) && visible(n));
            let cursor = 0;
            const matches = rows.map(r => {
                const index = originals.findIndex((n, i) => i >= cursor && (normalized(n.innerText) === normalized(r.text) ||
                    (normalized(r.text).length >= 12 && normalized(n.innerText).startsWith(normalized(r.text)))));
                if (index < 0)
                    return null;
                cursor = index + 1;
                return originals[index];
            });
            // If the provider changed the order or text, do not duplicate a
            // still-present original. Matching identical repeated text is
            // handled by the ordered one-to-one pass above.
            const unmatchedOriginals = originals.filter(n => !matches.includes(n));
            const missing = rows.map((r, i) => ({ r, i })).filter(({ r, i }) => !matches[i] &&
                !unmatchedOriginals.some(n => normalized(n.innerText) === normalized(r.text)));
            const signature = JSON.stringify([originals.map(n => normalized(n.innerText)), missing.map(({ r, i }) => [r.id, r.text, i])]);
            const current = [...group.querySelectorAll(":scope > " + retainedSelector)];
            if (restored.get(group) === signature && current.length === missing.length &&
                current.every((n, i) => n.getAttribute("data-equinox-retained-progress") === missing[i]?.r.id))
                continue;
            for (const n of current)
                n.remove();
            for (const { r, i } of missing) {
                const row = document.createElement("div");
                row.className = originals[0]?.className ?? "";
                row.setAttribute("data-markdown-text-style", "assistant-message");
                row.setAttribute("data-equinox-retained-progress", r.id);
                row.title = "Previously displayed progress";
                row.style.whiteSpace = "pre-wrap";
                row.style.overflowWrap = "anywhere";
                row.textContent = r.text;
                const next = matches.slice(i + 1).find(n => n !== null);
                group.insertBefore(row, next ?? null);
            }
            restored.set(group, signature);
        }
        for (const [group] of restored)
            if (!wanted.has(group)) {
                for (const n of group.querySelectorAll(":scope > " + retainedSelector))
                    n.remove();
                restored.delete(group);
            }
    }
    function scheduleProgress() {
        if (scanPending)
            return;
        scanPending = true;
        requestAnimationFrame(() => {
            scanPending = false;
            captureProgress();
            if (saved.size || restored.size)
                restoreProgress();
            // Numeric diagnostics only, never message text or identifiers.
            const counts = JSON.stringify([publicIds.size, saved.size, document.querySelectorAll(retainedSelector).length]);
            if (document.documentElement?.getAttribute("data-equinox-progress-counts") !== counts)
                document.documentElement?.setAttribute("data-equinox-progress-counts", counts);
        });
    }
    const progressObserver = new MutationObserver(scheduleProgress);
    progressObserver.observe(document, { subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ["data-chatgpt-search-message-ids", "data-turn-key", "data-content-search-turn-key", "data-chatgpt-conversation-selection-target", "data-chatgpt-selection-conversation-id", "data-chatgpt-selection-message-id", "data-talvt-turn-state", "data-spacing", "data-markdown-text-style", "aria-expanded", "aria-hidden", "hidden"] });
    window.addEventListener("pagehide", flush);
    window.addEventListener("storage", event => {
        if (event.key !== STORAGE_KEY && event.key !== null)
            return;
        saved = new Map(readSaved().map(r => [keyOf(r), r]));
        for (const [key, r] of pending)
            saved.set(key, r);
        scheduleProgress();
    });
    scheduleProgress();
    function isPublicProgress(message) {
        if (!message || typeof message !== "object" || Array.isArray(message))
            return false;
        const metadata = message.metadata;
        return typeof message.id === "string" && message.id.length > 0
            && message.author?.role === "assistant"
            && (message.channel === "commentary" || metadata?.message_channel === "commentary")
            && (message.recipient === undefined || message.recipient === "all")
            && message.content?.content_type === "text"
            && Array.isArray(message.content.parts)
            && metadata && typeof metadata === "object"
            // ChatGPT also sets is_thinking_preamble_message=true on public
            // commentary progress. It is NOT proof of private analysis; role,
            // commentary channel and recipient=all establish public visibility.
            && metadata.message_type === "next"
            && message.end_turn !== true
            && metadata.is_visually_hidden !== true
            && metadata.is_hidden !== true;
    }
    function changeFrame(frame, state) {
        // SSE records must contain one complete JSON data field, not multiline
        // fragments or unrecognized control/event framing.
        const lines = frame.split(/\r?\n/u);
        const data = lines.filter((line) => line.startsWith("data: "));
        if (data.length !== 1)
            return frame;
        const raw = data[0].slice(6);
        if (!raw.startsWith("{") || raw.length > MAX_FRAME)
            return frame;
        let payload;
        try {
            payload = JSON.parse(raw);
        }
        catch {
            return frame;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
            return frame;
        // ChatGPT's conversation SSE wraps full message snapshots under v.message.
        // Direct message snapshots and full-message patch operations also occur.
        // Do not modify metadata-only deltas: they do not establish whether the
        // target is a user-facing commentary message or private analysis/tool work.
        let changed = false;
        const reveal = (message) => {
            if (!message || typeof message !== "object")
                return;
            // Each full message establishes the recipient and channel for later
            // /message/metadata patches in this same SSE response.
            state.currentPublicProgress = isPublicProgress(message);
            state.currentPublicId = state.currentPublicProgress && message.recipient === "all" ? message.id : null;
            if (state.currentPublicId)
                rememberPublicId(state.currentPublicId);
            else if (typeof message.id === "string")
                revokePublicId(message.id);
            if (!state.currentPublicProgress || message.metadata.is_visually_hidden_from_conversation !== true)
                return;
            message.metadata.is_visually_hidden_from_conversation = false;
            changed = true;
        };
        reveal(payload.message);
        if (payload.v && typeof payload.v === "object" && !Array.isArray(payload.v)) {
            reveal(payload.v.message);
        }
        if (Array.isArray(payload.v)) {
            for (const op of payload.v) {
                if (!op || typeof op !== "object")
                    continue;
                if (state.currentPublicId && (((op.p === "/message/metadata/is_hidden" || op.p === "/message/metadata/is_visually_hidden") && op.v === true) ||
                    (op.p === "/message/metadata" && (op.v?.is_hidden === true || op.v?.is_visually_hidden === true)) ||
                    (op.p === "/message/channel" && op.v !== "commentary") ||
                    (op.p === "/message/recipient" && op.v !== "all"))) {
                    revokePublicId(state.currentPublicId);
                    state.currentPublicId = null;
                    state.currentPublicProgress = false;
                }
                if ((op.o === "add" || op.o === "replace") && (op.p === "/message" || op.p === "")) {
                    reveal(op.v);
                }
                else if (state.currentPublicProgress && (op.o === "append" || op.o === "add" || op.o === "replace")
                    && op.p === "/message/metadata" && op.v && typeof op.v === "object"
                    && op.v.is_visually_hidden_from_conversation === true) {
                    // ChatGPT sometimes hides the FOURTH progress message only in a
                    // later metadata patch, even though its initial snapshot was public.
                    op.v.is_visually_hidden_from_conversation = false;
                    changed = true;
                }
                else if (state.currentPublicProgress && (op.o === "add" || op.o === "replace")
                    && op.p === "/message/metadata/is_visually_hidden_from_conversation" && op.v === true) {
                    op.v = false;
                    changed = true;
                }
            }
        }
        return changed ? frame.replace(data[0], "data: " + JSON.stringify(payload)) : frame;
    }
    function wrap(response, body) {
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers });
        Object.defineProperties(wrapped, {
            url: { value: response.url }, redirected: { value: response.redirected }, type: { value: response.type },
        });
        return wrapped;
    }
    // A completed turn can be hydrated from a fresh conversation response.
    // Only full, explicitly public commentary records in the exact mapping
    // are eligible. Never reconstruct missing records or read other endpoints.
    async function rewriteHistory(response, conversationId) {
        if (response.status !== 200 || !response.body ||
            !/^application\/json(?:\s*;|\s*$)/iu.test(response.headers.get("content-type") || ""))
            return response;
        try {
            const url = new URL(response.url);
            if (url.origin !== location.origin || url.pathname !== "/backend-api/conversations/" + conversationId)
                return response;
            const MAX_HISTORY = 16 * 1024 * 1024;
            const length = Number(response.headers.get("content-length") || 0);
            if (length > MAX_HISTORY)
                return response;
            const reader = response.clone().body.getReader();
            const decoder = new TextDecoder();
            let raw = "", bytes = 0;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done)
                        break;
                    bytes += value.byteLength;
                    if (bytes > MAX_HISTORY) {
                        void reader.cancel().catch(() => { });
                        return response;
                    }
                    raw += decoder.decode(value, { stream: true });
                }
                raw += decoder.decode();
            }
            finally {
                reader.releaseLock();
            }
            const payload = JSON.parse(raw);
            if (!payload || typeof payload !== "object" || Array.isArray(payload))
                return response;
            const conversation = payload.mapping || Array.isArray(payload.messages) ? payload : payload.conversation;
            if (!conversation || typeof conversation !== "object" ||
                (conversation.conversation_id !== undefined && conversation.conversation_id !== conversationId) ||
                (conversation.id !== undefined && conversation.id !== conversationId))
                return response;
            const messages = Array.isArray(conversation.messages) ? conversation.messages :
                conversation.mapping && typeof conversation.mapping === "object" && !Array.isArray(conversation.mapping) ?
                    Object.values(conversation.mapping).map(node => node?.message) : [];
            let changed = false;
            for (const message of messages) {
                if (message?.recipient === "all" && isPublicProgress(message) && message.metadata.is_visually_hidden_from_conversation === true) {
                    message.metadata.is_visually_hidden_from_conversation = false;
                    changed = true;
                }
            }
            return changed ? wrap(response, JSON.stringify(payload)) : response;
        }
        catch {
            return response;
        }
    }
    function rewrite(response) {
        if (!response.body || response.status !== 200 ||
            !/^text\/event-stream(?:\s*;|\s*$)/iu.test(response.headers.get("content-type") || ""))
            return response;
        const decoder = new TextDecoder();
        const state = { currentPublicProgress: false, currentPublicId: null };
        let pending = "";
        let passthrough = false;
        const stream = response.body.pipeThrough(new TransformStream({
            transform(value, controller) {
                if (passthrough) {
                    controller.enqueue(value);
                    return;
                }
                pending += decoder.decode(value, { stream: true });
                while (true) {
                    const match = /\r?\n\r?\n/u.exec(pending);
                    if (!match)
                        break;
                    const end = match.index + match[0].length;
                    controller.enqueue(encoder.encode(changeFrame(pending.slice(0, match.index), state) + match[0]));
                    pending = pending.slice(end);
                }
                if (pending.length > MAX_FRAME) {
                    // Do not interpret an oversized or incomplete event.
                    controller.enqueue(encoder.encode(pending + decoder.decode()));
                    pending = "";
                    passthrough = true;
                }
            },
            flush(controller) {
                if (!passthrough) {
                    pending += decoder.decode();
                    if (pending)
                        controller.enqueue(encoder.encode(pending));
                }
            },
        }));
        return wrap(response, stream);
    }
    window.fetch = function (input, init) {
        const result = nativeFetch.apply(this, arguments);
        try {
            const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, location.href);
            const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
            if (url.origin !== location.origin)
                return result;
            if (url.pathname === "/backend-api/f/conversation" && method === "POST")
                return result.then(rewrite);
            const history = /^\/backend-api\/conversations\/([a-f0-9-]{36})$/iu.exec(url.pathname);
            if (method === "GET" && history?.[1])
                return result.then(response => rewriteHistory(response, history[1]));
        }
        catch { /* Unknown requests are untouched. */ }
        return result;
    };
})();
