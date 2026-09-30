import path from "node:path";

import { equinoxLocalPlatformPaths } from "./equinox-local-platform.js";

const BLOCKED_FILENAMES = new Set([
  ".npmrc",
  ".netrc",
  "auth-profiles.json",
  "credentials.json",
  "secrets.json",
  "service-account.json",
  "id_rsa",
  "id_ed25519",
]);

const BLOCKED_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
]);

const AGENT_PROTECTED_HOME_RELATIVE_ROOTS = Object.freeze([
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config/gh",
  ".config/gcloud",
  ".codex/auth.json",
  ".codex/credentials.json",
  ".openclaw/credentials",
  ".openclaw/service-env",
  ".openclaw/identity",
  ".openclaw/devices",
  ".claude/.credentials.json",
  ".claude/session-env",
  ".claude/shell-snapshots",
  ".claude/credentials.json",
]);

const DARWIN_PROTECTED_HOME_RELATIVE_ROOTS = Object.freeze([
  "Library/Keychains",
  "Library/Safari",
  "Library/Application Support/Equinox Local Developer",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/BraveSoftware/Brave-Browser",
]);

const WINDOWS_BROWSER_LOCALAPPDATA_RELATIVE_ROOTS = Object.freeze([
  ["Google", "Chrome", "User Data"],
  ["Chromium", "User Data"],
  ["Microsoft", "Edge", "User Data"],
  ["BraveSoftware", "Brave-Browser", "User Data"],
]);

const SECRET_LIKE_DOTFILE_SUFFIX = /(?:^|[-_.])(?:key|token|secret|credentials?)$/u;
const PUBLIC_KEY_DOTFILE_SUFFIX = /(?:^|[-_.])public[-_]?key$/u;

function pathApiFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathComparisonKey(value, platform, pathApi) {
  const normalized = pathApi.normalize(value);
  return platform === "darwin" || platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isInsideComparisonRoot(rootPath, targetPath, platform, pathApi) {
  const root = pathComparisonKey(rootPath, platform, pathApi);
  const target = pathComparisonKey(targetPath, platform, pathApi);
  const relative = pathApi.relative(root, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${pathApi.sep}`) &&
    !pathApi.isAbsolute(relative)
  );
}

function protectedRootsForPlatform(homeDir, { platform, arch, env }) {
  const pathApi = pathApiFor(platform);
  const roots = AGENT_PROTECTED_HOME_RELATIVE_ROOTS.map((relativePath) =>
    pathApi.resolve(homeDir, relativePath),
  );

  if (platform === "darwin") {
    const layout = equinoxLocalPlatformPaths({ platform, arch, homeDir, env });
    roots.push(layout.appDataRoot);
    roots.push(...DARWIN_PROTECTED_HOME_RELATIVE_ROOTS.map((relativePath) =>
      path.posix.resolve(homeDir, relativePath),
    ));
    return roots;
  }

  if (platform === "win32") {
    const layout = equinoxLocalPlatformPaths({ platform, arch, homeDir, env });
    roots.push(layout.appDataRoot);
    const localAppData = path.win32.dirname(layout.appDataRoot);
    roots.push(...WINDOWS_BROWSER_LOCALAPPDATA_RELATIVE_ROOTS.map((segments) =>
      path.win32.join(localAppData, ...segments),
    ));
  }

  return roots;
}

export function isSensitiveAgentName(name) {
  const lowerName = String(name ?? "").toLowerCase();
  const dotfileBody = lowerName.startsWith(".") ? lowerName.slice(1) : "";
  const secretLikeDotfile =
    dotfileBody.length > 0 &&
    SECRET_LIKE_DOTFILE_SUFFIX.test(dotfileBody) &&
    !PUBLIC_KEY_DOTFILE_SUFFIX.test(dotfileBody);

  return (
    lowerName === ".env" ||
    lowerName.startsWith(".env.") ||
    BLOCKED_FILENAMES.has(lowerName) ||
    BLOCKED_EXTENSIONS.has(path.extname(lowerName)) ||
    secretLikeDotfile
  );
}

export function createProtectedAgentPathChecker(
  homeDir,
  { platform = process.platform, arch = process.arch, env = process.env } = {},
) {
  const pathApi = pathApiFor(platform);
  if (typeof homeDir !== "string" || !pathApi.isAbsolute(homeDir)) {
    return () => false;
  }

  const protectedRoots = protectedRootsForPlatform(homeDir, { platform, arch, env });

  return (absolutePath) => {
    if (typeof absolutePath !== "string" || !pathApi.isAbsolute(absolutePath)) {
      return false;
    }
    return protectedRoots.some((root) =>
      isInsideComparisonRoot(root, absolutePath, platform, pathApi),
    );
  };
}
