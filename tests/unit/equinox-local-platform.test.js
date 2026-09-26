import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS,
  equinoxLocalFiniteShell,
  equinoxLocalHostDescriptor,
  equinoxLocalInteractiveShells,
  equinoxLocalManagedLifecycle,
  equinoxLocalPlatformPaths,
  equinoxLocalReleaseTarget,
} from "../../src/equinox-local-platform.js";

test("release target model covers exactly macOS and Windows x64/ARM64", () => {
  assert.deepEqual(EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS, [
    "darwin-arm64",
    "darwin-x64",
    "win32-arm64",
    "win32-x64",
  ]);
  for (const [platform, arch, target] of [
    ["darwin", "arm64", "darwin-arm64"],
    ["darwin", "x64", "darwin-x64"],
    ["win32", "arm64", "win32-arm64"],
    ["win32", "x64", "win32-x64"],
  ]) {
    assert.equal(equinoxLocalReleaseTarget({ platform, arch }), target);
  }
  assert.throws(() => equinoxLocalReleaseTarget({ platform: "linux", arch: "x64" }), /Unsupported Equinox Local release target/u);
  assert.throws(() => equinoxLocalReleaseTarget({ platform: "win32", arch: "ia32" }), /Unsupported Equinox Local release target/u);
});

test("host descriptor exposes platform semantics without claiming Windows desktop automation", () => {
  const mac = equinoxLocalHostDescriptor({ platform: "darwin", arch: "arm64" });
  assert.equal(mac.target, "darwin-arm64");
  assert.equal(mac.pathFlavor, "posix");
  assert.equal(mac.executableSuffix, "");
  assert.equal(mac.features.nativeDesktopAutomation, true);
  assert.equal(mac.features.unixDomainSocket, true);
  assert.equal(mac.features.namedPipe, false);

  const windows = equinoxLocalHostDescriptor({ platform: "win32", arch: "x64" });
  assert.equal(windows.target, "win32-x64");
  assert.equal(windows.pathFlavor, "win32");
  assert.equal(windows.executableSuffix, ".exe");
  assert.equal(windows.features.nativeDesktopAutomation, false);
  assert.equal(windows.features.unixDomainSocket, false);
  assert.equal(windows.features.namedPipe, true);
  assert.equal(windows.features.nativeMessagingRegistry, true);
});

test("macOS platform paths preserve the current managed layout exactly", () => {
  const result = equinoxLocalPlatformPaths({ platform: "darwin", arch: "x64", homeDir: "/Users/example", env: {} });
  assert.equal(result.appDataRoot, "/Users/example/Library/Application Support/Equinox Local");
  assert.equal(result.releasesRoot, "/Users/example/Library/Application Support/Equinox Local/releases");
  assert.equal(result.logsRoot, "/Users/example/Library/Logs");
  assert.equal(result.programRoot, "/Users/example/Applications");
  assert.equal(result.configPath, "/Users/example/Library/Application Support/Equinox Local/config.json");
  assert.equal(result.turnBudgetPath, "/Users/example/Library/Application Support/Equinox Local/turn-budget.json");
});

test("Windows platform paths are per-user LocalAppData and preserve spaces/unicode", () => {
  const home = "C:\\Users\\Çağrı Test";
  const localAppData = "C:\\Users\\Çağrı Test\\AppData\\Local";
  const result = equinoxLocalPlatformPaths({
    platform: "win32",
    arch: "arm64",
    homeDir: home,
    env: { LOCALAPPDATA: localAppData },
  });
  assert.equal(result.appDataRoot, path.win32.join(localAppData, "Equinox Local"));
  assert.equal(result.releasesRoot, path.win32.join(localAppData, "Equinox Local", "releases"));
  assert.equal(result.stateRoot, path.win32.join(localAppData, "Equinox Local", "state"));
  assert.equal(result.logsRoot, path.win32.join(localAppData, "Equinox Local", "logs"));
  assert.equal(result.programRoot, path.win32.join(localAppData, "Programs", "Equinox Local"));
  assert.equal(result.configPath, path.win32.join(localAppData, "Equinox Local", "state", "config.json"));
  assert.equal(result.turnBudgetPath, path.win32.join(localAppData, "Equinox Local", "state", "turn-budget.json"));
});

test("Windows platform paths fail closed without trusted absolute LocalAppData and home paths", () => {
  assert.throws(
    () => equinoxLocalPlatformPaths({ platform: "win32", arch: "x64", homeDir: "C:\\Users\\x", env: {} }),
    /LOCALAPPDATA must be an absolute path/u,
  );
  assert.throws(
    () => equinoxLocalPlatformPaths({ platform: "win32", arch: "x64", homeDir: "relative", env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" } }),
    /home directory must be an absolute path/u,
  );
});


test("platform lifecycle and shell contracts are explicit without claiming Windows implementation", () => {
  const macLifecycle = equinoxLocalManagedLifecycle({ platform: "darwin", arch: "arm64" });
  assert.equal(macLifecycle.kind, "launch-agent");
  assert.equal(macLifecycle.implemented, true);
  assert.equal(macLifecycle.currentPointerKind, "symlink");
  assert.equal(macLifecycle.processOwnership, "posix-session");

  const windowsLifecycle = equinoxLocalManagedLifecycle({ platform: "win32", arch: "x64" });
  assert.equal(windowsLifecycle.kind, "windows-user");
  assert.equal(windowsLifecycle.implemented, false);
  assert.equal(windowsLifecycle.currentPointerKind, "version-file");
  assert.equal(windowsLifecycle.processOwnership, "job-object");

  const macFinite = equinoxLocalFiniteShell({ platform: "darwin", arch: "arm64" });
  assert.equal(macFinite.command, "/bin/zsh");
  assert.deepEqual(macFinite.argsFor("echo ok"), ["-lc", "echo ok"]);
  assert.equal(macFinite.pathDelimiter, ":");

  const windowsFinite = equinoxLocalFiniteShell({ platform: "win32", arch: "x64" });
  assert.equal(windowsFinite.command, "powershell.exe");
  assert.deepEqual(windowsFinite.argsFor("Write-Output ok"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "Write-Output ok"]);
  assert.equal(windowsFinite.pathDelimiter, ";");

  const windowsInteractive = equinoxLocalInteractiveShells({ platform: "win32", arch: "arm64" });
  assert.equal(windowsInteractive.defaultShell, "powershell");
  assert.equal(windowsInteractive.shells.powershell.command, "powershell.exe");
});
