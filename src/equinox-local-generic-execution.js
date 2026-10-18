import path from "node:path";
import { equinoxLocalFiniteShell } from "./equinox-local-platform.js";

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_MAX_OUTPUT_CHARS = 40_000;
const FORCE_KILL_DELAY_MS = 250;
const CLEANUP_VERIFY_DELAY_MS = 100;
const CLEANUP_CLOSE_WAIT_MS = 250;

const SENSITIVE_PROVIDER_PREFIX = /^(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|GITHUB|GH|NPM|CLOUDFLARE|CF|AWS|AZURE|VERCEL|NETLIFY|HUGGINGFACE|HF)_/iu;
const SENSITIVE_NAME_FRAGMENT = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET|CREDENTIALS?|AUTH_?TOKEN)(?:_|$)/iu;

export function isSensitiveGenericExecutionEnvName(name) {
  if (typeof name !== "string" || !name) return false;
  return SENSITIVE_PROVIDER_PREFIX.test(name) || SENSITIVE_NAME_FRAGMENT.test(name);
}

// Repair launcher-truncated PATHEXT (observed ".CPL" on physical Windows).
// Without .EXE PowerShell 5.1 treats native programs as documents.
export function repairWindowsPathext(value) {
  const extensions = typeof value === "string"
    ? value.split(";").map((part) => part.trim()).filter(Boolean)
    : [];
  const present = new Set(extensions.map((part) => part.toUpperCase()));
  const required = [".COM", ".EXE", ".BAT", ".CMD"];
  return [...required.filter((part) => !present.has(part)), ...extensions].join(";");
}

export function buildGenericExecutionEnvironment({
  runtimeEnv = {},
  extraEnv = {},
  projectId = null,
  projectRoot = null,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const env = {};

  const mergeSafe = (source) => {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (typeof value !== "string" || isSensitiveGenericExecutionEnvName(name)) {
        continue;
      }
      env[name] = value;
    }
  };

  mergeSafe(runtimeEnv);
  mergeSafe(extraEnv);

  if (platform === "win32") {
    const keys = Object.keys(env).filter((key) => key.toUpperCase() === "PATHEXT");
    const source = keys.length ? env[keys[keys.length - 1]] : undefined;
    for (const key of keys) delete env[key];
    env.PATHEXT = repairWindowsPathext(source);
  }

  const inheritedPath = typeof extraEnv?.PATH === "string"
    ? extraEnv.PATH
    : typeof runtimeEnv?.PATH === "string"
      ? runtimeEnv.PATH
      : "";
  const shell = equinoxLocalFiniteShell({ platform, arch });
  if (platform === "win32") {
    const keys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
    for (const key of keys) delete env[key];
    // Preserve runtime PATH (including Store aliases) alongside project PATH.
    const candidates = [inheritedPath, runtimeEnv?.PATH,
      typeof runtimeEnv?.LOCALAPPDATA === "string" && path.win32.isAbsolute(runtimeEnv.LOCALAPPDATA)
        ? path.win32.join(runtimeEnv.LOCALAPPDATA, "Microsoft", "WindowsApps") : ""];
    const seen = new Set();
    env.PATH = candidates.flatMap((part) => typeof part === "string" ? part.split(";") : [])
      .map((part) => part.trim()).filter((part) => {
        if (!part || seen.has(part.toLowerCase())) return false;
        seen.add(part.toLowerCase());
        return true;
      }).join(";");
  } else if (shell.pathPrefix && inheritedPath) env.PATH = shell.pathPrefix + shell.pathDelimiter + inheritedPath;
  else if (shell.pathPrefix) env.PATH = shell.pathPrefix;
  else if (inheritedPath) env.PATH = inheritedPath;
  else env.PATH = "";

  if (typeof projectId === "string" && projectId) {
    env.EQUINOX_PROJECT_ID = projectId;
  }
  if (typeof projectRoot === "string" && projectRoot) {
    env.EQUINOX_PROJECT_ROOT = projectRoot;
  }

  return env;
}
