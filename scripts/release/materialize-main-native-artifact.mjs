import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { hashFile } from "../lib/package-io.mjs";
import {
  computeEquinoxLocalMainNativeRuntimeContract,
  validateEquinoxLocalMainNativeArtifactManifest,
} from "../../src/equinox-local-main-native-admission.js";
import { equinoxLocalReleaseTargetContract } from "../../src/equinox-local-platform.js";

const execFile = promisify(execFileCallback);
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;

async function assertExactCleanCheckout(rootDir, sourceSha, { execFileImpl = execFile } = {}) {
  const head = await execFileImpl("git", ["-C", rootDir, "rev-parse", "HEAD"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (String(head.stdout ?? "").trim() !== sourceSha) throw new Error("Main native artifact build checkout does not match the exact source SHA.");
  const status = await execFileImpl("git", ["-C", rootDir, "status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  });
  if (String(status.stdout ?? "").trim()) throw new Error("Main native artifact build checkout is dirty.");
}

export async function materializeEquinoxLocalMainNativeArtifact({
  rootDir,
  sourceSha,
  target,
  candidateArtifactPath,
  outputDir,
  execFileImpl = execFile,
  hashFileImpl = hashFile,
  computeRuntimeContractImpl = computeEquinoxLocalMainNativeRuntimeContract,
} = {}) {
  if (typeof rootDir !== "string" || !rootDir) throw new Error("Main native artifact root is required.");
  if (!SHA_PATTERN.test(sourceSha ?? "")) throw new Error("Main native artifact source SHA is invalid.");
  if (typeof candidateArtifactPath !== "string" || !candidateArtifactPath) throw new Error("Main native candidate artifact is required.");
  if (typeof outputDir !== "string" || !outputDir) throw new Error("Main native artifact output directory is required.");
  const root = path.resolve(rootDir);
  const candidate = path.resolve(candidateArtifactPath);
  const output = path.resolve(outputDir);
  const contract = equinoxLocalReleaseTargetContract(target);
  await assertExactCleanCheckout(root, sourceSha, { execFileImpl });
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_ARTIFACT_BYTES) {
    throw new Error("Main native candidate artifact is not a safe bounded normal file.");
  }
  if (!candidate.endsWith(contract.artifactExtension)) throw new Error("Main native candidate artifact extension does not match the target.");
  const runtimeContract = await computeRuntimeContractImpl({ rootDir: root, sourceSha, target, execFileImpl });
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const artifactName = `equinox-local-main-${sourceSha}-${target}${contract.artifactExtension}`;
  const artifactPath = path.join(output, artifactName);
  const manifestPath = path.join(output, `equinox-local-main-${sourceSha}-${target}.json`);
  await fs.copyFile(candidate, artifactPath, fsConstants.COPYFILE_EXCL);
  try {
    const digest = await hashFileImpl(artifactPath, { suppressCloseErrors: true });
    const manifest = validateEquinoxLocalMainNativeArtifactManifest({
      schemaVersion: 1,
      channel: "main",
      sourceSha,
      target,
      runtimeContractSha256: runtimeContract.sha256,
      artifact: { name: artifactName, sha256: digest.sha256, bytes: digest.bytes },
    }, {
      expectedSourceSha: sourceSha,
      expectedTarget: target,
      expectedRuntimeContractSha256: runtimeContract.sha256,
    });
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return Object.freeze({ artifactPath, manifestPath, manifest, runtimeContract });
  } catch (error) {
    await fs.rm(artifactPath, { force: true }).catch(() => {});
    await fs.rm(manifestPath, { force: true }).catch(() => {});
    throw error;
  }
}
