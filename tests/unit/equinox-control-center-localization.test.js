import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  SUPPORTED_LANGUAGES,
  localeForLanguage,
  normalizeLanguage,
  translateDoctorDetail,
  translateRuntimeEventMessage,
  translateUiText,
} from "../../src/equinox-control-center-localization.js";

test("Control Center localization normalizes explicit language and locale without browser globals", () => {
  assert.deepEqual([...SUPPORTED_LANGUAGES], ["en", "tr"]);
  assert.equal(normalizeLanguage("tr"), "tr");
  assert.equal(normalizeLanguage("en"), "en");
  assert.equal(normalizeLanguage("fr"), "en");
  assert.equal(localeForLanguage("tr"), "tr-TR");
  assert.equal(localeForLanguage("en"), "en-US");
});

test("Control Center startup language respects saved, native, navigator and English fallback priority", async () => {
  const source = await fs.readFile(new URL("../../src/equinox-control-center.js", import.meta.url), "utf8");
  const start = source.indexOf("function initialLanguage() {");
  const end = source.indexOf("\nfunction notifyNativeLanguage()", start);
  assert.ok(start >= 0 && end > start, "execute the actual entrypoint language initializer");
  const initializer = source.slice(start, end);
  const choose = ({ saved = null, native = null, navigatorLanguage = "en-US", storageBlocked = false } = {}) => (
    vm.runInNewContext(`${initializer}\ninitialLanguage()`, {
      SUPPORTED_LANGUAGES,
      LANGUAGE_STORAGE_KEY: "equinox-local-control-center-language",
      localStorage: { getItem(key) {
        assert.equal(key, "equinox-local-control-center-language");
        if (storageBlocked) throw new Error("Storage blocked by host");
        return saved;
      } },
      window: { __equinoxNativeLanguage: native },
      navigator: { language: navigatorLanguage },
    }, { timeout: 1000 })
  );
  assert.equal(choose({ saved: "en", native: "tr", navigatorLanguage: "tr-TR" }), "en");
  assert.equal(choose({ saved: "tr", native: "en", navigatorLanguage: "en-US" }), "tr");
  assert.equal(choose({ saved: "fr", native: "en", navigatorLanguage: "tr-TR" }), "en");
  assert.equal(choose({ native: "tr", navigatorLanguage: "en-US", storageBlocked: true }), "tr");
  assert.equal(choose({ saved: "fr", native: "de", navigatorLanguage: "TR-tr" }), "tr");
  assert.equal(choose({ navigatorLanguage: "de-DE", storageBlocked: true }), "en");
  assert.equal(choose({ navigatorLanguage: null }), "en");
});

test("UI translator preserves exact catalog text, dynamic values, and unknown text", () => {
  assert.equal(translateUiText("Dashboard", "tr"), "Gösterge Paneli");
  assert.equal(translateUiText("Dashboard", "en"), "Dashboard");
  assert.equal(translateUiText("12 tasks", "tr"), "12 görev");
  assert.equal(translateUiText("Checked yesterday", "tr"), "Kontrol edildi: yesterday");
  assert.equal(translateUiText("Checking canonical main", "tr"), "Canonical main kontrol ediliyor");
  assert.equal(translateUiText("Current SHA 5df006f", "tr"), "Mevcut SHA 5df006f");
  assert.equal(translateUiText("Target SHA 500784c", "tr"), "Hedef SHA 500784c");
  assert.equal(translateUiText("Distance ↓3 ↑0", "tr"), "Mesafe ↓3 ↑0");
  assert.equal(translateUiText("3 commits available on main", "tr"), "main'de 3 commit kullanılabilir");
  assert.equal(translateUiText("1 commit available on main", "tr"), "main'de 1 commit kullanılabilir");
  assert.equal(translateUiText("Main update check needs attention", "tr"), "Main güncelleme kontrolü dikkat gerektiriyor");
  assert.equal(translateUiText("New source text", "tr"), "New source text");
  assert.equal(translateUiText("  Dashboard  ", "tr"), "  Dashboard  ");
});

test("doctor details use the same explicit-language UI translator", () => {
  assert.equal(translateDoctorDetail({ detail: "No additional detail." }, "tr"), "Ek ayrıntı yok.");
  assert.equal(translateDoctorDetail({}, "tr"), "Ek ayrıntı yok.");
  assert.equal(translateDoctorDetail({ detail: "Custom backend detail" }, "en"), "Custom backend detail");
});

test("runtime-event translator canonicalizes legacy Turkish and localizes with explicit language", () => {
  const legacy = "Workflow başladı: release";
  assert.equal(translateRuntimeEventMessage(legacy, "en"), "Workflow started: release");
  assert.equal(translateRuntimeEventMessage(legacy, "tr"), "Workflow başladı: release");
  assert.equal(translateRuntimeEventMessage("Workflow completed successfully.", "tr"), "Workflow başarıyla tamamlandı.");
  assert.equal(
    translateRuntimeEventMessage("Peekaboo safe tool-surface compatibility check passed.", "tr"),
    "Peekaboo güvenli araç yüzeyi uyumluluk kontrolünü geçti.",
  );
  assert.equal(translateRuntimeEventMessage("unknown event", "en"), "unknown event");
});
