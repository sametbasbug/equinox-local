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
      const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
      try {
        const openedStat = fs.fstatSync(descriptor);
        const pathStat = fs.lstatSync(filePath);
        const sameFile = openedStat.dev === pathStat.dev && openedStat.ino === pathStat.ino;
        if (!openedStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() || !sameFile) {
          throw new Error(`Extension importScripts target is not a stable regular file: ${script}`);
        }
        vm.runInContext(fs.readFileSync(descriptor, "utf8"), context, { filename: filePath });
      } finally {
        fs.closeSync(descriptor);
      }
    }
  };
  return context;
}
