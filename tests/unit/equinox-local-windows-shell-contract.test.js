import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SHELL = path.join(ROOT, "native", "windows", "EquinoxLocal.WindowsShell");

async function source(name) {
  return fs.readFile(path.join(SHELL, name), "utf8");
}

test("Windows shell is a thin x64/ARM64 WPF/WebView2 host for the shared Control Center", async () => {
  const [project, window] = await Promise.all([
    source("EquinoxLocal.WindowsShell.csproj"),
    source("MainWindow.xaml.cs"),
  ]);

  assert.match(project, /<TargetFramework>net8\.0-windows10\.0\.19041\.0<\/TargetFramework>/u);
  assert.match(project, /<UseWPF>true<\/UseWPF>/u);
  assert.match(project, /<UseWindowsForms>true<\/UseWindowsForms>/u);
  assert.match(project, /<Platforms>x64;ARM64<\/Platforms>/u);
  assert.match(project, /<PlatformTarget>x64<\/PlatformTarget>/u);
  assert.match(project, /<PlatformTarget>ARM64<\/PlatformTarget>/u);
  assert.match(project, /win-x64/u);
  assert.match(project, /win-arm64/u);
  assert.match(project, /<SelfContained>true<\/SelfContained>/u);
  assert.match(project, /<PublishSingleFile>false<\/PublishSingleFile>/u);
  assert.match(project, /<PublishTrimmed>false<\/PublishTrimmed>/u);
  assert.match(project, /ValidateWindowsShellRuntimeIdentifier/u);
  assert.match(project, /RuntimeIdentifier=win-x64 or win-arm64/u);
  assert.match(project, /Microsoft\.Web\.WebView2/u);
  assert.match(window, /http:\/\/127\.0\.0\.1:24891\//u);
  assert.match(window, /EnsureCoreWebView2Async/u);
  assert.match(window, /GetAvailableBrowserVersionString/u);
  assert.match(window, /UseShellExecute\s*=\s*true/u);
  assert.doesNotMatch(window, /cmd\.exe|powershell(?:\.exe)?|ProcessStartInfo\s*\([^)]*\/c/iu);
});

test("Windows shell single-instance and runtime-restart channel is local-user-only", async () => {
  const [app, coordinator, handoff, locator, uninstallHandoff] = await Promise.all([
    source("App.xaml.cs"),
    source("SingleInstanceCoordinator.cs"),
    source("ManagedUpdateHandoff.cs"),
    source("WindowsManagedReleaseLocator.cs"),
    source("ManagedUninstallHandoff.cs"),
  ]);

  assert.match(app, /class App : System\.Windows\.Application/u);
  assert.match(app, /if \(!_singleInstance\.IsPrimary\)/u);
  assert.match(app, /SignalPrimaryAsync/u);
  assert.match(app, /ActivateFromReopen/u);
  assert.match(coordinator, /Local\\EquinoxLocal\.WindowsShell\.SingleInstance/u);
  assert.match(coordinator, /NamedPipeServerStream/u);
  assert.match(coordinator, /PipeOptions\.CurrentUserOnly/u);
  assert.match(coordinator, /string\.Equals\(command, "reopen", StringComparison\.Ordinal\)/u);
  assert.match(coordinator, /string\.Equals\(command, "restart-runtime", StringComparison\.Ordinal\)/u);
  assert.match(app, /RuntimeRestartRequested/u);
  assert.match(app, /RestartRuntimeAsync/u);
  assert.match(coordinator, /PipeDirection\.InOut/u);
  assert.match(coordinator, /activate-release:/u);
  assert.match(coordinator, /ManagedUpdateHandoff\.Launch/u);
  assert.match(handoff, /ProcessStartInfo/u);
  assert.match(handoff, /Environment\.Clear\(\)/u);
  assert.match(handoff, /runtime.*node.*bin.*node\.exe/su);
  assert.match(handoff, /equinox-local-update-helper\.js/u);
  assert.match(handoff, /System32/u);
  assert.match(handoff, /EQUINOX_LOCAL_INSTALL_ROOT/u);
  assert.match(handoff, /EQUINOX_LOCAL_RELEASE_DIR/u);
  assert.doesNotMatch(handoff, /cmd\.exe|powershell(?:\.exe)?/iu);
  assert.match(locator, /ResolveRelease\(string version\)/u);
  assert.match(coordinator, /uninstall:/u);
  assert.match(coordinator, /ManagedUninstallHandoff\.Launch/u);
  assert.match(uninstallHandoff, /ResolveCurrentRelease/u);
  assert.match(uninstallHandoff, /new StartupRegistration/u);
  assert.match(uninstallHandoff, /StartupRegistrationState\.Foreign/u);
  assert.match(uninstallHandoff, /Environment\.Clear\(\)/u);
  assert.match(uninstallHandoff, /EQUINOX_LOCAL_EXPECTED_STARTUP_COMMAND/u);
  assert.match(uninstallHandoff, /EQUINOX_LOCAL_UNINSTALL_SHELL_PID/u);
  assert.doesNotMatch(uninstallHandoff, /cmd\.exe|powershell(?:\.exe)?/iu);
});


test("Windows shell tray lifecycle keeps close-to-tray distinct from explicit exit", async () => {
  const [app, window, tray] = await Promise.all([
    source("App.xaml.cs"),
    source("MainWindow.xaml.cs"),
    source("TrayIconController.cs"),
  ]);

  assert.match(tray, /new NotifyIcon/u);
  assert.match(tray, /new ContextMenuStrip/u);
  assert.match(tray, /Open Control Center/u);
  assert.match(tray, /Open in browser/u);
  assert.match(tray, /Exit Equinox Local/u);
  assert.match(tray, /DoubleClick/u);
  assert.match(window, /e\.Cancel\s*=\s*true/u);
  assert.match(window, /Hide\(\)/u);
  assert.match(window, /PrepareForExit/u);
  assert.match(app, /new TrayIconController/u);
  assert.match(app, /PrepareForExit\(\)/u);
  assert.match(app, /Shutdown\(\)/u);
});

test("Windows shell consumes shared bounded presentation status without duplicating onboarding logic", async () => {
  const [app, monitor, tray] = await Promise.all([
    source("App.xaml.cs"),
    source("ShellPresentationMonitor.cs"),
    source("TrayIconController.cs"),
  ]);

  assert.match(app, /new ShellPresentationMonitor/u);
  assert.match(app, /SetPresentationStatus/u);
  assert.match(monitor, /using System\.IO;/u);
  assert.match(monitor, /127\.0\.0\.1:24891\/api\/v1\/status/u);
  assert.match(monitor, /X-Equinox-Background-Refresh/u);
  assert.match(monitor, /MaxStatusBytes = 64 \* 1024/u);
  assert.match(monitor, /setup_required/u);
  assert.match(monitor, /TimeSpan\.FromSeconds\(1\)/u);
  assert.match(monitor, /TimeSpan\.FromSeconds\(2\)/u);
  assert.match(monitor, /HttpCompletionOption\.ResponseHeadersRead/u);
  assert.match(tray, /Status: \{status\.Label\}/u);
  assert.doesNotMatch(monitor, /browserConnected|connectedThroughTunnel|setupComplete|server\.js|node(?:\.exe)?|Process\.Start|powershell/iu);
});

test("Windows shell runtime supervisor uses the existing Job Object gate with bounded recovery", async () => {
  const [app, supervisor, locator, tray] = await Promise.all([
    source("App.xaml.cs"),
    source("RuntimeSupervisor.cs"),
    source("WindowsManagedReleaseLocator.cs"),
    source("TrayIconController.cs"),
  ]);
  assert.match(app, /RuntimeSupervisor\.TryCreateFromEnvironmentOrManagedInstall/u);
  assert.match(app, /await _runtimeSupervisor\.StopAsync/u);
  assert.match(supervisor, /EQUINOX_LOCAL_RELEASE_DIR/u);
  assert.match(supervisor, /using System\.IO;/u);
  assert.match(supervisor, /equinox-local-windows-job-object\.ps1/u);
  assert.match(supervisor, /equinox-local-windows-process-gate\.ps1/u);
  assert.match(supervisor, /EQUINOX_LOCAL_OWNED_PROCESS_SPEC/u);
  assert.match(supervisor, /EQUINOX_GO/u);
  assert.match(supervisor, /MaxAutomaticRestarts = 3/u);
  assert.match(supervisor, /ProtocolTimeout = TimeSpan\.FromSeconds\(15\)/u);
  assert.match(supervisor, /EQUINOX_LOCAL_SUPERVISOR_MODE/u);
  assert.match(supervisor, /_releaseResolver/u);
  assert.match(supervisor, /EQUINOX_LOCAL_INSTALL_ROOT/u);
  assert.doesNotMatch(supervisor, /taskkill|current-version\.json|cmd\.exe/iu);
  assert.match(locator, /current-version\.json/u);
  assert.match(locator, /Environment\.SpecialFolder\.LocalApplicationData/u);
  assert.match(locator, /RuntimeInformation\.ProcessArchitecture/u);
  assert.match(locator, /Architecture\.X64 => "win32-x64"/u);
  assert.match(locator, /Architecture\.Arm64 => "win32-arm64"/u);
  assert.match(locator, /schemaVersion/u);
  assert.match(locator, /release\.json/u);
  assert.match(locator, /FileAttributes\.ReparsePoint/u);
  assert.match(locator, /RequireExactProperties/u);
  assert.match(tray, /Start Runtime/u);
  assert.match(tray, /Restart Runtime/u);
  assert.match(tray, /Stop Runtime/u);
});

test("Windows shell user-login startup registration is per-user, owned and non-intrusive", async () => {
  const [app, startup, tray] = await Promise.all([
    source("App.xaml.cs"),
    source("StartupRegistration.cs"),
    source("TrayIconController.cs"),
  ]);
  assert.match(startup, /using System\.IO;/u);
  assert.match(startup, /Registry\.CurrentUser/u);
  assert.match(startup, /Software\\Microsoft\\Windows\\CurrentVersion\\Run/u);
  assert.match(startup, /RegistryValueKind\.String/u);
  assert.match(startup, /StartupRegistrationState\.Foreign/u);
  assert.match(startup, /DeleteValue/u);
  assert.doesNotMatch(startup, /LocalMachine|HKEY_LOCAL_MACHINE|schtasks|Task Scheduler/iu);
  assert.match(app, /--startup/u);
  assert.match(app, /if \(!_startedAtLogin\) _window\.Show\(\)/u);
  assert.match(app, /if \(!_startedAtLogin\) _singleInstance\.SignalPrimaryAsync/u);
  assert.match(tray, /Start at login/u);
  assert.match(tray, /registration conflict/u);
});

test("Windows shell exposes one origin-bound native folder picker bridge", async () => {
  const [window, picker, client] = await Promise.all([
    source("MainWindow.xaml.cs"),
    source("NativeFolderPicker.cs"),
    fs.readFile(path.join(ROOT, "src", "equinox-control-center.js"), "utf8"),
  ]);
  assert.match(window, /WebMessageReceived/u);
  assert.match(window, /equinox-folder-picker/u);
  assert.match(window, /127\.0\.0\.1/u);
  assert.match(window, /uri\.Port == 24891/u);
  assert.match(window, /IsSafeRequestId/u);
  assert.match(picker, /new FolderBrowserDialog/u);
  assert.match(picker, /FileAttributes\.ReparsePoint/u);
  assert.match(picker, /filesystem root cannot be granted/u);
  assert.doesNotMatch(picker, /powershell|cmd\.exe|Process\.Start/iu);
  assert.match(client, /window\.chrome\?\.webview/u);
  assert.match(client, /pickLocalFolder/u);
  assert.match(client, /equinox-folder-picker-result/u);
  assert.ok(client.includes(`if (/^[A-Za-z]:[\\\\/](?!$)/u.test(value)) return true;`));
});

test("Windows shell branding reuses canonical Equinox artwork across window, executable and tray", async () => {
  const [project, windowXaml, tray, iconBytes] = await Promise.all([
    source("EquinoxLocal.WindowsShell.csproj"),
    source("MainWindow.xaml"),
    source("TrayIconController.cs"),
    fs.readFile(path.join(SHELL, "Assets", "EquinoxLocal.ico")),
  ]);

  assert.match(project, /<ApplicationIcon>Assets\\EquinoxLocal\.ico<\/ApplicationIcon>/u);
  assert.match(project, /\.\.\/\.\.\/\.\.\/app\/EquinoxLocal\.png/u);
  assert.match(project, /Link="Assets\\EquinoxLocal\.png"/u);
  assert.match(windowXaml, /Icon="Assets\/EquinoxLocal\.png"/u);
  assert.match(tray, /Icon\.ExtractAssociatedIcon/u);
  assert.match(tray, /Icon\s*=\s*_applicationIcon/u);
  assert.match(tray, /_applicationIcon\.Dispose\(\)/u);
  assert.doesNotMatch(tray, /Icon\s*=\s*SystemIcons\.Application/u);
  assert.equal(iconBytes.readUInt16LE(0), 0);
  assert.equal(iconBytes.readUInt16LE(2), 1);
  assert.ok(iconBytes.readUInt16LE(4) >= 8, "Windows ICO should carry multiple native icon sizes");
});

test("public Windows CI restores and builds the native x64 shell", async () => {
  const publicCi = path.join(ROOT, ".github", "workflows", "ci.yml");
  const factoryCi = path.join(ROOT, "factory", "local", "public-template", ".github", "workflows", "ci.yml");
  const ciPath = await fs.access(publicCi).then(() => publicCi).catch(() => factoryCi);
  const ci = await fs.readFile(ciPath, "utf8");
  assert.match(ci, /windows-runtime:/u);
  assert.match(ci, /windows-shell:/u);
  assert.match(ci, /windows-package:/u);
  assert.match(ci, /needs: \[windows-runtime, windows-shell, windows-package, windows-arm64-foundation\]/u);
  assert.match(ci, /ARM64_RESULT: \$\{\{ needs\.windows-arm64-foundation\.result \}\}/u);
  assert.ok(ci.includes('test "$ARM64_RESULT" = success'));
  assert.match(ci, /name: Windows x64 managed package/u);
  assert.match(ci, /Windows transfer and Telegram path parity smoke/u);
  assert.match(ci, /Windows private-state ACL acceptance/u);
  assert.match(ci, /equinox-local-windows-private-state\.test\.js/u);
  assert.match(ci, /Web transfer defaults follow the shared Windows per-user path contract\|Telegram defaults follow the shared Windows per-user path contract/u);
  assert.match(ci, /Windows managed release contract and activation rollback tests/u);
  assert.match(ci, /\$PSNativeCommandUseErrorActionPreference = \$true/u);
  assert.match(ci, /node --test tests\/release\/equinox-local-release-runtime-contract\.test\.js/u);
  assert.ok(ci.includes('Windows x64 first-install release validation accepts native runtime names without Peekaboo|Windows x64 fresh first install promotes current-version and stable shell without admin'));
  assert.ok(ci.includes('tests/release/equinox-local-first-install.test.js'));
  assert.ok(ci.includes('Windows x64 managed user bootstrap uses state config and Windows Native Messaging without Darwin lifecycle'));
  assert.ok(ci.includes('tests/release/equinox-local-bootstrap.test.js'));
  assert.match(ci, /node --test tests\/release\/equinox-local-current-release\.test\.js/u);
  assert.match(ci, /name: Windows PowerShell 5\.1 bootstrap acceptance/u);
  assert.match(ci, /& powershell\.exe .*windows-installer-bootstrap-smoke\.ps1/u);
  assert.match(ci, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/u);
  assert.ok(ci.includes('node --test tests/release/equinox-local-windows-stable-shell.test.js'));
  assert.ok(ci.includes('Windows managed activation rotates pointer stable shell and Native Messaging together'));
  assert.ok(ci.includes('Windows managed activation forced health failure restores pointer stable shell and Native Messaging'));
  assert.ok(ci.includes('tests/release/equinox-local-update-activation.test.js'));
  assert.match(ci, /actions\/setup-dotnet@v5/u);
  assert.match(ci, /dotnet-version:\s*8\.0\.x/u);
  assert.match(ci, /dotnet build native\/windows\/EquinoxLocal\.WindowsShell\/EquinoxLocal\.WindowsShell\.csproj/u);
  const runtimeHarness = await fs.readFile(path.join(ROOT, "tests", "windows", "EquinoxLocal.WindowsShell.RuntimeHarness", "EquinoxLocal.WindowsShell.RuntimeHarness.csproj"), "utf8");
  assert.match(runtimeHarness, /WindowsManagedReleaseLocator\.cs/u);
  assert.match(ci, /-p:Platform=x64/u);
  assert.match(ci, /EquinoxLocal\.WindowsShell\.RuntimeHarness/u);
  assert.match(ci, /Windows native shell update handoff smoke/u);
  assert.match(ci, /EquinoxLocal\.WindowsShell\.UpdateHandoffHarness/u);
  assert.match(ci, /Windows native shell uninstall handoff smoke/u);
  assert.match(ci, /EquinoxLocal\.WindowsShell\.UninstallHandoffHarness/u);
  assert.match(ci, /tests\/release\/equinox-local-windows-lifecycle\.test\.js/u);
  assert.match(ci, /EQUINOX_TEST_NODE_EXE/u);
  assert.match(ci, /EquinoxLocal\.WindowsShell\.StartupHarness/u);
  assert.match(ci, /EquinoxLocal\.WindowsShell\.FolderPickerHarness/u);
  assert.match(ci, /EquinoxLocal\.WindowsShell\.PresentationHarness/u);
  assert.match(ci, /dotnet publish native\/windows\/EquinoxLocal\.WindowsShell\/EquinoxLocal\.WindowsShell\.csproj[^\n]*--runtime win-x64[^\n]*--self-contained true/u);
  assert.match(ci, /artifacts\/windows-shell\/win-x64/u);
  assert.match(ci, /coreclr\.dll/u);
  assert.match(ci, /hostfxr\.dll/u);
  assert.match(ci, /0x8664/u);
  assert.match(ci, /windows-arm64-foundation:/u);
  assert.match(ci, /windows-11-vs2026-arm/u);
  assert.match(ci, /architecture:\s*arm64/u);
  assert.match(ci, /windows-node-pty-smoke\.mjs/u);
  assert.match(ci, /Native ARM64 node-pty \/ ConPTY smoke\n\s+timeout-minutes:\s*1/u);
  const factoryArmPtySmokePath = path.join(ROOT, "factory", "local", "windows-node-pty-smoke.mjs");
  const publicArmPtySmokePath = path.join(ROOT, "tests", "release", "windows-node-pty-smoke.mjs");
  const armPtySmoke = await fs.readFile(
    await fs.access(factoryArmPtySmokePath).then(() => factoryArmPtySmokePath, () => publicArmPtySmokePath),
    "utf8",
  );
  assert.match(armPtySmoke, /spawnProcess\(process\.execPath/u);
  assert.match(armPtySmoke, /CHILD_TIMEOUT_MS = 20_000/u);
  assert.match(armPtySmoke, /taskkill\.exe/u);
  assert.match(ci, /--runtime win-arm64/u);
  assert.match(ci, /-p:Platform=ARM64/u);
  assert.match(ci, /0xAA64/u);
  assert.match(ci, /equinox-local-\*-win32-arm64\.zip/u);
  assert.match(ci, /WebView2Loader\.dll/u);
  assert.match(ci, /Windows native shell branding smoke/u);
  assert.match(ci, /ExtractAssociatedIcon/u);
});


test("Windows shell update handoff acknowledges before draining the runtime and exposes rollback shutdown", async () => {
  const coordinator = await fs.readFile(path.join(ROOT, "native", "windows", "EquinoxLocal.WindowsShell", "SingleInstanceCoordinator.cs"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "native", "windows", "EquinoxLocal.WindowsShell", "App.xaml.cs"), "utf8");
  const launchIndex = coordinator.indexOf("ManagedUpdateHandoff.Launch(version)");
  const ackIndex = coordinator.indexOf('WriteLineAsync("ok")', launchIndex);
  const shutdownIndex = coordinator.indexOf("UpdateShutdownRequested?.Invoke", ackIndex);
  assert.ok(launchIndex >= 0 && ackIndex > launchIndex && shutdownIndex > ackIndex);
  assert.match(coordinator, /shutdown-for-update/u);
  assert.match(app, /UpdateShutdownRequested/u);
  assert.match(app, /ExitApplicationAsync/u);
});
