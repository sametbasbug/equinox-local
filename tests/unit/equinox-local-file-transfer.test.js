import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import {
  __test as transferTest,
  createFileExportResult,
  importChatGptFile,
  MAX_FILE_EXPORT_BYTES,
  registerFileTransferTools,
  resolveFileExportPath,
} from "../../src/equinox-local-file-transfer.js";

function registrationHarness(options = {}) {
  const records = new Map();
  registerFileTransferTools({
    registerRawTool: (name, config, handler, toolOptions) => records.set(name, { name, config, handler, toolOptions }),
    z,
    fullFileAccess: true,
    fileRootIds: [],
    projectIds: [],
    resolveFileRootContext: async () => { throw new Error("unused"); },
    resolveProjectContext: async () => { throw new Error("unused"); },
    homeDir: "/Users/example",
    ...options,
  });
  return records;
}

function fileRef(overrides = {}) {
  return {
    download_url: "https://files.example.invalid/upload.bin",
    file_id: "file_123",
    mime_type: "application/octet-stream",
    file_name: "upload.bin",
    ...overrides,
  };
}

test("file transfer tools expose permanent export/import operations without MIME whitelists", () => {
  const tools = registrationHarness();
  assert.deepEqual([...tools.keys()], ["file_export", "file_import"]);
  assert.equal(tools.get("file_export").config.annotations.readOnlyHint, true);
  assert.equal(tools.get("file_import").config.annotations.readOnlyHint, false);
  assert.equal(tools.get("file_import").config.annotations.destructiveHint, true);
  assert.equal(tools.get("file_import").toolOptions.mcpExposed, false);
  const parsed = tools.get("file_import").config.inputSchema.file.safeParse(fileRef({
    mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    file_name: "odev.pptx",
  }));
  assert.equal(parsed.success, true);
});

test("file_export returns a valid native MCP resource with inferred MIME and exact bytes", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-file-export-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const source = path.join(homeDir, "sunum.pptx");
  const bytes = Buffer.from([0, 1, 2, 3, 255, 10, 42]);
  await fs.writeFile(source, bytes);

  const result = await createFileExportResult({
    filePath: source,
    fullFileAccess: true,
    fileRootIds: [],
    resolveFileRootContext: async () => { throw new Error("unused"); },
    homeDir,
  });
  assert.equal(CallToolResultSchema.safeParse(result).success, true);
  assert.match(result.content[0].text, /sunum\.pptx/u);
  assert.equal(result.content[1].type, "resource");
  assert.equal(result.content[1].resource.mimeType, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  const resourceUrl = new URL(result.content[1].resource.uri);
  assert.equal(resourceUrl.search, "");
  const resourceParts = resourceUrl.pathname.split("/").filter(Boolean);
  assert.equal(resourceParts.at(-2), createHash("sha256").update(bytes).digest("hex"));
  assert.equal(decodeURIComponent(resourceParts.at(-1)), "sunum.pptx");
  assert.deepEqual(Buffer.from(result.content[1].resource.blob, "base64"), bytes);
});

test("file_export keeps a clean Unicode filename and declares UTF-8 only for valid text bytes", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-file-export-utf8-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const fileName = "Türkçe-not-ş-ı.txt";
  const source = path.join(homeDir, fileName);
  const text = "Selamlar herkese. Samet karşınızda.";
  const bytes = Buffer.from(text, "utf8");
  await fs.writeFile(source, bytes);

  const result = await createFileExportResult({
    filePath: source,
    fullFileAccess: true,
    fileRootIds: [],
    resolveFileRootContext: async () => { throw new Error("unused"); },
    homeDir,
  });
  const resource = result.content[1].resource;
  assert.equal(resource.mimeType, "text/plain; charset=utf-8");
  const resourceUrl = new URL(resource.uri);
  assert.equal(resourceUrl.search, "");
  const resourceParts = resourceUrl.pathname.split("/").filter(Boolean);
  assert.equal(resourceParts.at(-2), createHash("sha256").update(bytes).digest("hex"));
  assert.equal(decodeURIComponent(resourceParts.at(-1)), fileName);
  assert.deepEqual(Buffer.from(resource.blob, "base64"), bytes);

  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x61]);
  assert.equal(transferTest.exportMimeType("legacy.txt", invalidUtf8), "text/plain");
});

test("file_export supports ~/ paths and Selected mode stays inside configured roots", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-file-export-roots-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const allowed = path.join(homeDir, "Allowed");
  const outside = path.join(homeDir, "Outside");
  await fs.mkdir(allowed);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(allowed, "inside.txt"), "inside");
  await fs.writeFile(path.join(outside, "outside.txt"), "outside");
  const resolver = async (id) => {
    assert.equal(id, "allowed");
    return { rootRealPath: await fs.realpath(allowed) };
  };

  const inside = await resolveFileExportPath({
    filePath: path.join(allowed, "inside.txt"),
    fullFileAccess: false,
    fileRootIds: ["allowed"],
    resolveFileRootContext: resolver,
    homeDir,
  });
  assert.equal(inside.absolutePath, path.join(await fs.realpath(allowed), "inside.txt"));

  await assert.rejects(resolveFileExportPath({
    filePath: path.join(outside, "outside.txt"),
    fullFileAccess: false,
    fileRootIds: ["allowed"],
    resolveFileRootContext: resolver,
    homeDir,
  }), /Selected Agent Access roots/u);

  const tilde = await resolveFileExportPath({
    filePath: "~/Allowed/inside.txt",
    fullFileAccess: true,
    fileRootIds: [],
    resolveFileRootContext: async () => { throw new Error("unused"); },
    homeDir,
  });
  assert.equal(tilde.absolutePath, path.join(await fs.realpath(allowed), "inside.txt"));
});

test("file_export blocks symlinks, sensitive names, and oversized files", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-file-export-guards-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const normal = path.join(homeDir, "normal.txt");
  await fs.writeFile(normal, "ok");
  await fs.symlink(normal, path.join(homeDir, "link.txt"));
  await fs.writeFile(path.join(homeDir, ".env"), "SECRET=x");
  const huge = path.join(homeDir, "huge.bin");
  const handle = await fs.open(huge, "w");
  await handle.truncate(MAX_FILE_EXPORT_BYTES + 1);
  await handle.close();
  const options = { fullFileAccess: true, fileRootIds: [], resolveFileRootContext: async () => {}, homeDir };
  await assert.rejects(resolveFileExportPath({ ...options, filePath: path.join(homeDir, "link.txt") }), /non-symlink/u);
  await assert.rejects(resolveFileExportPath({ ...options, filePath: path.join(homeDir, ".env") }), /protected sensitive name/u);
  await assert.rejects(resolveFileExportPath({ ...options, filePath: huge }), /128 MiB/u);
});

test("file_import streams arbitrary binary to Downloads and preserves filename/hash", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-file-import-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  await fs.mkdir(path.join(homeDir, "Downloads"));
  const body = Buffer.from([0, 255, 1, 2, 3, 10, 11]);
  const result = await importChatGptFile({
    file: fileRef({ file_name: "photo.raw" }),
    fullFileAccess: true,
    projectIds: [],
    resolveProjectContext: async () => { throw new Error("unused"); },
    homeDir,
    fetchImpl: async () => new Response(body, { status: 200, headers: { "content-type": "application/octet-stream" } }),
  });
  assert.equal(result.destination, path.join(await fs.realpath(path.join(homeDir, "Downloads")), "photo.raw"));
  assert.equal(result.bytes, body.length);
  assert.equal(result.sha256, createHash("sha256").update(body).digest("hex"));
  assert.deepEqual(await fs.readFile(result.destination), body);
});

test("file_import default collision renames; replace and error are explicit", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-file-import-collision-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const downloads = path.join(homeDir, "Downloads");
  await fs.mkdir(downloads);
  const original = path.join(downloads, "same.txt");
  await fs.writeFile(original, "old");
  const common = {
    file: fileRef({ file_name: "same.txt", mime_type: "text/plain" }),
    fullFileAccess: true,
    projectIds: [],
    resolveProjectContext: async () => { throw new Error("unused"); },
    homeDir,
  };
  const renamed = await importChatGptFile({ ...common, fetchImpl: async () => new Response("new") });
  assert.equal(renamed.destination, path.join(await fs.realpath(downloads), "same (2).txt"));
  assert.equal(await fs.readFile(original, "utf8"), "old");
  assert.equal(await fs.readFile(renamed.destination, "utf8"), "new");

  await assert.rejects(importChatGptFile({ ...common, collision: "error", fetchImpl: async () => new Response("nope") }), /already exists/u);
  const replaced = await importChatGptFile({ ...common, collision: "replace", fetchImpl: async () => new Response("replacement") });
  assert.equal(replaced.destination, path.join(await fs.realpath(downloads), "same.txt"));
  assert.equal(replaced.replaced, true);
  assert.equal(await fs.readFile(original, "utf8"), "replacement");
  const fresh = path.join(downloads, "fresh.txt");
  const createdWithReplace = await importChatGptFile({
    ...common,
    file: fileRef({ file_name: "fresh.txt", mime_type: "text/plain" }),
    collision: "replace",
    fetchImpl: async () => new Response("fresh"),
  });
  assert.equal(createdWithReplace.destination, path.join(await fs.realpath(downloads), "fresh.txt"));
  assert.equal(createdWithReplace.replaced, false);
  assert.equal(await fs.readFile(fresh, "utf8"), "fresh");

});

test("file_import accepts a directory destination and Selected mode writes only in project roots", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-file-import-selected-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const projectRoot = path.join(homeDir, "Project");
  const outside = path.join(homeDir, "Outside");
  await fs.mkdir(projectRoot);
  await fs.mkdir(outside);
  const resolver = async (id) => {
    assert.equal(id, "project");
    return { rootRealPath: await fs.realpath(projectRoot) };
  };
  const result = await importChatGptFile({
    file: fileRef({ file_name: "in.zip" }),
    destination: projectRoot,
    fullFileAccess: false,
    projectIds: ["project"],
    resolveProjectContext: resolver,
    homeDir,
    fetchImpl: async () => new Response("zipbytes"),
  });
  assert.equal(result.destination, path.join(await fs.realpath(projectRoot), "in.zip"));
  await assert.rejects(importChatGptFile({
    file: fileRef({ file_name: "out.zip" }),
    destination: outside,
    fullFileAccess: false,
    projectIds: ["project"],
    resolveProjectContext: resolver,
    homeDir,
    fetchImpl: async () => new Response("unused"),
  }), /Selected Agent Access roots/u);
});

test("file_import rejects non-HTTPS downloads and enforces streaming byte bound", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-file-import-bounds-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const downloads = path.join(homeDir, "Downloads");
  await fs.mkdir(downloads);
  await assert.rejects(transferTest.downloadAttachmentToTemp({
    file: fileRef({ download_url: "http://example.invalid/file" }),
    parentReal: downloads,
  }), /HTTPS/u);
  await assert.rejects(transferTest.downloadAttachmentToTemp({
    file: fileRef(),
    parentReal: downloads,
    maxBytes: 4,
    fetchImpl: async () => new Response("12345"),
  }), /up to/u);
});
