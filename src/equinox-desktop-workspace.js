const chatInfo = new Map();
const chatDrafts = new Map();
const chatRequests = new Set();
const chatSending = new Set();
const chatStarting = new Set();
const chatStartBlocked = new Set();
const chatStartErrors = new Map();
const byId = (id) => {
    const element = document.getElementById(id);
    if (!element)
        throw new Error("Workspace element missing: " + id);
    return element;
};
const state = { tasks: [], selected: null, filter: "all", search: "", busy: false, connected: false };
const selectedTaskKey = "equinox-workspace-selected-task";
function rememberSelection() {
    if (!state.selected)
        return;
    try {
        sessionStorage.setItem(selectedTaskKey, state.selected);
    }
    catch { /* Optional tab storage. */ }
}
function node(name, className, value) {
    const el = document.createElement(name);
    if (className)
        el.className = className;
    if (value !== undefined)
        el.textContent = value;
    return el;
}
function safeTask(value) {
    if (!value || typeof value !== "object")
        return null;
    const t = value;
    if (typeof t.taskId !== "string" || !/^task-[a-z0-9-]{6,80}$/u.test(t.taskId))
        return null;
    return {
        taskId: t.taskId,
        title: typeof t.title === "string" ? t.title.slice(0, 200) : "Başlıksız görev",
        objective: typeof t.objective === "string" ? t.objective.slice(0, 12000) : "",
        status: typeof t.status === "string" ? t.status : "unknown",
        completed: Array.isArray(t.completed) ? t.completed.filter((x) => typeof x === "string").slice(0, 64) : [],
        next: Array.isArray(t.next) ? t.next.filter((x) => typeof x === "string").slice(0, 64) : [],
        updatedAt: typeof t.updatedAt === "string" ? t.updatedAt : "",
        chatBound: Boolean(value.chatBinding?.browserContext === "user"),
    };
}
function statusLabel(value) {
    if (value === "active")
        return "Devam ediyor";
    if (value === "completed")
        return "Tamamlandı";
    if (value === "cancelled")
        return "İptal edildi";
    return "Durum bilinmiyor";
}
function formattedDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()))
        return "—";
    return new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", year: "numeric" }).format(date);
}
function visibleTasks() {
    return state.tasks.filter((task) => (state.filter === "all" || (state.filter === "active" ? task.status === "active" : task.status === "completed"))
        && (!state.search || (task.title + " " + task.objective).toLocaleLowerCase("tr").includes(state.search)));
}
function updateCounters() {
    const active = state.tasks.filter((task) => task.status === "active").length;
    const completed = state.tasks.filter((task) => task.status === "completed").length;
    byId("metric-active").textContent = String(active);
    byId("metric-completed").textContent = String(completed);
    byId("all-count").textContent = String(state.tasks.length);
    byId("active-count").textContent = String(active);
}
function makeSteps(values, completed) {
    const list = node("ul", completed ? "step-list complete" : "step-list");
    for (const value of values.slice(0, completed ? 8 : 10)) {
        const row = node("li", "");
        const symbol = node("span", "step-symbol", completed ? "✓" : "→");
        symbol.setAttribute("aria-hidden", "true");
        row.append(symbol, node("span", "", value));
        list.append(row);
    }
    return list;
}
function chatPath(taskId, action) {
    return "/api/v1/tasks/" + encodeURIComponent(taskId) + "/chat/" + action;
}
async function loadChat(taskId) {
    if (chatRequests.has(taskId))
        return;
    chatRequests.add(taskId);
    try {
        const response = await fetch(chatPath(taskId, "status"), { credentials: "same-origin", cache: "no-store" });
        const payload = await response.json();
        if (!response.ok || !payload.ok || !payload.chat)
            throw new Error("Sohbet bağlantısı okunamadı.");
        chatInfo.set(taskId, payload.chat);
    }
    catch {
        // No mutation, no guessed conversation, and no automatic replay.
        chatInfo.set(taskId, { status: "unavailable" });
    }
    finally {
        chatRequests.delete(taskId);
    }
    if (taskId === state.selected)
        renderDetail();
}
async function chatMutation(taskId, action, data) {
    if (chatSending.has(taskId))
        return;
    chatSending.add(taskId);
    if (taskId === state.selected)
        renderDetail();
    try {
        const session = await fetch("/api/v1/session", { credentials: "same-origin", cache: "no-store" });
        const token = await session.json();
        if (!session.ok || typeof token.csrfToken !== "string")
            throw new Error("Güvenli oturum doğrulanamadı.");
        const response = await fetch(chatPath(taskId, action), {
            method: "POST",
            credentials: "same-origin", signal: AbortSignal.timeout(60_000),
            headers: { "content-type": "application/json", "x-equinox-csrf": token.csrfToken },
            body: JSON.stringify(data),
        });
        const payload = await response.json();
        if (!response.ok || !payload.chat)
            throw new Error(payload.error || "Gönderim durumu doğrulanamadı.");
        chatInfo.set(taskId, payload.chat);
        if (action === "send")
            chatDrafts.delete(taskId);
    }
    catch {
        // The browser boundary may already have been crossed. Re-read state,
        // never re-POST automatically, and block a new send until reconciled.
        chatInfo.set(taskId, { status: "unavailable" });
    }
    finally {
        chatSending.delete(taskId);
    }
    if (taskId === state.selected)
        renderDetail();
    void loadChat(taskId);
}
async function postAction(path, data, timeoutMs = 25_000) {
    const session = await fetch("/api/v1/session", {
        credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    const token = await session.json();
    if (!session.ok || typeof token.csrfToken !== "string")
        throw new Error("Güvenli oturum doğrulanamadı.");
    const response = await fetch(path, {
        method: "POST", credentials: "same-origin", signal: AbortSignal.timeout(timeoutMs),
        headers: { "content-type": "application/json", "x-equinox-csrf": token.csrfToken },
        body: JSON.stringify(data),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok || !payload.task)
        throw new Error(payload.error || "İşlem tamamlanamadı.");
    return payload;
}
async function startTaskChat(taskId) {
    if (chatStarting.has(taskId) || chatStartBlocked.has(taskId))
        return;
    chatStarting.add(taskId);
    if (taskId === state.selected)
        renderDetail();
    try {
        const response = await postAction(chatPath(taskId, "start"), {}, 60_000);
        if (!response.task?.chatBinding) {
            throw new Error("Sohbet bağlantısı doğrulanamadı.");
        }
        chatStartErrors.delete(taskId);
        chatInfo.delete(taskId);
        const task = state.tasks.find((entry) => entry.taskId === taskId);
        if (task)
            task.chatBound = true;
        renderTasks();
        void refresh();
        void loadChat(taskId);
    }
    catch {
        // A remote tab may already exist. The user must inspect it first.
        chatStartBlocked.add(taskId);
        chatStartErrors.set(taskId, "Bağlantı doğrulanamadı veya zaman aşımına uğradı. ChatGPT sekmesi açılmış olabilir. Sekmeyi kontrol et; bu oturumda yeniden başlatma kapalı.");
    }
    finally {
        chatStarting.delete(taskId);
        if (taskId === state.selected)
            renderDetail();
    }
}
function bindNewTaskDialog() {
    const dialog = byId("new-task-dialog");
    const form = byId("new-task-form");
    const opener = () => {
        byId("new-task-error").textContent = "";
        if (!dialog.open)
            dialog.showModal();
    };
    byId("new-task").addEventListener("click", opener);
    byId("new-task-welcome").addEventListener("click", opener);
    byId("new-task-close").addEventListener("click", () => dialog.close());
    byId("new-task-cancel").addEventListener("click", () => dialog.close());
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const name = byId("new-task-name").value.trim();
        const objective = byId("new-task-objective").value.trim();
        if (!name || objective.length < 12)
            return;
        const submit = byId("new-task-submit");
        if (!state.connected) {
            byId("new-task-error").textContent = "Yerel servis bağlı değil. Bağlantı geri geldiğinde yeniden deneyebilirsin.";
            return;
        }
        if (submit.disabled)
            return;
        submit.disabled = true;
        void (async () => {
            try {
                const result = await postAction("/api/v1/tasks/create", { title: name, objective });
                if (!result.task?.taskId)
                    throw new Error("Görev kimliği alınamadı.");
                dialog.close();
                form.reset();
                state.search = "";
                byId("task-search").value = "";
                setFilter("all");
                state.selected = result.task.taskId;
                rememberSelection();
                await refresh();
                const scroller = document.querySelector(".main-scroll");
                if (scroller)
                    scroller.scrollTo({ top: byId("work-section").offsetTop - 66, behavior: "smooth" });
            }
            catch {
                byId("new-task-error").textContent = "İşlemin sonucu doğrulanamadı. Tekrar oluşturmadan önce görev listesini yenile.";
            }
            finally {
                submit.disabled = false;
            }
        })();
    });
}
function appendChat(target, task) {
    const card = node("section", "chat-card");
    card.id = "task-chat";
    card.setAttribute("aria-label", "Göreve bağlı ChatGPT sohbeti");
    const title = node("div", "chat-card-title");
    title.append(node("h4", "", "Göreve bağlı sohbet"), node("span", "chat-provider", "ChatGPT · Your Browser"));
    card.append(title);
    if (task.status !== "active" || !task.chatBound) {
        card.append(node("p", "chat-hint", task.status === "active"
            ? "Bu göreve henüz bir sohbet bağlanmadı. Hazırsan ChatGPT'de ayrı bir konuşma oluşturabilirsin; görevin kendiliğinden çalışmaya başlamaz."
            : "Tamamlanan veya iptal edilen görevlerde yeni sohbet başlatılamaz."));
        if (task.status === "active") {
            const button = node("button", "chat-start", chatStarting.has(task.taskId)
                ? "Konuşma oluşturuluyor…" : "ChatGPT konuşmasını başlat ↗");
            button.type = "button";
            button.disabled = !state.connected || chatStarting.has(task.taskId) || chatStartBlocked.has(task.taskId);
            button.addEventListener("click", () => void startTaskChat(task.taskId));
            card.append(button);
        }
        if (chatStartErrors.has(task.taskId))
            card.append(node("p", "chat-status warning", chatStartErrors.get(task.taskId)));
        target.append(card);
        return;
    }
    const info = chatInfo.get(task.taskId);
    if (!info) {
        card.append(node("p", "chat-hint", "Sohbetin durumu yükleniyor…"));
        target.append(card);
        void loadChat(task.taskId);
        return;
    }
    if (info.conversationUrl) {
        const link = node("a", "chat-conversation-link", "Bağlı ChatGPT konuşmasını aç ↗");
        link.href = info.conversationUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        card.append(link);
    }
    if (info.message) {
        const outgoing = node("div", "chat-bubble outgoing");
        outgoing.append(node("span", "chat-person", "SEN"), node("p", "", info.message));
        card.append(outgoing);
    }
    if (info.status === "ready" && info.response) {
        const incoming = node("div", "chat-bubble incoming");
        incoming.append(node("span", "chat-person", "CHATGPT"), node("p", "", info.response));
        if (info.truncated)
            incoming.append(node("small", "", "Yanıt kesilmiş olabilir; ayrıntı için ChatGPT konuşmasını aç."));
        card.append(incoming);
    }
    const status = {
        idle: "Bu görevde son gönderilen mesaj burada görünecek. Eski sohbet geçmişi ChatGPT sekmesinde tutulur.",
        sending: "Mesaj gönderiliyor…",
        waiting: "Mesaj gönderildi. ChatGPT yanıtı bekleniyor…",
        ready: "Son yanıt alındı.",
        uncertain: "Gönderim ya da yanıt durumu belirsiz. ChatGPT sekmesini kontrol etmeden yeniden mesaj gönderme.",
        unavailable: "Sohbet durumu doğrulanamadı. Mesajı tekrar gönderme; önce ChatGPT sekmesini kontrol et.",
    }[info.status];
    card.append(node("p", "chat-status" + (info.status === "uncertain" || info.status === "unavailable" ? " warning" : ""), status));
    if (info.status === "unavailable" && !info.requestId) {
        const resume = node("button", "chat-acknowledge", "ChatGPT sekmesini kontrol ettim · Devam et");
        resume.type = "button";
        resume.addEventListener("click", () => {
            if (window.confirm("Göreve bağlı ChatGPT konuşmasını açıp son mesajı ve yanıtı kontrol ettin mi? Bu onay gönderimi tekrarlamaz; yalnızca Workspace'te yeni mesaj yazmayı etkinleştirir.")) {
                void chatMutation(task.taskId, "acknowledge", { requestId: "confirm-inspected" });
            }
        });
        card.append(resume);
    }
    if (info.status === "uncertain" && info.requestId) {
        const acknowledge = node("button", "chat-acknowledge", "Sekmeyi kontrol ettim · Kilidi kaldır");
        acknowledge.type = "button";
        acknowledge.addEventListener("click", () => {
            if (window.confirm("ChatGPT konuşmasını kontrol ettiğini onaylıyor musun? Bu işlem mesajı yeniden göndermez. Emin değilsen iptal et.")) {
                void chatMutation(task.taskId, "acknowledge", { requestId: info.requestId });
            }
        });
        card.append(acknowledge);
    }
    const form = node("form", "chat-form");
    const input = node("input", "chat-input");
    input.type = "text";
    input.maxLength = 3800;
    input.placeholder = "Bu göreve bir mesaj yaz…";
    input.setAttribute("aria-label", "Göreve bağlı ChatGPT mesajı");
    input.autocomplete = "off";
    input.value = chatDrafts.get(task.taskId) || "";
    input.addEventListener("input", () => chatDrafts.set(task.taskId, input.value));
    const send = node("button", "chat-send", "Gönder ↗");
    send.type = "submit";
    const blocked = !state.connected || chatSending.has(task.taskId) || !["idle", "ready"].includes(info.status);
    input.disabled = blocked;
    send.disabled = blocked;
    form.append(input, send);
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        const message = input.value.trim();
        if (!message || blocked || message.length > 3800)
            return;
        const requestId = crypto.randomUUID().toLowerCase();
        void chatMutation(task.taskId, "send", { message, requestId });
    });
    card.append(form, node("p", "chat-footnote", "Önizleme: tek satırlık mesajlar desteklenir. Bu özellik mevcut ChatGPT konuşmasını kullanır; bağımsız model API'si değildir."));
    target.append(card);
}
function renderDetail() {
    const target = byId("task-detail");
    target.replaceChildren();
    const task = state.tasks.find((item) => item.taskId === state.selected);
    const stateTag = byId("detail-state");
    if (!task) {
        stateTag.textContent = "—";
        stateTag.className = "state-tag";
        const empty = node("div", "detail-placeholder");
        empty.append(node("div", "detail-placeholder-icon", "✧"));
        empty.append(node("h3", "", "Bir görev seç"));
        empty.append(node("p", "", "Yapılanları, sıradaki işleri ve hedefini burada görebilirsin."));
        target.append(empty);
        return;
    }
    stateTag.textContent = statusLabel(task.status);
    stateTag.className = task.status === "completed" ? "state-tag done" : "state-tag";
    target.append(node("h3", "detail-title", task.title));
    if (task.objective)
        target.append(node("p", "detail-objective", task.objective));
    appendChat(target, task);
    target.append(node("h4", "detail-subtitle", "SIRADAKİ ADIMLAR"));
    if (task.next.length)
        target.append(makeSteps(task.next, false));
    else
        target.append(node("p", "detail-objective", task.status === "active" ? "Sıradaki adım henüz belirlenmedi." : "Bu görev için bekleyen adım yok."));
    if (task.completed.length) {
        const details = node("details", "detail-details");
        const summary = node("summary", "", "Tamamlanan adımlar (" + task.completed.length + ")");
        details.append(summary, makeSteps(task.completed, true));
        target.append(details);
    }
    const actions = node("div", "detail-actions");
    const manage = node("a", "detail-link", "Görevi yönet ↗");
    manage.href = "/?task=" + encodeURIComponent(task.taskId);
    const updated = node("span", "detail-secondary", "Son güncelleme: " + formattedDate(task.updatedAt));
    actions.append(manage, updated);
    target.append(actions);
}
function renderTasks() {
    // A periodic task update must not steal focus from someone composing a message
    // or navigating the task list by keyboard. The DOM nodes are replaced below.
    const focused = document.activeElement;
    const chatInputFocused = focused instanceof HTMLInputElement && focused.matches("#task-chat .chat-input");
    const focusedTaskId = focused instanceof HTMLButtonElement && focused.classList.contains("task-item")
        ? focused.dataset.taskId : null;
    const originalSelection = state.selected;
    const caret = chatInputFocused && focused instanceof HTMLInputElement
        ? { start: focused.selectionStart ?? focused.value.length, end: focused.selectionEnd ?? focused.value.length }
        : null;
    const list = byId("task-list");
    const tasks = visibleTasks();
    const titles = { all: "Tüm görevler", active: "Devam eden görevler", completed: "Tamamlanan görevler" };
    byId("list-title").textContent = titles[state.filter];
    byId("list-count").textContent = tasks.length + " görev";
    if (!tasks.some((task) => task.taskId === state.selected))
        state.selected = tasks[0]?.taskId ?? null;
    list.replaceChildren();
    if (!tasks.length) {
        list.append(node("div", "task-empty", state.search ? "Bu aramayla eşleşen görev bulunamadı." : "Bu bölümde henüz görev bulunmuyor. Kontrol Merkezi'nden görevlerini yönetebilirsin."));
    }
    for (const task of tasks) {
        const button = node("button", "task-item" + (task.taskId === state.selected ? " is-selected" : ""));
        button.type = "button";
        button.dataset.taskId = task.taskId;
        button.setAttribute("aria-pressed", task.taskId === state.selected ? "true" : "false");
        const icon = node("span", "task-indicator" + (task.status === "completed" ? " done" : ""), task.status === "completed" ? "✓" : "◷");
        icon.setAttribute("aria-hidden", "true");
        const copy = node("span", "task-copy");
        copy.append(node("span", "task-title", task.title));
        copy.append(node("span", "task-summary", task.objective || statusLabel(task.status)));
        copy.append(node("span", "task-meta", statusLabel(task.status) + " · " + formattedDate(task.updatedAt)));
        button.append(icon, copy, node("span", "task-caret", "›"));
        button.addEventListener("click", () => {
            state.selected = task.taskId;
            rememberSelection();
            renderTasks();
            if (task.chatBound && task.status === "active")
                void loadChat(task.taskId);
        });
        button.addEventListener("keydown", (event) => {
            const index = tasks.findIndex((entry) => entry.taskId === task.taskId);
            let nextIndex = index;
            if (event.key === "ArrowDown")
                nextIndex = Math.min(index + 1, tasks.length - 1);
            else if (event.key === "ArrowUp")
                nextIndex = Math.max(index - 1, 0);
            else if (event.key === "Home")
                nextIndex = 0;
            else if (event.key === "End")
                nextIndex = tasks.length - 1;
            else
                return;
            event.preventDefault();
            const next = tasks[nextIndex];
            if (!next)
                return;
            state.selected = next.taskId;
            rememberSelection();
            renderTasks();
            const target = [...list.querySelectorAll(".task-item")]
                .find((entry) => entry.dataset.taskId === next.taskId);
            target?.focus({ preventScroll: true });
            target?.scrollIntoView({ block: "nearest" });
        });
        list.append(button);
    }
    renderDetail();
    if (chatInputFocused && originalSelection === state.selected && caret) {
        const input = document.querySelector("#task-chat .chat-input");
        if (input && !input.disabled) {
            input.focus({ preventScroll: true });
            input.setSelectionRange(Math.min(caret.start, input.value.length), Math.min(caret.end, input.value.length));
        }
    }
    else if (focusedTaskId) {
        const button = [...list.querySelectorAll(".task-item")]
            .find((item) => item.dataset.taskId === focusedTaskId);
        button?.focus({ preventScroll: true });
    }
}
function setFilter(filter) {
    state.filter = filter;
    for (const button of document.querySelectorAll("[data-filter]")) {
        const selected = button.dataset.filter === filter;
        button.classList.toggle("is-active", selected);
        if (selected)
            button.setAttribute("aria-current", "page");
        else
            button.removeAttribute("aria-current");
    }
    renderTasks();
}
function updateHealth(data) {
    const healthValue = data?.status?.health;
    const health = typeof healthValue === "string" ? healthValue
        : typeof healthValue === "object" && healthValue && "state" in healthValue
            ? String(healthValue.state) : "";
    const healthy = health.toUpperCase() === "HEALTHY";
    const label = healthy ? "Çalışıyor" : health ? "Kontrol gerekli" : "Bağlı";
    byId("metric-health").textContent = label;
    byId("metric-health").classList.toggle("attention", !healthy);
}
async function refresh() {
    if (state.busy)
        return;
    state.busy = true;
    const button = byId("refresh-button");
    button.disabled = true;
    try {
        const options = {
            headers: { "x-equinox-background-refresh": "1" },
            cache: "no-store",
            credentials: "same-origin",
            signal: AbortSignal.timeout(8000),
        };
        const [tasksResult, statusResult] = await Promise.all([
            fetch("/api/v1/tasks", options),
            fetch("/api/v1/status", options),
        ]);
        if (!tasksResult.ok || !statusResult.ok)
            throw new Error("Yerel servis yanıt vermiyor.");
        const taskPayload = await tasksResult.json();
        const statusPayload = await statusResult.json();
        if (!Array.isArray(taskPayload.tasks))
            throw new Error("Görev bilgileri alınamadı.");
        const updated = taskPayload.tasks.map(safeTask).filter((x) => x !== null);
        const changed = JSON.stringify(updated) !== JSON.stringify(state.tasks);
        state.tasks = updated;
        updateCounters();
        if (changed)
            renderTasks();
        updateHealth(statusPayload);
        const restored = !state.connected;
        state.connected = true;
        byId("connection-alert").hidden = true;
        if (restored) {
            renderDetail();
            const selected = state.tasks.find((entry) => entry.taskId === state.selected);
            if (selected?.chatBound && chatInfo.get(selected.taskId)?.status === "unavailable")
                void loadChat(selected.taskId);
        }
        byId("connection-text").textContent = "Yerel servis bağlı";
        byId("connection-dot").classList.add("ok");
    }
    catch {
        const lost = state.connected;
        state.connected = false;
        byId("connection-alert").hidden = false;
        if (lost)
            renderDetail();
        byId("connection-text").textContent = "Bağlantı yok";
        byId("connection-dot").classList.remove("ok");
        byId("metric-health").textContent = "Bağlantı yok";
        byId("metric-health").classList.add("attention");
        if (!state.tasks.length)
            byId("task-list").replaceChildren(node("div", "task-empty error-text", "Görevler alınamadı. Equinox Local servisinin çalıştığından emin ol ve yeniden dene."));
    }
    finally {
        state.busy = false;
        button.disabled = false;
    }
}
function boot() {
    try {
        const remembered = sessionStorage.getItem(selectedTaskKey);
        if (remembered && /^task-[a-z0-9-]{6,80}$/u.test(remembered))
            state.selected = remembered;
    }
    catch { /* Optional tab storage. */ }
    byId("today-label").textContent = new Intl.DateTimeFormat("tr-TR", {
        day: "numeric", month: "long", year: "numeric",
    }).format(new Date());
    for (const button of document.querySelectorAll("[data-filter]")) {
        button.addEventListener("click", () => setFilter(button.dataset.filter));
    }
    byId("show-active").addEventListener("click", () => {
        setFilter("active");
        byId("work-section").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    byId("task-search").addEventListener("input", (event) => {
        state.search = event.target.value.trim().toLocaleLowerCase("tr").slice(0, 120);
        renderTasks();
    });
    byId("open-chat").addEventListener("click", () => {
        const scroller = document.querySelector(".main-scroll");
        const card = byId("task-chat");
        if (scroller) {
            const offset = card.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
            scroller.scrollTo({ top: scroller.scrollTop + offset - 110, behavior: "smooth" });
        }
        document.querySelector("#task-chat .chat-input")?.focus({ preventScroll: true });
    });
    bindNewTaskDialog();
    byId("refresh-button").addEventListener("click", () => void refresh());
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden)
            void refresh();
    });
    window.setInterval(() => { if (!document.hidden)
        void refresh(); }, 20000);
    // A disconnected workspace should recover promptly, but never re-POST a
    // potentially delivered task/chat mutation.
    window.setInterval(() => { if (!document.hidden && !state.connected)
        void refresh(); }, 5000);
    window.setInterval(() => {
        if (document.hidden || !state.selected || chatRequests.has(state.selected))
            return;
        const info = chatInfo.get(state.selected);
        if (info && ["sending", "waiting"].includes(info.status))
            void loadChat(state.selected);
    }, 5000);
    void refresh();
}
boot();
export {};
