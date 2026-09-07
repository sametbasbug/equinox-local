import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EQUINOX_LOCAL_APP_BUNDLE_ID,
  EQUINOX_LOCAL_LAUNCH_LOG_KEEP_BYTES,
  EQUINOX_LOCAL_LAUNCH_LOG_MAX_BYTES,
  ensureEquinoxLocalAppHost,
  equinoxLocalAppAppleScript,
  equinoxLocalAppRuntimeWrapperPath,
  launchAgentLogMaintenanceShell,
} from "../../src/equinox-local-app-host.js";

const macTest = process.platform === "darwin" ? test : test.skip;

test("LaunchAgent log maintenance keeps fixed log files bounded without replacing their inode", () => {
  const script = launchAgentLogMaintenanceShell({
    stdoutName: "Equinox Local.log",
    stderrName: "Equinox Local.error.log",
  });
  assert.match(script, new RegExp(`LAUNCH_LOG_MAX_BYTES=${EQUINOX_LOCAL_LAUNCH_LOG_MAX_BYTES}`, "u"));
  assert.match(script, new RegExp(`LAUNCH_LOG_KEEP_BYTES=${EQUINOX_LOCAL_LAUNCH_LOG_KEEP_BYTES}`, "u"));
  assert.match(script, /LAUNCH_LOG_CHECK_INTERVAL_SECONDS=300/u);
  assert.match(script, /maintain_launch_logs/u);
  assert.match(script, /Equinox Local\.log/u);
  assert.match(script, /Equinox Local\.error\.log/u);
  assert.match(script, /tail -c/u);
  assert.match(script, /cat .* > .*target/u);
  assert.doesNotMatch(script, /mv /u);
  assert.throws(
    () => launchAgentLogMaintenanceShell({ stdoutName: "../bad.log", stderrName: "ok.log" }),
    /filename is invalid/u,
  );
});

macTest("Equinox Local app host keeps one stable bundle identity across bootstrap runs", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-app-host-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));

  const first = await ensureEquinoxLocalAppHost({ homeDir });
  assert.equal(first.created, true);
  assert.equal(first.appPath, path.join(homeDir, "Applications", "Equinox Local.app"));
  assert.equal((await fs.lstat(first.executablePath)).isFile(), true);
  const firstStat = await fs.lstat(first.appPath);

  const second = await ensureEquinoxLocalAppHost({ homeDir });
  assert.equal(second.created, false);
  assert.equal(second.appPath, first.appPath);
  const secondStat = await fs.lstat(second.appPath);
  assert.equal(secondStat.ino, firstStat.ino);

  const infoPlist = path.join(first.appPath, "Contents", "Info.plist");
  const { execFile } = await import("node:child_process");
  const bundleId = await new Promise((resolve, reject) => {
    execFile("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", infoPlist], (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout).trim());
    });
  });
  assert.equal(bundleId, EQUINOX_LOCAL_APP_BUNDLE_ID);
  assert.match(equinoxLocalAppAppleScript(), /Equinox Local\/equinox-local-app-runtime/u);
  assert.equal(equinoxLocalAppRuntimeWrapperPath(homeDir), path.join(homeDir, "Library", "Application Support", "Equinox Local", "equinox-local-app-runtime"));
});

macTest("Equinox Local app host refuses a symlinked app identity", async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-app-host-symlink-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const applications = path.join(homeDir, "Applications");
  await fs.mkdir(applications, { recursive: true });
  await fs.symlink("/tmp", path.join(applications, "Equinox Local.app"));
  await assert.rejects(ensureEquinoxLocalAppHost({ homeDir }), /safe app bundle/u);
});
