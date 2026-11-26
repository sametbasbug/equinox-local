import net from "node:net";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTROL_DOCUMENT_ORIGIN } from "./control-assets.js";

export const CONTROL_ORIGIN = CONTROL_DOCUMENT_ORIGIN;
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MUTATION_PATHS = new Set([
  "/api/v1/agent/pause", "/api/v1/agent/resume",
  "/api/v1/runtime/restart", "/api/v1/browser/agent/open",
]);

/** Only the existing Control Center document may be hosted, never an API or remote page. */
export function isControlDocument(value: string): boolean {
  try {
    const url = new URL(value);
    const sections = new Set(["dashboard", "projects", "tasks", "browser", "chat", "permissions", "integrations", "activity"]);
    const section = url.searchParams.get("section");
    const task = url.searchParams.get("task");
    return url.protocol === "equinox:" && url.host === "control" && !url.username && !url.password && !url.port && !url.hash
      && url.pathname === "/" && url.searchParams.getAll("section").length <= 1
      && url.searchParams.getAll("task").length <= 1
      && [...url.searchParams.keys()].every((key) => key === "section" || key === "task")
      && (section === null || sections.has(section))
      && (task === null || (/^task-[a-z0-9-]{6,80}$/u.test(task) && (section === null || section === "tasks")));
  } catch { return false; }
}

/** Native menu operations use the same authenticated private socket as the UI. */
export async function readControlJson(route: string): Promise<Record<string, any>> {
  if (route !== "/api/v1/status" && route !== "/api/v1/plugins") throw new Error("Unsupported Control Center shell read.");
  const result = await callAuthenticatedControlSocket({ method: "GET", path: route, backgroundRefresh: true });
  if (result.status !== 200 || result.body.ok !== true) throw new Error("Control Center native status unavailable.");
  return result.body;
}

/** Never retry an uncertain native mutation. */
export async function mutateControl(route: string): Promise<void> {
  if (!MUTATION_PATHS.has(route)) throw new Error("Unsupported Control Center shell mutation.");
  const result = await callAuthenticatedControlSocket({method: "POST", path: route, body: "{}", backgroundRefresh: false});
  if (![200, 202].includes(result.status) || result.body.ok !== true) {
    throw new Error("Control Center native operation could not be confirmed.");
  }
}

// The renderer can request only these existing, versioned Control Center
// operations. No raw URL, headers, shell command or native IPC channel crosses
// the preload bridge. The renderer connects to the existing current-user authenticated IPC socket
// through Electron main, without a browser-accessible management route.
const UI_READ_PATHS = new Set([
  "/api/v1/health", "/api/v1/status", "/api/v1/activity", "/api/v1/tasks",
  "/api/v1/onboarding", "/api/v1/doctor", "/api/v1/doctor/repairs",
  "/api/v1/config", "/api/v1/update", "/api/v1/turn-budget",
  "/api/v1/integrations/peekaboo", "/api/v1/integrations/telegram",
  "/api/v1/integrations/telegram/pair", "/api/v1/integrations/http-profiles",
  "/api/v1/files/import-settings", "/api/v1/plugins",
]);
const UI_WRITE_PATHS: Readonly<Record<string, ReadonlySet<string>>> = {
  POST: new Set([
    "/api/v1/agent/pause", "/api/v1/agent/resume", "/api/v1/runtime/restart",
    "/api/v1/browser/agent/open", "/api/v1/doctor/repair", "/api/v1/update/check",
    "/api/v1/update/apply", "/api/v1/uninstall", "/api/v1/folder-picker",
    "/api/v1/onboarding/tunnel", "/api/v1/integrations/telegram/pair/start",
    "/api/v1/integrations/telegram/pair/confirm", "/api/v1/integrations/telegram/pair/cancel",
    "/api/v1/integrations/telegram/test", "/api/v1/integrations/telegram/disconnect",
    "/api/v1/integrations/http-profiles/test", "/api/v1/integrations/http-profiles/delete",
    "/api/v1/plugins/brain/connect", "/api/v1/plugins/brain/install", "/api/v1/plugins/brain/disconnect",
    "/api/v1/plugins/brain/search-access", "/api/v1/plugins/brain/sync", "/api/v1/plugins/brain/write-access", "/api/v1/plugins/brain/preferences",
  ]),
  PUT: new Set([
    "/api/v1/config", "/api/v1/turn-budget", "/api/v1/browser/settings",
    "/api/v1/files/import-settings", "/api/v1/integrations/telegram/downloads",
    "/api/v1/integrations/telegram/remote-control", "/api/v1/integrations/telegram",
    "/api/v1/integrations/http-profiles/management", "/api/v1/integrations/http-profiles/profile",
  ]),
};

function allowedUiOperation(method: string, route: string): boolean {
  if (method === "GET" && (UI_READ_PATHS.has(route) || /^\/api\/v1\/tasks\/task-[a-z0-9-]{6,80}$/u.test(route))) return true;
  if (UI_WRITE_PATHS[method]?.has(route)) return true;
  const match = /^\/api\/v1\/tasks\/task-[a-z0-9-]{6,80}(?:\/(complete|cancel|delete|continuation\/cancel|fresh-resume\/cancel|fresh-resume\/abandon))?$/u.exec(route);
  return Boolean(match && ((method === "PUT" && !match[1]) || (method === "POST" && match[1])));
}

type UiControlRequest = { path?: unknown; method?: unknown; body?: unknown; backgroundRefresh?: unknown };
export async function requestUiControlJson(value: UiControlRequest): Promise<{ status: number; body: Record<string, any> }> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !["path", "method", "body", "backgroundRefresh"].includes(key))) {
    throw new Error("Invalid desktop control request.");
  }
  const { path: route, method = "GET", body, backgroundRefresh = false } = value;
  if (typeof route !== "string" || route.length > 180 || typeof method !== "string" ||
      !allowedUiOperation(method, route) || typeof backgroundRefresh !== "boolean" ||
      (backgroundRefresh && method !== "GET") ||
      (method === "GET" && body !== undefined) ||
      (method !== "GET" && (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES))) {
    throw new Error("Unsupported desktop control operation.");
  }
  return await callAuthenticatedControlSocket({
    method, path: route, ...(method === "GET" ? {} : { body: body as string }), backgroundRefresh,
  });
}

/** The runtime owner refuses a second backend even after the HTTP listener is retired. */
export async function assertNoOtherLocalRuntime(): Promise<void> {
  let descriptor: Awaited<ReturnType<typeof readPrivateControlDescriptor>>;
  try { descriptor = await readPrivateControlDescriptor(); }
  catch (error) {
    // A missing descriptor/socket means a previous instance is not listening.
    // A malformed or foreign-owned descriptor must fail closed.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(descriptor.endpoint);
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Cannot establish private runtime ownership.")), 1_500);
    socket.once("connect", () => finish(new Error("Another local runtime owns the private IPC socket; refusing a second backend.")));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" || error.code === "ECONNREFUSED"
        ? undefined : new Error("Private runtime socket ownership is unavailable."));
    });
  });
}

// Electron main is the only reader of the credential-bearing, mode-bounded
// discovery descriptor. Reuse these checks for both IPC requests and the
// single-owner startup guard; no endpoint or token reaches the renderer.
async function readPrivateControlDescriptor(): Promise<{endpoint: string; token: string}> {
  const stateRoot = process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Equinox Local")
    : process.platform === "win32" && typeof process.env.LOCALAPPDATA === "string"
      ? path.join(process.env.LOCALAPPDATA, "Equinox Local", "state") : null;
  if (!stateRoot) throw new Error("Desktop control IPC is unsupported on this host.");
  const file = path.join(stateRoot, "cli-ipc.json");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let descriptor: { version?: unknown; endpoint?: unknown; token?: unknown; pid?: unknown };
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 8192 ||
        (process.platform === "darwin" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) {
      throw new Error("Desktop control IPC descriptor is not private.");
    }
    descriptor = JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
  if (!descriptor || descriptor.version !== 1 || typeof descriptor.token !== "string" ||
      !/^[a-f0-9]{64}$/u.test(descriptor.token) || typeof descriptor.endpoint !== "string" ||
      !Number.isSafeInteger(descriptor.pid) || Number(descriptor.pid) < 1) {
    throw new Error("Desktop control IPC descriptor is invalid.");
  }
  const endpoint = descriptor.endpoint;
  if (process.platform === "darwin") {
    const uid = process.getuid?.();
    const directory = path.dirname(endpoint);
    if (typeof uid !== "number" || !new RegExp(`^/tmp/equinox-local-${uid}(?:-[a-z0-9][a-z0-9-]{0,31})?$`, "u").test(directory) ||
        path.basename(endpoint) !== "cli.sock") throw new Error("Desktop control IPC endpoint is untrusted.");
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new Error("Desktop control IPC socket directory is untrusted.");
    }
  } else if (!/^\\\\\.\\pipe\\equinox-local-cli-[a-f0-9]{32}$/u.test(endpoint)) {
    throw new Error("Desktop control IPC endpoint is untrusted.");
  }
  return { endpoint, token: descriptor.token };
}

// Reuse the already-running, private current-user CLI bridge. Main alone reads
// its credential-bearing descriptor. No token, endpoint, arbitrary path or
// generic socket API is exposed to the sandboxed renderer.
export async function exchangeNativeChat(exchange: {instanceId: string; viewVisible: boolean; state: unknown; reply?: unknown}): Promise<Record<string, any>> {
  const result = await callAuthenticatedControlSocket({nativeExchange: exchange});
  if (result.status !== 200 || result.body.ok !== true) throw new Error("Native Chat exchange unavailable.");
  return result.body;
}

export async function returnToTaskConversation(taskId:string,checkpointRevision:number):Promise<Record<string,any>>{
  const result=await callAuthenticatedControlSocket({taskReturn:{taskId,checkpointRevision}});
  if(result.status!==200||result.body.ok!==true)throw new Error("The saved conversation could not be opened.");
  return result.body;
}

async function callAuthenticatedControlSocket(request: {
  method: string; path: string; body?: string; backgroundRefresh: boolean;
} | {nativeExchange: unknown} | {taskReturn:{taskId:string;checkpointRevision:number}}): Promise<{ status: number; body: Record<string, any> }> {
  const descriptor = await readPrivateControlDescriptor();
  const { endpoint } = descriptor;
  const message = JSON.stringify("nativeExchange" in request ? {token: descriptor.token, action: "native-chat.exchange", exchange: request.nativeExchange}
    : "taskReturn" in request ? {token:descriptor.token,action:"task.return",...request.taskReturn}
    : { token: descriptor.token, action: "control.request", ...request });
  // Serialized JSON bodies are escaped again by the socket envelope. Bound
  // the encoded representation separately from the decoded 256 KiB body.
  if (Buffer.byteLength(message, "utf8") > MAX_REQUEST_BYTES * 2 + 4096) {
    throw new Error("Desktop control request is too large.");
  }
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    socket.setEncoding("utf8");
    let settled = false;
    let received = "";
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout("nativeExchange" in request ? 2_500 : "taskReturn" in request ? 45_000 : 150_000, () => fail(new Error("Desktop control IPC timed out; mutation outcome may be ambiguous.")));
    socket.once("connect", () => socket.write(`${message}\n`));
    socket.on("data", (chunk: string) => {
      if (settled) return;
      received += chunk;
      if (Buffer.byteLength(received, "utf8") > 8 * 1024 * 1024) {
        fail(new Error("Desktop control IPC reply is too large.")); return;
      }
      const newline = received.indexOf("\n");
      if (newline < 0) return;
      try {
        const envelope: unknown = JSON.parse(received.slice(0, newline));
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("Invalid desktop control IPC reply.");
        const response = envelope as Record<string, any>;
        if (response.ok !== true) throw new Error(typeof response.error?.message === "string"
          ? response.error.message : "Desktop control IPC request failed.");
        const result = response.result;
        if (!result || typeof result !== "object" || !Number.isInteger(result.status) ||
            !result.body || typeof result.body !== "object" || Array.isArray(result.body)) {
          throw new Error("Invalid desktop control result.");
        }
        settled = true;
        socket.end();
        resolve({ status: result.status, body: result.body });
      } catch (error) { fail(error instanceof Error ? error : new Error("Invalid desktop control reply.")); }
    });
    socket.once("error", (error) => fail(error));
    socket.once("end", () => fail(new Error("Desktop control IPC closed without a result; check before retrying.")));
  });
}
