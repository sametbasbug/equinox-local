import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const server = fs.readFileSync(path.resolve("src/server.js"), "utf8");

test("Windows Main background cleanup is bounded and audits Doctor only until first healthy approval", () => {
  const start = server.indexOf('if (platform === "win32" && ["managed-source", "managed"].includes(equinoxLocalInstallation.kind))');
  assert.notEqual(start, -1);
  const end = server.indexOf('if (EQUINOX_LOCAL_CONFIG.controlCenter.enabled)', start);
  const cleanup = server.slice(start, end);
  assert.match(cleanup, /let doctorApproved = false;/u);
  assert.match(cleanup, /if \(!doctorApproved\) \{\s*const doctor = await getControlCenterDoctorStatus\(\);\s*doctorApproved = doctor\.state === "HEALTHY" && doctor\.summary\.attention === 0;/u);
  assert.match(cleanup, /if \(doctorApproved\) \{/u);
  assert.match(cleanup, /const maxCleanupAttempts = 2;/u);
  assert.match(cleanup, /attempts < maxCleanupAttempts/u);
  assert.doesNotMatch(cleanup, /attempts < 8/u);
  assert.match(cleanup, /pruneVerifiedMainLargeStorage/u);
  assert.match(cleanup, /pruneDisenrolledWindowsMainLargeStorage/u);
  assert.match(cleanup, /pending\.length === 0/u);
  assert.match(cleanup, /pending until next runtime startup/u);
});
