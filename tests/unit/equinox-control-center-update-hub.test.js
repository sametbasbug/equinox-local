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
  for (const id of ["update-title", "update-copy", "update-badge", "update-main-summaries", "check-update-button", "install-update-button"]) {
    assert.equal(html.match(new RegExp(`id="${id}"`, "gu"))?.length, 1, `${id} must be a single dialog control`);
  }
  assert.match(js, /\$\("update-dialog"\)\.showModal\(\)/u);
  assert.match(js, /renderSidebarUpdateNotice\(update, main, mainChannel\)/u);
});

test("Main and Stable current-version display differ and background checks do not activate updates", () => {
  assert.match(js, /onMain && currentSha/u);
  assert.match(js, /mainChannel && runningSha/u);
  assert.doesNotMatch(js, /Main snapshot available separately from Stable\./u);
  assert.match(server, /setTimeout\(automaticUpdateCheck, 5_000\)/u);
  assert.match(server, /setInterval\(automaticUpdateCheck, 6 \* 60 \* 60_000\)/u);
  const automatic = server.slice(server.indexOf("const checkInstalledChannelForUpdates ="), server.indexOf("const getCombinedUpdateStatus ="));
  assert.doesNotMatch(automatic, /\.apply\(/u);
  assert.match(automatic, /Promise\.allSettled/u);
});

test("Stable update dialog shows only actionable version details, without migration notices", () => {
  assert.doesNotMatch(html, /update-stable-main-notice|docs\/updates\.md#single-main-update-stream/u);
  assert.doesNotMatch(js, /update-stable-main-notice|update-stable-main-copy/u);
  assert.doesNotMatch(html, /<strong>Main channel<\/strong>/u);
});

test("Main update dialog shows only admitted snapshot identity, not docs-only Git ancestry commits as updates", () => {
  assert.match(js, /snapshotAvailable = main\.state === "behind" && Boolean\(targetSha\)/u);
  assert.ok(js.includes('Verified Main snapshot ${targetSha}'));
  assert.match(js, /One admitted Main update/u);
  assert.doesNotMatch(js, /main\.summaries\.slice\(0, 5\)/u);
  assert.equal(js.includes('${entry.message || "Commit"}'), false);
  assert.match(html, /Admitted Main update/u);
});

test("Control Center avoids expensive Doctor fingerprints and hidden-page redraws on hot polls", () => {
  assert.match(js, /void refreshAll\(\{ initial: true \}\)/u);
  assert.match(js, /initial \? Promise\.resolve\(\{ doctor: null \}\) : requestJson\("\/api\/v1\/doctor"\)/u);
  assert.match(js, /async function runFullDoctorChecks\(\)/u);
  const medium = js.slice(js.indexOf("async function refreshMediumState()"), js.indexOf("async function refreshSlowState()"));
  assert.doesNotMatch(medium, /requestJson\("\/api\/v1\/doctor"/u);
  assert.match(js, /if \(state\.activeSection === "tasks"\)\s+renderTasks\(\)/u);
  assert.match(js, /if \(state\.activeSection === "activity"\)\s+renderActivity\(\)/u);
  assert.match(js, /if \(state\.activeSection === "browser"\)\s+renderBrowserPage\(\)/u);
  assert.match(js, /if \(section === "tasks"\)\s+renderTasks\(\)/u);
});

test("Main failure feedback never labels an unverified rollback as safe", () => {
  assert.match(js, /rollbackUnverified = main\.applyError\.startsWith\("Main update rollback_failed:"\)/u);
  assert.match(js, /"Main rollback needs attention"/u);
  assert.match(js, /"Rollback unverified"/u);
  assert.doesNotMatch(js, /Main update failed safely/u);
});



test("managed-native Main UI checks only original Ed25519 full SHA and dispatches ONLY the original external installer",()=>{
 const serverFields=[
  'const signedNativeMainNotice = equinoxLocalInstallation.kind === "managed-main"',
  "await signedNativeMainNotice?.check({ force })",
  'mode: "signed-native", checkSupported: true, channel: "main"',
  'state: signed.status === "available" ? "behind"',
  'currentSha: signed.installedSha, targetSha: signed.targetSha',
  'signed.status === "available" && !signedMainInstallerPending()',
  'await scheduleEquinoxLocalSignedNativeMacInstaller({',
  'signedMainInstallerRequestedSha = checked.targetSha',
 ];
 for(const field of serverFields) assert.equal(server.includes(field),true,field);
 const uiFields=[
  'const signedNativeMain = update.installationKind === "managed-main" && main.mode === "signed-native"',
  "Check signed SHA",
  "original Ed25519-signed native selector",
  "A newer exact source SHA is production-signed. Update & restart launches the same original external installer",
  "Signed native Main SHA is up to date",
  'const managedMain = update.installationKind === "managed-source"',
  'installButton.hidden = !nativeOrSourceMain',
  'const nativeOrSourceMain = managedMain || signedNativeMain',
  'const managedMain = state.update?.installationKind === "managed-source" || signedNativeMain',
 ];
 for(const field of uiFields) assert.equal(js.includes(field),true,field);
});
