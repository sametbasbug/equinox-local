import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { prepareEquinoxBrowserSocketDirectory } from "./equinox-browser-socket.js";
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TASK_ID = /^task-[a-z0-9-]{6,80}$/u;
const OPERATION = /^[a-z][a-z0-9_.-]{0,159}$/u;
function requiredString(value, label, max = 4096) {
    if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
        throw new Error(`${label} is invalid.`);
    return value;
}
function taskId(input) {
    const id = requiredString(input.task, "task", 90);
    if (!TASK_ID.test(id))
        throw new Error("Expected an exact Task Capsule id.");
    return id;
}
function unpack(result) {
    if (!result || typeof result !== "object" || !Array.isArray(result.content))
        return result;
    if (result.isError)
        throw new Error(result.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n") || "Capability failed.");
    if (result.structuredContent !== undefined)
        return result.structuredContent;
    if (result.content.length === 1 && result.content[0]?.type === "text") {
        const text = result.content[0].text;
        if (typeof text === "string") {
            try {
                return JSON.parse(text);
            }
            catch {
                return text;
            }
        }
    }
    return result;
}
export function createEquinoxLocalCliBridge({ stateRoot, platform = process.platform, namespace = null, registry, desktop, tasks, chat, assertMutationAllowed }) {
    const discoveryPath = path.join(stateRoot, "cli-ipc.json");
    let server = null;
    let socketPath = null;
    let session = null;
    const inflight = new Set();
    const connections = new Set();
    async function summary() {
        const base = registry.summary();
        let extra;
        try {
            const catalog = await desktop.catalog();
            extra = { domain: "desktop", label: catalog.label || "Desktop", count: catalog.count || 0, callTool: "desktop_call" };
        }
        catch {
            extra = { domain: "desktop", label: "Desktop", count: 0, callTool: "desktop_call", available: false };
        }
        return { ...base, operationCount: (base.operationCount || 0) + Number(extra.count || 0), domains: [...(base.domains || []), extra] };
    }
    async function dispatch(input) {
        const action = requiredString(input.action, "action", 64);
        if (action === "status")
            return { connected: true, protocol: 1, capabilities: await summary() };
        if (action === "tools.list") {
            if (input.domain === undefined)
                return summary();
            const domain = requiredString(input.domain, "domain", 32);
            return domain === "desktop" ? desktop.catalog() : registry.catalog(domain);
        }
        if (action === "tools.describe") {
            const domain = requiredString(input.domain, "domain", 32);
            const operation = requiredString(input.operation, "operation", 160);
            if (!OPERATION.test(operation))
                throw new Error("Invalid operation name.");
            return domain === "desktop" ? desktop.describe(operation) : registry.describe(domain, operation);
        }
        if (action === "tools.call") {
            const domain = requiredString(input.domain, "domain", 32);
            const operation = requiredString(input.operation, "operation", 160);
            if (!OPERATION.test(operation))
                throw new Error("Invalid operation name.");
            const args = input.args ?? {};
            if (!args || typeof args !== "object" || Array.isArray(args))
                throw new Error("Capability arguments must be a JSON object.");
            if (domain === "desktop") {
                if (!desktop.call && !desktop.invoke)
                    throw new Error("Desktop capability invocation is unavailable.");
                return unpack(await (desktop.call ? desktop.call(operation, args) : desktop.invoke(operation, args)));
            }
            return unpack(await registry.invoke(domain, operation, args));
        }
        if (action === "tasks.list")
            return tasks.list({ limit: Number.isInteger(input.limit) ? input.limit : 50, ...(input.status ? { status: input.status } : {}) });
        if (action === "tasks.read")
            return tasks.read(taskId(input));
        if (action === "tasks.delete") {
            assertMutationAllowed("cli_task_delete");
            return tasks.remove(taskId(input));
        }
        if (action === "tasks.create") {
            assertMutationAllowed("cli_task_create");
            const objective = requiredString(input.objective, "objective", 12 * 1024);
            const title = requiredString(input.title ?? objective.slice(0, 120), "title", 160);
            return tasks.checkpoint({ title, objective, completed: [], next: [], references: [] });
        }
        if (action === "chat.start") {
            assertMutationAllowed("cli_chat_start");
            const id = taskId(input);
            if (inflight.has(id))
                throw new Error("A CLI chat operation is in progress for this task.");
            inflight.add(id);
            try {
                const task = await tasks.readInternal(id);
                if (task.status !== "active" || task.chatBinding)
                    throw new Error("Task must be active and not already bound to ChatGPT.");
                // CLI chat creation is conversational by default. The Telegram Task
                // starter still executes the original objective unless explicitly
                // given a neutral initial message by this CLI surface.
                const initialMessage = input.runTask === true ? undefined
                    : `Equinox Local CLI chat for ${id} is connected. Reply only EQL_CLI_READY. Do not run the Task Capsule objective yet or invoke tools; wait for the next CLI message.`;
                const started = await chat.startTaskChat({ taskId: id, checkpointRevision: task.checkpointRevision, ...(initialMessage ? { initialMessage } : {}) });
                if (!started?.confirmed || !started.binding)
                    throw new Error("Chat creation was not confirmed; inspect the task before retrying.");
                const updated = await tasks.bindChat({ taskId: id, binding: started.binding });
                return { task: updated, initialTurn: { userEpoch: started.userEpoch, previousAssistantTurnKey: started.previousAssistantTurnKey } };
            }
            finally {
                inflight.delete(id);
            }
        }
        if (action === "chat.send") {
            assertMutationAllowed("cli_chat_send");
            const id = taskId(input);
            if (inflight.has(id))
                throw new Error("A CLI delivery is in progress for this task.");
            const task = await tasks.readInternal(id);
            if (task.status !== "active" || !task.chatBinding)
                throw new Error("An active task with a verified ChatGPT binding is required.");
            const agent = input.agent === undefined ? null : requiredString(input.agent, "agent", 80);
            const rawMessage = requiredString(input.message, "message", 3800);
            const message = agent ? `[Equinox Local CLI · Agent: ${agent}] ${rawMessage}` : rawMessage;
            const idempotency = input.requestId === undefined ? randomBytes(12).toString("hex") : requiredString(input.requestId, "requestId", 64);
            if (!/^[a-z0-9-]{8,64}$/u.test(idempotency))
                throw new Error("requestId must contain 8–64 lowercase alphanumeric/hyphen characters.");
            inflight.add(id);
            try {
                const delivered = await chat.deliverText({ binding: task.chatBinding, deliveryId: `tgb-${idempotency}`, text: message });
                return { taskId: id, ...delivered };
            }
            finally {
                inflight.delete(id);
            }
        }
        if (action === "chat.initial") {
            const task = await tasks.readInternal(taskId(input));
            if (!task.chatBinding)
                throw new Error("Task does not have a ChatGPT binding.");
            const state = await chat.inspectTurnIdentity({ binding: task.chatBinding });
            return { status: state.status, userEpoch: state.userEpoch, previousAssistantTurnKey: null };
        }
        if (action === "chat.read") {
            const task = await tasks.readInternal(taskId(input));
            if (!task.chatBinding)
                throw new Error("Task does not have a ChatGPT binding.");
            const userEpoch = requiredString(input.userEpoch, "userEpoch", 200);
            const previousAssistantTurnKey = input.previousAssistantTurnKey === null ? null : requiredString(input.previousAssistantTurnKey, "previousAssistantTurnKey", 200);
            return chat.readFinal({ binding: task.chatBinding, userEpoch, previousAssistantTurnKey });
        }
        throw new Error(`Unknown CLI action: ${action}`);
    }
    async function start() {
        if (server)
            throw new Error("CLI bridge is already started.");
        await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
        const token = randomBytes(32).toString("hex");
        const endpoint = platform === "darwin"
            ? path.join(await prepareEquinoxBrowserSocketDirectory({ namespace }), "cli.sock")
            : `\\\\.\\pipe\\equinox-local-cli-${randomBytes(16).toString("hex")}`;
        if (platform !== "darwin" && platform !== "win32")
            throw new Error("Unsupported CLI bridge host platform.");
        if (platform === "darwin") {
            const stat = await fs.lstat(endpoint).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
            if (stat) {
                if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
                    throw new Error("CLI socket is occupied by an unsafe entry.");
                const active = await new Promise((resolve) => {
                    const probe = net.connect(endpoint);
                    const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 250);
                    probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(true); });
                    probe.once("error", () => { clearTimeout(timer); resolve(false); });
                });
                if (active)
                    throw new Error("Another CLI bridge is active.");
                await fs.unlink(endpoint);
            }
        }
        const instance = net.createServer((socket) => {
            connections.add(socket);
            socket.once("close", () => connections.delete(socket));
            socket.setTimeout(150_000, () => socket.destroy());
            socket.setEncoding("utf8");
            let input = "";
            let handled = false;
            socket.on("data", (chunk) => {
                if (handled)
                    return;
                input += chunk;
                if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
                    handled = true;
                    socket.destroy();
                    return;
                }
                const newline = input.indexOf("\n");
                if (newline < 0)
                    return;
                handled = true;
                void (async () => {
                    let response;
                    try {
                        const request = JSON.parse(input.slice(0, newline));
                        if (!request || typeof request !== "object" || Array.isArray(request) || request.token !== token)
                            throw new Error("CLI request authentication failed.");
                        response = { ok: true, result: await dispatch(request) };
                    }
                    catch (error) {
                        response = { ok: false, error: { code: typeof error?.code === "string" ? error.code : "CLI_ERROR", message: error instanceof Error ? error.message.slice(0, 800) : "CLI request failed." } };
                    }
                    const data = JSON.stringify(response);
                    if (Buffer.byteLength(data) > MAX_RESPONSE_BYTES)
                        socket.end(JSON.stringify({ ok: false, error: { code: "RESPONSE_TOO_LARGE", message: "CLI response exceeds 8 MiB." } }) + "\n");
                    else
                        socket.end(data + "\n");
                })();
            });
            socket.on("error", () => { });
        });
        try {
            await new Promise((resolve, reject) => { instance.once("error", reject); instance.listen(endpoint, () => { instance.removeListener("error", reject); resolve(); }); });
            if (platform === "darwin")
                await fs.chmod(endpoint, 0o600);
            const tempPath = `${discoveryPath}.${randomBytes(8).toString("hex")}.tmp`;
            try {
                await fs.writeFile(tempPath, JSON.stringify({ version: 1, endpoint, token, pid: process.pid }) + "\n", { mode: 0o600, flag: "wx" });
                await fs.rename(tempPath, discoveryPath);
                if (platform === "darwin")
                    await fs.chmod(discoveryPath, 0o600);
            }
            finally {
                await fs.unlink(tempPath).catch(() => { });
            }
            socketPath = endpoint;
            session = token;
            server = instance;
        }
        catch (error) {
            await new Promise((resolve) => instance.close(() => resolve())).catch(() => { });
            throw error;
        }
    }
    async function close() {
        const instance = server;
        if (!instance)
            return;
        server = null;
        // Shutdown must not wait for a long-running CLI request. Its client
        // receives a disconnect and can recover with its recorded receipt.
        for (const connection of connections)
            connection.destroy();
        await new Promise((resolve) => instance.close(() => resolve()));
        const snapshot = await fs.readFile(discoveryPath, "utf8").catch(() => "");
        try {
            if (snapshot && JSON.parse(snapshot).token === session)
                await fs.unlink(discoveryPath);
        }
        catch { }
        if (socketPath && platform === "darwin")
            await fs.unlink(socketPath).catch(() => { });
        socketPath = null;
        session = null;
    }
    return Object.freeze({ start, close });
}
