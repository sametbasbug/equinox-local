import http from "node:http";

export const CONTROL_ORIGIN = "http://127.0.0.1:24891";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MUTATION_PATHS = new Set([
  "/api/v1/agent/pause", "/api/v1/agent/resume",
  "/api/v1/runtime/restart", "/api/v1/browser/agent/open",
]);

/** Only the existing Control Center document may be hosted, never an API or remote page. */
export function isControlDocument(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === CONTROL_ORIGIN && !url.username && !url.password
      && url.pathname === "/"
      && [...url.searchParams.keys()].every((key) => key === "section" || key === "task");
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
    const request = http.request(`${CONTROL_ORIGIN}${route}`, {
      method: mutation ? "POST" : "GET",
      headers: mutation
        ? { "content-type": "application/json", "content-length": "2", origin: CONTROL_ORIGIN, "x-equinox-csrf": csrfToken }
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
