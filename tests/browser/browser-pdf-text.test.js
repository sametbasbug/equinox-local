import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractBrowserPdfText,
  MAX_BROWSER_PDF_BYTES,
} from "../../src/browser-pdf-text.js";

const FIXTURE = Buffer.from("%PDF-1.4\nEquinox PDF Fixture\n", "utf8");

test("PDFKit extraction uses a private temporary file and removes it after bounded parsing", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-browser-pdf-test-"));
  let workingDirectory = null;
  let seenPdf = null;
  const result = await extractBrowserPdfText(FIXTURE, {
    tempRoot,
    maxPages: 3,
    maxChars: 2_000,
    execFileAsync: async (binary, args, options) => {
      assert.equal(binary, "/usr/bin/osascript");
      assert.deepEqual(args.slice(0, 2), ["-l", "JavaScript"]);
      const scriptPath = args[2];
      const pdfPath = args[3];
      workingDirectory = path.dirname(pdfPath);
      seenPdf = await fs.readFile(pdfPath);
      const scriptMode = (await fs.stat(scriptPath)).mode & 0o777;
      const pdfMode = (await fs.stat(pdfPath)).mode & 0o777;
      assert.equal(scriptMode, 0o600);
      assert.equal(pdfMode, 0o600);
      assert.equal(options.timeout, 15_000);
      return {
        stdout: JSON.stringify({
          pageCount: 2,
          pages: [
            { pageNumber: 1, text: "Equinox PDF Fixture" },
            { pageNumber: 2, text: "Second page" },
          ],
          truncated: false,
        }),
        stderr: "",
      };
    },
  });

  assert.deepEqual(seenPdf, FIXTURE);
  assert.equal(result.parser, "macos-pdfkit");
  assert.equal(result.pageCount, 2);
  assert.equal(result.pages[0].text, "Equinox PDF Fixture");
  assert.equal(result.textChars, "Equinox PDF Fixture".length + "Second page".length);
  await assert.rejects(fs.stat(workingDirectory), /ENOENT/u);
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test("PDFKit extraction rejects invalid and oversized PDF input before spawning a helper", async () => {
  let calls = 0;
  const execFileAsync = async () => {
    calls += 1;
    return { stdout: "{}", stderr: "" };
  };
  await assert.rejects(
    extractBrowserPdfText(Buffer.from("not a pdf"), { execFileAsync }),
    /valid PDF header/u,
  );
  await assert.rejects(
    extractBrowserPdfText(Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(MAX_BROWSER_PDF_BYTES)]), { execFileAsync }),
    /parsing limit/u,
  );
  assert.equal(calls, 0);
});
