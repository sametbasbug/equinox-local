import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as z from "zod/v4";

import { registerAssetMutationTools } from "../../src/equinox-local-asset-mutation-tools.js";

function createHarness(overrides = {}) {
  const registrations = new Map();
  const unlinks = [];
  const stats = {
    dev: 1,
    ino: 2,
    size: 42,
    mtimeMs: 1234,
  };
  const inspected = {
    fileName: "hero.png",
    kind: "png",
    realPath: "/tmp/inbox/hero.png",
    sha256: "a".repeat(64),
    stats,
  };

  registerAssetMutationTools({
    registerTextTool(name, config, handler, options = {}) {
      registrations.set(name, { config, handler, options });
    },
    z,
    inspectInboxAsset: async () => inspected,
    fsImpl: {
      async lstat() {
        return {
          ...stats,
          isSymbolicLink: () => false,
          isFile: () => true,
        };
      },
      async unlink(target) {
        unlinks.push(target);
      },
    },
    formatAssetBytes: (bytes) => `${bytes} B`,
    textResult: (text) => ({ content: [{ type: "text", text }] }),
    errorResult: (error) => ({
      content: [{ type: "text", text: `Hata: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    }),
    ...overrides,
  });

  return { registrations, unlinks, inspected, stats };
}

test("delete_inbox_asset preserves destructive project-independent metadata", () => {
  const { registrations } = createHarness();
  const registration = registrations.get("delete_inbox_asset");
  assert.ok(registration);
  assert.equal(registration.config.annotations.readOnlyHint, false);
  assert.equal(registration.config.annotations.destructiveHint, true);
  assert.equal(registration.config.annotations.idempotentHint, false);
  assert.deepEqual(registration.options, { projectAware: false });
});

test("delete_inbox_asset refuses SHA mismatch before filesystem mutation", async () => {
  const { registrations, unlinks } = createHarness();
  const result = await registrations.get("delete_inbox_asset").handler({
    file: "hero.png",
    expected_sha256: "b".repeat(64),
  });
  assert.equal(result.isError, true);
  assert.equal(unlinks.length, 0);
  assert.match(result.content[0].text, /SHA-256 uyuşmazlığı/u);
});

test("delete_inbox_asset revalidates file identity before unlink", async () => {
  const unlinks = [];
  const harness = createHarness({
    fsImpl: {
      async lstat() {
        return {
          dev: 1,
          ino: 999,
          size: 42,
          mtimeMs: 1234,
          isSymbolicLink: () => false,
          isFile: () => true,
        };
      },
      async unlink(target) {
        unlinks.push(target);
      },
    },
  });
  const result = await harness.registrations.get("delete_inbox_asset").handler({
    file: "hero.png",
    expected_sha256: "a".repeat(64),
  });
  assert.equal(result.isError, true);
  assert.equal(unlinks.length, 0);
  assert.match(result.content[0].text, /silme öncesinde değişti/u);
});

test("delete_inbox_asset unlinks only after SHA and identity checks", async () => {
  const { registrations, unlinks } = createHarness();
  const result = await registrations.get("delete_inbox_asset").handler({
    file: "hero.png",
    expected_sha256: "A".repeat(64),
  });
  assert.deepEqual(unlinks, ["/tmp/inbox/hero.png"]);
  assert.match(result.content[0].text, /Inbox varlığı silindi: hero\.png/u);
  assert.match(result.content[0].text, /Doğrulanan SHA-256: a{64}/u);
});

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function createTransferRegistration(overrides = {}) {
  const registrations = new Map();
  const projectRoot = overrides.projectRoot;
  const inboxRoot = overrides.inboxRoot;
  registerAssetMutationTools({
    registerTextTool(name, config, handler, options = {}) {
      registrations.set(name, { config, handler, options });
    },
    z,
    inspectInboxAsset: overrides.inspectInboxAsset,
    fsImpl: fs,
    pathImpl: path,
    processImpl: { pid: 4242 },
    formatAssetBytes: (bytes) => `${bytes} B`,
    assertNoGitOperationInProgress: async () => {},
    getCurrentGitBranch: async () => "equinox/test",
    validateAssetDestination(destination) {
      return {
        normalized: destination,
        extension: path.extname(destination).toLowerCase(),
      };
    },
    assertAssetExtensionCompatible(sourceExtension, destinationExtension) {
      assert.equal(destinationExtension, sourceExtension);
    },
    getActiveProjectRoot: () => projectRoot,
    safeResolve: async (relativePath) => path.resolve(projectRoot, relativePath),
    isInsideProject: (candidate) =>
      candidate === projectRoot || candidate.startsWith(`${projectRoot}${path.sep}`),
    assertPathNotIgnored: async () => {},
    runGitWithCode: async () => ({ code: 0, stdout: "?? assets/hero.png\n", stderr: "" }),
    maxInboxAssetBytes: 10 * 1024 * 1024,
    sha256Buffer: async (buffer) => sha256(buffer),
    getActiveProjectId: () => "test-project",
    getActiveProjectName: () => "Test Project",
    readBoundedNormalFile: async (absolutePath) => ({
      data: await fs.readFile(absolutePath),
      stat: await fs.stat(absolutePath),
    }),
    allowedInboxAssetExtensions: new Set([".png"]),
    detectAndValidateAsset: () => ({ kind: "png", mime: "image/png" }),
    validateInboxAssetName(fileName) {
      return {
        fileName,
        extension: path.extname(fileName).toLowerCase(),
      };
    },
    resolveAssetInboxRoot: async () => inboxRoot,
    displayPath: (absolutePath) => path.relative(projectRoot, absolutePath),
    textResult: (text) => ({ content: [{ type: "text", text }] }),
    errorResult: (error) => ({
      content: [{ type: "text", text: `Hata: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    }),
    ...overrides.dependencies,
  });
  return registrations;
}

test("asset transfer registrations preserve destructive metadata", () => {
  const registrations = createTransferRegistration({
    projectRoot: "/tmp/project",
    inboxRoot: "/tmp/inbox",
    inspectInboxAsset: async () => {
      throw new Error("not used");
    },
  });
  for (const name of ["import_asset", "export_asset"]) {
    const registration = registrations.get(name);
    assert.ok(registration);
    assert.equal(registration.config.annotations.readOnlyHint, false);
    assert.equal(registration.config.annotations.destructiveHint, true);
    assert.equal(registration.config.annotations.idempotentHint, false);
  }
});

test("import_asset atomically creates a new project asset with matching bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-asset-import-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const inboxRoot = path.join(root, "inbox");
  await fs.mkdir(path.join(projectRoot, "assets"), { recursive: true });
  await fs.mkdir(inboxRoot, { recursive: true });
  const sourceBuffer = Buffer.from("asset-import-bytes");
  const sourceHash = sha256(sourceBuffer);
  const sourcePath = path.join(inboxRoot, "hero.png");
  await fs.writeFile(sourcePath, sourceBuffer);
  const sourceStats = await fs.stat(sourcePath);
  const registrations = createTransferRegistration({
    projectRoot,
    inboxRoot,
    inspectInboxAsset: async () => ({
      fileName: "hero.png",
      extension: ".png",
      kind: "png",
      mime: "image/png",
      inboxRoot,
      realPath: sourcePath,
      buffer: sourceBuffer,
      sha256: sourceHash,
      stats: sourceStats,
    }),
  });
  const result = await registrations.get("import_asset").handler({
    inbox_file: "hero.png",
    expected_sha256: sourceHash,
    destination: "assets/hero.png",
    replace_existing: false,
    expected_destination_sha256: undefined,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(await fs.readFile(path.join(projectRoot, "assets/hero.png")), sourceBuffer);
  assert.match(result.content[0].text, /Web varlığı projeye aktarıldı/u);
});

test("import_asset removes a newly created target when post-write hash verification fails", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-asset-import-rollback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const inboxRoot = path.join(root, "inbox");
  await fs.mkdir(path.join(projectRoot, "assets"), { recursive: true });
  await fs.mkdir(inboxRoot, { recursive: true });
  const sourceBuffer = Buffer.from("asset-import-rollback");
  const sourceHash = sha256(sourceBuffer);
  const sourcePath = path.join(inboxRoot, "hero.png");
  await fs.writeFile(sourcePath, sourceBuffer);
  const sourceStats = await fs.stat(sourcePath);
  const registrations = createTransferRegistration({
    projectRoot,
    inboxRoot,
    inspectInboxAsset: async () => ({
      fileName: "hero.png",
      extension: ".png",
      kind: "png",
      mime: "image/png",
      inboxRoot,
      realPath: sourcePath,
      buffer: sourceBuffer,
      sha256: sourceHash,
      stats: sourceStats,
    }),
    dependencies: {
      sha256Buffer: async () => "f".repeat(64),
    },
  });
  const destination = path.join(projectRoot, "assets/hero.png");
  const result = await registrations.get("import_asset").handler({
    inbox_file: "hero.png",
    expected_sha256: sourceHash,
    destination: "assets/hero.png",
    replace_existing: false,
    expected_destination_sha256: undefined,
  });
  assert.equal(result.isError, true);
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
  assert.match(result.content[0].text, /SHA-256 özeti kaynakla eşleşmiyor/u);
});

test("export_asset copies validated source bytes into the inbox", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-asset-export-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project");
  const inboxRoot = path.join(root, "inbox");
  await fs.mkdir(path.join(projectRoot, "assets"), { recursive: true });
  await fs.mkdir(inboxRoot, { recursive: true });
  const sourceBuffer = Buffer.from("asset-export-bytes");
  const sourceHash = sha256(sourceBuffer);
  const sourcePath = path.join(projectRoot, "assets/logo.png");
  await fs.writeFile(sourcePath, sourceBuffer);
  const registrations = createTransferRegistration({
    projectRoot,
    inboxRoot,
    inspectInboxAsset: async (fileName) => {
      const realPath = path.join(inboxRoot, fileName);
      const buffer = await fs.readFile(realPath);
      return {
        fileName,
        extension: ".png",
        kind: "png",
        mime: "image/png",
        inboxRoot,
        realPath,
        buffer,
        sha256: sha256(buffer),
        stats: await fs.stat(realPath),
      };
    },
  });
  const result = await registrations.get("export_asset").handler({
    source_path: "assets/logo.png",
    expected_sha256: sourceHash,
    inbox_name: "logo.png",
    replace_existing: false,
    expected_inbox_sha256: undefined,
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(await fs.readFile(path.join(inboxRoot, "logo.png")), sourceBuffer);
  assert.match(result.content[0].text, /Web varlığı inbox'a aktarıldı/u);
});
