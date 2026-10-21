import fs from "node:fs/promises";
import path from "node:path";

function packageDirectory(relative: string): string | null {
  const parts = relative.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  if (parts.includes(".bin")) return null;
  const lastNodeModules = parts.lastIndexOf("node_modules");
  const first = lastNodeModules < 0 ? 0 : lastNodeModules + 1;
  const name = parts[first];
  if (!name || name.startsWith(".") || name === "node_modules") return null;
  const packageEnd = name.startsWith("@") ? first + 2 : first + 1;
  if (name.startsWith("@") && !parts[first + 1]) return null;
  return parts.slice(0, packageEnd).join("/");
}

/**
 * Only production packages from the exact npm lockfile may enter a signed
 * Stable release. Development tools such as TypeScript must not be shipped.
 * This deliberately operates on an already-installed, target-native tree:
 * node-pty prebuilds survive unchanged and no npm install is run in staging.
 */
type LockPackage = { dev?: boolean; dependencies?: Record<string, string> };
type Lockfile = { lockfileVersion?: number; packages?: Record<string, LockPackage | null> };

export function createProductionNodeModulesFilter(value: unknown): (relative: string) => boolean {
  const lock = value as Lockfile | null | undefined;
  if (lock?.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== "object" ||
      !lock.packages[""] || typeof lock.packages[""] !== "object") {
    throw new Error("Managed production dependency lockfile must use npm lockfile v3.");
  }
  const included = new Set<string>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key === "") continue;
    if (!key.startsWith("node_modules/") || !entry || typeof entry !== "object") {
      throw new Error("Managed production dependency lockfile contains an invalid package entry.");
    }
    const relative = key.slice("node_modules/".length);
    if (!relative || relative.includes("\\") || !packageDirectory(relative) ||
        packageDirectory(relative) !== relative) {
      throw new Error("Managed production dependency lockfile contains an unsafe package path.");
    }
    if (entry.dev !== true) included.add(relative);
  }
  // File-tree filtering runs for each entry: precompute package ancestors once.
  const ancestors = new Set<string>();
  for (const name of included) {
    const parts = name.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      ancestors.add(parts.slice(0, index).join("/"));
    }
  }
  const declared = lock.packages[""].dependencies;
  if (!declared || typeof declared !== "object") throw new Error("Managed production root dependencies are missing.");
  for (const dependency of Object.keys(declared)) {
    if (!included.has(dependency)) {
      throw new Error(`Managed production dependency is missing from the admitted lockfile: ${dependency}`);
    }
  }
  return (relative: string) => {
    if (relative === "") return true;
    if (typeof relative !== "string" || path.isAbsolute(relative)) return false;
    const normalized = relative.replaceAll("\\", "/");
    if (normalized.split("/").some((part) => !part || part === "." || part === ".." || part === ".bin")) return false;
    if (ancestors.has(normalized)) return true; // scoped or nested package ancestors
    const packageRoot = packageDirectory(normalized);
    return packageRoot !== null && included.has(packageRoot);
  };
}

export async function productionNodeModulesFilter(rootDir: string, { fsImpl = fs } = {}) {
  const lock = JSON.parse(await fsImpl.readFile(path.join(rootDir, "package-lock.json"), "utf8"));
  return createProductionNodeModulesFilter(lock);
}
