// Hosted Windows ONLY: observe real healthy new Stable, force failed health,
// and assert that the old Main, native WPF and Native Messaging are restored.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { installManagedEquinoxRelease } from "../../src/equinox-local-first-install.js";
import { activatePreparedEquinoxRelease } from "../../src/equinox-local-update-activation.js";

const [stagedReleaseDir, installedRoot, oldSha, versionB] = process.argv.slice(2);
if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true" ||
    process.env.CI !== "true" || process.env.EQUINOX_WINDOWS_LEGACY_REINSTALL_ACCEPTANCE !== "true" ||
    !["x64", "arm64"].includes(process.arch) || !path.win32.isAbsolute(stagedReleaseDir ?? "") ||
    !path.win32.isAbsolute(installedRoot ?? "") ||
    !/^[a-f0-9]{40}$/u.test(oldSha ?? "") || !/^\d+\.\d+\.\d+$/u.test(versionB ?? "")) {
  throw new Error("Refusing historic native rollback outside a disposable exact Windows runner.");
}
const trustedRoot = path.win32.join(process.env.LOCALAPPDATA, "Equinox Local");
assert.equal(path.win32.normalize(installedRoot).toLowerCase(), path.win32.normalize(trustedRoot).toLowerCase());
assert.equal(path.win32.dirname(stagedReleaseDir).toLowerCase(),
  path.win32.join(installedRoot, "staging", "historic-repair-negative").toLowerCase());
const metadata = JSON.parse(await fs.readFile(path.win32.join(stagedReleaseDir, "release.json"), "utf8"));
assert.equal(metadata.target, "win32-" + process.arch);
assert.equal(metadata.version, versionB);
assert.notEqual(metadata.sourceSha, oldSha);
const mainStamp = path.win32.join(installedRoot, "state", "main-update", "install.json");
const originalStamp = await fs.readFile(mainStamp);
const currentPath = path.win32.join(installedRoot, "current-version.json");
const previousCurrent = JSON.parse(await fs.readFile(currentPath, "utf8"));
assert.notEqual(previousCurrent.version, versionB);
const manifestPath = path.win32.join(installedRoot, "browser", "native-messaging", "dev.equinox.browser.json");
const originalManifest = await fs.readFile(manifestPath);
const shellPath = path.win32.join(process.env.LOCALAPPDATA, "Programs", "Equinox Local", "EquinoxLocal.exe");
const shellHash = async () => createHash("sha256").update(await fs.readFile(shellPath)).digest("hex");
const originalShell = await shellHash();
let observations = 0;
let polls = 0;
let nativeStarts = 0;
let lastStatus = "no status";
await assert.rejects(installManagedEquinoxRelease({
  stagedReleaseDir, platform: "win32", arch: process.arch,
  activateImpl: (options) => activatePreparedEquinoxRelease({
    ...options, healthAttempts: 30,
    kickstartImpl: async (...args) => { nativeStarts++; return options.kickstartImpl(...args); },
    fetchImpl: async (...args) => {
      polls++;
      const response = await fetch(...args);
      if (!response.ok) lastStatus = "HTTP " + response.status;
      if (!response.ok) return response;
      const body = await response.clone().json().catch(() => null);
      lastStatus = JSON.stringify({ version: body?.status?.server?.version, kind: body?.status?.installation?.kind, health: body?.status?.health?.state });
      if (body?.status?.server?.version !== versionB ||
          body?.status?.installation?.kind !== "managed" ||
          body?.status?.health?.state !== "HEALTHY") return response;
      observations++;
      return new Response(JSON.stringify({ ...body, status: {
        ...body.status, health: { ...body.status.health, state: "UNHEALTHY" },
      } }), { status: response.status, headers: { "content-type": "application/json" } });
    },
  }),
}), /rolled back/u);
assert.ok(observations > 0, "New native Stable must reach HEALTHY before forced rollback; " + JSON.stringify({ polls, lastStatus, nativeStarts }));
assert.deepEqual(await fs.readFile(mainStamp), originalStamp);
assert.deepEqual(JSON.parse(await fs.readFile(currentPath, "utf8")), previousCurrent);
assert.deepEqual(await fs.readFile(manifestPath), originalManifest);
assert.equal(await shellHash(), originalShell);
const response = await fetch("http://127.0.0.1:24891/api/v1/status", { signal: AbortSignal.timeout(10000) });
const { status } = await response.json();
assert.equal(status.server.version, previousCurrent.version);
assert.equal(status.installation.kind, "managed-source");
assert.equal(status.installation.sourceSha, oldSha);
assert.equal(status.health.state, "HEALTHY");
console.log("Real Windows win32-" + process.arch + " old Main forced Stable B failure -> healthy original Main native WPF and Native Messaging rollback PASSED.");
