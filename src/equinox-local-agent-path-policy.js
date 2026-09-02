import path from "node:path";

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
  "Library/Keychains",
  "Library/Safari",
  "Library/Application Support/Equinox Local",
  "Library/Application Support/Equinox Local Developer",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/BraveSoftware/Brave-Browser",
]);

const SECRET_LIKE_DOTFILE_SUFFIX = /(?:^|[-_.])(?:key|token|secret|credentials?)$/u;
const PUBLIC_KEY_DOTFILE_SUFFIX = /(?:^|[-_.])public[-_]?key$/u;

function pathComparisonKey(value, platform) {
  const normalized = path.normalize(value);
  return platform === "darwin" ? normalized.toLowerCase() : normalized;
}

function isInsideComparisonRoot(rootPath, targetPath, platform) {
  const root = pathComparisonKey(rootPath, platform);
  const target = pathComparisonKey(targetPath, platform);
  const relative = path.relative(root, target);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
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
  { platform = process.platform } = {},
) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) {
    return () => false;
  }

  const protectedRoots = AGENT_PROTECTED_HOME_RELATIVE_ROOTS.map((relativePath) =>
    path.resolve(homeDir, relativePath),
  );

  return (absolutePath) => {
    if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath)) {
      return false;
    }
    return protectedRoots.some((root) =>
      isInsideComparisonRoot(root, absolutePath, platform),
    );
  };
}
