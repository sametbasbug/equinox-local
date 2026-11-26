/**
 * Presentation-only isolated-world bridge. Every row is anchored to the
 * original host-created invocation frame and response-body, never a runtime
 * log, inferred conversation, or reconstructed tool call. No privileged IPC,
 * arbitrary script, persistent data, network request or tool execution.
 */
export function decorateNativeToolActivity(update, generation) {
    const world = window;
    if (world.__equinoxRunTimeline && world.__equinoxRunTimeline.generation > generation)
        return;
    if (update && (location.origin !== "https://chatgpt.com" || location.pathname !== update.pathname))
        return;
    world.__equinoxRunTimeline?.dispose();
    if (!update) {
        delete world.__equinoxRunTimeline;
        return;
    }
    const route = location.origin + location.pathname;
    const sameRoute = () => location.origin + location.pathname === route;
    const tr = (en, turkish) => update.language === "tr" ? turkish : en;
    const selector = "[data-response-body] > [data-mcp-app-portal-target] iframe";
    const entries = new Map();
    const expanded = new WeakMap();
    let scheduled = 0;
    let disposed = false;
    let frames = 0, candidates = 0, requests = 0, replies = 0, accepted = 0;
    const valid = (e) => !disposed && sameRoute() && e.frame.isConnected && e.body.isConnected &&
        e.frame.src === e.src && e.body.getAttribute("data-response-body") === e.id &&
        e.portal.parentElement === e.body && e.portal.contains(e.frame);
    // WindowProxy exposes child references across origins without granting DOM
    // access. The observed provider shell has exactly one inner resource frame.
    // Do not enumerate arbitrary descendants or deliver data to them.
    const resourceWindow = (e) => {
        try {
            const outer = e.frame.contentWindow;
            if (!outer)
                return null;
            if (outer.length === 0)
                return outer;
            return outer.length === 1 ? outer.frames[0] ?? null : null;
        }
        catch {
            return null;
        }
    };
    const request = (e) => {
        if (!valid(e))
            return;
        const target = resourceWindow(e);
        if (!target)
            return;
        requests = Math.min(10000, requests + 1);
        // An inner sandbox may have an opaque origin. Only an opaque random
        // challenge is sent with wildcard targeting, never command/result data.
        target.postMessage({ type: "equinox-native-run/request-v1", nonce: e.nonce }, target === e.frame.contentWindow ? e.origin : "*");
    };
    const forget = (e) => {
        for (const timer of e.timers)
            window.clearTimeout(timer);
        e.host?.remove();
        e.collapsedSlot?.removeAttribute("data-equinox-run-collapsed");
        e.body.removeAttribute("data-equinox-native-run");
        entries.delete(e.frame);
    };
    function reconcileGroups() {
        const ready = [...entries.values()].filter(e => e.host?.isConnected && e.row && valid(e))
            .sort((a, b) => a.body.compareDocumentPosition(b.body) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
        const groups = [];
        const slot = (e) => {
            const p = e.body.parentElement;
            return p?.parentElement?.getAttribute("data-spacing") === "activity" && p.children.length === 1 ? p : e.body;
        };
        for (const e of ready) {
            const last = groups.at(-1)?.at(-1), previous = last && slot(last), current = slot(e);
            let adjacent = false;
            if (previous && previous.parentElement === current.parentElement &&
                current.parentElement?.getAttribute("data-spacing") === "activity") {
                let next = previous.nextElementSibling;
                while (next && next !== current && !next.textContent?.trim() && !next.querySelector("iframe,button,img,video,canvas,svg"))
                    next = next.nextElementSibling;
                adjacent = next === current;
            }
            if (adjacent)
                groups.at(-1).push(e);
            else
                groups.push([e]);
        }
        for (const e of ready) {
            e.collapsedSlot?.removeAttribute("data-equinox-run-collapsed");
            delete e.collapsedSlot;
            e.host.classList.remove("eq-run-nested");
        }
        for (const group of groups) {
            const first = group[0];
            for (const e of group.slice(1)) {
                e.group?.remove();
                delete e.group;
            }
            if (group.length === 1) {
                first.group?.remove();
                delete first.group;
                first.row.hidden = false;
                continue;
            }
            const open = expanded.get(first.body) ?? group.some(e => e.status === "running");
            const commands = group.filter(e => e.operation === "terminal_exec").length;
            const other = group.length - commands;
            const title = [commands ? tr(commands === 1 ? "1 command" : commands + " commands", commands + " komut") : "",
                other ? tr(other === 1 ? "1 tool call" : other + " tool calls", other + " araç çağrısı") : ""].filter(Boolean).join(" · ");
            if (!first.group) {
                first.group = document.createElement("button");
                first.group.type = "button";
                first.group.className = "eq-run-group";
                first.host.prepend(first.group);
            }
            const button = first.group;
            button.textContent = title;
            button.setAttribute("aria-expanded", String(open));
            button.onclick = () => { expanded.set(first.body, button.getAttribute("aria-expanded") !== "true"); reconcileGroups(); };
            for (const e of group) {
                e.row.hidden = !open;
                e.host.classList.add("eq-run-nested");
                if (!open && e !== first) {
                    e.collapsedSlot = slot(e);
                    e.collapsedSlot.setAttribute("data-equinox-run-collapsed", "");
                }
            }
        }
    }
    function onMessage(event) {
        if (disposed || !sameRoute() || event.data?.type !== "equinox-native-run/v1")
            return;
        replies = Math.min(10000, replies + 1);
        const e = [...entries.values()].find(x => {
            const source = resourceWindow(x);
            return source !== null && source === event.source && x.nonce === event.data.nonce &&
                (event.origin === x.origin || (source !== x.frame.contentWindow && event.origin === "null"));
        });
        if (!e || !valid(e))
            return;
        const d = event.data.data;
        if (!d || typeof d.operation !== "string" || !/^[a-z][a-z0-9_]{0,159}$/.test(d.operation) ||
            !["running", "success", "complete", "failed", "cancelled", "background"].includes(d.state))
            return;
        const str = (v, n) => typeof v === "string" ? v.slice(0, n) : "";
        const command = str(d.command, 12000);
        if (d.operation === "terminal_exec" && !command)
            return;
        const data = { operation: d.operation, state: d.state, command, stdout: str(d.stdout, 24000), stderr: str(d.stderr, 24000),
            result: str(d.result, 24000), error: str(d.error, 24000), truncated: d.truncated === true,
            exit: Number.isSafeInteger(d.exitCode) ? Number(d.exitCode) : null,
            duration: typeof d.durationMs === "number" && Number.isFinite(d.durationMs) && d.durationMs >= 0 ? Math.round(d.durationMs) : null };
        accepted = Math.min(10000, accepted + 1);
        const signature = JSON.stringify(data);
        if (signature === e.signature && e.host?.isConnected)
            return;
        const wasOpen = e.row?.open ?? false;
        const wasFocused = e.row?.querySelector("summary") === document.activeElement;
        if (!e.host?.isConnected) {
            e.host = document.createElement("div");
            e.host.className = "eq-run-host";
            e.host.setAttribute("data-equinox-activity-ui", "");
            e.body.append(e.host);
        }
        e.row?.remove();
        const row = document.createElement("details");
        row.className = "eq-run-row";
        row.open = wasOpen;
        const summary = document.createElement("summary");
        const icon = document.createElement("span");
        icon.className = "eq-run-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = data.operation === "terminal_exec" ? "›_" : "◇";
        const name = document.createElement("span");
        name.className = "eq-run-label";
        name.textContent = command || data.operation.replace(/_/g, " ");
        name.title = name.textContent;
        const status = document.createElement("span");
        status.className = "eq-run-status";
        status.dataset.kind = data.state;
        status.textContent = data.state === "running" ? tr("Running", "Çalışıyor") : data.state === "failed" ? tr("Failed", "Başarısız") :
            data.state === "cancelled" ? tr("Cancelled", "İptal") : data.state === "background" ? tr("Background", "Arka planda") :
                data.state === "success" ? tr("Success", "Başarılı") : tr("Completed", "Tamamlandı");
        summary.append(icon, name, status);
        row.append(summary);
        const detail = document.createElement("div");
        detail.className = "eq-run-detail";
        const heading = document.createElement("div");
        heading.className = "eq-run-detail-label";
        heading.textContent = command ? "Shell" : tr("Result", "Sonuç");
        detail.append(heading);
        const pre = (value) => { if (value) {
            const el = document.createElement("pre");
            el.textContent = value;
            detail.append(el);
        } };
        pre(command ? "$ " + command : "");
        pre(data.stdout);
        if (data.stderr)
            pre("stderr\n" + data.stderr);
        pre(data.error);
        pre(data.result);
        if (data.state === "running")
            pre(tr("Waiting for result…", "Sonuç bekleniyor…"));
        const footer = document.createElement("div");
        footer.className = "eq-run-footer";
        footer.textContent = [
            data.truncated ? tr("Output truncated", "Çıktı kısaltıldı") : "",
            data.exit !== null ? tr("Exit ", "Çıkış ") + data.exit : "",
            data.duration !== null ? data.duration + " ms" : "", status.textContent
        ].filter(Boolean).join(" · ");
        detail.append(footer);
        row.append(detail);
        e.host.append(row);
        e.row = row;
        e.operation = data.operation;
        e.status = data.state;
        e.signature = signature;
        e.body.setAttribute("data-equinox-native-run", "");
        reconcileGroups();
        if (wasFocused && !row.hidden)
            summary.focus({ preventScroll: true });
    }
    function scan() {
        scheduled = 0;
        if (disposed)
            return;
        if (!sameRoute()) {
            dispose();
            return;
        }
        let changed = false;
        for (const e of entries.values())
            if (!valid(e)) {
                forget(e);
                changed = true;
            }
        const mounted = Array.from(document.querySelectorAll(selector)).slice(-120);
        frames = Math.max(frames, mounted.length);
        for (const frame of mounted) {
            if (entries.has(frame))
                continue;
            const portal = frame.closest("[data-mcp-app-portal-target]"), body = portal?.parentElement;
            const id = body?.getAttribute("data-response-body");
            if (!body || !portal || !id || body.querySelectorAll(selector).length !== 1)
                continue;
            let origin;
            try {
                origin = new URL(frame.src).origin;
            }
            catch {
                continue;
            }
            if (!/^https:\/\/connector-id-[a-f0-9-]+\.web-sandbox\.oaiusercontent\.com$/u.test(origin) ||
                frame.closest("[data-mcp-app-origin-generated]")?.getAttribute("data-mcp-app-origin-generated") !== origin)
                continue;
            const e = { frame, body, portal, id, src: frame.src, origin, nonce: crypto.randomUUID(), timers: [] };
            candidates = Math.min(10000, candidates + 1);
            entries.set(frame, e);
            for (const delay of [0, 300, 1200, 4000, 9000, 16000])
                e.timers.push(window.setTimeout(() => request(e), delay));
        }
        if (changed)
            reconcileGroups();
    }
    function schedule() { if (!disposed && !scheduled)
        scheduled = requestAnimationFrame(scan); }
    const observer = new MutationObserver(records => {
        if (records.some(r => !(r.target instanceof Element) || !r.target.closest("[data-equinox-activity-ui]")))
            schedule();
    });
    function onLoad(event) { if (event.target instanceof HTMLIFrameElement) {
        const e = entries.get(event.target);
        if (e)
            request(e);
        else
            schedule();
    } }
    function dispose() {
        if (disposed)
            return;
        disposed = true;
        observer.disconnect();
        if (scheduled)
            cancelAnimationFrame(scheduled);
        window.removeEventListener("message", onMessage);
        window.removeEventListener("load", onLoad, true);
        for (const e of entries.values())
            forget(e);
    }
    world.__equinoxRunTimeline = { generation, dispose, inspect: () => ({ frames, candidates, requests, replies, accepted }) };
    window.addEventListener("message", onMessage);
    window.addEventListener("load", onLoad, true);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "data-response-body", "data-mcp-app-portal-target", "data-mcp-app-origin-generated", "data-spacing"] });
    scan();
}
