const byId = (id) => {
    const element = document.getElementById(id);
    if (!element)
        throw new Error("Workspace element missing: " + id);
    return element;
};
const state = { tasks: [], selected: null, filter: "all", search: "", busy: false };
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
            renderTasks();
        });
        list.append(button);
    }
    renderDetail();
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
        state.tasks = taskPayload.tasks.map(safeTask).filter((x) => x !== null);
        updateCounters();
        renderTasks();
        updateHealth(statusPayload);
        byId("connection-text").textContent = "Yerel servis bağlı";
        byId("connection-dot").classList.add("ok");
    }
    catch {
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
    byId("refresh-button").addEventListener("click", () => void refresh());
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden)
            void refresh();
    });
    window.setInterval(() => { if (!document.hidden)
        void refresh(); }, 20000);
    void refresh();
}
boot();
export {};
