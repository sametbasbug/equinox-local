import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  MAX_RELEASE_TREE_BYTES,
  MAX_RELEASE_TREE_ENTRIES,
  walkBoundedReleaseTree,
} from "../../src/equinox-local-release-tree.js";

function makeFakeTree({ files = [], directories = [], specialEntries = [], symbolicLinks = [] } = {}) {
  const root = path.resolve("/virtual/release");
  const children = new Map([[root, []]]);
  const stats = new Map([[root, statFor("directory")]]);
  let readdirCalls = 0;
  let lstatCalls = 0;

  const addEntry = (relativePath, type, size = 0) => {
    const absolute = path.join(root, relativePath);
    const parent = path.dirname(absolute);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(dirent(path.basename(absolute), type));
    if (type === "directory") children.set(absolute, []);
    stats.set(absolute, statFor(type, size));
  };

  for (const relativePath of directories) addEntry(relativePath, "directory");
  for (const [relativePath, size] of files) addEntry(relativePath, "file", size);
  for (const relativePath of symbolicLinks) addEntry(relativePath, "symlink");
  for (const relativePath of specialEntries) addEntry(relativePath, "special");

  const fsImpl = {
    async readdir(directory, options) {
      readdirCalls += 1;
      assert.deepEqual(options, { withFileTypes: true });
      if (!children.has(directory)) throw Object.assign(new Error("missing directory"), { code: "ENOENT" });
      return children.get(directory);
    },
    async lstat(absolute) {
      lstatCalls += 1;
      if (!stats.has(absolute)) throw Object.assign(new Error("missing entry"), { code: "ENOENT" });
      return stats.get(absolute);
    },
  };
  return {
    root,
    fsImpl,
    calls: () => ({ readdirCalls, lstatCalls }),
  };
}

function dirent(name, type) {
  return {
    name,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
    isSymbolicLink: () => type === "symlink",
  };
}

function statFor(type, size = 0) {
  return {
    size,
    isDirectory: () => type === "directory",
    isFile: () => type === "file",
    isSymbolicLink: () => type === "symlink",
  };
}

test("release-tree walker uses injected filesystem and preserves the caller count key", async () => {
  const fixture = makeFakeTree({
    directories: ["runtime"],
    files: [["server.js", 3], [path.join("runtime", "node"), 5]],
  });
  const result = await walkBoundedReleaseTree(fixture.root, {
    fsImpl: fixture.fsImpl,
    countName: "fileCount",
  });

  assert.deepEqual(result, { fileCount: 3, totalBytes: 8 });
  assert.deepEqual(fixture.calls(), { readdirCalls: 2, lstatCalls: 3 });
});

test("release-tree walker accepts exactly 20,000 entries and rejects the next entry", async () => {
  assert.equal(MAX_RELEASE_TREE_ENTRIES, 20_000);
  const exact = makeFakeTree({
    files: Array.from({ length: MAX_RELEASE_TREE_ENTRIES }, (_, index) => [`file-${index}`, 0]),
  });
  const exactResult = await walkBoundedReleaseTree(exact.root, {
    fsImpl: exact.fsImpl,
    countName: "entryCount",
  });
  assert.equal(exactResult.entryCount, MAX_RELEASE_TREE_ENTRIES);

  const over = makeFakeTree({
    files: Array.from({ length: MAX_RELEASE_TREE_ENTRIES + 1 }, (_, index) => [`file-${index}`, 0]),
  });
  await assert.rejects(
    walkBoundedReleaseTree(over.root, {
      fsImpl: over.fsImpl,
      errors: { entryLimit: "caller entry-count limit" },
    }),
    { message: "caller entry-count limit" },
  );
});

test("release-tree walker accepts exactly 2 GiB and rejects a tree one byte larger", async () => {
  assert.equal(MAX_RELEASE_TREE_BYTES, 2 * 1024 * 1024 * 1024);
  const exact = makeFakeTree({ files: [["payload.bin", MAX_RELEASE_TREE_BYTES]] });
  assert.deepEqual(await walkBoundedReleaseTree(exact.root, { fsImpl: exact.fsImpl }), {
    entryCount: 1,
    totalBytes: MAX_RELEASE_TREE_BYTES,
  });

  const over = makeFakeTree({ files: [["payload.bin", MAX_RELEASE_TREE_BYTES + 1]] });
  await assert.rejects(
    walkBoundedReleaseTree(over.root, {
      fsImpl: over.fsImpl,
      errors: { byteLimit: "caller extracted-size limit" },
    }),
    { message: "caller extracted-size limit" },
  );
});

test("release-tree walker rejects symlinks and special entries with caller-specific errors", async () => {
  const linked = makeFakeTree({ symbolicLinks: ["link"] });
  await assert.rejects(
    walkBoundedReleaseTree(linked.root, {
      fsImpl: linked.fsImpl,
      errors: { symlink: "caller symlink error" },
    }),
    { message: "caller symlink error" },
  );

  const special = makeFakeTree({ specialEntries: ["socket"] });
  await assert.rejects(
    walkBoundedReleaseTree(special.root, {
      fsImpl: special.fsImpl,
      errors: { unsupportedEntry: "caller special-entry error" },
    }),
    { message: "caller special-entry error" },
  );
});
