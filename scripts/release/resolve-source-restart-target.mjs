#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readEquinoxLocalMainSourcePointer } from "../../src/equinox-local-main-source-pointer.js";

/**
 * The helper may be running from the PREVIOUS checkout during a source switch.
 * Resolve only the exact validated pointer for the managed Developer source
 * store; ordinary source checkouts continue to use their own script root.
 */
export async function resolveSourceRestartTarget(sourceRoot, {
  home = os.homedir(),
  readPointer = readEquinoxLocalMainSourcePointer,
} = {}) {
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) throw new Error("Source restart root must be absolute.");
  const sourceStore = path.join(home, "Library", "Application Support", "Equinox Local Developer", "main-update", "sources");
  const resolved = path.resolve(sourceRoot);
  if (!resolved.startsWith(`${sourceStore}${path.sep}`)) return resolved;
  const pointerPath = path.join(path.dirname(sourceStore), "current-source.conf");
  // Missing, invalid, unsafe or moved pointers must fail closed for managed
  // sources; do not guess an old source or enumerate unrelated node processes.
  const pointer = await readPointer(pointerPath);
  if (typeof pointer?.sourceRoot !== "string" || !path.isAbsolute(pointer.sourceRoot) ||
      !pointer.sourceRoot.startsWith(`${sourceStore}${path.sep}`) ||
      !/^[a-f0-9]{40}$/u.test(pointer.sha ?? "") ||
      path.basename(pointer.sourceRoot) !== pointer.sha) {
    throw new Error("Managed restart target is outside the verified source store.");
  }
  return pointer.sourceRoot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const sourceRoot = await resolveSourceRestartTarget(process.argv[2]);
    process.stdout.write(`${sourceRoot}\n`);
  } catch (error) {
    console.error(`Source restart target validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
