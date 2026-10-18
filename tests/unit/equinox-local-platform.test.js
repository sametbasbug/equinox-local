import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  EQUINOX_LOCAL_RELEASE_TARGET_MATRIX,
  EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS,
  equinoxLocalReleaseArtifactName,
  equinoxLocalReleaseTargetContract,
  equinoxLocalFiniteShell,
  equinoxLocalHostDescriptor,
  equinoxLocalInteractiveShells,
  equinoxLocalWindowsPowerShellPath,
  equinoxLocalWindowsPowerShell7Path,
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

test("release matrix is the canonical four-target native provenance contract", () => {
  assert.equal(EQUINOX_LOCAL_RELEASE_TARGET_MATRIX.length, 4);
  assert.deepEqual(EQUINOX_LOCAL_RELEASE_TARGET_MATRIX.map((entry) => entry.target), EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS);
  assert.deepEqual(EQUINOX_LOCAL_RELEASE_TARGET_MATRIX.map((entry) => entry.artifactExtension), [".tar.gz", ".tar.gz", ".zip", ".zip"]);
  assert.equal(equinoxLocalReleaseTargetContract("darwin-arm64").buildAuthority, "factory-native");
  assert.equal(equinoxLocalReleaseTargetContract("darwin-x64").nativeRunner, "macos-26-intel");
  assert.equal(equinoxLocalReleaseTargetContract("win32-arm64").nativeRunner, "windows-11-vs2026-arm");
  assert.equal(equinoxLocalReleaseTargetContract("win32-x64").nativeRunner, "windows-latest");
  assert.equal(equinoxLocalReleaseArtifactName("5.2.1", "darwin-arm64"), "equinox-local-5.2.1-darwin-arm64.tar.gz");
  assert.equal(equinoxLocalReleaseArtifactName("5.2.1", "win32-arm64"), "equinox-local-5.2.1-win32-arm64.zip");
  assert.throws(() => equinoxLocalReleaseArtifactName("next", "darwin-arm64"), /version is invalid/u);
});

test("host descriptor exposes native desktop support for both Windows and macOS", () => {
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
  assert.equal(windows.features.nativeDesktopAutomation, true);
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
  assert.equal(result.currentPointer, path.win32.join(localAppData, "Equinox Local", "current-version.json"));
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


test("platform lifecycle and shell contracts enable both native Windows architectures", () => {
  const macLifecycle = equinoxLocalManagedLifecycle({ platform: "darwin", arch: "arm64" });
  assert.equal(macLifecycle.kind, "launch-agent");
  assert.equal(macLifecycle.implemented, true);
  assert.equal(macLifecycle.currentPointerKind, "symlink");
  assert.equal(macLifecycle.processOwnership, "posix-session");

  const windowsLifecycle = equinoxLocalManagedLifecycle({ platform: "win32", arch: "x64" });
  assert.equal(windowsLifecycle.kind, "windows-user");
  assert.equal(windowsLifecycle.implemented, true);
  assert.equal(windowsLifecycle.currentPointerKind, "version-file");
  assert.equal(windowsLifecycle.processOwnership, "job-object");
  const windowsArm64Lifecycle = equinoxLocalManagedLifecycle({ platform: "win32", arch: "arm64" });
  assert.equal(windowsArm64Lifecycle.kind, "windows-user");
  assert.equal(windowsArm64Lifecycle.implemented, true);
  assert.equal(windowsArm64Lifecycle.currentPointerKind, "version-file");
  assert.equal(windowsArm64Lifecycle.processOwnership, "job-object");

  const macFinite = equinoxLocalFiniteShell({ platform: "darwin", arch: "arm64" });
  assert.equal(macFinite.command, "/bin/zsh");
  assert.deepEqual(macFinite.argsFor("echo ok"), ["-lc", "echo ok"]);
  assert.equal(macFinite.pathDelimiter, ":");

  const windowsFinite = equinoxLocalFiniteShell({ platform: "win32", arch: "x64" });
  assert.equal(windowsFinite.command, equinoxLocalWindowsPowerShellPath());
  const finiteArgs = windowsFinite.argsFor("Write-Output ok; exit 17");
  assert.deepEqual(finiteArgs.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand"]);
  assert.equal(Buffer.from(finiteArgs[6], "base64").toString("utf16le"), "$ProgressPreference = 'SilentlyContinue'; Write-Output ok; exit 17");
  assert.equal(windowsFinite.pathDelimiter, ";");

  const windowsInteractive = equinoxLocalInteractiveShells({ platform: "win32", arch: "arm64" });
  assert.equal(windowsInteractive.defaultShell, "powershell");
  assert.equal(windowsInteractive.shells.powershell.command, equinoxLocalWindowsPowerShellPath());
});

test("PowerShell 7 uses only a regular file in fixed Program Files and stays optional", () => {
  const env = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", PATH: "C:\\Evil" };
  const installedPath = path.win32.join(env.ProgramFiles, "PowerShell", "7", "pwsh.exe");
  const inspected = [];
  const statFile = (candidate) => {
    inspected.push(candidate);
    if (candidate === installedPath) return { isFile: () => true };
    throw new Error("missing");
  };
  assert.equal(equinoxLocalWindowsPowerShell7Path(env, { statFile }), installedPath);
  const finite = equinoxLocalFiniteShell({ platform: "win32", arch: "x64", env, shell: "pwsh", statFile });
  assert.equal(finite.command, installedPath);
  assert.deepEqual(finite.argsFor("Write-Output ok").slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand"]);
  assert.equal(Buffer.from(finite.argsFor("Write-Output ok")[6], "base64").toString("utf16le"), "$ProgressPreference = 'SilentlyContinue'; Write-Output ok");
  const interactive = equinoxLocalInteractiveShells({ platform: "win32", arch: "x64", env, statFile });
  assert.equal(interactive.defaultShell, "powershell");
  assert.deepEqual(Object.keys(interactive.shells), ["powershell", "pwsh"]);
  assert.equal(interactive.shells.pwsh.command, installedPath);
  assert.deepEqual(interactive.shells.pwsh.args, ["-NoLogo", "-NoProfile"]);
  assert.equal(inspected.some((candidate) => candidate.toLowerCase().includes("evil")), false, "untrusted PATH must not be searched");
  assert.equal(equinoxLocalWindowsPowerShell7Path(env, { statFile: () => ({ isFile: () => false }) }), null, "symlink or non-file is rejected");
  assert.equal(equinoxLocalWindowsPowerShell7Path(env, { statFile: () => { throw new Error("ENOENT"); } }), null);
  assert.throws(
    () => equinoxLocalFiniteShell({ platform: "win32", arch: "x64", env, shell: "pwsh", statFile: () => { throw new Error("ENOENT"); } }),
    /PowerShell 7.*not installed/u,
  );
  assert.equal(equinoxLocalFiniteShell({ platform: "win32", arch: "x64", env }).command, equinoxLocalWindowsPowerShellPath(env));
  assert.throws(() => equinoxLocalFiniteShell({ platform: "darwin", arch: "x64", shell: "pwsh" }), /Unsupported macOS/u);
  assert.throws(() => equinoxLocalFiniteShell({ platform: "win32", arch: "x64", env, shell: "zsh" }), /Unsupported Windows/u);
});
