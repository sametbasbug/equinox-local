const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; script-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; upgrade-insecure-requests",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
});

const INSTALLER_PATHS = new Set([
  "/downloads/updates/install-equinox-local.sh",
  "/downloads/updates/install-equinox-local.ps1",
]);

const RELEASE_ASSET_PATTERN = /^\/downloads\/updates\/equinox-local-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))-(darwin-(?:arm64|x64)|win32-(?:arm64|x64))\.(tar\.gz|zip)$/u;

export function releaseAssetOriginForPath(pathname) {
  if (typeof pathname !== "string") return null;
  const match = RELEASE_ASSET_PATTERN.exec(pathname);
  if (!match) return null;
  const [, version, target, suffix] = match;
  const expectedSuffix = target.startsWith("win32-") ? "zip" : "tar.gz";
  if (suffix !== expectedSuffix) return null;
  return `https://github.com/sametbasbug/equinox-local/releases/download/v${version}/equinox-local-${version}-${target}.${expectedSuffix}`;
}

function withSecurityHeaders(response, { immutable = false, privacy = false, noStore = false } = {}) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (noStore) {
    // Installer bootstrap scripts must never be served stale after a repair.
    headers.set("Cache-Control", "no-store");
  } else if (immutable) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else if (privacy) {
    headers.set("Cache-Control", "public, max-age=300, must-revalidate");
  } else {
    headers.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function fetchReleaseAsset(request, upstreamUrl) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return withSecurityHeaders(new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    }));
  }

  const headers = new Headers();
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);

  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    redirect: "follow",
  });
  if (!upstream.ok && upstream.status !== 206) {
    return withSecurityHeaders(new Response("Release asset unavailable", { status: 502 }));
  }
  return withSecurityHeaders(upstream, { immutable: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const releaseAssetOrigin = releaseAssetOriginForPath(url.pathname);
    if (releaseAssetOrigin) return fetchReleaseAsset(request, releaseAssetOrigin);

    const response = await env.ASSETS.fetch(request);
    return withSecurityHeaders(response, {
      privacy: url.pathname.startsWith("/privacy"),
      noStore: INSTALLER_PATHS.has(url.pathname),
    });
  },
};
