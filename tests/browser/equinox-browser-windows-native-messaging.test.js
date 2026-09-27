import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY,
  readWindowsNativeMessagingRegistryValue,
  registerWindowsNativeMessagingHost,
  unregisterWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
  windowsNativeMessagingManifest,
} from "../../src/equinox-browser-windows-native-messaging.js";

const LAUNCHER = "C:\\Program Files\\Equinox Local\\releases\\5.3.0\\runtime\\browser\\equinox-browser-native-host.exe";

test("Windows Native Messaging release contract is release-local and production-origin only", () => {
  assert.equal(
    windowsNativeMessagingLauncherPath("C:\\Program Files\\Equinox Local\\releases\\5.3.0"),
    LAUNCHER,
  );
  const manifest = JSON.parse(windowsNativeMessagingManifest(LAUNCHER));
  assert.equal(manifest.name, "dev.equinox.browser");
  assert.equal(manifest.path, LAUNCHER);
  assert.deepEqual(manifest.allowed_origins, ["chrome-extension://npdneefcobilfkjlihghjgjnknenhfoj/"]);
});

test("Windows Native Messaging registration writes a bounded manifest and exact HKCU default value", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-native-host-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const execFileAsync = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: "", stderr: "" };
  };
  const result = await registerWindowsNativeMessagingHost({
    manifestRoot: root,
    launcherPath: LAUNCHER,
    execFileAsync,
    verifyLauncher: false,
  });
  assert.equal(result.registryKey, EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY);
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.path, LAUNCHER);
  assert.deepEqual(calls[0].args, ["ADD", EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", result.manifestPath, "/f"]);
});

test("Windows registry read uses locale-independent JSON and preserves Unicode paths", async () => {
  const value = await readWindowsNativeMessagingRegistryValue({
    execFileAsync: async (_command, _args, options) => {
      assert.equal(options.env.EQUINOX_BROWSER_NATIVE_HOST_REGISTRY_KEY, EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY);
      return { stdout: '"C:\\\\Users\\\\Çağrı\\\\Equinox Local\\\\dev.equinox.browser.json"\n', stderr: "" };
    },
  });
  assert.equal(value, "C:\\Users\\Çağrı\\Equinox Local\\dev.equinox.browser.json");
});

test("Windows Native Messaging unregister refuses a registry key owned by another manifest", async () => {
  const calls = [];
  const result = await unregisterWindowsNativeMessagingHost({
    manifestPath: "C:\\Users\\Samet\\AppData\\Local\\Equinox Local\\browser\\native-messaging\\dev.equinox.browser.json",
    launcherPath: LAUNCHER,
    execFileAsync: async (command, args) => {
      calls.push({ command, args });
      if (command === "powershell.exe") return { stdout: '"C:\\\\Other\\\\dev.equinox.browser.json"\n', stderr: "" };
      throw new Error("unexpected mutation");
    },
  });
  assert.equal(result.removed, false);
  assert.equal(result.reason, "foreign-registry-owner");
  assert.equal(calls.length, 1);
});
