import { protocol, type Session } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

// A packaged, read-only UI origin. This protocol is never a local server and
// does not forward network requests, expose files or execute runtime actions.
export const CONTROL_DOCUMENT_ORIGIN = "equinox://control";
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'none'",
  "img-src 'self' data:",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");
const NAV_SECTIONS = new Set(["dashboard", "projects", "tasks", "browser", "chat", "permissions", "integrations", "activity"]);
const ASSETS = new Map<string, readonly [string, string]>([
  ["/", ["equinox-control-center.html", "text/html; charset=utf-8"]],
  ["/assets/control-center.css", ["equinox-control-center.css", "text/css; charset=utf-8"]],
  ["/assets/control-center.js", ["equinox-control-center.js", "text/javascript; charset=utf-8"]],
  ["/assets/equinox-control-center-localization.js", ["equinox-control-center-localization.js", "text/javascript; charset=utf-8"]],
  ["/assets/equinox-local.png", ["equinox-local.png", "image/png"]],
]);

// Scheme privileges must be registered before Electron becomes ready.
export function registerControlScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: "equinox", privileges: {
    standard: true, secure: true, supportFetchAPI: false, stream: true,
  } }]);
}

export function controlPageURL({ section, task }: { section?: string; task?: string } = {}): string {
  const url = new URL(`${CONTROL_DOCUMENT_ORIGIN}/`);
  if (section) url.searchParams.set("section", section);
  if (task) url.searchParams.set("task", task);
  return url.href;
}

export function installControlAssets(privateSession: Session, root: string, development: boolean): void {
  const assetRoot = path.join(root, development ? "src" : "control-center");
  privateSession.protocol.handle("equinox", async (request) => {
    try {
      const url = new URL(request.url);
      if (request.method !== "GET" || url.protocol !== "equinox:" || url.host !== "control" || url.username || url.password || url.port || url.hash) {
        return new Response(null, { status: 403 });
      }
      const asset = ASSETS.get(url.pathname);
      if (!asset || (url.pathname !== "/" && url.search)) return new Response(null, { status: 404 });
      if (url.pathname === "/") {
        const section = url.searchParams.get("section");
        const task = url.searchParams.get("task");
        if ([...url.searchParams.keys()].some(key => key !== "section" && key !== "task") ||
            url.searchParams.getAll("section").length > 1 || url.searchParams.getAll("task").length > 1 ||
            (section !== null && !NAV_SECTIONS.has(section)) ||
            (task !== null && (!/^task-[a-z0-9-]{6,80}$/u.test(task) || (section !== null && section !== "tasks")))) {
          return new Response(null, { status: 403 });
        }
      }
      const contentPath = development && asset[0] === "equinox-local.png"
        ? path.join(root, "app", "EquinoxLocal.png") : path.join(assetRoot, asset[0]);
      // All paths come from the fixed asset table, not a request-derived filename.
      const bytes = new Uint8Array(await fs.readFile(contentPath));
      return new Response(bytes, { status: 200, headers: {
        "content-type": asset[1], "content-security-policy": CONTENT_SECURITY_POLICY,
        "cache-control": "no-store", "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer", "cross-origin-resource-policy": "same-origin",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
      } });
    } catch { return new Response(null, { status: 500 }); }
  });
}
