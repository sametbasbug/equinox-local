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
  assert.equal(translateUiText("Checking Main snapshot", "tr"), "Main snapshot kontrol ediliyor");
  assert.equal(translateUiText("Current SHA 5df006f", "tr"), "Mevcut SHA 5df006f");
  assert.equal(translateUiText("Target SHA 500784c", "tr"), "Hedef SHA 500784c");
  assert.equal(translateUiText("Distance ↓3 ↑0", "tr"), "Mesafe ↓3 ↑0");
  assert.equal(translateUiText("3 commits available in Main snapshot", "tr"), "Main snapshot'ta 3 commit kullanılabilir");
  assert.equal(translateUiText("1 commit available in Main snapshot", "tr"), "Main snapshot'ta 1 commit kullanılabilir");
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

test("Control Center localization never conflates private Your Browser with isolated Agent Browser",()=>{
  assert.equal(translateUiText("Agent Browser","tr"),"Agent Browser");
  assert.equal(translateUiText("Your Browser","tr"),"Tarayıcınız");
  assert.notEqual(translateUiText("Your Browser","tr"),translateUiText("Agent Browser","tr"));
  assert.equal(translateUiText("No silent browser fallback","tr"),"Sessiz tarayıcı fallback'i yok");
  assert.equal(translateUiText("Your Browser","de"),"Your Browser");
});

test("Control Center localization retains credential and single-human consent labels without interpolating private values",()=>{
  for(const label of [
    "The token stays only on this computer. Do not share it with the agent or paste it into chat.",
    "Saved credentials are write-only and are never loaded back into this page.",
    "Connect a Telegram bot to one Telegram account. Groups and channels are not supported, and agents cannot choose another recipient.",
    "Credentials remain human-only and are never exposed to the agent.",
  ]){
    assert.equal(translateUiText(label,"en"),label);
  }
  const identifier="fixture-secret-sentinel";
  const event="Synthetic inbound private account "+identifier+" not in dictionary";
  for(const language of ["en","tr","de"]){
    assert.equal(translateUiText(event,language),event);
    assert.equal(translateRuntimeEventMessage(event,language),event);
  }
});

test("Control Center localization rejects unsupported locale by selecting English without substituting dynamic owner identifiers",()=>{
  for(const unsupported of ["TR-tr","de",null,undefined,47,{},[]]){
    assert.equal(normalizeLanguage(unsupported),"en");
    assert.equal(localeForLanguage(unsupported),"en-US");
    assert.equal(translateUiText("Your Browser",unsupported),"Your Browser");
  }
  const sha="a1b2c3d";
  const suffix="synthetic-source-SHA-abcdef";
  assert.equal(translateUiText("Current SHA "+sha,"tr"),"Mevcut SHA "+sha);
  assert.equal(translateUiText("Target SHA "+sha,"tr"),"Hedef SHA "+sha);
  assert.equal(translateUiText("Current SHA "+suffix,"tr"),"Current SHA "+suffix);
  assert.equal(translateUiText("Restarting into Equinox Local "+suffix,"tr"),
    "Equinox Local "+suffix+" sürümüne yeniden başlatılıyor");
});

test("Control Center translations do not transform unrecognized markup or synthetic errors into executable content",()=>{
  const untrusted='<img src=x onerror="synthetic-side-effect()">';
  const suspicious=[
    untrusted,
    "Unrecognized runtime error: "+untrusted,
    "Unexpected owner token "+untrusted,
    "  Dashboard  ",
  ];
  for(const value of suspicious){
    assert.equal(translateUiText(value,"tr"),value);
    assert.equal(translateRuntimeEventMessage(value,"tr"),value);
  }
  assert.equal(translateDoctorDetail({detail:untrusted},"tr"),untrusted);
  assert.equal(translateDoctorDetail({detail:""},"tr"),"Ek ayrıntı yok.");
});


test("Control Center refuses inherited Object keys as untrusted runtime translations", () => {
  for (const text of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "__defineGetter__", "prototype"]) {
    for (const translate of [translateUiText, translateRuntimeEventMessage]) {
      for (const language of ["tr", "en", "de"]) {
        const result = translate(text, language);
        assert.equal(typeof result, "string", `${text} must never resolve to an Object prototype property`);
        assert.equal(result, text);
      }
    }
    assert.equal(translateDoctorDetail({detail:text}, "tr"), text);
  }
  assert.equal(translateUiText("Dashboard", "tr"), "Gösterge Paneli");
  assert.equal(translateRuntimeEventMessage("Workflow completed successfully.", "tr"), "Workflow başarıyla tamamlandı.");
});

test("Control Center does not mistake a poisoned Object prototype for a catalog translation", () => {
  const sentinel = "synthetic-untrusted-event-not-in-catalog";
  const original = Object.getOwnPropertyDescriptor(Object.prototype, sentinel);
  try {
    Object.defineProperty(Object.prototype, sentinel, {value:"spoofed dictionary text", configurable:true, writable:true});
    assert.equal(translateUiText(sentinel, "tr"), sentinel);
    assert.equal(translateRuntimeEventMessage(sentinel, "tr"), sentinel);
    assert.equal(translateUiText("Dashboard", "tr"), "Gösterge Paneli");
  } finally {
    if (original) Object.defineProperty(Object.prototype,sentinel,original);
    else delete Object.prototype[sentinel];
  }
});
