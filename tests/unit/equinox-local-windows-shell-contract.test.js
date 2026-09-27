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

test("Windows shell is a thin x64 WPF/WebView2 host for the shared Control Center", async () => {
  const [project, window] = await Promise.all([
    source("EquinoxLocal.WindowsShell.csproj"),
    source("MainWindow.xaml.cs"),
  ]);

  assert.match(project, /<TargetFramework>net8\.0-windows10\.0\.19041\.0<\/TargetFramework>/u);
  assert.match(project, /<UseWPF>true<\/UseWPF>/u);
  assert.match(project, /<UseWindowsForms>true<\/UseWindowsForms>/u);
  assert.match(project, /<PlatformTarget>x64<\/PlatformTarget>/u);
  assert.match(project, /Microsoft\.Web\.WebView2/u);
  assert.match(window, /http:\/\/127\.0\.0\.1:24891\//u);
  assert.match(window, /EnsureCoreWebView2Async/u);
  assert.match(window, /GetAvailableBrowserVersionString/u);
  assert.match(window, /UseShellExecute\s*=\s*true/u);
  assert.doesNotMatch(window, /cmd\.exe|powershell(?:\.exe)?|ProcessStartInfo\s*\([^)]*\/c/iu);
});

test("Windows shell single-instance reopen channel is local-user-only", async () => {
  const [app, coordinator] = await Promise.all([
    source("App.xaml.cs"),
    source("SingleInstanceCoordinator.cs"),
  ]);

  assert.match(app, /class App : System\.Windows\.Application/u);
  assert.match(app, /if \(!_singleInstance\.IsPrimary\)/u);
  assert.match(app, /SignalPrimaryAsync/u);
  assert.match(app, /ActivateFromReopen/u);
  assert.match(coordinator, /Local\\EquinoxLocal\.WindowsShell\.SingleInstance/u);
  assert.match(coordinator, /NamedPipeServerStream/u);
  assert.match(coordinator, /PipeOptions\.CurrentUserOnly/u);
  assert.match(coordinator, /string\.Equals\(command, "reopen", StringComparison\.Ordinal\)/u);
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

test("Windows shell exposes bounded runtime health in the tray without duplicating Control Center logic", async () => {
  const [app, monitor, tray] = await Promise.all([
    source("App.xaml.cs"),
    source("RuntimeStatusMonitor.cs"),
    source("TrayIconController.cs"),
  ]);

  assert.match(app, /new RuntimeStatusMonitor/u);
  assert.match(app, /StatusChanged/u);
  assert.match(monitor, /127\.0\.0\.1:24891\/api\/v1\/health/u);
  assert.match(monitor, /TimeSpan\.FromSeconds\(1\)/u);
  assert.match(monitor, /TimeSpan\.FromSeconds\(2\)/u);
  assert.match(monitor, /HttpCompletionOption\.ResponseHeadersRead/u);
  assert.match(tray, /Runtime: \{label\}/u);
  assert.doesNotMatch(monitor, /server\.js|node(?:\.exe)?|Process\.Start|powershell/iu);
});

test("Windows shell runtime supervisor uses the existing Job Object gate with bounded recovery", async () => {
  const [app, supervisor, tray] = await Promise.all([
    source("App.xaml.cs"),
    source("RuntimeSupervisor.cs"),
    source("TrayIconController.cs"),
  ]);
  assert.match(app, /RuntimeSupervisor\.TryCreateFromEnvironment/u);
  assert.match(app, /await _runtimeSupervisor\.StopAsync/u);
  assert.match(supervisor, /EQUINOX_LOCAL_RELEASE_DIR/u);
  assert.match(supervisor, /using System\.IO;/u);
  assert.match(supervisor, /equinox-local-windows-job-object\.ps1/u);
  assert.match(supervisor, /equinox-local-windows-process-gate\.ps1/u);
  assert.match(supervisor, /EQUINOX_LOCAL_OWNED_PROCESS_SPEC/u);
  assert.match(supervisor, /EQUINOX_GO/u);
  assert.match(supervisor, /MaxAutomaticRestarts = 3/u);
  assert.match(supervisor, /EQUINOX_LOCAL_SUPERVISOR_MODE/u);
  assert.doesNotMatch(supervisor, /taskkill|current-version\.json|cmd\.exe/iu);
  assert.match(tray, /Start Runtime/u);
  assert.match(tray, /Restart Runtime/u);
  assert.match(tray, /Stop Runtime/u);
});

test("public Windows CI restores and builds the native x64 shell", async () => {
  const publicCi = path.join(ROOT, ".github", "workflows", "ci.yml");
  const factoryCi = path.join(ROOT, "factory", "local", "public-template", ".github", "workflows", "ci.yml");
  const ciPath = await fs.access(publicCi).then(() => publicCi).catch(() => factoryCi);
  const ci = await fs.readFile(ciPath, "utf8");
  assert.match(ci, /actions\/setup-dotnet@v5/u);
  assert.match(ci, /dotnet-version:\s*8\.0\.x/u);
  assert.match(ci, /dotnet build native\/windows\/EquinoxLocal\.WindowsShell\/EquinoxLocal\.WindowsShell\.csproj/u);
  assert.match(ci, /-p:Platform=x64/u);
  assert.match(ci, /EquinoxLocal\.WindowsShell\.RuntimeHarness/u);
  assert.match(ci, /EQUINOX_TEST_NODE_EXE/u);
});
