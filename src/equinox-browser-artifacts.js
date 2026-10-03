import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PNG } from "pngjs";
import { MAX_BROWSER_PDF_BYTES } from "./browser-pdf-text.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_SCREENSHOT_PNG_BYTES = 32 * 1024 * 1024;
const MAX_SCREENSHOT_PNG_PIXELS = 20_000_000;
const MAX_SCREENSHOT_PNG_DIMENSION = 20_000;
export const SCREENSHOT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const SCREENSHOT_CAPTURE_ID_PATTERN = /^capture-\d{13}-[0-9a-f-]{36}$/u;
export const SCREENSHOT_RETENTION_MS = 60 * 60 * 1000;
export const SCREENSHOT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export const SCREENSHOT_MAX_CAPTURE_DIRS = 24;
const SCREENSHOT_MAX_TREE_ENTRIES = 100;

export function decodeBrowserPdfData(payload) {
  const version = Number(payload?.pdfContentVersion);
  if (!Number.isFinite(version) || version < 1) {
    throw new Error("Chrome PDF readable-content response is missing pdfContentVersion 1.");
  }
  const byteLength = Number(payload?.byteLength);
  if (!Number.isInteger(byteLength) || byteLength < 5 || byteLength > MAX_BROWSER_PDF_BYTES) {
    throw new Error(`Chrome PDF data exceeds the ${MAX_BROWSER_PDF_BYTES / 1024 / 1024} MB parsing limit.`);
  }
  const encoded = String(payload?.data || "");
  if (!encoded || encoded.length > Math.ceil(MAX_BROWSER_PDF_BYTES * 4 / 3) + 16) {
    throw new Error("Chrome PDF data is empty or exceeds the encoded transport limit.");
  }
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length !== byteLength || buffer.toString("base64") !== encoded) {
    throw new Error("Chrome PDF data failed base64 length/integrity validation.");
  }
  if (buffer.subarray(0, Math.min(buffer.length, 1024)).indexOf(Buffer.from("%PDF-", "ascii")) < 0) {
    throw new Error("Chrome PDF data does not contain a valid PDF header.");
  }
  return buffer;
}

function redactSensitivePdfText(rawValue) {
  let value = String(rawValue || "").replace(/\u0000/gu, "").replace(/\r\n?/gu, "\n");
  let count = 0;
  const replace = (pattern, replacement) => {
    value = value.replace(pattern, (...args) => {
      count += 1;
      return typeof replacement === "function" ? replacement(...args) : replacement;
    });
  };
  replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{8,}\b/giu, (_match, prefix) => `${prefix}[REDACTED]`);
  replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]");
  replace(/\b(?:api[ _-]?key|secret|token|session|authorization|password|passwd)\s*[:=]\s*[^\s,;]{6,}/giu, (match) => {
    const separator = match.search(/[:=]/u);
    return separator >= 0 ? `${match.slice(0, separator + 1)}[REDACTED]` : "[REDACTED]";
  });
  replace(/((?:otp|one[- ]time(?: password| code)?|verification code|security code|recovery code|account recovery code|login code|authentication code|confirmation code|passcode|doğrulama kodu|kurtarma kodu|hesap kurtarma kodu|giriş kodu|kimlik doğrulama kodu|onay kodu|tek kullanımlık(?: şifre| kod)?)[^\d]{0,24})\b\d{4,8}\b/giu, (_match, prefix) => `${prefix}[REDACTED]`);
  replace(/\b[a-f0-9]{40,}\b/giu, "[REDACTED]");
  replace(/\b[A-Za-z0-9_\-+/]{48,}={0,2}\b/gu, "[REDACTED]");
  return { value, count };
}

function pdfSnapshotFrameId(snapshot) {
  const frames = Array.isArray(snapshot?.frames) ? snapshot.frames : [];
  return frames.filter((frame) => (
    frame?.process === "oopif" && frame?.url === snapshot?.tab?.url
  )).at(-1)?.id || snapshot?.snapshot?.mainFrameId || null;
}

export function augmentSnapshotWithPdfText(snapshot, parsed, maxNodes = 250) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.deltaOnly) return snapshot;
  const existingCount = Number.isInteger(snapshot.elementCount) ? snapshot.elementCount : 0;
  const nodeBudget = Math.max(0, Math.min(250, Number(maxNodes) || 250) - existingCount);
  const pages = Array.isArray(parsed?.pages) ? parsed.pages : [];
  const privacyRedactionEnabled = snapshot?.privacy?.sensitiveTextRedaction === true;
  const processedPages = [];
  let sensitiveRedactionCount = 0;
  for (const page of pages) {
    const pageNumber = Number(page?.pageNumber) || processedPages.length + 1;
    if (privacyRedactionEnabled) {
      const redacted = redactSensitivePdfText(page?.text);
      sensitiveRedactionCount += redacted.count;
      processedPages.push({ pageNumber, text: redacted.value });
    } else {
      processedPages.push({
        pageNumber,
        text: String(page?.text || "").replace(/\u0000/gu, "").replace(/\r\n?/gu, "\n"),
      });
    }
  }

  const chunks = [];
  for (const page of processedPages) {
    const text = String(page.text || "");
    if (!text) continue;
    for (let offset = 0, chunkIndex = 0; offset < text.length; offset += 4_000, chunkIndex += 1) {
      chunks.push({
        pageNumber: page.pageNumber,
        chunkIndex,
        text: text.slice(offset, offset + 4_000),
      });
    }
  }
  const returnedChunks = chunks.slice(0, nodeBudget);
  const pdfTruncated = Boolean(parsed?.truncated) || returnedChunks.length < chunks.length;
  const returnedPageNumbers = new Set(returnedChunks.map((chunk) => chunk.pageNumber));
  const frameId = pdfSnapshotFrameId(snapshot);
  const syntheticElements = returnedChunks.map((chunk) => ({
    ref: null,
    role: "StaticText",
    name: chunk.text,
    value: null,
    frameId,
    frameProcess: frameId && frameId !== snapshot?.snapshot?.mainFrameId ? "oopif" : "same-process",
    disabled: null,
    checked: null,
    selected: null,
    pressed: null,
    expanded: null,
    required: null,
    focusable: null,
    contentSource: "pdfjs-dist",
    pdfPage: chunk.pageNumber,
    pdfChunk: chunk.chunkIndex,
  }));
  const textByPage = new Map();
  for (const chunk of returnedChunks) {
    const current = textByPage.get(chunk.pageNumber) || "";
    textByPage.set(chunk.pageNumber, `${current}${chunk.text}`);
  }
  const pdfText = [...textByPage.entries()]
    .map(([pageNumber, text]) => `[PDF page ${pageNumber}]\n${text}`)
    .join("\n");
  const result = {
    ...snapshot,
    pdfContent: {
      version: 1,
      parser: String(parsed?.parser || "pdfjs-dist"),
      pageCount: Number(parsed?.pageCount) || 0,
      parsedPages: processedPages.length,
      returnedPages: returnedPageNumbers.size,
      textChunks: returnedChunks.length,
      textChars: processedPages.reduce((sum, page) => sum + page.text.length, 0),
      textAvailable: Boolean(pdfText),
      truncated: pdfTruncated,
      sensitiveRedactionCount,
    },
    privacy: {
      ...(snapshot.privacy || {}),
      pdfTextRedaction: privacyRedactionEnabled,
      sensitiveRedactionCount: Number(snapshot?.privacy?.sensitiveRedactionCount || 0) + sensitiveRedactionCount,
    },
    elementCount: existingCount + returnedChunks.length,
    returnedElementCount: (Number.isInteger(snapshot.returnedElementCount) ? snapshot.returnedElementCount : 0) + returnedChunks.length,
    truncated: Boolean(snapshot.truncated) || pdfTruncated,
  };
  if (Object.hasOwn(snapshot, "text")) {
    result.text = [snapshot.text, pdfText].filter(Boolean).join("\n");
  }
  if (Array.isArray(snapshot.elements)) {
    result.elements = [...snapshot.elements, ...syntheticElements];
  }
  return result;
}

export function validateScreenshotName(value, label) {
  if (typeof value !== "string" || !SCREENSHOT_NAME_PATTERN.test(value)) {
    throw new Error(`${label} küçük harf, sayı, nokta, alt çizgi veya tire içermeli ve 1-80 karakter olmalı.`);
  }
  return value;
}

function readScreenshotPngDimensions(buffer) {
  if (
    buffer.length < 29 ||
    buffer.readUInt32BE(8) !== 13 ||
    buffer.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("Equinox Browser screenshot PNG IHDR başlığı geçersiz veya eksik.");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 1 || height < 1) {
    throw new Error("Equinox Browser screenshot PNG boyutları geçersiz.");
  }
  if (width > MAX_SCREENSHOT_PNG_DIMENSION || height > MAX_SCREENSHOT_PNG_DIMENSION) {
    throw new Error(`Equinox Browser screenshot PNG ${MAX_SCREENSHOT_PNG_DIMENSION}px boyut sınırını aşıyor.`);
  }
  if (width > Math.floor(MAX_SCREENSHOT_PNG_PIXELS / height)) {
    throw new Error(`Equinox Browser screenshot PNG ${MAX_SCREENSHOT_PNG_PIXELS} pixel güvenlik bütçesini aşıyor.`);
  }
  return { width, height };
}

export function decodeScreenshotPng(data) {
  const encoded = String(data || "");
  if (!encoded) throw new Error("Equinox Browser boş screenshot verisi döndürdü.");
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0 || buffer.length > MAX_SCREENSHOT_PNG_BYTES) {
    throw new Error(`Screenshot PNG ${MAX_SCREENSHOT_PNG_BYTES / 1024 / 1024} MB güvenlik sınırını aşıyor.`);
  }
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Equinox Browser screenshot çıktısı geçerli PNG imzası taşımıyor.");
  }
  readScreenshotPngDimensions(buffer);
  let png;
  try {
    png = PNG.sync.read(buffer, { checkCRC: true, skipRescale: false });
  } catch (error) {
    throw new Error(`Equinox Browser screenshot PNG çıktısı çözümlenemedi: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { buffer, png };
}

export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function writeScreenshotAtomic({ absolutePath, buffer }) {
  const parent = path.dirname(absolutePath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(parent, `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, buffer, { flag: "wx", mode: 0o600 });
    await fs.link(temporaryPath, absolutePath);
    await fs.unlink(temporaryPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function inspectScreenshotCapture(root, captureDir) {
  if (!isInside(root, captureDir)) return { safe: false, reason: "outside-root" };
  const rootStat = await fs.lstat(captureDir).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return { safe: false, reason: "invalid-root" };
  const stack = [captureDir];
  let entriesSeen = 0;
  let bytes = 0;
  let mtimeMs = rootStat.mtimeMs;
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > SCREENSHOT_MAX_TREE_ENTRIES) return { safe: false, reason: "too-many-entries" };
      const absolute = path.join(current, entry.name);
      if (!isInside(root, absolute) || entry.isSymbolicLink?.()) return { safe: false, reason: "unsafe-entry" };
      const stat = await fs.lstat(absolute);
      mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
      if (stat.isDirectory()) stack.push(absolute);
      else if (stat.isFile()) bytes += stat.size;
      else return { safe: false, reason: "unsupported-entry" };
    }
  }
  return { safe: true, bytes, mtimeMs };
}

export async function pruneScreenshotStorage(screenshotRoot, nowMs = Date.now()) {
  await fs.mkdir(screenshotRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(screenshotRoot, 0o700).catch(() => {});
  const entries = await fs.readdir(screenshotRoot, { withFileTypes: true });
  const captures = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SCREENSHOT_CAPTURE_ID_PATTERN.test(entry.name)) continue;
    const absolute = path.join(screenshotRoot, entry.name);
    const inspected = await inspectScreenshotCapture(screenshotRoot, absolute);
    if (inspected.safe) captures.push({ id: entry.name, absolute, ...inspected });
  }

  const removed = [];
  const removeCapture = async (capture, reason) => {
    await fs.rm(capture.absolute, { recursive: true, force: true });
    removed.push({ id: capture.id, bytes: capture.bytes, reason });
  };

  const retained = [];
  for (const capture of captures) {
    if (nowMs - capture.mtimeMs >= SCREENSHOT_RETENTION_MS) await removeCapture(capture, "retention");
    else retained.push(capture);
  }
  retained.sort((a, b) => (a.mtimeMs - b.mtimeMs) || a.id.localeCompare(b.id));
  let totalBytes = retained.reduce((sum, item) => sum + item.bytes, 0);
  while (retained.length > SCREENSHOT_MAX_CAPTURE_DIRS || totalBytes > SCREENSHOT_MAX_TOTAL_BYTES) {
    const oldest = retained.shift();
    if (!oldest) break;
    await removeCapture(oldest, "quota");
    totalBytes -= oldest.bytes;
  }
  return {
    removedCaptures: removed.length,
    reclaimedBytes: removed.reduce((sum, item) => sum + item.bytes, 0),
    retainedCaptures: retained.length,
    retainedBytes: totalBytes,
  };
}

export function screenshotTarget(screenshotRoot, { captureId, collection, name }) {
  const relativePath = path.posix.join("browser-screenshots", captureId, collection, `${name}.png`);
  const absolutePath = path.join(screenshotRoot, captureId, collection, `${name}.png`);
  if (!isInside(screenshotRoot, absolutePath)) throw new Error("Screenshot hedefi runtime kökünün dışına çıkıyor.");
  return { relativePath, absolutePath };
}

export function resolveScreenshotPath(screenshotRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() !== relativePath) {
    throw new Error("Screenshot yolu geçersiz.");
  }
  const normalized = relativePath.replaceAll("\\", "/").split("/");
  if (normalized.length !== 4 || normalized[0] !== "browser-screenshots") {
    throw new Error("Yalnız Equinox Browser runtime screenshot yolları silinebilir.");
  }
  const [, captureId, collection, filename] = normalized;
  if (!SCREENSHOT_CAPTURE_ID_PATTERN.test(captureId) || !SCREENSHOT_NAME_PATTERN.test(collection) || !filename.endsWith(".png")) {
    throw new Error("Screenshot runtime yolu beklenen biçimde değil.");
  }
  const name = filename.slice(0, -4);
  if (!SCREENSHOT_NAME_PATTERN.test(name)) throw new Error("Screenshot dosya adı beklenen biçimde değil.");
  const absolutePath = path.join(screenshotRoot, captureId, collection, filename);
  if (!isInside(screenshotRoot, absolutePath)) throw new Error("Screenshot yolu runtime kökünün dışına çıkıyor.");
  return { absolutePath, captureDir: path.join(screenshotRoot, captureId), collectionDir: path.join(screenshotRoot, captureId, collection) };
}
