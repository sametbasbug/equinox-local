import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

function isSameOrAncestor(ancestor, target) {
  const relative = path.relative(ancestor, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function mutationPathsOverlap(first, second) {
  if (typeof first !== "string" || !path.isAbsolute(first)) {
    throw new Error("Mutation lock root must be an absolute path.");
  }
  if (typeof second !== "string" || !path.isAbsolute(second)) {
    throw new Error("Mutation lock root must be an absolute path.");
  }
  const a = path.normalize(first);
  const b = path.normalize(second);
  return isSameOrAncestor(a, b) || isSameOrAncestor(b, a);
}

async function readBoundedMetadataFile(filePath, label, { fsImpl = fs } = {}) {
  let handle;
  try {
    handle = await fsImpl.open(
      filePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 4096) {
      throw new Error(`${label} is outside the allowed bounds.`);
    }
    return (await handle.readFile({ encoding: "utf8" })).trim();
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error(`${label} may not be a symlink.`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function resolveGitCommonDirectory(projectRoot, { fsImpl = fs } = {}) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    throw new Error("Git common-dir resolution requires an absolute project root.");
  }
  const dotGit = path.join(projectRoot, ".git");
  const dotGitStat = await fsImpl.lstat(dotGit);
  if (dotGitStat.isSymbolicLink()) throw new Error("Git metadata path may not be a symlink.");

  let gitDir;
  if (dotGitStat.isDirectory()) {
    gitDir = await fsImpl.realpath(dotGit);
  } else if (dotGitStat.isFile()) {
    const text = await readBoundedMetadataFile(
      dotGit,
      "Git worktree metadata file",
      { fsImpl },
    );
    const match = text.match(/^gitdir:\s*(.+)$/u);
    if (!match) throw new Error("Git worktree metadata file is invalid.");
    gitDir = await fsImpl.realpath(path.resolve(projectRoot, match[1]));
  } else {
    throw new Error("Git metadata path has an unsupported filesystem type.");
  }

  const commonFile = path.join(gitDir, "commondir");
  let commonRef;
  try {
    commonRef = await readBoundedMetadataFile(
      commonFile,
      "Git commondir metadata",
      { fsImpl },
    );
  } catch (error) {
    if (error?.code === "ENOENT") return gitDir;
    throw error;
  }
  if (!commonRef || commonRef.includes("\0")) throw new Error("Git commondir metadata is empty or invalid.");
  const commonDir = await fsImpl.realpath(path.resolve(gitDir, commonRef));
  const commonDirStat = await fsImpl.lstat(commonDir);
  if (commonDirStat.isSymbolicLink() || !commonDirStat.isDirectory()) {
    throw new Error("Git common directory is not a normal directory.");
  }
  return commonDir;
}

export function createMutationPathLockManager({ waitMs = 30 * 60 * 1000 } = {}) {
  if (!Number.isInteger(waitMs) || waitMs < 1) {
    throw new Error("Mutation path lock wait must be a positive integer.");
  }

  const records = new Set();

  const withLock = async (rootPath, task) => {
    if (typeof rootPath !== "string" || !path.isAbsolute(rootPath)) {
      throw new Error("Mutation lock root must be an absolute path.");
    }
    if (typeof task !== "function") throw new Error("Mutation lock task must be a function.");

    const root = path.normalize(rootPath);
    const blockers = [...records]
      .filter((record) => mutationPathsOverlap(root, record.root))
      .map((record) => record.tail.catch(() => {}));
    const blockersDone = Promise.all(blockers);

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const tail = blockersDone.then(() => gate);
    const record = { root, tail };
    records.add(record);

    let timeoutHandle;
    try {
      await Promise.race([
        blockersDone,
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`Yazma kilidi bekleme süresi aşıldı: ${root}`));
          }, waitMs);
        }),
      ]);
      return await task();
    } finally {
      clearTimeout(timeoutHandle);
      release();
      void tail.finally(() => records.delete(record));
    }
  };

  return Object.freeze({ withLock });
}
