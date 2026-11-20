import http from "node:http";
import { CONTROL_DOCUMENT_ORIGIN } from "./control-assets.js";

export const CONTROL_ORIGIN = CONTROL_DOCUMENT_ORIGIN;
const API_ORIGIN = "http://127.0.0.1:24891";
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
    const sections = new Set(["dashboard", "projects", "tasks", "browser", "permissions", "integrations", "activity"]);
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

/** A fixed-origin, bounded native client; this is not exposed to the renderer. */
export async function readControlJson(route: string, { csrfToken }: { csrfToken?: string } = {}): Promise<Record<string, any>> {
  const mutation = csrfToken !== undefined;
  if ((mutation && !MUTATION_PATHS.has(route))
    || (!mutation && !["/api/v1/status", "/api/v1/session"].includes(route))) {
    throw new Error("Unsupported Control Center shell operation.");
  }
  return new Promise((resolve, reject) => {
    const request = http.request(`${API_ORIGIN}${route}`, {
      method: mutation ? "POST" : "GET",
      headers: mutation
        ? { "content-type": "application/json", "content-length": "2", origin: API_ORIGIN, "x-equinox-csrf": csrfToken }
        : { accept: "application/json", "x-equinox-background-refresh": "1" },
    }, (response) => {
      if (response.statusCode !== 200 && response.statusCode !== 202) {
        response.destroy();
        reject(new Error(`Control Center returned HTTP ${response.statusCode}.`));
        return;
      }
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) response.destroy(new Error("Control Center response is too large."));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid Control Center response.");
          resolve(payload as Record<string, any>);
        } catch (error) { reject(error); }
      });
    });
    const timeout = setTimeout(() => request.destroy(new Error("Control Center request timed out.")), 3_000);
    request.once("close", () => clearTimeout(timeout));
    request.on("error", reject);
    request.end(mutation ? "{}" : undefined);
  });
}

/** Fetch a fresh session; never retry an uncertain mutation. */
export async function mutateControl(route: string): Promise<void> {
  const session = await readControlJson("/api/v1/session");
  if (typeof session.csrfToken !== "string" || !/^[a-f0-9]{64}$/u.test(session.csrfToken)) {
    throw new Error("Control Center session is unavailable.");
  }
  await readControlJson(route, { csrfToken: session.csrfToken });
}


// The renderer can request only these existing, versioned Control Center
// operations. No raw URL, headers, shell command or native IPC channel crosses
// the preload bridge. The loopback hop is a temporary backend transport while
// the existing handlers are extracted from the HTTP server.
const UI_READ_PATHS = new Set([
  "/api/v1/health", "/api/v1/status", "/api/v1/activity", "/api/v1/tasks",
  "/api/v1/onboarding", "/api/v1/doctor", "/api/v1/doctor/repairs",
  "/api/v1/config", "/api/v1/update", "/api/v1/turn-budget",
  "/api/v1/integrations/peekaboo", "/api/v1/integrations/telegram",
  "/api/v1/integrations/telegram/pair", "/api/v1/integrations/http-profiles",
  "/api/v1/files/import-settings",
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
  const payload = method === "GET" ? undefined : body as string;
  // The renderer never supplies or acquires a mutation authorization header.
  // Main obtains a fresh token from the existing backend for each mutation.
  const session = method === "GET" ? null : await readControlJson("/api/v1/session");
  if (session && (typeof session.csrfToken !== "string" || !/^[a-f0-9]{64}$/u.test(session.csrfToken))) {
    throw new Error("Desktop Control Center session unavailable.");
  }
  return await new Promise((resolve, reject) => {
    const request = http.request(`${API_ORIGIN}${route}`, {
      method,
      headers: method === "GET"
        ? { accept: "application/json", ...(backgroundRefresh ? { "x-equinox-background-refresh": "1" } : {}) }
        : { accept: "application/json", "content-type": "application/json", "content-length": Buffer.byteLength(payload!, "utf8"),
          origin: API_ORIGIN, "x-equinox-csrf": session!.csrfToken },
    }, response => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) response.destroy(new Error("Desktop control response is too large."));
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid desktop control response.");
          resolve({ status: response.statusCode ?? 500, body: parsed as Record<string, any> });
        } catch { reject(new Error("Unreadable desktop control response.")); }
      });
    });
    const timeout = setTimeout(() => request.destroy(new Error("Desktop control operation timed out.")), 10_000);
    request.once("close", () => clearTimeout(timeout));
    request.once("error", reject);
    request.end(payload);
  });
}
