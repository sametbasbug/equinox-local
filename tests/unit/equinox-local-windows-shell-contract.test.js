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

  assert.match(app, /if \(!_singleInstance\.IsPrimary\)/u);
  assert.match(app, /SignalPrimaryAsync/u);
  assert.match(app, /ActivateFromReopen/u);
  assert.match(coordinator, /Local\\EquinoxLocal\.WindowsShell\.SingleInstance/u);
  assert.match(coordinator, /NamedPipeServerStream/u);
  assert.match(coordinator, /PipeOptions\.CurrentUserOnly/u);
  assert.match(coordinator, /string\.Equals\(command, "reopen", StringComparison\.Ordinal\)/u);
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
});
