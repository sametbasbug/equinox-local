import { BrowserWindow, ipcMain, screen, session, shell } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
const states = new Set(["idle", "connecting", "working", "waiting", "success", "needs_attention", "emergency_stopped", "offline"]);
const bounded = (value, limit = 240) => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, limit) : "";
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
/** Only the owning main calls this. No backend, polling, lifecycle ownership or private renderer payload. */
export function createCompanionController(options) {
    const windows = new Map();
    const ready = new Set();
    const urls = new Map();
    for (const surface of ["pet", "actions", "speech"])
        urls.set(surface, `${pathToFileURL(path.join(options.directory, "companion.html")).href}?surface=${surface}`);
    const allowedAssets = new Set([
        ...urls.values(), pathToFileURL(path.join(options.directory, "companion-renderer.js")).href,
        pathToFileURL(path.join(options.directory, "companion.css")).href,
        pathToFileURL(path.join(options.directory, "../app/EquinoxCompanionNyx.webp")).href,
    ]);
    const isolated = session.fromPartition(`equinox-companion-${randomUUID()}`);
    isolated.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on("will-download", event => event.preventDefault());
    isolated.webRequest.onBeforeRequest((details, reply) => reply({ cancel: !allowedAssets.has(details.url) }));
    let language = options.language;
    let state = "offline";
    let visible = false;
    let disposed = false;
    let speech = "";
    let speechId = 0;
    let measuredSpeechId = -1;
    let speechMaxWidth = 360;
    let speechTailBottom = true;
    let speechTailX = 48;
    let dismiss = null;
    let boundsTimer = null;
    let pendingBounds = null;
    let lastSavedBounds = null;
    let lastPointerBegin = -Infinity;
    let lastActivation = -Infinity;
    let drag = null;
    let baseline = false;
    let lastTask = "";
    let lastContinuation = "";
    let lastNotification = "";
    let manualCounter = 0;
    let lastManualKey = "";
    const text = (english, turkish) => language === "tr" ? turkish : english;
    const notify = () => { try {
        options.onVisibilityChanged?.();
    }
    catch { /* Optional observer. */ } };
    function publish(surface) {
        for (const [kind, window] of windows) {
            if ((!surface || surface === kind) && ready.has(kind) && !window.isDestroyed()) {
                window.webContents.send("equinox-companion:snapshot", {
                    ...(kind === "pet" ? { state, paused: !visible } : {}), language,
                    ...(kind === "speech" ? { speech, speechId, maxWidth: speechMaxWidth, tailBottom: speechTailBottom, tailX: speechTailX } : {}),
                });
            }
        }
    }
    function hideSpeech() {
        if (dismiss)
            clearTimeout(dismiss);
        dismiss = null;
        speech = "";
        speechId += 1;
        windows.get("speech")?.hide();
    }
    function hidePopups() { windows.get("actions")?.hide(); hideSpeech(); }
    function clamp(rect) {
        const area = screen.getDisplayMatching(rect).workArea;
        return { ...rect, x: Math.round(Math.max(area.x + 8, Math.min(rect.x, area.x + area.width - rect.width - 8))),
            y: Math.round(Math.max(area.y + 8, Math.min(rect.y, area.y + area.height - rect.height - 8))) };
    }
    function flushBounds() {
        if (boundsTimer)
            clearTimeout(boundsTimer);
        boundsTimer = null;
        const next = pendingBounds;
        pendingBounds = null;
        if (!next || (next.x === lastSavedBounds?.x && next.y === lastSavedBounds?.y))
            return true;
        const saved = options.preferences.read().companionBounds;
        if ((next.x !== saved?.x || next.y !== saved?.y) && !options.preferences.write({ companionBounds: next })) {
            pendingBounds = next;
            return false;
        }
        lastSavedBounds = next;
        return true;
    }
    function saveBounds(flush = false) {
        const pet = windows.get("pet");
        if (pet && !pet.isDestroyed()) {
            const { x, y } = pet.getBounds();
            pendingBounds = x === lastSavedBounds?.x && y === lastSavedBounds?.y ? null : { x, y };
        }
        if (flush) {
            flushBounds();
            return;
        }
        if (!pendingBounds && boundsTimer) {
            clearTimeout(boundsTimer);
            boundsTimer = null;
        }
        // One fixed-delay save, never a growing queue or a renderer-reset debounce.
        if (pendingBounds && !boundsTimer)
            boundsTimer = setTimeout(flushBounds, 500);
    }
    function reveal(surface) {
        const window = windows.get(surface);
        if (!disposed && visible && ready.has(surface) && window && !window.isDestroyed()
            && (surface === "pet" || (surface === "actions" && actionsRequested) || (surface === "speech" && speech)))
            window.showInactive();
    }
    function fail(surface, window) {
        if (windows.get(surface) !== window)
            return;
        if (surface === "pet")
            flushBounds();
        ready.delete(surface);
        windows.delete(surface);
        if (!window.isDestroyed())
            window.destroy();
        if (surface === "actions")
            actionsRequested = false;
        if (surface === "pet") {
            visible = false;
            drag = null;
            actionsRequested = false;
            hidePopups();
            notify();
        }
    }
    function create(surface) {
        const existing = windows.get(surface);
        if (existing && !existing.isDestroyed())
            return existing;
        if (disposed)
            throw new Error("Companion is closed.");
        const size = surface === "pet" ? { width: 132, height: 142 } : surface === "actions" ? { width: 188, height: 124 } : { width: 260, height: 72 };
        const window = new BrowserWindow({
            ...size, show: false, title: "Equinox Companion · Nyx", frame: false, transparent: true,
            backgroundColor: "#00000000", resizable: false, minimizable: false, maximizable: false,
            fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false,
            hasShadow: surface !== "speech", ...(process.platform === "darwin" ? { type: "panel" } : {}),
            webPreferences: { preload: path.join(options.directory, "companion-preload.cjs"), session: isolated,
                sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
                nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true,
                allowRunningInsecureContent: false, spellcheck: false, devTools: false,
            },
        });
        windows.set(surface, window);
        try {
            window.setAlwaysOnTop(true, "floating");
            if (process.platform === "darwin")
                window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
            if (surface === "speech")
                window.setIgnoreMouseEvents(true);
            if (surface === "pet") {
                const area = screen.getPrimaryDisplay().workArea;
                const saved = options.preferences.read().companionBounds;
                const candidate = { ...size, x: saved?.x ?? area.x + area.width - size.width - 28, y: saved?.y ?? area.y + area.height - size.height - 44 };
                // Native restored intersecting frames; reject entirely detached displays, otherwise keep the saved origin.
                const intersects = screen.getAllDisplays().some(({ workArea: a }) => candidate.x < a.x + a.width && candidate.x + size.width > a.x && candidate.y < a.y + a.height && candidate.y + size.height > a.y);
                window.setBounds(intersects ? candidate : { ...size, x: area.x + area.width - size.width - 28, y: area.y + area.height - size.height - 44 });
                // The initial restored/default origin is not a user move or a reason to write.
                const { x, y } = window.getBounds();
                lastSavedBounds = { x, y };
            }
            const contents = window.webContents;
            contents.setWindowOpenHandler(() => ({ action: "deny" }));
            contents.on("will-navigate", event => event.preventDefault());
            contents.on("will-redirect", event => event.preventDefault());
            contents.on("will-frame-navigate", event => event.preventDefault());
            contents.on("will-attach-webview", event => event.preventDefault());
            contents.on("render-process-gone", () => fail(surface, window));
            contents.on("did-fail-load", (_event, _code, _description, _url, mainFrame) => { if (mainFrame)
                fail(surface, window); });
            window.on("closed", () => { if (windows.get(surface) === window) {
                ready.delete(surface);
                windows.delete(surface);
            } });
            window.on("close", event => {
                if (!disposed) {
                    event.preventDefault();
                    if (surface === "pet")
                        setVisible(false);
                    else if (surface === "speech")
                        hideSpeech();
                    else {
                        actionsRequested = false;
                        window.hide();
                    }
                }
            });
            void window.loadURL(urls.get(surface)).then(() => {
                if (disposed || window.isDestroyed() || windows.get(surface) !== window)
                    return;
                ready.add(surface);
                publish(surface);
                // Exactly one completion per created document; consult current intent,
                // so dismissed or replaced requests cannot retain/reveal stale callbacks.
                reveal(surface);
            }).catch(() => fail(surface, window));
            return window;
        }
        catch (error) {
            fail(surface, window);
            throw error;
        }
    }
    function positionPopup(surface, width, height) {
        const pet = windows.get("pet");
        const bounds = pet.getBounds();
        const area = screen.getDisplayMatching(bounds).workArea;
        let x, y;
        if (surface === "actions") {
            x = bounds.x + bounds.width + 8;
            if (x + width > area.x + area.width - 8)
                x = bounds.x - width - 8;
            y = bounds.y + (bounds.height - height) / 2;
        }
        else {
            x = bounds.x + (bounds.width - width) / 2;
            speechTailBottom = bounds.y - height - 5 >= area.y + 8;
            y = speechTailBottom ? bounds.y - height - 5 : bounds.y + bounds.height + 5;
        }
        const result = clamp({ x: Math.round(x), y: Math.round(y), width, height });
        speechTailX = Math.min(width - 26, Math.max(26, bounds.x + bounds.width / 2 - result.x));
        create(surface).setBounds(result);
    }
    function showSpeech(value, seconds) {
        if (!visible || disposed)
            return;
        hideSpeech();
        speech = bounded(value, 240);
        const area = screen.getDisplayMatching(windows.get("pet").getBounds()).workArea;
        speechMaxWidth = Math.min(360, Math.max(1, area.width - 16));
        const width = Math.min(speechMaxWidth, Math.max(252, speech.length * 6.8 + 32));
        const height = Math.min(area.height - 16, Math.max(58, Math.ceil(speech.length * 6.8 / (width - 32)) * 17 + 30));
        positionPopup("speech", Math.round(width), Math.round(height));
        publish("speech");
        reveal("speech");
        dismiss = setTimeout(hideSpeech, seconds * 1000);
    }
    function manualSpeech() {
        const hour = new Date().getHours();
        const greeting = hour >= 5 && hour < 12 ? ["morning", "Good morning. Ready when you are.", "Günaydın. Hazır olduğunda buradayım."]
            : hour >= 12 && hour < 18 ? ["day", "Hope your day is going well.", "Umarım günün iyi gidiyordur."]
                : hour >= 18 && hour < 23 ? ["evening", "Good evening. What's next?", "İyi akşamlar. Sırada ne var?"]
                    : ["night", "Good night… or one more task?", "İyi geceler… yoksa bir görev daha mı?"];
        const choices = [greeting,
            ["need-anything", "Need anything?", "Bir şeye ihtiyacın var mı?"],
            ["watching", "I'm keeping an eye on things.", "Buralara göz kulak oluyorum."],
            ["quiet", "Quiet around here. For now.", "Buralar sakin. Şimdilik."],
            ["one-task", "One task at a time.", "Her seferinde bir görev."],
            ["ready", "Ready for the next thing.", "Sıradaki işe hazırım."],
            ["listening", "I'm here when you need me.", "İhtiyacın olduğunda buradayım."],
        ];
        let index = manualCounter++ % choices.length;
        if (choices[index][0] === lastManualKey)
            index = (index + 1) % choices.length;
        const choice = choices[index];
        lastManualKey = choice[0];
        showSpeech(choice[language === "tr" ? 2 : 1], 4.2);
    }
    let actionsRequested = false;
    function toggleActions() {
        const now = performance.now();
        if (!visible || now - lastActivation < 100)
            return;
        lastActivation = now;
        const actions = windows.get("actions");
        if (actionsRequested || actions?.isVisible()) {
            actionsRequested = false;
            actions?.hide();
            return;
        }
        actionsRequested = true;
        positionPopup("actions", 188, 124);
        publish("actions");
        reveal("actions");
        manualSpeech();
    }
    function setVisible(value, persist = true) {
        if (disposed)
            return;
        try {
            if (value) {
                create("pet");
                visible = true;
                publish();
                if (ready.has("pet"))
                    windows.get("pet").showInactive();
            }
            else {
                saveBounds(true);
                visible = false;
                drag = null;
                actionsRequested = false;
                hidePopups();
                windows.get("pet")?.hide();
                publish();
            }
            if (persist && options.preferences.read().companionVisible !== value)
                options.preferences.write({ companionVisible: value });
            notify();
        }
        catch {
            visible = false;
            notify();
        }
    }
    function trusted(event, surface) {
        const window = windows.get(surface);
        return Boolean(!disposed && window && !window.isDestroyed() && event.sender === window.webContents
            && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === urls.get(surface));
    }
    const action = (event, value) => {
        if (!visible || !trusted(event, "actions") || !windows.get("actions")?.isVisible())
            return;
        if (value !== "new-chat" && value !== "control-center" && value !== "hide")
            return;
        actionsRequested = false;
        windows.get("actions")?.hide();
        if (value === "new-chat")
            void shell.openExternal("https://chatgpt.com/").catch(() => { });
        else if (value === "control-center") {
            try {
                options.openControlCenter();
            }
            catch { /* Optional action. */ }
        }
        else
            setVisible(false);
    };
    const pointer = (event, phase) => {
        if (!visible || !trusted(event, "pet") || !windows.get("pet")?.isVisible())
            return;
        const pet = windows.get("pet");
        const now = performance.now();
        if (phase === "begin") {
            if (drag && now - drag.started > 30_000) {
                drag = null;
                saveBounds();
            }
            if (drag || now - lastPointerBegin < 100)
                return;
            lastPointerBegin = now;
            drag = { cursor: screen.getCursorScreenPoint(), origin: pet.getBounds(), started: now, last: -Infinity, distance: 0 };
            return;
        }
        if ((phase !== "move" && phase !== "end" && phase !== "cancel") || !drag)
            return;
        if (now - drag.started > 30_000) {
            drag = null;
            saveBounds();
            return;
        }
        if (phase === "move" && now - drag.last < 16)
            return;
        drag.last = now;
        const cursor = screen.getCursorScreenPoint();
        const dx = cursor.x - drag.cursor.x, dy = cursor.y - drag.cursor.y;
        if (![dx, dy].every(Number.isFinite) || Math.abs(dx) > 100_000 || Math.abs(dy) > 100_000) {
            drag = null;
            return;
        }
        drag.distance = Math.max(drag.distance, Math.hypot(dx, dy));
        if (phase !== "cancel" && drag.distance >= 4) {
            actionsRequested = false;
            hidePopups();
            pet.setBounds(clamp({ ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy }));
            saveBounds();
        }
        if (phase === "end" || phase === "cancel") {
            const click = phase === "end" && drag.distance < 4;
            drag = null;
            saveBounds();
            if (click)
                toggleActions();
        }
    };
    // Renderer measures only its own public, bounded speech. Main retains geometry authority.
    const measureSpeech = (event, id, width, height) => {
        if (!trusted(event, "speech") || !visible || !speech || id !== speechId || measuredSpeechId === speechId
            || typeof width !== "number" || typeof height !== "number" || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
            || width < Math.min(252, Math.floor(speechMaxWidth)) || width > 360 || height < 58 || height > 512)
            return;
        const pet = windows.get("pet");
        if (!pet || pet.isDestroyed())
            return;
        const area = screen.getDisplayMatching(pet.getBounds()).workArea;
        measuredSpeechId = speechId;
        positionPopup("speech", Math.max(1, Math.min(width, speechMaxWidth)), Math.max(1, Math.min(height, area.height - 16)));
        publish("speech");
    };
    const handleAction = (event, value) => { try {
        action(event, value);
    }
    catch { /* Optional UI only. */ } };
    const handlePointer = (event, phase) => { try {
        pointer(event, phase);
    }
    catch {
        drag = null;
    } };
    const handleMeasurement = (event, id, width, height) => {
        try {
            measureSpeech(event, id, width, height);
        }
        catch { /* Retain the bounded initial speech frame. */ }
    };
    const activate = (event) => { try {
        if (visible && trusted(event, "pet"))
            toggleActions();
    }
    catch { /* Optional UI only. */ } };
    ipcMain.on("equinox-companion:action", handleAction);
    ipcMain.on("equinox-companion:pointer", handlePointer);
    ipcMain.on("equinox-companion:activate", activate);
    ipcMain.on("equinox-companion:measure-speech", handleMeasurement);
    function update(snapshot) {
        if (disposed)
            return;
        if (snapshot.language !== language) {
            language = snapshot.language;
            actionsRequested = false;
            hidePopups();
        }
        const presentation = record(snapshot.presentation);
        state = snapshot.connected && states.has(presentation.state) ? presentation.state : "offline";
        windows.get("pet")?.setOpacity(state === "emergency_stopped" ? 0.72 : 1);
        publish();
        if (!snapshot.connected)
            return;
        const task = record(presentation.task), notification = record(presentation.notification);
        const taskId = typeof task.taskId === "string" && /^task-[a-z0-9-]{6,80}$/u.test(task.taskId) ? task.taskId : "";
        const continuation = bounded(task.continuationStatus, 40);
        const notificationId = bounded(notification.id, 200);
        const title = bounded(task.title) || text("Untitled task", "Adsız görev");
        if (!baseline) {
            baseline = true;
            lastTask = taskId;
            lastContinuation = continuation;
            lastNotification = notificationId;
            return;
        }
        if (notificationId && notificationId !== lastNotification) {
            lastNotification = notificationId;
            if (notification.kind === "task_completed") {
                const name = bounded(notification.body) || title;
                showSpeech(text(`Finished “${name}”.`, `“${name}” tamamlandı.`), 5);
                return;
            }
            if (notification.kind === "fresh_resume_attention") {
                showSpeech(text(`I need you for “${title}”.`, `“${title}” için sana ihtiyacım var.`), 5.5);
                return;
            }
            if (notification.kind === "runtime_attention") {
                showSpeech(text("Something needs attention. Check Control Center.", "Bir şey dikkat gerektiriyor. Kontrol Merkezi'ne bak."), 5.5);
                return;
            }
        }
        else if (!notificationId)
            lastNotification = "";
        if (taskId && task.status === "active" && taskId !== lastTask) {
            lastTask = taskId;
            lastContinuation = continuation;
            showSpeech(text(`Starting “${title}”.`, `“${title}” görevine başlıyorum.`), 5);
            return;
        }
        if (taskId === lastTask && continuation === "delivered" && lastContinuation !== "delivered") {
            lastContinuation = continuation;
            showSpeech(text(`Continuing “${title}”.`, `“${title}” görevine devam ediyorum.`), 5);
            return;
        }
        lastTask = taskId;
        lastContinuation = continuation;
    }
    const displaysChanged = () => {
        try {
            if (!visible)
                return;
            const pet = windows.get("pet");
            if (pet && !pet.isDestroyed()) {
                hidePopups();
                actionsRequested = false;
                pet.setBounds(clamp(pet.getBounds()));
                saveBounds();
            }
        }
        catch { /* A display change cannot stop the runtime. */ }
    };
    screen.on("display-removed", displaysChanged);
    screen.on("display-metrics-changed", displaysChanged);
    if (options.autoShow && options.preferences.available() && options.preferences.read().companionVisible !== false)
        setVisible(true, false);
    return {
        update, setVisible, isVisible: () => visible,
        // Main-only one-time saved-preference application, not renderer authority.
        // No argument flushes genuine user motion before main's missing-field merge.
        applySavedPreferences(saved) {
            if (disposed)
                return;
            if (!flushBounds())
                throw new Error("Pending companion motion could not be persisted.");
            if (!saved)
                return;
            if (saved.companionBounds) {
                const pet = windows.get("pet");
                if (pet && !pet.isDestroyed()) {
                    drag = null;
                    actionsRequested = false;
                    hidePopups();
                    const candidate = { ...pet.getBounds(), ...saved.companionBounds };
                    const intersects = screen.getAllDisplays().some(({ workArea: a }) => candidate.x < a.x + a.width && candidate.x + candidate.width > a.x && candidate.y < a.y + a.height && candidate.y + candidate.height > a.y);
                    const area = screen.getPrimaryDisplay().workArea;
                    pet.setBounds(intersects ? candidate : { ...candidate, x: area.x + area.width - candidate.width - 28, y: area.y + area.height - candidate.height - 44 });
                    const { x, y } = pet.getBounds();
                    lastSavedBounds = { x, y };
                }
            }
            setVisible(saved.companionVisible ?? true, false);
            if (visible !== (saved.companionVisible ?? true))
                throw new Error("Saved companion visibility could not be applied.");
        },
        dispose() {
            if (disposed)
                return;
            saveBounds(true);
            disposed = true;
            visible = false;
            drag = null;
            hideSpeech();
            ipcMain.removeListener("equinox-companion:action", handleAction);
            ipcMain.removeListener("equinox-companion:pointer", handlePointer);
            ipcMain.removeListener("equinox-companion:activate", activate);
            ipcMain.removeListener("equinox-companion:measure-speech", handleMeasurement);
            screen.removeListener("display-removed", displaysChanged);
            screen.removeListener("display-metrics-changed", displaysChanged);
            for (const window of windows.values())
                if (!window.isDestroyed())
                    window.destroy();
            windows.clear();
            ready.clear();
            isolated.webRequest.onBeforeRequest(null);
        },
    };
}
