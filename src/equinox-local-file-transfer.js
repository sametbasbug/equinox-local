import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

import { createProtectedAgentPathChecker, isSensitiveAgentName } from "./equinox-local-agent-path-policy.js";
import { readBoundedNormalFile } from "./equinox-local-safe-file.js";
import { isPathInside } from "./worktree-utils.js";

export const MAX_FILE_EXPORT_BYTES = 128 * 1024 * 1024;
export const MAX_FILE_IMPORT_BYTES = 512 * 1024 * 1024;
export const FILE_IMPORT_TIMEOUT_MS = 3 * 60 * 1000;

export function defaultWebImportRoot(homeDir = os.homedir()) {
  return path.join(homeDir, "Downloads", "Equinox Local", "Web");
}

export function defaultWebImportSettingsPath(homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "Application Support", "Equinox Local", "settings", "web-imports.json");
}

function normalizeWebImportPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) throw new Error("Web file transfer folder must be an absolute path.");
  const normalized = path.resolve(value);
  if (normalized === path.parse(normalized).root) throw new Error("Web file transfer folder cannot be the filesystem root.");
  return normalized;
}

async function ensureNormalDirectory(value, { fsImpl = fs, create = false } = {}) {
  const normalized = normalizeWebImportPath(value);
  if (create) await fsImpl.mkdir(normalized, { recursive: true, mode: 0o755 });
  const stat = await fsImpl.lstat(normalized);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Web file transfer folder must be a normal local directory.");
  return fsImpl.realpath(normalized);
}

export async function getWebImportSettings({ settingsPath = defaultWebImportSettingsPath(), homeDir = os.homedir(), fsImpl = fs } = {}) {
  const defaultPath = defaultWebImportRoot(homeDir);
  let parsed = null;
  try { parsed = JSON.parse(await fsImpl.readFile(settingsPath, "utf8")); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  const configuredPath = parsed?.downloadPath ? normalizeWebImportPath(parsed.downloadPath) : defaultPath;
  return Object.freeze({ path: configuredPath, isDefault: configuredPath === defaultPath, autoCleanup: false });
}

export async function setWebImportLocation({ downloadPath = null, settingsPath = defaultWebImportSettingsPath(), homeDir = os.homedir(), fsImpl = fs } = {}) {
  const defaultPath = defaultWebImportRoot(homeDir);
  const resetToDefault = downloadPath == null;
  const defaultReal = await ensureNormalDirectory(defaultPath, { fsImpl, create: true });
  const selected = resetToDefault
    ? defaultReal
    : await ensureNormalDirectory(downloadPath, { fsImpl, create: false });
  const parent = path.dirname(settingsPath);
  await fsImpl.mkdir(parent, { recursive: true, mode: 0o700 });
  await fsImpl.chmod(parent, 0o700).catch(() => {});
  await fsImpl.writeFile(settingsPath, `${JSON.stringify({ version: 1, downloadPath: resetToDefault || selected === defaultReal ? null : selected }, null, 2)}\n`, { mode: 0o600 });
  await fsImpl.chmod(settingsPath, 0o600).catch(() => {});
  return getWebImportSettings({ settingsPath, homeDir, fsImpl });
}

const MIME_BY_EXTENSION = new Map([
  [".txt", "text/plain"], [".md", "text/markdown"], [".csv", "text/csv"], [".json", "application/json"],
  [".pdf", "application/pdf"], [".zip", "application/zip"], [".gz", "application/gzip"], [".tar", "application/x-tar"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".gif", "image/gif"], [".webp", "image/webp"], [".svg", "image/svg+xml"],
  [".mp4", "video/mp4"], [".mov", "video/quicktime"], [".mp3", "audio/mpeg"], [".wav", "audio/wav"],
  [".ppt", "application/vnd.ms-powerpoint"], [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".doc", "application/msword"], [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xls", "application/vnd.ms-excel"], [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
]);

function expandUserPath(value, homeDir, label) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`${label} must be a non-empty local path.`);
  const input = value.trim();
  const expanded = input === "~" ? homeDir : input.startsWith("~/") ? path.join(homeDir, input.slice(2)) : input;
  if (!path.isAbsolute(expanded)) throw new Error(`${label} must be absolute or start with ~/.`);
  return path.normalize(expanded);
}

function assertTransferPathParts(absolutePath) {
  for (const part of path.normalize(absolutePath).split(path.sep).filter(Boolean)) {
    if (part === ".git") throw new Error("File transfer cannot traverse a .git directory.");
    if (isSensitiveAgentName(part)) throw new Error(`File transfer path contains a protected sensitive name: ${part}`);
  }
}

function inferMimeType(fileName) {
  return MIME_BY_EXTENSION.get(path.extname(fileName).toLowerCase()) ?? "application/octet-stream";
}

function exportMimeType(fileName, data) {
  const mimeType = inferMimeType(fileName);
  if (!mimeType.startsWith("text/") || !Buffer.isBuffer(data)) return mimeType;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return `${mimeType}; charset=utf-8`;
  } catch {
    return mimeType;
  }
}

async function configuredRoots(ids, resolver) {
  const roots = [];
  for (const id of ids) {
    try { roots.push((await resolver(id)).rootRealPath); } catch { /* unavailable roots do not broaden access */ }
  }
  return roots;
}

function assertAllowedByRoots(targetPath, roots, label) {
  if (!roots.some((root) => isPathInside(root, targetPath))) throw new Error(`${label} is outside the configured Selected Agent Access roots.`);
}

export async function resolveFileExportPath({ filePath, fullFileAccess, fileRootIds, resolveFileRootContext, homeDir, fsImpl = fs } = {}) {
  const candidate = expandUserPath(filePath, homeDir, "file_export path");
  assertTransferPathParts(candidate);
  const isProtectedPath = createProtectedAgentPathChecker(homeDir);
  if (isProtectedPath(candidate)) throw new Error("File export path is inside a protected credential or application-data area.");
  const stats = await fsImpl.lstat(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("file_export requires a normal, non-symlink file.");
  if (stats.size > MAX_FILE_EXPORT_BYTES) throw new Error(`file_export supports files up to ${MAX_FILE_EXPORT_BYTES / 1024 / 1024} MiB.`);
  const realCandidate = await fsImpl.realpath(candidate);
  assertTransferPathParts(realCandidate);
  if (isProtectedPath(realCandidate)) throw new Error("File export resolves into a protected credential or application-data area.");
  if (!fullFileAccess) assertAllowedByRoots(realCandidate, await configuredRoots(fileRootIds, resolveFileRootContext), "File export path");
  return Object.freeze({ absolutePath: realCandidate, bytes: stats.size });
}

export async function createFileExportResult(options = {}) {
  const resolved = await resolveFileExportPath(options);
  const { data, stat } = await readBoundedNormalFile(resolved.absolutePath, {
    fsImpl: options.fsImpl ?? fs, minBytes: 0, maxBytes: MAX_FILE_EXPORT_BYTES, label: "File export",
  });
  if (!Buffer.isBuffer(data) || data.length !== stat.size || data.length !== resolved.bytes) throw new Error("File changed while it was being exported; retry with a stable file.");
  const fileName = path.basename(resolved.absolutePath);
  const mimeType = exportMimeType(fileName, data);
  const sha256 = createHash("sha256").update(data).digest("hex");
  return { content: [
    { type: "text", text: [`Exported local file: ${fileName}`, `Size: ${data.length} bytes`, `MIME: ${mimeType}`, `SHA-256: ${sha256}`].join("\n") },
    { type: "resource", resource: { uri: `equinox-local://file-export/${sha256}/${encodeURIComponent(fileName)}`, mimeType, blob: data.toString("base64") }, annotations: { audience: ["user"], priority: 1 } },
  ] };
}

function safeAttachmentName(file) {
  const raw = typeof file?.file_name === "string" ? file.file_name.trim() : "";
  const baseName = path.posix.basename(raw.replaceAll("\\", "/"));
  if (baseName && baseName !== "." && baseName !== ".." && !baseName.includes("\0")) {
    if (isSensitiveAgentName(baseName)) throw new Error(`Attachment filename is protected by the credential policy: ${baseName}`);
    return baseName;
  }
  const safeId = String(file?.file_id ?? "file").replace(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 80) || "file";
  return `chatgpt-${safeId}.bin`;
}

async function inspectDestination({ destination, sourceFileName, fullFileAccess, projectIds, resolveProjectContext, homeDir, fsImpl = fs } = {}) {
  let candidate = destination === undefined
    ? path.join(homeDir, "Downloads", sourceFileName)
    : expandUserPath(destination, homeDir, "file_import destination");
  try {
    const destinationStat = await fsImpl.lstat(candidate);
    if (destinationStat.isSymbolicLink()) throw new Error("file_import destination cannot be a symlink.");
    if (destinationStat.isDirectory()) candidate = path.join(await fsImpl.realpath(candidate), sourceFileName);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  assertTransferPathParts(candidate);
  const isProtectedPath = createProtectedAgentPathChecker(homeDir);
  if (isProtectedPath(candidate)) throw new Error("File import destination is inside a protected credential or application-data area.");
  const parentReal = await fsImpl.realpath(path.dirname(candidate));
  const parentStat = await fsImpl.stat(parentReal);
  if (!parentStat.isDirectory()) throw new Error("file_import destination parent must be an existing directory.");
  const target = path.join(parentReal, path.basename(candidate));
  assertTransferPathParts(target);
  if (isProtectedPath(target)) throw new Error("File import destination resolves into a protected credential or application-data area.");
  if (!fullFileAccess) assertAllowedByRoots(target, await configuredRoots(projectIds, resolveProjectContext), "File import destination");
  return Object.freeze({ target, parentReal });
}

async function downloadAttachmentToTemp({ file, parentReal, fetchImpl = globalThis.fetch, fsImpl = fs, maxBytes = MAX_FILE_IMPORT_BYTES, timeoutMs = FILE_IMPORT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("file_import requires fetch support.");
  let parsed;
  try { parsed = new URL(file.download_url); } catch { throw new Error("file_import received an invalid download URL."); }
  if (parsed.protocol !== "https:") throw new Error("file_import accepts only HTTPS attachment download URLs.");
  const signal = typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : undefined;
  const response = await fetchImpl(parsed.href, { method: "GET", redirect: "follow", signal });
  if (!response?.ok) throw new Error(`file_import download failed with HTTP ${response?.status ?? "unknown"}.`);
  if (response.url && new URL(response.url).protocol !== "https:") throw new Error("file_import refused a redirect to a non-HTTPS URL.");
  const declaredLength = Number.parseInt(response.headers?.get?.("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error(`file_import supports attachments up to ${maxBytes / 1024 / 1024} MiB.`);
  if (!response.body || typeof response.body.getReader !== "function") throw new Error("file_import response body is unavailable.");

  const temporaryPath = path.join(parentReal, `.equinox-import-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const handle = await fsImpl.open(temporaryPath, "wx", 0o644);
  const hash = createHash("sha256");
  let total = 0;
  let succeeded = false;
  try {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`file_import supports attachments up to ${maxBytes / 1024 / 1024} MiB.`);
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    await handle.sync();
    succeeded = true;
  } finally {
    await handle.close().catch(() => {});
    if (!succeeded) await fsImpl.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return Object.freeze({ temporaryPath, bytes: total, sha256: hash.digest("hex") });
}

function suffixedPath(target, index) {
  const parsed = path.parse(target);
  return path.join(parsed.dir, `${parsed.name} (${index})${parsed.ext}`);
}

async function publishImportedFile({ temporaryPath, target, collision, fsImpl = fs }) {
  if (collision === "replace") {
    let existed = false;
    try {
      const existing = await fsImpl.lstat(target);
      if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("file_import can replace only a normal, non-symlink file.");
      existed = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fsImpl.rename(temporaryPath, target);
    return Object.freeze({ destination: target, renamed: false, replaced: existed });
  }
  const attempts = collision === "rename" ? 10_000 : 1;
  for (let index = 0; index < attempts; index += 1) {
    const candidate = index === 0 ? target : suffixedPath(target, index + 1);
    try {
      await fsImpl.link(temporaryPath, candidate);
      await fsImpl.unlink(temporaryPath);
      return Object.freeze({ destination: candidate, renamed: candidate !== target, replaced: false });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (collision === "error") throw new Error("file_import destination already exists; use collision=rename or collision=replace.");
    }
  }
  throw new Error("file_import could not find a free destination filename.");
}

export async function importChatGptFile({ file, destination, collision = "rename", fullFileAccess, projectIds, resolveProjectContext, homeDir = os.homedir(), settingsPath = defaultWebImportSettingsPath(homeDir), fetchImpl = globalThis.fetch, fsImpl = fs } = {}) {
  if (!file || typeof file !== "object") throw new Error("file_import requires one ChatGPT attachment on the same user turn.");
  if (typeof file.file_id !== "string" || !file.file_id || typeof file.download_url !== "string") throw new Error("file_import received an incomplete ChatGPT file reference.");
  if (!["rename", "replace", "error"].includes(collision)) throw new Error("file_import collision must be rename, replace, or error.");
  const sourceFileName = safeAttachmentName(file);
  let effectiveDestination = destination;
  if (effectiveDestination === undefined) {
    const settings = await getWebImportSettings({ settingsPath, homeDir, fsImpl });
    effectiveDestination = await ensureNormalDirectory(settings.path, { fsImpl, create: settings.isDefault });
  }
  const resolved = await inspectDestination({ destination: effectiveDestination, sourceFileName, fullFileAccess, projectIds, resolveProjectContext, homeDir, fsImpl });
  const downloaded = await downloadAttachmentToTemp({ file, parentReal: resolved.parentReal, fetchImpl, fsImpl });
  try {
    const published = await publishImportedFile({ temporaryPath: downloaded.temporaryPath, target: resolved.target, collision, fsImpl });
    return Object.freeze({ ...published, bytes: downloaded.bytes, sha256: downloaded.sha256, sourceFileId: file.file_id, sourceFileName, mimeType: typeof file.mime_type === "string" ? file.mime_type : null });
  } catch (error) {
    await fsImpl.rm(downloaded.temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function registerFileTransferTools({ registerRawTool, z, fullFileAccess, fileRootIds, projectIds, resolveFileRootContext, resolveProjectContext, homeDir = process.env.HOME, webImportSettingsPath = defaultWebImportSettingsPath(homeDir), fetchImpl = globalThis.fetch, fsImpl = fs } = {}) {
  registerRawTool("file_export", {
    description: "Intentionally transfer one normal local file from the Mac into the current ChatGPT conversation as a native downloadable file result. Do not use this merely to inspect a local PNG/JPEG/WebP; use image_view so the model can inspect the Mac path directly without a transfer/container-copy workflow. Arbitrary file types are supported up to 128 MiB. Full Agent Access accepts accessible absolute/~/ paths except protected credential/application-data paths; Selected mode stays inside configured roots. Symlinks and .git/sensitive credential paths are blocked.",
    inputSchema: { path: z.string().min(1).max(4096).describe("Absolute local file path or ~/ path to send to ChatGPT") },
    annotations: { title: "Send local file to ChatGPT", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ path: filePath }) => createFileExportResult({ filePath, fullFileAccess, fileRootIds, resolveFileRootContext, homeDir, fsImpl }), { capabilityDomain: "files", mcpExposed: false });

  const chatGptFileSchema = z.object({
    download_url: z.string().url(), file_id: z.string().min(1).max(256), mime_type: z.string().min(1).max(200).optional(), file_name: z.string().min(1).max(255).optional(),
  }).strict();
  registerRawTool("file_import", {
    description: "Save one ChatGPT attachment onto the Mac through the native file bridge. Arbitrary file types are accepted up to 512 MiB and streamed to disk. destination is optional and defaults to the Control Center Web file transfer folder (~/Downloads/Equinox Local/Web by default); an existing directory means save inside it. collision defaults to rename and may be replace or error. Full Agent Access supports accessible absolute/~/ destinations except protected paths; Selected mode writes only inside configured project roots.",
    inputSchema: {
      file: chatGptFileSchema,
      destination: z.string().min(1).max(4096).optional().describe("Optional absolute or ~/ destination file/directory path; defaults to the configured Web file transfer folder with the original filename"),
      collision: z.enum(["rename", "replace", "error"]).default("rename").describe("rename preserves an existing file by choosing a free name; replace overwrites a normal file; error refuses collisions"),
    },
    annotations: { title: "Save ChatGPT attachment to Mac", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ file, destination, collision }) => {
    const result = await importChatGptFile({ file, destination, collision, fullFileAccess, projectIds, resolveProjectContext, homeDir, settingsPath: webImportSettingsPath, fetchImpl, fsImpl });
    return { content: [{ type: "text", text: [
      `Saved ChatGPT attachment to ${result.destination}`,
      `Size: ${result.bytes} bytes`,
      `SHA-256: ${result.sha256}`,
      result.renamed ? "Collision: kept existing file and chose a new filename" : null,
      result.replaced ? "Collision: replaced existing normal file" : null,
    ].filter(Boolean).join("\n") }] };
  }, { capabilityDomain: "files", mcpExposed: false });
}

export const __test = Object.freeze({ inferMimeType, exportMimeType, safeAttachmentName, inspectDestination, downloadAttachmentToTemp, publishImportedFile });
