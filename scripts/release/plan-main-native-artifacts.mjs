import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inspectEquinoxLocalMainNativeImpactRange } from "../../src/equinox-local-main-native-admission.js";
import { EQUINOX_LOCAL_RELEASE_TARGET_MATRIX } from "../../src/equinox-local-platform.js";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const MAIN_NATIVE_RUNNERS = Object.freeze({
  "darwin-arm64": "macos-latest",
  "darwin-x64": "macos-15-intel",
  "win32-arm64": "windows-11-vs2026-arm",
  "win32-x64": "windows-latest",
});

function parseCliArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) throw new Error("Main native artifact planner arguments are invalid.");
    if (values.has(key)) throw new Error(`Duplicate Main native artifact planner argument: ${key}.`);
    values.set(key, value);
  }
  const allowed = new Set(["--current-sha", "--target-sha", "--root"]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`Unsupported Main native artifact planner argument: ${key}.`);
  return values;
}

function githubTargetEntry(contract, mainNativeRunners) {
  const runner = mainNativeRunners?.[contract.target];
  if (typeof runner !== "string" || !runner) throw new Error(`Main native target ${contract.target} has no GitHub runner.`);
  const entry = { target: contract.target, runner, platform: contract.platform, arch: contract.arch };
  if (contract.platform === "win32") {
    entry.shellRid = `win-${contract.arch}`;
    entry.dotnetPlatform = contract.arch === "arm64" ? "ARM64" : "x64";
  }
  return Object.freeze(entry);
}

export async function planEquinoxLocalMainNativeArtifacts({
  rootDir,
  currentSha,
  targetSha,
  inspectImpactImpl = inspectEquinoxLocalMainNativeImpactRange,
  targetMatrix = EQUINOX_LOCAL_RELEASE_TARGET_MATRIX,
  mainNativeRunners = MAIN_NATIVE_RUNNERS,
} = {}) {
  if (typeof rootDir !== "string" || !rootDir) throw new Error("Main native artifact planner root is required.");
  if (!SHA_PATTERN.test(currentSha ?? "")) throw new Error("Main native artifact planner current SHA is invalid.");
  if (!SHA_PATTERN.test(targetSha ?? "")) throw new Error("Main native artifact planner target SHA is invalid.");
  if (!Array.isArray(targetMatrix)) throw new Error("Main native artifact target matrix is invalid.");

  const impact = await inspectImpactImpl({ rootDir: path.resolve(rootDir), currentSha, targetSha });
  const contracts = new Map(targetMatrix.map((entry) => [entry.target, entry]));
  if (contracts.size !== targetMatrix.length) throw new Error("Main native artifact target matrix contains duplicate targets.");
  const githubTargets = [];
  for (const target of impact.requiredTargets) {
    const contract = contracts.get(target);
    if (!contract) throw new Error(`Main native artifact target contract is missing: ${target}.`);
    githubTargets.push(githubTargetEntry(contract, mainNativeRunners));
  }

  return Object.freeze({
    schemaVersion: 1,
    currentSha,
    targetSha,
    canonicalMainSha: impact.canonicalMainSha,
    nativeImpact: impact.nativeImpact,
    changedPathCount: impact.changedPaths.length,
    requiredTargets: Object.freeze([...impact.requiredTargets]),
    githubTargets: Object.freeze(githubTargets),
    reasons: Object.freeze([...impact.reasons]),
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const currentSha = args.get("--current-sha");
    const targetSha = args.get("--target-sha");
    const rootDir = path.resolve(args.get("--root") ?? path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))));
    const result = await planEquinoxLocalMainNativeArtifacts({ rootDir, currentSha, targetSha });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
