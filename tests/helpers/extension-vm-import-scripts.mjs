import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export function createExtensionVmContext({ sandbox = {}, extensionRoot, allowedScripts = [] } = {}) {
  if (!extensionRoot || !path.isAbsolute(extensionRoot)) {
    throw new TypeError("Extension VM root must be an absolute path.");
  }
  if (!Array.isArray(allowedScripts) || allowedScripts.some((script) => (
    typeof script !== "string" || !script || path.basename(script) !== script || script.includes("\\")
  ))) {
    throw new TypeError("Extension VM importScripts allowlist must contain plain script filenames.");
  }

  const root = path.resolve(extensionRoot);
  const allowed = new Set(allowedScripts);
  const context = vm.isContext(sandbox) ? sandbox : vm.createContext(sandbox);
  context.importScripts = (...scripts) => {
    for (const script of scripts) {
      if (typeof script !== "string" || !allowed.has(script)) {
        throw new Error(`Extension importScripts path is not allowlisted: ${String(script)}`);
      }
      const filePath = path.resolve(root, script);
      const relative = path.relative(root, filePath);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Extension importScripts path escapes the extension root: ${script}`);
      }
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Extension importScripts target is not a regular file: ${script}`);
      }
      vm.runInContext(fs.readFileSync(filePath, "utf8"), context, { filename: filePath });
    }
  };
  return context;
}
