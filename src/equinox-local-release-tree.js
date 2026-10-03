import fs from "node:fs/promises";
import path from "node:path";

export const MAX_RELEASE_TREE_ENTRIES = 20_000;
export const MAX_RELEASE_TREE_BYTES = 2 * 1024 * 1024 * 1024;

const DEFAULT_ERRORS = Object.freeze({
  entryLimit: "Release tree contains too many entries.",
  byteLimit: "Release tree exceeds the extracted size limit.",
  symlink: "Release tree may not contain symbolic links.",
  unsupportedEntry: "Release tree contains an unsupported filesystem entry.",
});

export async function walkBoundedReleaseTree(root, {
  fsImpl = fs,
  countName = "entryCount",
  errors = {},
} = {}) {
  let entryCount = 0;
  let totalBytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    const entries = await fsImpl.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > MAX_RELEASE_TREE_ENTRIES) {
        throw new Error(errors.entryLimit ?? DEFAULT_ERRORS.entryLimit);
      }
      const absolute = path.join(directory, entry.name);
      const stat = await fsImpl.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(errors.symlink ?? DEFAULT_ERRORS.symlink);
      }
      if (stat.isDirectory()) {
        stack.push(absolute);
      } else if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > MAX_RELEASE_TREE_BYTES) {
          throw new Error(errors.byteLimit ?? DEFAULT_ERRORS.byteLimit);
        }
      } else {
        throw new Error(errors.unsupportedEntry ?? DEFAULT_ERRORS.unsupportedEntry);
      }
    }
  }
  return Object.freeze({ [countName]: entryCount, totalBytes });
}
