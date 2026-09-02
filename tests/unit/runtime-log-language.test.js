import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const TURKISH_GLYPHS = /[ğüşöçıİĞÜŞÖÇ]/u;
const EVENT_PRODUCER_FILES = [
  "terminal-manager.js",
  "process-manager.js",
  "workflow-manager.js",
  "peekaboo-bridge.js",
  "recovery-policy.js",
  "repair-engine.js",
  "runtime-janitor.js",
  "chrome-profile-bridge.js",
];

function runtimeSourceUrl(file) {
  const factoryUrl = new URL(`./${file}`, import.meta.url);
  if (existsSync(factoryUrl)) return factoryUrl;
  const publicUrl = new URL(`../../src/${file}`, import.meta.url);
  return existsSync(publicUrl) ? publicUrl : null;
}

function readRuntimeSource(file) {
  const sourceUrl = runtimeSourceUrl(file);
  return sourceUrl ? readFileSync(sourceUrl, "utf8") : null;
}

test("canonical runtime observability messages are English", () => {
  for (const file of EVENT_PRODUCER_FILES) {
    const source = readRuntimeSource(file);
    if (source === null) continue;
    let index = source.indexOf("message:");
    while (index !== -1) {
      const snippet = source.slice(index, index + 260).split("details:")[0];
      assert.doesNotMatch(
        snippet,
        TURKISH_GLYPHS,
        `${file} has a Turkish observability message near: ${snippet}`,
      );
      index = source.indexOf("message:", index + 1);
    }
  }
});

test("persisted workflow and release logs use canonical English labels", () => {
  const workflow = readRuntimeSource("workflow-manager.js");
  const releaseGate = readRuntimeSource("release-gate.js");
  assert.notEqual(workflow, null, "workflow-manager.js must exist in factory and public runtime");

  for (const legacy of [
    "Workflow kaydı oluşturuldu",
    "Adım başladı",
    "Adım tamamlandı",
    "Adım başarısız",
    "Workflow motoru hatası",
    "Workflow iptal isteği alındı",
    "Release preview başlatıldı",
  ]) {
    assert.equal(
      workflow.includes(legacy) || Boolean(releaseGate?.includes(legacy)),
      false,
      `legacy Turkish log label remained: ${legacy}`,
    );
  }

  assert.match(workflow, /Workflow record created:/u);
  assert.match(workflow, /Step started:/u);
  assert.match(workflow, /Workflow completed successfully\./u);
  if (releaseGate !== null) assert.match(releaseGate, /Release preview started:/u);
});
