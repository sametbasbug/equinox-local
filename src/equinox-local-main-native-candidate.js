import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { validateFirstInstallRelease } from "./equinox-local-first-install.js";
import { inspectStagedEquinoxLocalMainSnapshotArtifact } from "./equinox-local-main-snapshot.js";
import { extractEquinoxReleaseArchive, inspectEquinoxReleaseArchive } from "./equinox-local-release-manager.js";

const execFile = promisify(execFileCallback);

async function assertCanonicalDirectory(directory, label, fsImpl) {
  const resolved = path.resolve(directory);
  const [stat, real] = await Promise.all([fsImpl.lstat(resolved), fsImpl.realpath(resolved)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || real !== resolved) throw new Error(`${label} is not a canonical normal directory.`);
  return resolved;
}

export async function prepareEquinoxLocalMainNativeCandidate({
  sourceSha,
  target,
  expectedRuntimeContractSha256,
  transactionRoot,
  transactionId,
  fsImpl = fs,
  execFileImpl = execFile,
  inspectStagedArtifact = inspectStagedEquinoxLocalMainSnapshotArtifact,
  inspectArchive = inspectEquinoxReleaseArchive,
  extractArchive = extractEquinoxReleaseArchive,
  validateRelease = validateFirstInstallRelease,
} = {}) {
  const staged = await inspectStagedArtifact({
    sourceSha,
    target,
    expectedRuntimeContractSha256,
    transactionRoot,
    transactionId,
    fsImpl,
  });
  const transactionDir = await assertCanonicalDirectory(
    path.join(path.resolve(transactionRoot), "staging", transactionId),
    "Main native candidate transaction directory",
    fsImpl,
  );
  const candidateRoot = path.join(transactionDir, "native-candidate");
  const extractionRoot = path.join(candidateRoot, "extracted");
  const candidateReleaseDir = path.join(candidateRoot, "release");
  let created = false;
  try {
    await fsImpl.mkdir(candidateRoot, { recursive: false, mode: 0o700 });
    created = true;
    await assertCanonicalDirectory(candidateRoot, "Main native candidate root", fsImpl);
    await inspectArchive(staged.artifactPath, { target, execFileImpl });
    await extractArchive(staged.artifactPath, extractionRoot, { target, execFileImpl });
    const extractedReleaseDir = path.join(extractionRoot, "release");
    const validated = await validateRelease(extractedReleaseDir, { target, fsImpl });
    if (validated?.target !== target || validated?.releaseDir !== extractedReleaseDir) {
      throw new Error("Main native candidate release validation drifted from the exact transaction target.");
    }
    await fsImpl.rename(extractedReleaseDir, candidateReleaseDir);
    await fsImpl.rm(extractionRoot, { recursive: true, force: true });
    const finalValidation = await validateRelease(candidateReleaseDir, { target, fsImpl });
    if (finalValidation?.target !== target || finalValidation?.releaseDir !== candidateReleaseDir) {
      throw new Error("Main native candidate final validation drifted from the exact transaction target.");
    }
    return Object.freeze({
      sourceSha,
      target,
      transactionId,
      runtimeContractSha256: staged.manifest.runtimeContractSha256,
      artifactSha256: staged.sha256,
      artifactBytes: staged.bytes,
      payloadVersion: finalValidation.version,
      releaseDir: candidateReleaseDir,
      tree: finalValidation.tree,
      metadata: finalValidation.metadata,
    });
  } catch (error) {
    if (created) await fsImpl.rm(candidateRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
