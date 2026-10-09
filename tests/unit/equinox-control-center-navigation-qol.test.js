import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../../src/equinox-control-center.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../../src/equinox-control-center.css", import.meta.url), "utf8");
const js = readFileSync(new URL("../../src/equinox-control-center.js", import.meta.url), "utf8");
const locale = readFileSync(new URL("../../src/equinox-control-center-localization.js", import.meta.url), "utf8");

const sections = ["dashboard", "projects", "tasks", "browser", "permissions", "integrations", "activity"];

test("sidebar presents seven scoped keyboard hints with a readable modifier legend", () => {
  for (const [index, section] of sections.entries()) {
    const button = html.match(new RegExp(`<button class="nav-item(?: is-active)?" type="button" data-section="${section}"[^>]*>([\\s\\S]*?)<\\/button>`, "u"));
    assert.ok(button, `missing ${section} section`);
    assert.match(button[1], new RegExp(`<kbd class="nav-hotkey" aria-hidden="true">${index + 1}<\\/kbd>`, "u"));
  }
  assert.match(html, /id="navigation-shortcuts-hint"/u);
  assert.match(locale, /"Shortcuts: Alt\/Option \+ Shift \+ 1–7": "Kısayollar: Alt\/Option/u);
  assert.match(css, /\.nav-item\.is-active::before/u);
  assert.match(css, /\.navigation-shortcuts-hint/u);
  assert.match(css, /\.nav-hotkey, \.navigation-shortcuts-hint \{ display: none; \}/u);
});

test("navigation is remembered only on human actions; setup and explicit links take precedence", () => {
  assert.match(js, /const SECTION_STORAGE_KEY = /u);
  assert.match(js, /localStorage\.setItem\(SECTION_STORAGE_KEY, section\)/u);
  assert.match(js, /remember && section !== "setup"/u);
  assert.match(js, /button\.dataset\.section, \{ remember: true \}/u);
  assert.match(js, /button\.dataset\.jumpSection, \{ remember: true \}/u);
  assert.match(js, /if \(section && sectionMeta\[section\]\) state\.activeSection = section/u);
  assert.match(js, /else if \(taskId && .*\) state\.activeSection = "tasks"/u);
  assert.match(js, /remembered && remembered !== "setup" && sectionMeta\[remembered\]/u);
});

test("navigation shortcuts skip editor input, open dialogs and restricted setup", () => {
  assert.match(js, /event\.altKey.*event\.shiftKey.*event\.ctrlKey.*event\.metaKey.*event\.repeat.*event\.isComposing/u);
  assert.match(js, /state\.setupMode \|\| document\.body\.classList\.contains\("control-loading"\) \|\| document\.querySelector\("dialog\[open\]"\)/u);
  assert.match(js, /event\.target instanceof Element && event\.target\.closest\('input, textarea, select, \[contenteditable\], \[role="textbox"\]'\)/u);
  assert.match(js, /event\.preventDefault\(\);\s+switchSection\(section, \{ remember: true \}\)/u);
  assert.match(css, /body\.setup-mode \.navigation-shortcuts-hint \{ display: none; \}/u);
});
