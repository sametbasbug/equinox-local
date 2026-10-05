import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY,
  assertWindowsNativeMessagingHostOwnership,
  readWindowsNativeMessagingRegistryValue,
  registerWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
} from "../../src/equinox-browser-windows-native-messaging.js";
import { prepareEquinoxLocalMainNativeLifecycle } from "../../src/equinox-local-main-native-activation.js";
import { recoverEquinoxLocalMainNativeLifecycle } from "../../src/equinox-local-main-native-recovery.js";
import { assertWindowsStableShellOwnedByRelease } from "../../src/equinox-local-windows-stable-shell.js";

const execFile = promisify(execFileCallback);
const windowsTest = process.platform === "win32" ? test : test.skip;
const A = "1".repeat(40);
const B = "2".repeat(40);
const DA = "a".repeat(64);
const DB = "b".repeat(64);
const TX = `main-${"c".repeat(32)}`;

function transition(target) {
  return Object.freeze({
    mode: "artifact_required",
    target,
    currentSha: A,
    targetSha: B,
    currentRuntimeContractSha256: DA,
    targetRuntimeContractSha256: DB,
  });
}

async function writeRelease(releaseDir, marker) {
  const shellRoot = path.join(releaseDir, "runtime", "shell");
  const browserRoot = path.join(releaseDir, "runtime", "browser");
  await fs.mkdir(shellRoot, { recursive: true });
  await fs.mkdir(browserRoot, { recursive: true });
  await fs.writeFile(path.join(shellRoot, "EquinoxLocal.exe"), `shell-${marker}\n`);
  await fs.writeFile(path.join(shellRoot, "EquinoxLocal.Core.dll"), `core-${marker}\n`);
  await fs.writeFile(path.join(browserRoot, "equinox-browser-native-host.exe"), `host-${marker}\n`);
}

windowsTest("Windows Main native lifecycle switches and recovers shell plus Native Messaging on the real host", async (t) => {
  assert.match(process.arch, /^(?:x64|arm64)$/u);
  const target = `win32-${process.arch}`;
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-win-acceptance-")));
  const transactionRoot = path.join(temp, "state");
  const previousRelease = path.join(temp, "native-store", target, A, "release");
  const targetRelease = path.join(temp, "native-store", target, B, "release");
  const programRoot = path.join(temp, "program", "Equinox Local");
  const manifestRoot = path.join(temp, "native-messaging");
  const installation = Object.freeze({
    managed: true,
    selfUpdateSupported: true,
    target,
    platform: "win32",
    releasesRoot: path.join(temp, "stable-releases"),
    releaseDir: path.join(temp, "stable-releases", "5.2.0"),
    programRoot,
    nativeMessagingManifestRoot: manifestRoot,
  });
  const previousLauncher = windowsNativeMessagingLauncherPath(previousRelease);
  const targetLauncher = windowsNativeMessagingLauncherPath(targetRelease);

  t.after(async () => {
    await execFile("reg.exe", ["DELETE", EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY, "/f"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    }).catch(() => {});
    await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
  });

  assert.equal(await readWindowsNativeMessagingRegistryValue(), null, "hosted Windows acceptance requires an unowned Native Messaging test key");
  await writeRelease(previousRelease, "previous");
  await writeRelease(targetRelease, "target");
  await fs.mkdir(path.dirname(programRoot), { recursive: true });
  await fs.cp(path.join(previousRelease, "runtime", "shell"), programRoot, { recursive: true });
  const initialRegistration = await registerWindowsNativeMessagingHost({ manifestRoot, launcherPath: previousLauncher });
  assert.equal(initialRegistration.launcherPath, previousLauncher);

  const nativeTransition = transition(target);
  const lifecycle = await prepareEquinoxLocalMainNativeLifecycle({
    transition: nativeTransition,
    candidate: {
      sourceSha: B,
      target,
      transactionId: TX,
      runtimeContractSha256: DB,
      artifactSha256: "d".repeat(64),
      artifactBytes: 42,
      payloadVersion: "5.2.1",
      releaseDir: path.join(transactionRoot, "staging", TX, "native-candidate", "release"),
    },
    transactionRoot,
    transactionId: TX,
    installation,
    promoteCandidateImpl: async () => ({ sourceSha: B, target, runtimeContractSha256: DB, releaseDir: targetRelease }),
    readPointerImpl: async () => ({ sourceSha: A, target, runtimeContractSha256: DA, releaseDir: previousRelease }),
    writePointerImpl: async (_file, value) => value,
  });

  await lifecycle.activate();
  await assertWindowsStableShellOwnedByRelease({ releaseDir: targetRelease, programRoot });
  const targetOwnership = await assertWindowsNativeMessagingHostOwnership({ manifestRoot, acceptedLauncherPaths: [targetLauncher] });
  assert.equal(targetOwnership.launcherPath, targetLauncher);

  const recovered = await recoverEquinoxLocalMainNativeLifecycle({
    transition: nativeTransition,
    transactionRoot,
    transactionId: TX,
    installation,
    inspectStoredReleaseImpl: async ({ sourceSha }) => ({ releaseDir: sourceSha === B ? targetRelease : previousRelease }),
    writePointerImpl: async (_file, value) => value,
  });
  await recovered.activate();
  await assertWindowsStableShellOwnedByRelease({ releaseDir: targetRelease, programRoot });
  await recovered.rollback();

  await assertWindowsStableShellOwnedByRelease({ releaseDir: previousRelease, programRoot });
  const restoredOwnership = await assertWindowsNativeMessagingHostOwnership({ manifestRoot, acceptedLauncherPaths: [previousLauncher] });
  assert.equal(restoredOwnership.launcherPath, previousLauncher);
});
