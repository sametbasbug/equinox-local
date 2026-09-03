import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DEV_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(DEV_DIR, "../../extension");
const EXPECTED_PERMISSIONS = ["alarms", "debugger", "downloads", "nativeMessaging", "storage", "tabs"];
const EXPECTED_PRODUCTION_ID = "npdneefcobilfkjlihghjgjnknenhfoj";
const EXPECTED_ICONS = new Map([
  ["16", 16],
  ["32", 32],
  ["48", 48],
  ["128", 128],
]);

function pngDimensions(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(buffer.subarray(0, 8).equals(signature), true, "icon must be PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function extensionIdFromManifestKey(key) {
  const prefix = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...prefix]
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16)))
    .join("");
}

test("Equinox Browser product manifest stays minimal, versioned and icon-complete", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(EXTENSION_DIR, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Equinox Browser");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual([...manifest.permissions].sort(), EXPECTED_PERMISSIONS);
  assert.equal(Object.hasOwn(manifest, "host_permissions"), false);
  assert.equal(typeof manifest.key, "string");
  assert.equal(extensionIdFromManifestKey(manifest.key), EXPECTED_PRODUCTION_ID);
  assert.equal(manifest.background?.service_worker, "service-worker.js");
  assert.equal(manifest.action?.default_title, "Equinox Browser");
  assert.equal(manifest.action?.default_popup, "popup.html");

  for (const [key, size] of EXPECTED_ICONS) {
    const relativePath = manifest.icons?.[key];
    assert.equal(relativePath, `icons/icon-${size}.png`);
    const icon = await fs.readFile(path.join(EXTENSION_DIR, relativePath));
    assert.deepEqual(pngDimensions(icon), { width: size, height: size });
  }
});

test("popup ships prominent browser-data consent, accessible controls and local agent identity without inline script", async () => {
  const html = await fs.readFile(path.join(EXTENSION_DIR, "popup.html"), "utf8");
  assert.match(html, /id="consent-card"/);
  assert.match(html, /id="accept-consent"/);
  assert.match(html, /https:\/\/local\.sametbasbug\.dev\/privacy/);
  assert.match(html, /tab content/iu);
  assert.match(html, /screenshots/iu);
  assert.match(html, /text you enter/iu);
  assert.match(html, /console\/network metadata/iu);
  assert.match(html, /AI service you choose/iu);
  assert.match(html, /id="open-agent-browser"[^>]*disabled/);
  assert.match(html, /Agent Browser/);
  assert.match(html, /id="enabled-toggle"/);
  assert.match(html, /id="cursor-toggle"/);
  assert.match(html, /id="agent-name"[^>]*maxlength="32"/);
  assert.equal((html.match(/role="switch"/g) || []).length, 2);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<script src="popup\.js"><\/script>/);
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false, "popup must not use inline script");
});

test("shipped extension directory contains runtime files only", async () => {
  const rootEntries = (await fs.readdir(EXTENSION_DIR, { withFileTypes: true }))
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(rootEntries, ["icons", "manifest.json", "popup.css", "popup.html", "popup.js", "service-worker.js"]);

  const iconEntries = (await fs.readdir(path.join(EXTENSION_DIR, "icons"))).sort();
  assert.deepEqual(iconEntries, ["icon-128.png", "icon-16.png", "icon-32.png", "icon-48.png"]);
});
