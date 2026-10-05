import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from "../../src/equinox-local-platform.js";
import { materializeEquinoxLocalMainNativeArtifact } from "./materialize-main-native-artifact.mjs";
import { packageManagedEquinoxRelease } from "./package-managed-release.mjs";
import { packageManagedEquinoxWindowsRelease } from "./package-managed-release-windows.mjs";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;

function parseCliArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error("Main native artifact builder arguments are invalid.");
    if (values.has(key)) throw new Error(`Duplicate Main native artifact builder argument: ${key}.`);
    values.set(key, value);
  }
  const allowed = new Set(["--source-sha", "--target", "--root", "--output-dir"]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`Unsupported Main native artifact builder argument: ${key}.`);
  return values;
}

export async function buildEquinoxLocalMainNativeArtifact({
  rootDir,
  sourceSha,
  target,
  outputDir,
  hostPlatform = process.platform,
  hostArch = process.arch,
  packageDarwinImpl = packageManagedEquinoxRelease,
  packageWindowsImpl = packageManagedEquinoxWindowsRelease,
  materializeImpl = materializeEquinoxLocalMainNativeArtifact,
} = {}) {
  if (typeof rootDir !== "string" || !rootDir) throw new Error("Main native artifact builder root is required.");
  if (!SHA_PATTERN.test(sourceSha ?? "")) throw new Error("Main native artifact builder source SHA is invalid.");
  if (!EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS.includes(target)) throw new Error("Main native artifact builder target is unsupported.");
  if (typeof outputDir !== "string" || !outputDir) throw new Error("Main native artifact builder output directory is required.");
  const hostTarget = `${hostPlatform}-${hostArch}`;
  if (hostTarget !== target) throw new Error(`Main native artifact builder requires a native host/target match; got host=${hostTarget} target=${target}.`);
  if (hostPlatform !== "darwin" && hostPlatform !== "win32") throw new Error(`Main native artifact builder host platform is unsupported: ${hostPlatform}.`);

  const root = path.resolve(rootDir);
  const candidate = hostPlatform === "win32"
    ? await packageWindowsImpl({ rootDir: root, target })
    : await packageDarwinImpl({ rootDir: root, target });
  if (candidate?.target !== target || typeof candidate?.artifactPath !== "string" || !candidate.artifactPath) {
    throw new Error("Main native candidate builder returned invalid target metadata.");
  }
  const materialized = await materializeImpl({
    rootDir: root,
    sourceSha,
    target,
    candidateArtifactPath: candidate.artifactPath,
    outputDir: path.resolve(outputDir),
  });
  return Object.freeze({
    sourceSha,
    target,
    artifactPath: materialized.artifactPath,
    manifestPath: materialized.manifestPath,
    runtimeContractSha256: materialized.manifest.runtimeContractSha256,
    artifactSha256: materialized.manifest.artifact.sha256,
    artifactBytes: materialized.manifest.artifact.bytes,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const rootDir = path.resolve(args.get("--root") ?? path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
    const sourceSha = args.get("--source-sha");
    const target = args.get("--target");
    const outputDir = path.resolve(args.get("--output-dir") ?? path.join(rootDir, "backups", "main-native", sourceSha ?? "unknown", target ?? "unknown"));
    const result = await buildEquinoxLocalMainNativeArtifact({ rootDir, sourceSha, target, outputDir });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
