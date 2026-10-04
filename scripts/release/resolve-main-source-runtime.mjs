import path from "node:path";
import { fileURLToPath } from "node:url";

import { readEquinoxLocalMainSourcePointer } from "../../src/equinox-local-main-source-pointer.js";
import { readSourceRuntimeConfig } from "../../src/equinox-local-source-runtime.js";

const modulePath = fileURLToPath(import.meta.url);

export async function resolveMainSourceRuntime({ pointerPath, configPath } = {}) {
  if (typeof pointerPath !== "string" || !path.isAbsolute(pointerPath)) throw new Error("Main source runtime pointer path must be absolute.");
  if (typeof configPath !== "string" || !path.isAbsolute(configPath)) throw new Error("Main source runtime config path must be absolute.");
  const [pointer, loaded] = await Promise.all([
    readEquinoxLocalMainSourcePointer(pointerPath),
    readSourceRuntimeConfig({ configPath }),
  ]);
  if (!loaded.configured) throw new Error("Main source runtime config is unavailable.");
  return Object.freeze({ sourceRoot: pointer.sourceRoot, sha: pointer.sha, configPath: loaded.configPath, config: loaded.config });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  resolveMainSourceRuntime({ pointerPath: process.argv[2], configPath: process.argv[3] }).then((value) => {
    process.stdout.write(`${value.sourceRoot}\n`);
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
