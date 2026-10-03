import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";

import {
  augmentSnapshotWithPdfText,
  decodeBrowserPdfData,
  decodeScreenshotPng,
  pruneScreenshotStorage,
  resolveScreenshotPath,
  screenshotTarget,
} from "../../src/equinox-browser-artifacts.js";

const TEMP_ROOT = process.env.TMPDIR || os.tmpdir();

function pdfPayload(text = "%PDF-1.4\nfixture\n") {
  const bytes = Buffer.from(text, "utf8");
  return { pdfContentVersion: 1, byteLength: bytes.length, data: bytes.toString("base64") };
}

test("PDF payload decoder enforces version, byte length, canonical base64 and PDF header", () => {
  const payload = pdfPayload();
  assert.deepEqual(decodeBrowserPdfData(payload), Buffer.from(payload.data, "base64"));
  assert.throws(() => decodeBrowserPdfData({ ...payload, data: `${payload.data}!` }), /base64 length\/integrity/u);
  assert.throws(() => decodeBrowserPdfData({ ...payload, pdfContentVersion: 0 }), /pdfContentVersion 1/u);
  assert.throws(() => decodeBrowserPdfData(pdfPayload("not a document")), /valid PDF header/u);
});

test("PDF snapshot enrichment preserves privacy redaction, node budgets, and delta snapshots", () => {
  const snapshot = {
    text: "existing page text",
    elementCount: 1,
    returnedElementCount: 1,
    elements: [{ name: "existing" }],
    privacy: { sensitiveTextRedaction: true, sensitiveRedactionCount: 2 },
    snapshot: { mainFrameId: "main" },
  };
  const enriched = augmentSnapshotWithPdfText(snapshot, {
    parser: "fixture-parser",
    pageCount: 1,
    pages: [{ pageNumber: 1, text: `Verification code 123456\ntoken=supersecretvalue\n${"safe ".repeat(1_000)}` }],
    truncated: false,
  }, 2);

  assert.equal(enriched.pdfContent.version, 1);
  assert.equal(enriched.pdfContent.textChunks, 1);
  assert.equal(enriched.pdfContent.truncated, true);
  assert.equal(enriched.pdfContent.sensitiveRedactionCount, 2);
  assert.equal(enriched.privacy.sensitiveRedactionCount, 4);
  assert.match(enriched.text, /Verification code \[REDACTED\]/u);
  assert.doesNotMatch(enriched.text, /123456|supersecretvalue/u);
  assert.equal(enriched.elements.length, 2);
  const delta = { deltaOnly: true };
  assert.equal(augmentSnapshotWithPdfText(delta, { pages: [] }), delta);
});

test("screenshot decoder checks PNG signature and dimensions before returning decoded pixels", () => {
  const png = PNG.sync.write({ width: 2, height: 1, data: Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]) });
  assert.equal(decodeScreenshotPng(png.toString("base64")).png.width, 2);
  assert.throws(() => decodeScreenshotPng(Buffer.from("not png").toString("base64")), /PNG imzası/u);

  const excessive = Buffer.from(png);
  excessive.writeUInt32BE(40_001, 16);
  assert.throws(() => decodeScreenshotPng(excessive.toString("base64")), /32 MB|20000px/u);
});

test("screenshot paths stay within runtime storage and pruning enforces capture quota", async () => {
  const root = await fs.mkdtemp(path.join(TEMP_ROOT, "equinox-artifact-helper-"));
  const screenshotRoot = path.join(root, "browser-screenshots");
  try {
    const captureId = "capture-0000000000000-11111111-2222-4333-8444-555555555555";
    const relativeParts = ["browser-screenshots", captureId, "browser", "view.png"];
    const target = screenshotTarget(screenshotRoot, { captureId, collection: "browser", name: "view" });
    assert.equal(target.relativePath, relativeParts.join("/"));

    const forwardSlashResolverPath = relativeParts.join("/");
    assert.equal(resolveScreenshotPath(screenshotRoot, forwardSlashResolverPath).absolutePath, target.absolutePath);

    const windowsRelativePath = path.win32.join(...relativeParts);
    assert.equal(resolveScreenshotPath(screenshotRoot, windowsRelativePath).absolutePath, target.absolutePath);
    assert.equal(resolveScreenshotPath(screenshotRoot, target.relativePath).absolutePath, target.absolutePath);

    assert.throws(() => resolveScreenshotPath(screenshotRoot, "browser-screenshots/../../escape/browser/view.png"), /expected format|runtime screenshot/u);

    await fs.mkdir(screenshotRoot, { recursive: true });
    for (let index = 0; index < 25; index += 1) {
      const id = `capture-${String(index).padStart(13, "0")}-11111111-2222-4333-8444-555555555555`;
      await fs.mkdir(path.join(screenshotRoot, id), { recursive: true });
    }
    const cleanup = await pruneScreenshotStorage(screenshotRoot, Date.now());
    assert.equal(cleanup.retainedCaptures, 24);
    assert.equal(cleanup.removedCaptures, 1);
    assert.equal((await fs.readdir(screenshotRoot)).length, 24);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
