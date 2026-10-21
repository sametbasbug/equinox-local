import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

type PrivateHookName =
  | "registerPrivateVisualTools"
  | "createPrivateReleaseGateRuntime"
  | "privateWorkflowStepExecutor"
  | "registerPrivateReleaseGateTools"
  | "registerPrivateSecureServiceTools"
  | "privateReleaseGateSnapshot"
  | "privateGitHubStatus";

type PrivateComposition = Record<PrivateHookName, (...args: unknown[]) => unknown>;

type GitHubStatusInput = {
  context: unknown;
  projectContextStorage: {
    run: (context: unknown, callback: () => Promise<{code?: number; stdout?: unknown}>) => Promise<{code?: number; stdout?: unknown} | null>;
  };
  runGhWithCode: (argv: string[], input: string, timeoutMs: number) => Promise<{code?: number; stdout?: unknown}>;
};

type FileSystem = Pick<typeof fs, "lstat" | "realpath">;
type PrivateCompositionOptions = {
  modulePath?: unknown;
  rootPath?: unknown;
  fsImpl?: FileSystem;
  importModule?: (url: string) => Promise<unknown>;
};

const REQUIRED_PRIVATE_COMPOSITION_HOOKS = Object.freeze([
  "registerPrivateVisualTools",
  "createPrivateReleaseGateRuntime",
  "privateWorkflowStepExecutor",
  "registerPrivateReleaseGateTools",
  "registerPrivateSecureServiceTools",
  "privateReleaseGateSnapshot",
  "privateGitHubStatus",
] as const);

function isInsidePath(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createDefaultPrivateComposition(): PrivateComposition {
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
    }: GitHubStatusInput) {
      const result = await projectContextStorage.run(
        context,
        () => runGhWithCode(["api", "user", "--jq", ".login"], "", 15_000),
      ).catch(() => null);
      const rawAccount = result?.code === 0 ? String(result.stdout ?? "").trim() : "";
      const account = /^[A-Za-z0-9-]{1,39}$/u.test(rawAccount) ? rawAccount : null;
      return { ready: Boolean(account), account };
    },
  }) as PrivateComposition;
}

export async function loadPrivateComposition({
  modulePath = process.env.EQUINOX_LOCAL_PRIVATE_COMPOSITION_MODULE || "",
  rootPath = process.env.EQUINOX_LOCAL_PRIVATE_COMPOSITION_ROOT || "",
  fsImpl = fs,
  importModule = (url) => import(url),
}: PrivateCompositionOptions = {}): Promise<PrivateComposition> {
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

    const loaded = await importModule(pathToFileURL(moduleRealPath).href) as Record<string, unknown> | null;
    for (const name of REQUIRED_PRIVATE_COMPOSITION_HOOKS) {
      if (typeof loaded?.[name] !== "function") return fallback;
    }
    return Object.freeze(Object.fromEntries(
      REQUIRED_PRIVATE_COMPOSITION_HOOKS.map((name) => [name, loaded![name]]),
    )) as PrivateComposition;
  } catch {
    return fallback;
  }
}

const activePrivateComposition = await loadPrivateComposition();

export function registerPrivateVisualTools(...args: unknown[]) {
  return activePrivateComposition.registerPrivateVisualTools(...args);
}

export function createPrivateReleaseGateRuntime(...args: unknown[]) {
  return activePrivateComposition.createPrivateReleaseGateRuntime(...args);
}

export function privateWorkflowStepExecutor(...args: unknown[]) {
  return activePrivateComposition.privateWorkflowStepExecutor(...args);
}

export async function registerPrivateReleaseGateTools(...args: unknown[]) {
  return activePrivateComposition.registerPrivateReleaseGateTools(...args);
}

export function registerPrivateSecureServiceTools(...args: unknown[]) {
  return activePrivateComposition.registerPrivateSecureServiceTools(...args);
}

export async function privateReleaseGateSnapshot(...args: unknown[]) {
  return activePrivateComposition.privateReleaseGateSnapshot(...args);
}

export async function privateGitHubStatus(...args: unknown[]) {
  return activePrivateComposition.privateGitHubStatus(...args);
}
