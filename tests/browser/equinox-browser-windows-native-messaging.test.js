import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertWindowsNativeMessagingHostOwnership,
  EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY,
  readWindowsNativeMessagingRegistryValue,
  registerWindowsNativeMessagingHost,
  unregisterWindowsNativeMessagingHost,
  windowsNativeMessagingLauncherPath,
  windowsNativeMessagingManifest,
} from "../../src/equinox-browser-windows-native-messaging.js";

const LAUNCHER = "C:\\Program Files\\Equinox Local\\releases\\5.3.0\\runtime\\browser\\equinox-browser-native-host.exe";
const OLD_LAUNCHER = "C:\\Program Files\\Equinox Local\\releases\\5.2.1\\runtime\\browser\\equinox-browser-native-host.exe";

function registryReadOutput(value) {
  if (value === null) return "missing\n";
  if (typeof value !== "string" || !value) return "invalid\n";
  return `value:${Buffer.from(value, "utf8").toString("hex").toUpperCase()}\n`;
}

function registryMock(initial = null) {
  let value = initial;
  const calls = [];
  return {
    calls,
    get value() { return value; },
    execFileAsync: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command.toLowerCase().endsWith("powershell.exe")) {
        return { stdout: registryReadOutput(value), stderr: "" };
      }
      if (command === "reg.exe" && args[0] === "ADD") {
        value = args[args.indexOf("/d") + 1];
        return { stdout: "", stderr: "" };
      }
      if (command === "reg.exe" && args[0] === "DELETE") {
        value = null;
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  };
}

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

test("Windows Native Messaging fresh registration writes one bounded manifest and exact HKCU default value", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-native-host-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = registryMock();
  const result = await registerWindowsNativeMessagingHost({
    manifestRoot: root,
    launcherPath: LAUNCHER,
    execFileAsync: registry.execFileAsync,
    verifyLauncher: false,
  });
  assert.equal(result.registryKey, EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY);
  assert.equal(result.manifestChanged, true);
  assert.equal(result.registryChanged, true);
  assert.equal(result.idempotent, false);
  const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.path, LAUNCHER);
  const mutation = registry.calls.find((call) => call.command === "reg.exe");
  assert.deepEqual(mutation.args, ["ADD", EQUINOX_BROWSER_WINDOWS_REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", result.manifestPath, "/f"]);
});

test("Windows Native Messaging exact owned registration is mutation-free and idempotent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-native-host-idempotent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "dev.equinox.browser.json");
  await fs.writeFile(manifestPath, windowsNativeMessagingManifest(LAUNCHER));
  const registry = registryMock(manifestPath);
  const result = await registerWindowsNativeMessagingHost({
    manifestRoot: root,
    launcherPath: LAUNCHER,
    execFileAsync: registry.execFileAsync,
    verifyLauncher: false,
  });
  assert.equal(result.idempotent, true);
  assert.equal(result.manifestChanged, false);
  assert.equal(result.registryChanged, false);
  assert.equal(registry.calls.filter((call) => call.command === "reg.exe").length, 0);
  assert.equal(await fs.readFile(manifestPath, "utf8"), windowsNativeMessagingManifest(LAUNCHER));
});

test("Windows Native Messaging registration refuses a foreign HKCU manifest owner", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-native-host-foreign-registry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registry = registryMock("C:\\Other\\dev.equinox.browser.json");
  await assert.rejects(
    registerWindowsNativeMessagingHost({
      manifestRoot: root,
      launcherPath: LAUNCHER,
      execFileAsync: registry.execFileAsync,
      verifyLauncher: false,
    }),
    /owned by another manifest/u,
  );
  assert.equal(registry.calls.filter((call) => call.command === "reg.exe").length, 0);
  await assert.rejects(fs.lstat(path.join(root, "dev.equinox.browser.json")), (error) => error?.code === "ENOENT");
});

test("Windows Native Messaging registration refuses foreign or malformed manifest content", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-native-host-foreign-manifest-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "dev.equinox.browser.json");
  const foreign = '{"name":"dev.equinox.browser","path":"C:\\\\Foreign\\\\host.exe"}\n';
  await fs.writeFile(manifestPath, foreign);
  const registry = registryMock();
  await assert.rejects(
    registerWindowsNativeMessagingHost({
      manifestRoot: root,
      launcherPath: LAUNCHER,
      execFileAsync: registry.execFileAsync,
      verifyLauncher: false,
    }),
    /foreign or malformed/u,
  );
  assert.equal(await fs.readFile(manifestPath, "utf8"), foreign);
  assert.equal(registry.calls.filter((call) => call.command === "reg.exe").length, 0);
});

test("Windows Native Messaging launcher rotation requires the exact expected previous owned manifest", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-native-host-rotate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "dev.equinox.browser.json");
  await fs.writeFile(manifestPath, windowsNativeMessagingManifest(OLD_LAUNCHER));
  const registry = registryMock(manifestPath);

  await assert.rejects(
    registerWindowsNativeMessagingHost({
      manifestRoot: root,
      launcherPath: LAUNCHER,
      execFileAsync: registry.execFileAsync,
      verifyLauncher: false,
    }),
    /foreign or malformed/u,
  );
  assert.equal(await fs.readFile(manifestPath, "utf8"), windowsNativeMessagingManifest(OLD_LAUNCHER));

  const result = await registerWindowsNativeMessagingHost({
    manifestRoot: root,
    launcherPath: LAUNCHER,
    expectedPreviousLauncherPath: OLD_LAUNCHER,
    execFileAsync: registry.execFileAsync,
    verifyLauncher: false,
  });
  assert.equal(result.manifestChanged, true);
  assert.equal(result.registryChanged, false);
  assert.equal(await fs.readFile(manifestPath, "utf8"), windowsNativeMessagingManifest(LAUNCHER));
  assert.equal(registry.calls.filter((call) => call.command === "reg.exe").length, 0);
});

test("Windows Native Messaging manifest replacement rejects concurrent drift", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-native-host-drift-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "dev.equinox.browser.json");
  await fs.writeFile(manifestPath, windowsNativeMessagingManifest(OLD_LAUNCHER));
  const registry = registryMock(manifestPath);
  const foreign = '{"foreign":true}\n';
  let drifted = false;
  const fsImpl = {
    ...fs,
    lstat: async (target) => {
      if (!drifted && target === manifestPath) {
        drifted = true;
        await fs.writeFile(manifestPath, foreign);
      }
      return fs.lstat(target);
    },
  };
  await assert.rejects(
    registerWindowsNativeMessagingHost({
      manifestRoot: root,
      launcherPath: LAUNCHER,
      expectedPreviousLauncherPath: OLD_LAUNCHER,
      execFileAsync: registry.execFileAsync,
      fsImpl,
      verifyLauncher: false,
    }),
    /SHA-256 guard mismatch|foreign or malformed/u,
  );
  assert.equal(await fs.readFile(manifestPath, "utf8"), foreign);
  assert.equal(registry.calls.filter((call) => call.command === "reg.exe").length, 0);
});

test("Windows Native Messaging registry read is module-independent, credential-scrubbed and preserves Unicode paths", async () => {
  const expected = "C:\\Users\\Çağrı\\Equinox Local\\dev.equinox.browser.json";
  const env = {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    USERPROFILE: "C:\\Users\\Çağrı",
    LOCALAPPDATA: "C:\\Users\\Çağrı\\AppData\\Local",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    PSModulePath: "C:\\Untrusted\\Modules",
    OPENAI_API_KEY: "must-not-propagate",
  };
  const value = await readWindowsNativeMessagingRegistryValue({
    env,
    execFileAsync: async (command, args, options) => {
      assert.equal(command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      assert.equal(options.timeout, 15_000);
      assert.equal(options.env.SystemRoot, env.SystemRoot);
      assert.equal(options.env.EQUINOX_BROWSER_NATIVE_HOST_REGISTRY_SUBKEY, "Software\\Google\\Chrome\\NativeMessagingHosts\\dev.equinox.browser");
      assert.equal("PSModulePath" in options.env, false);
      assert.equal("OPENAI_API_KEY" in options.env, false);
      const script = args.at(-1);
      assert.match(script, /Microsoft\.Win32\.Registry/u);
      assert.doesNotMatch(script, /Get-Item|ConvertTo-Json|Import-Module/u);
      return { stdout: registryReadOutput(expected), stderr: "" };
    },
  });
  assert.equal(value, expected);
});

test("Windows Native Messaging registry read rejects malformed helper protocol", async () => {
  for (const stdout of ["invalid\n", "42\n", "value:GG\n", "value:\n"]) {
    await assert.rejects(
      readWindowsNativeMessagingRegistryValue({
        execFileAsync: async () => ({ stdout, stderr: "" }),
      }),
      /registry default value is malformed/u,
    );
  }
});

test("Windows Native Messaging unregister refuses a registry key owned by another manifest", async () => {
  const calls = [];
  const result = await unregisterWindowsNativeMessagingHost({
    manifestPath: "C:\\Users\\Samet\\AppData\\Local\\Equinox Local\\browser\\native-messaging\\dev.equinox.browser.json",
    launcherPath: LAUNCHER,
    execFileAsync: async (command, args) => {
      calls.push({ command, args });
      if (command.toLowerCase().endsWith("powershell.exe")) return { stdout: registryReadOutput("C:\\Other\\dev.equinox.browser.json"), stderr: "" };
      throw new Error("unexpected mutation");
    },
  });
  assert.equal(result.removed, false);
  assert.equal(result.reason, "foreign-registry-owner");
  assert.equal(calls.length, 1);
});

test("Windows Native Messaging unregister preserves HKCU when the canonical manifest is foreign", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-native-host-unregister-foreign-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "dev.equinox.browser.json");
  const foreign = '{"foreign":true}\n';
  await fs.writeFile(manifestPath, foreign);
  const registry = registryMock(manifestPath);
  const result = await unregisterWindowsNativeMessagingHost({
    manifestPath,
    launcherPath: LAUNCHER,
    execFileAsync: registry.execFileAsync,
  });
  assert.equal(result.removed, false);
  assert.equal(result.reason, "foreign-manifest");
  assert.equal(registry.value, manifestPath);
  assert.equal(await fs.readFile(manifestPath, "utf8"), foreign);
  assert.equal(registry.calls.filter((call) => call.command === "reg.exe").length, 0);
});


test("Windows Native Messaging update ownership check is read-only and accepts only the bounded launcher set", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-win-native-host-ownership-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifestPath = path.join(root, "dev.equinox.browser.json");
  await fs.writeFile(manifestPath, windowsNativeMessagingManifest(OLD_LAUNCHER));
  const registry = registryMock(manifestPath);
  const result = await assertWindowsNativeMessagingHostOwnership({
    manifestRoot: root,
    acceptedLauncherPaths: [OLD_LAUNCHER, LAUNCHER],
    execFileAsync: registry.execFileAsync,
  });
  assert.equal(result.launcherPath, OLD_LAUNCHER);
  assert.equal(registry.calls.filter((call) => call.command === "reg.exe").length, 0);

  await fs.writeFile(manifestPath, windowsNativeMessagingManifest("C:\\Foreign\\host.exe"));
  await assert.rejects(
    assertWindowsNativeMessagingHostOwnership({
      manifestRoot: root,
      acceptedLauncherPaths: [OLD_LAUNCHER, LAUNCHER],
      execFileAsync: registry.execFileAsync,
    }),
    /outside the accepted update ownership set/u,
  );
  assert.equal(registry.calls.filter((call) => call.command === "reg.exe").length, 0);
});
