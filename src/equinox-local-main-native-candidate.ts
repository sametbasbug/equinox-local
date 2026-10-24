import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { validateFirstInstallRelease } from "./equinox-local-first-install.js";
import { inspectStagedEquinoxLocalMainSnapshotArtifact } from "./equinox-local-main-snapshot.js";
import { extractEquinoxReleaseArchive, inspectEquinoxReleaseArchive } from "./equinox-local-release-manager.js";

const execFile = promisify(execFileCallback);

type CandidateFs = typeof fs;
type CandidateExec = typeof execFile;
type StagedArtifact = Awaited<ReturnType<typeof inspectStagedEquinoxLocalMainSnapshotArtifact>>;
type ValidatedRelease = Awaited<ReturnType<typeof validateFirstInstallRelease>>;
type InspectStaged = (input: {
  sourceSha: string; target: string; expectedRuntimeContractSha256: string;
  transactionRoot: string; transactionId: string; fsImpl: CandidateFs;
}) => Promise<StagedArtifact>;
type InspectArchive = (archivePath: string, options: {
  target: string; execFileImpl: CandidateExec;
}) => Promise<unknown>;
type ExtractArchive = (archivePath: string, destinationPath: string, options: {
  target: string; execFileImpl: CandidateExec;
}) => Promise<unknown>;
type ValidateRelease = (releaseDir: string, options: {
  target: string; fsImpl: CandidateFs;
}) => Promise<ValidatedRelease>;
type CandidateOptions = {
  sourceSha: string; target: string; expectedRuntimeContractSha256: string;
  transactionRoot: string; transactionId: string;
  fsImpl?: CandidateFs; execFileImpl?: CandidateExec;
  inspectStagedArtifact?: InspectStaged; inspectArchive?: InspectArchive;
  extractArchive?: ExtractArchive; validateRelease?: ValidateRelease;
};
function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}


async function assertCanonicalDirectory(directory: string, label: string, fsImpl: CandidateFs): Promise<string> {
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
}: CandidateOptions) {
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
    try {
      await fsImpl.mkdir(candidateRoot, { recursive: false, mode: 0o700 });
      created = true;
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      await assertCanonicalDirectory(candidateRoot, "Main native candidate root", fsImpl);
      const existing = await validateRelease(candidateReleaseDir, { target, fsImpl });
      if (existing?.target !== target || existing?.releaseDir !== candidateReleaseDir) throw new Error("Existing Main native candidate identity drifted from the exact transaction target.");
      return Object.freeze({
        sourceSha, target, transactionId, runtimeContractSha256: staged.manifest.runtimeContractSha256,
        artifactSha256: staged.sha256, artifactBytes: staged.bytes, payloadVersion: existing.version,
        releaseDir: candidateReleaseDir, tree: existing.tree, metadata: existing.metadata, reused: true,
      });
    }
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
      reused: false,
    });
  } catch (error) {
    if (created) await fsImpl.rm(candidateRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

// This is the trust transition between a merely hash-matching staged ZIP and
// an independently signed, complete native B payload. It is intentionally
// read-only; the Windows Guardian must verify the SAME signed record again
// inside the live OS-owned A/B lease before writing any journal milestone.
import { fingerprintEquinoxLocalNativeState } from "./equinox-local-native-state-fingerprint.js";
import { validateSignedMainNativeBAuthorization } from "./equinox-local-main-native-b-authorization.js";

export async function inspectSignedEquinoxLocalMainNativeCandidate({
  previousSourceSha,
  candidate,
  authorization,
  publicKeys,
  fsImpl = fs,
}: {
  previousSourceSha: string;
  candidate: Awaited<ReturnType<typeof prepareEquinoxLocalMainNativeCandidate>>;
  authorization: unknown;
  /** Test injection only; production callers omit it and use the pinned public keyring. */
  publicKeys?: Readonly<Record<string, string>>;
  fsImpl?: CandidateFs;
}) {
  if (typeof previousSourceSha !== "string" || !/^[a-f0-9]{40}$/u.test(previousSourceSha) ||
      previousSourceSha === candidate?.sourceSha) {
    throw new Error("Signed native Main B predecessor must be a distinct exact commit SHA.");
  }
  if (candidate?.target !== "win32-x64" && candidate?.target !== "win32-arm64") {
    throw new Error("Signed native Main B admission is currently Windows-only.");
  }
  const directory = await assertCanonicalDirectory(candidate.releaseDir, "Signed Main B release directory", fsImpl);
  const measured = await fingerprintEquinoxLocalNativeState(directory, {fsImpl});
  const expected = {
    schemaVersion: 2 as const,
    channel: "main" as const,
    sourceSha: candidate.sourceSha,
    target: candidate.target,
    runtimeContractSha256: candidate.runtimeContractSha256,
    artifact: {sha256: candidate.artifactSha256, bytes: candidate.artifactBytes},
    releaseFingerprint: {sha256: measured.sha256, entries: measured.entries, bytes: measured.bytes},
  };
  const signed = validateSignedMainNativeBAuthorization(authorization, {
    ...(publicKeys === undefined ? {} : {publicKeys}), expected,
  });
  return Object.freeze({
    sourceSha: signed.sourceSha, previousSourceSha,
    target: signed.target, releaseDir: directory,
    artifactSha256: signed.artifact.sha256, artifactBytes: signed.artifact.bytes,
    runtimeContractSha256: signed.runtimeContractSha256,
    fingerprint: measured,
    signedKeyId: signed.signature.keyId,
  });
}
