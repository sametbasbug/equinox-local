import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const OSASCRIPT = "/usr/bin/osascript";
const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");

export const MAX_BROWSER_PDF_BYTES = 16 * 1024 * 1024;
export const MAX_BROWSER_PDF_TEXT_PAGES = 100;
export const MAX_BROWSER_PDF_PAGE_CHARS = 20_000;
export const MAX_BROWSER_PDF_TEXT_CHARS = 200_000;

const PDFKIT_SCRIPT = `
ObjC.import('Foundation');
ObjC.import('PDFKit');
function run(argv) {
  const pdfPath = String(argv[0] || '');
  const maxPages = Math.max(1, Math.min(250, Number(argv[1]) || 100));
  const maxChars = Math.max(1, Math.min(1000000, Number(argv[2]) || 200000));
  const maxPageChars = Math.max(1, Math.min(100000, Number(argv[3]) || 20000));
  const url = $.NSURL.fileURLWithPath(pdfPath);
  const document = $.PDFDocument.alloc.initWithURL(url);
  if (!document) throw new Error('PDFKit could not open the document');
  const pageCount = Number(document.pageCount);
  const pages = [];
  let remaining = maxChars;
  let truncated = pageCount > maxPages;
  const pageLimit = Math.min(pageCount, maxPages);
  for (let index = 0; index < pageLimit && remaining > 0; index += 1) {
    const page = document.pageAtIndex(index);
    const raw = page && page.string ? String(ObjC.unwrap(page.string)) : '';
    const clean = raw.replace(/\\u0000/g, '').replace(/\\r\\n?/g, '\\n');
    const allowed = Math.min(maxPageChars, remaining);
    const text = clean.slice(0, allowed);
    if (clean.length > text.length) truncated = true;
    pages.push({ pageNumber: index + 1, text });
    remaining -= text.length;
  }
  if (pageLimit < pageCount || remaining <= 0) truncated = true;
  return JSON.stringify({ pageCount, pages, truncated });
}
`;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function assertPdfBuffer(buffer, maxBytes) {
  if (!Buffer.isBuffer(buffer)) throw new Error("Browser PDF parser requires a Buffer.");
  if (buffer.length < PDF_SIGNATURE.length || buffer.length > maxBytes) {
    throw new Error(`Browser PDF exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MB parsing limit.`);
  }
  if (buffer.subarray(0, Math.min(buffer.length, 1024)).indexOf(PDF_SIGNATURE) < 0) {
    throw new Error("Browser PDF data does not contain a valid PDF header.");
  }
}

export async function extractBrowserPdfText(buffer, {
  platform = process.platform,
  execFileAsync = execFile,
  tempRoot = os.tmpdir(),
  maxBytes = MAX_BROWSER_PDF_BYTES,
  maxPages = MAX_BROWSER_PDF_TEXT_PAGES,
  maxChars = MAX_BROWSER_PDF_TEXT_CHARS,
  maxPageChars = MAX_BROWSER_PDF_PAGE_CHARS,
} = {}) {
  if (platform !== "darwin") throw new Error("Browser PDF text extraction currently requires macOS PDFKit.");
  const byteLimit = boundedInteger(maxBytes, MAX_BROWSER_PDF_BYTES, 1, MAX_BROWSER_PDF_BYTES);
  const pageLimit = boundedInteger(maxPages, MAX_BROWSER_PDF_TEXT_PAGES, 1, 250);
  const charLimit = boundedInteger(maxChars, MAX_BROWSER_PDF_TEXT_CHARS, 1, 1_000_000);
  const pageCharLimit = boundedInteger(maxPageChars, MAX_BROWSER_PDF_PAGE_CHARS, 1, 100_000);
  assertPdfBuffer(buffer, byteLimit);

  const directory = await fs.mkdtemp(path.join(tempRoot, "equinox-browser-pdfkit-"));
  const pdfPath = path.join(directory, "document.pdf");
  const scriptPath = path.join(directory, "extract.js");
  try {
    await fs.chmod(directory, 0o700);
    await fs.writeFile(pdfPath, buffer, { flag: "wx", mode: 0o600 });
    await fs.writeFile(scriptPath, PDFKIT_SCRIPT, { flag: "wx", mode: 0o600 });
    const result = await execFileAsync(OSASCRIPT, [
      "-l", "JavaScript", scriptPath, pdfPath,
      String(pageLimit), String(charLimit), String(pageCharLimit),
    ], {
      timeout: 15_000,
      maxBuffer: Math.min(5 * 1024 * 1024, charLimit * 4 + 256 * 1024),
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME || "",
      },
    });
    let parsed;
    try {
      parsed = JSON.parse(String(result?.stdout || "").trim());
    } catch {
      throw new Error("macOS PDFKit returned malformed text extraction output.");
    }
    const pageCount = boundedInteger(parsed?.pageCount, 0, 0, 1_000_000);
    const pages = Array.isArray(parsed?.pages) ? parsed.pages.slice(0, pageLimit).map((page, index) => ({
      pageNumber: boundedInteger(page?.pageNumber, index + 1, 1, Math.max(1, pageCount || pageLimit)),
      text: String(page?.text || "").replace(/\u0000/gu, "").replace(/\r\n?/gu, "\n").slice(0, pageCharLimit),
    })) : [];
    let remaining = charLimit;
    let truncated = Boolean(parsed?.truncated) || pages.length < Math.min(pageCount, pageLimit);
    const boundedPages = [];
    for (const page of pages) {
      if (remaining <= 0) { truncated = true; break; }
      const text = page.text.slice(0, remaining);
      if (text.length < page.text.length) truncated = true;
      boundedPages.push({ ...page, text });
      remaining -= text.length;
    }
    return {
      parser: "macos-pdfkit",
      pageCount,
      pages: boundedPages,
      truncated,
      textChars: boundedPages.reduce((sum, page) => sum + page.text.length, 0),
    };
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}

export const __test = Object.freeze({ OSASCRIPT, PDFKIT_SCRIPT, assertPdfBuffer });
