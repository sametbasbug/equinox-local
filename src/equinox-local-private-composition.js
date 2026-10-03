import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_PRIVATE_COMPOSITION_HOOKS = Object.freeze([
  "registerPrivateVisualTools",
  "createPrivateReleaseGateRuntime",
  "privateWorkflowStepExecutor",
  "registerPrivateReleaseGateTools",
  "registerPrivateSecureServiceTools",
  "privateReleaseGateSnapshot",
  "privateGitHubStatus",
]);

function isInsidePath(rootPath, targetPath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createDefaultPrivateComposition() {
  return Object.freeze({
    registerPrivateVisualTools() {
      return null;
    },
    createPrivateReleaseGateRuntime() {
      return null;
    },
    privateWorkflowStepExecutor() {
      return null;
    },
    async registerPrivateReleaseGateTools() {
      return null;
    },
    registerPrivateSecureServiceTools() {
      return null;
    },
    async privateReleaseGateSnapshot() {
      return {};
    },
    async privateGitHubStatus({
      context,
      projectContextStorage,
      runGhWithCode,
    }) {
      const result = await projectContextStorage.run(
        context,
        () => runGhWithCode(["api", "user", "--jq", ".login"], "", 15_000),
      ).catch(() => null);
      const rawAccount = result?.code === 0 ? String(result.stdout ?? "").trim() : "";
      const account = /^[A-Za-z0-9-]{1,39}$/u.test(rawAccount) ? rawAccount : null;
      return { ready: Boolean(account), account };
    },
  });
}

export async function loadPrivateComposition({
  modulePath = process.env.EQUINOX_LOCAL_PRIVATE_COMPOSITION_MODULE || "",
  rootPath = process.env.EQUINOX_LOCAL_PRIVATE_COMPOSITION_ROOT || "",
  fsImpl = fs,
  importModule = (url) => import(url),
} = {}) {
  const fallback = createDefaultPrivateComposition();
  if (!modulePath && !rootPath) return fallback;
  if (typeof modulePath !== "string" || typeof rootPath !== "string") return fallback;
  if (!path.isAbsolute(modulePath) || !path.isAbsolute(rootPath)) return fallback;

  try {
    const rootStat = await fsImpl.lstat(rootPath);
    const moduleStat = await fsImpl.lstat(modulePath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return fallback;
    if (!moduleStat.isFile() || moduleStat.isSymbolicLink()) return fallback;

    const rootRealPath = await fsImpl.realpath(rootPath);
    const moduleRealPath = await fsImpl.realpath(modulePath);
    if (!isInsidePath(rootRealPath, moduleRealPath) || moduleRealPath === rootRealPath) return fallback;

    const loaded = await importModule(pathToFileURL(moduleRealPath).href);
    for (const name of REQUIRED_PRIVATE_COMPOSITION_HOOKS) {
      if (typeof loaded?.[name] !== "function") return fallback;
    }
    return Object.freeze(Object.fromEntries(
      REQUIRED_PRIVATE_COMPOSITION_HOOKS.map((name) => [name, loaded[name]]),
    ));
  } catch {
    return fallback;
  }
}

const activePrivateComposition = await loadPrivateComposition();

export function registerPrivateVisualTools(...args) {
  return activePrivateComposition.registerPrivateVisualTools(...args);
}

export function createPrivateReleaseGateRuntime(...args) {
  return activePrivateComposition.createPrivateReleaseGateRuntime(...args);
}

export function privateWorkflowStepExecutor(...args) {
  return activePrivateComposition.privateWorkflowStepExecutor(...args);
}

export async function registerPrivateReleaseGateTools(...args) {
  return activePrivateComposition.registerPrivateReleaseGateTools(...args);
}

export function registerPrivateSecureServiceTools(...args) {
  return activePrivateComposition.registerPrivateSecureServiceTools(...args);
}

export async function privateReleaseGateSnapshot(...args) {
  return activePrivateComposition.privateReleaseGateSnapshot(...args);
}

export async function privateGitHubStatus(...args) {
  return activePrivateComposition.privateGitHubStatus(...args);
}
