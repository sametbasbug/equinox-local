import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";

const PDF_SIGNATURE = Buffer.from("%PDF-", "ascii");

export const MAX_BROWSER_PDF_BYTES = 16 * 1024 * 1024;
export const MAX_BROWSER_PDF_TEXT_PAGES = 100;
export const MAX_BROWSER_PDF_PAGE_CHARS = 20_000;
export const MAX_BROWSER_PDF_TEXT_CHARS = 200_000;

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

function boundedPageText(items, maxChars) {
  let output = "";
  let truncated = false;
  for (const item of Array.isArray(items) ? items : []) {
    if (output.length >= maxChars) {
      truncated = true;
      break;
    }
    if (!item || typeof item.str !== "string") continue;
    const normalized = item.str.replace(/\u0000/gu, "").replace(/\r\n?/gu, "\n");
    const separator = item.hasEOL === true ? "\n" : "";
    const remaining = maxChars - output.length;
    const chunk = `${normalized}${separator}`;
    if (chunk.length > remaining) {
      output += chunk.slice(0, remaining);
      truncated = true;
      break;
    }
    output += chunk;
  }
  return Object.freeze({ text: output, truncated });
}

export async function extractBrowserPdfText(buffer, {
  maxBytes = MAX_BROWSER_PDF_BYTES,
  maxPages = MAX_BROWSER_PDF_TEXT_PAGES,
  maxChars = MAX_BROWSER_PDF_TEXT_CHARS,
  maxPageChars = MAX_BROWSER_PDF_PAGE_CHARS,
  getDocumentImpl = getDocument,
} = {}) {
  const byteLimit = boundedInteger(maxBytes, MAX_BROWSER_PDF_BYTES, 1, MAX_BROWSER_PDF_BYTES);
  const pageLimit = boundedInteger(maxPages, MAX_BROWSER_PDF_TEXT_PAGES, 1, 250);
  const charLimit = boundedInteger(maxChars, MAX_BROWSER_PDF_TEXT_CHARS, 1, 1_000_000);
  const pageCharLimit = boundedInteger(maxPageChars, MAX_BROWSER_PDF_PAGE_CHARS, 1, 100_000);
  assertPdfBuffer(buffer, byteLimit);
  if (typeof getDocumentImpl !== "function") throw new Error("Browser PDF parser is unavailable.");

  const loadingTask = getDocumentImpl({
    data: new Uint8Array(buffer),
    disableWorker: true,
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  if (!loadingTask?.promise || typeof loadingTask.destroy !== "function") {
    throw new Error("Browser PDF parser returned an invalid loading task.");
  }

  try {
    const document = await loadingTask.promise;
    const pageCount = boundedInteger(document?.numPages, 0, 0, 1_000_000);
    if (!document || typeof document.getPage !== "function" || pageCount < 1) {
      throw new Error("Browser PDF parser could not read any pages.");
    }

    const pages = [];
    let remaining = charLimit;
    let truncated = pageCount > pageLimit;
    const count = Math.min(pageCount, pageLimit);
    for (let pageNumber = 1; pageNumber <= count && remaining > 0; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      if (!page || typeof page.getTextContent !== "function") {
        throw new Error(`Browser PDF parser could not read page ${pageNumber}.`);
      }
      const textContent = await page.getTextContent({ disableNormalization: false });
      const perPageLimit = Math.min(pageCharLimit, remaining);
      const bounded = boundedPageText(textContent?.items, perPageLimit);
      pages.push({ pageNumber, text: bounded.text });
      if (bounded.truncated) truncated = true;
      remaining -= bounded.text.length;
      if (typeof page.cleanup === "function") page.cleanup();
    }
    if (pages.length < count || remaining <= 0) truncated = true;

    return {
      parser: "pdfjs-dist",
      pageCount,
      pages,
      truncated,
      textChars: pages.reduce((sum, page) => sum + page.text.length, 0),
    };
  } finally {
    await loadingTask.destroy().catch(() => {});
  }
}

export const __test = Object.freeze({ assertPdfBuffer, boundedPageText });
