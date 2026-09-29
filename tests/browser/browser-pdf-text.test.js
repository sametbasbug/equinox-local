import assert from "node:assert/strict";
import test from "node:test";

import {
  extractBrowserPdfText,
  MAX_BROWSER_PDF_BYTES,
  __test,
} from "../../src/browser-pdf-text.js";

function escapePdfText(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

function makePdf(pages) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${3 + index} 0 R`).join(" ")}] /Count ${pages.length} >>`,
  ];
  const fontObject = 3 + pages.length;
  const firstContentObject = fontObject + 1;
  for (let index = 0; index < pages.length; index += 1) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${firstContentObject + index} 0 R >>`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (const text of pages) {
    const stream = `BT /F1 12 Tf 72 720 Td (${escapePdfText(text)}) Tj ET`;
    objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  }

  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets[index + 1] = Buffer.byteLength(output, "latin1");
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(output, "latin1");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) {
    output += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}

test("pdfjs extraction is platform-neutral and keeps bounded page text", async () => {
  const result = await extractBrowserPdfText(makePdf(["Equinox PDF Fixture", "Second page"]), {
    maxPages: 3,
    maxChars: 2_000,
  });
  assert.equal(result.parser, "pdfjs-dist");
  assert.equal(result.pageCount, 2);
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[0].text, "Equinox PDF Fixture");
  assert.equal(result.pages[1].text, "Second page");
  assert.equal(result.textChars, "Equinox PDF Fixture".length + "Second page".length);
  assert.equal(result.truncated, false);
});

test("pdfjs extraction enforces page and character bounds", async () => {
  const result = await extractBrowserPdfText(makePdf(["abcdefghij", "second page"]), {
    maxPages: 1,
    maxChars: 6,
    maxPageChars: 5,
  });
  assert.equal(result.pageCount, 2);
  assert.deepEqual(result.pages, [{ pageNumber: 1, text: "abcde" }]);
  assert.equal(result.textChars, 5);
  assert.equal(result.truncated, true);
});

test("pdfjs extraction rejects invalid and oversized PDF input before parsing", async () => {
  let calls = 0;
  const getDocumentImpl = () => {
    calls += 1;
    throw new Error("must not run");
  };
  await assert.rejects(
    extractBrowserPdfText(Buffer.from("not a pdf"), { getDocumentImpl }),
    /valid PDF header/u,
  );
  await assert.rejects(
    extractBrowserPdfText(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(MAX_BROWSER_PDF_BYTES)]), { getDocumentImpl }),
    /parsing limit/u,
  );
  assert.equal(calls, 0);
});

test("pdfjs loading task is destroyed on parse failure", async () => {
  let destroyed = 0;
  const getDocumentImpl = () => ({
    promise: Promise.reject(new Error("broken pdf")),
    destroy: async () => { destroyed += 1; },
  });
  await assert.rejects(
    extractBrowserPdfText(Buffer.from("%PDF-1.4\nfixture"), { getDocumentImpl }),
    /broken pdf/u,
  );
  assert.equal(destroyed, 1);
});

test("page text normalization is bounded without executing PDF content", () => {
  assert.deepEqual(__test.boundedPageText([
    { str: "a\u0000b\r\nc", hasEOL: true },
    { str: "def", hasEOL: false },
  ], 7), { text: "ab\nc\nde", truncated: true });
});
