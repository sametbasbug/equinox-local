import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const html = readFileSync(new URL("../../src/equinox-control-center.html", import.meta.url), "utf8");
const js = readFileSync(new URL("../../src/equinox-control-center.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../../src/server.js", import.meta.url), "utf8");

test("Control Center has exactly one accessible sidebar update dialog, without Overview update card", () => {
  assert.doesNotMatch(html, /class="panel-card update-card"/u);
  assert.doesNotMatch(html, /Private on this computer · 127\.0\.0\.1/u);
  assert.match(html, /id="sidebar-update-button"[^>]*aria-haspopup="dialog"[^>]*aria-controls="update-dialog"/u);
  assert.match(html, /<dialog id="update-dialog"[^>]*aria-labelledby="update-dialog-heading"/u);
  for (const id of ["update-title", "update-copy", "update-badge", "update-main-summaries", "check-update-button", "install-update-button", "update-stable-main-notice"]) {
    assert.equal(html.match(new RegExp(`id="${id}"`, "gu"))?.length, 1, `${id} must be a single dialog control`);
  }
  assert.match(js, /\$\("update-dialog"\)\.showModal\(\)/u);
  assert.match(js, /renderSidebarUpdateNotice\(update, main, mainChannel\)/u);
});

test("Main and Stable current-version display differ and background checks do not activate updates", () => {
  assert.match(js, /onMain && currentSha/u);
  assert.match(js, /mainChannel && runningSha/u);
  assert.match(js, /else if \(!mainChannel && update\.mainNotice\?\.targetSha\)/u);
  assert.match(server, /setTimeout\(automaticUpdateCheck, 5_000\)/u);
  assert.match(server, /setInterval\(automaticUpdateCheck, 6 \* 60 \* 60_000\)/u);
  const automatic = server.slice(server.indexOf("const checkInstalledChannelForUpdates ="), server.indexOf("const getCombinedUpdateStatus ="));
  assert.doesNotMatch(automatic, /\.apply\(/u);
  assert.match(automatic, /Promise\.allSettled/u);
});
