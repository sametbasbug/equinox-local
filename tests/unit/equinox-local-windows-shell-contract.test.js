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

  assert.match(project, /<TargetFramework>net10\.0-windows10\.0\.19041\.0<\/TargetFramework>/u);
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

test("Windows managed-source runtime separates source, native, and Stable bootstrap identity", async () => {
  const [supervisor, locator] = await Promise.all([
    source("RuntimeSupervisor.cs"),
    source("WindowsManagedSourceRuntimeLocator.cs"),
  ]);

  assert.match(locator, /current-source\.conf/u);
  assert.match(locator, /Path\.Combine\(transactionRoot, "sources"\)/u);
  assert.match(locator, /Path\.Combine\(sourceRoot, "src", "server\.js"\)/u);
  assert.match(locator, /Path\.Combine\(sourceRoot, "node_modules"\)/u);
  assert.match(locator, /current-native\.json/u);
  assert.match(locator, /Path\.Combine\(transactionRoot, "native-store", Target, sourceSha\)/u);
  assert.match(locator, /native-store\.json/u);
  assert.match(locator, /BootstrapReleaseDir/u);
  assert.match(locator, /stable\.ReleaseDir/u);
  assert.doesNotMatch(locator, /sourcePointer\.Sha\s*==\s*sourceSha|sourceSha\s*==\s*sourcePointer\.Sha/u);

  assert.match(supervisor, /WindowsManagedSourceRuntimeLocator\.Resolve/u);
  assert.match(supervisor, /location\.NativeReleaseDir/u);
  assert.match(supervisor, /location\.SourceRoot/u);
  assert.match(supervisor, /location\.ServerPath/u);
  assert.match(supervisor, /Path\.Combine\(nativeReleaseDir, "runtime", "node", "bin", "node\.exe"\)/u);
  assert.match(supervisor, /Path\.Combine\(nativeReleaseDir, "equinox-local-windows-job-object\.ps1"\)/u);
  assert.match(supervisor, /Path\.Combine\(nativeReleaseDir, "equinox-local-windows-process-gate\.ps1"\)/u);
  assert.match(supervisor, /startInfo\.WorkingDirectory = sourceRoot/u);
  assert.match(supervisor, /EQUINOX_LOCAL_RELEASE_DIR"\] = location\.BootstrapReleaseDir/u);
  assert.match(supervisor, /EQUINOX_LOCAL_INSTALL_ROOT"\] = location\.InstallRoot/u);
});

test("Windows managed-source acceptance exercises reuse-native, artifact transition, rollback and refuses existing installs", async () => {
  const harnessRoot = path.join(ROOT, "tests", "windows", "EquinoxLocal.WindowsShell.ManagedSourceHarness");
  const [project, program] = await Promise.all([
    fs.readFile(path.join(harnessRoot, "EquinoxLocal.WindowsShell.ManagedSourceHarness.csproj"), "utf8"),
    fs.readFile(path.join(harnessRoot, "Program.cs"), "utf8"),
  ]);
  assert.match(project, /WindowsManagedSourceRuntimeLocator\.cs/u);
  assert.match(project, /RuntimeSupervisor\.cs/u);
  assert.match(project, /<Platforms>x64;ARM64<\/Platforms>/u);
  assert.match(program, /refuses to touch an existing Equinox Local installation/u);
  assert.match(program, /WindowsManagedSourceRuntimeLocator\.Resolve\(\)/u);
  assert.match(program, /reuse_native/u);
  assert.match(program, /artifact_required/u);
  assert.match(program, /File\.Delete\(nativePointerPath\)/u);
  assert.match(program, /supervisor\.RestartAsync\(\)/u);
  assert.match(program, /process\.execPath/u);
  assert.match(program, /process\.cwd\(\)/u);
  assert.match(program, /WINDOWS_MANAGED_SOURCE_ACCEPTANCE_PASS/u);
});

test("Windows shell runtime supervisor uses the existing Job Object gate with bounded recovery", async () => {
  const [app, supervisor, locator, tray, diagnostics, jobHelper] = await Promise.all([
    source("App.xaml.cs"),
    source("RuntimeSupervisor.cs"),
    source("WindowsManagedReleaseLocator.cs"),
    source("TrayIconController.cs"),
    source("WindowsShellDiagnostics.cs"),
    fs.readFile(path.join(ROOT, "src", "equinox-local-windows-job-object.ps1"), "utf8"),
  ]);
  assert.match(app, /RuntimeSupervisor\.TryCreateFromEnvironmentOrManagedInstall/u);
  assert.match(app, /WindowsShellDiagnostics\.RecordRuntimeFailure\("runtime-start"/u);
  assert.match(app, /WindowsShellDiagnostics\.RecordRuntimeFailure\("runtime-restart"/u);
  assert.match(app, /WindowsShellDiagnostics\.RecordRuntimeState\(/u);
  assert.match(app, /runtime-discovery/u);
  assert.match(app, /managedPointer=/u);
  assert.match(app, /supervisor=/u);
  assert.match(app, /await _runtimeSupervisor\.StopAsync/u);
  assert.match(diagnostics, /windows-shell-runtime\.log/u);
  assert.match(diagnostics, /LocalApplicationData/u);
  assert.match(diagnostics, /MaxLogBytes = 64 \* 1024/u);
  assert.match(diagnostics, /char\.IsControl/u);
  assert.doesNotMatch(diagnostics, /error\.(?:StackTrace|ToString\(\))/u);
  assert.match(diagnostics, /RecordRuntimeState/u);
  assert.match(diagnostics, /RecordLine/u);
  assert.match(supervisor, /EQUINOX_LOCAL_RELEASE_DIR/u);
  assert.match(supervisor, /using System\.IO;/u);
  assert.match(supervisor, /equinox-local-windows-job-object\.ps1/u);
  assert.match(supervisor, /equinox-local-windows-process-gate\.ps1/u);
  assert.match(supervisor, /EQUINOX_LOCAL_OWNED_PROCESS_SPEC/u);
  assert.match(supervisor, /EQUINOX_GO/u);
  assert.match(supervisor, /gate\.StandardInput\.FlushAsync/u);
  assert.doesNotMatch(supervisor, /gate\.StandardInput\.Close\(\)/u);
  assert.match(supervisor, /MaxAutomaticRestarts = 3/u);
  assert.match(supervisor, /HelperReadyTimeout = TimeSpan\.FromSeconds\(45\)/u);
  assert.match(supervisor, /ProtocolTimeout = TimeSpan\.FromSeconds\(30\)/u);
  assert.match(supervisor, /ReadReplyAsync\(_jobHelper, "ready", cancellationToken, HelperReadyTimeout\)/u);
  assert.match(supervisor, /var timeout = replyTimeout \?\? ProtocolTimeout/u);
  assert.match(supervisor, /RecordRuntimeState\("runtime-start-phase", "helper-started"\)/u);
  assert.match(supervisor, /RecordRuntimeState\("runtime-start-phase", "helper-ready"\)/u);
  assert.match(supervisor, /RecordRuntimeState\("runtime-start-phase", "assign-started"\)/u);
  assert.match(supervisor, /RecordRuntimeState\("runtime-start-phase", "assigned"\)/u);
  assert.match(supervisor, /RecordRuntimeState\("runtime-start-phase", "gate-released"\)/u);
  assert.match(supervisor, /MaxGateDiagnosticChars = 1_200/u);
  assert.match(supervisor, /gate\.ErrorDataReceived/u);
  assert.match(supervisor, /RecordRuntimeState\("runtime-gate-exit", detail\)/u);
  assert.doesNotMatch(supervisor, /OnGateExited[\s\S]{0,700}gate\.WaitForExit\(\)/u);
  assert.match(supervisor, /Windows Job Object helper \{phase\} reply timed out after/u);
  assert.match(supervisor, /ExitedHelperDetailAsync/u);
  assert.match(supervisor, /ReadToEndAsync\(cancellationToken\)/u);
  assert.match(supervisor, /builder\.Length >= 1_200/u);
  assert.match(supervisor, /char\.IsControl/u);
  assert.match(supervisor, /EQUINOX_LOCAL_SUPERVISOR_MODE/u);
  assert.match(supervisor, /_runtimeResolver/u);
  assert.match(supervisor, /EQUINOX_LOCAL_INSTALL_ROOT/u);
  assert.doesNotMatch(supervisor, /taskkill|current-version\.json|cmd\.exe/iu);
  assert.match(jobHelper, /new InvalidOperationException\(operation \+ " failed with Win32 error "/u);
  assert.match(jobHelper, /Marshal\.GetLastWin32Error\(\)/u);
  assert.doesNotMatch(jobHelper, /System\.ComponentModel|Win32Exception/u);
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

test("Windows runtime harness links and owns only its new shell diagnostics", async () => {
  const harnessRoot = path.join(ROOT, "tests", "windows", "EquinoxLocal.WindowsShell.RuntimeHarness");
  const [project, program] = await Promise.all([
    fs.readFile(path.join(harnessRoot, "EquinoxLocal.WindowsShell.RuntimeHarness.csproj"), "utf8"),
    fs.readFile(path.join(harnessRoot, "Program.cs"), "utf8"),
  ]);
  assert.match(project, /WindowsShellDiagnostics\.cs/u);
  assert.match(project, /WindowsManagedSourceRuntimeLocator\.cs/u);
  assert.match(program, /diagnosticLogExisted = File\.Exists\(diagnosticLog\)/u);
  assert.match(program, /if \(!diagnosticLogExisted\)/u);
  assert.match(program, /File\.Delete\(diagnosticLog\)/u);
  assert.match(program, /Directory\.EnumerateFileSystemEntries\(diagnosticLogsRoot\)\.Any\(\)/u);
  assert.match(program, /Directory\.EnumerateFileSystemEntries\(diagnosticInstallRoot\)\.Any\(\)/u);
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
  const ciWorkflow = await fs.readFile(ciPath, "utf8");
  assert.match(ciWorkflow, /uses: \.\/\.github\/actions\/prepare-arm64-package/u);
  const arm64Preparation = await fs.readFile(path.join(ROOT, ".github", "actions", "prepare-arm64-package", "action.yml"), "utf8");
  const arm64Inputs = await fs.readFile(path.join(ROOT, ".github", "actions", "prepare-arm64-package", "prepare-inputs.ps1"), "utf8");
  const ci = `${ciWorkflow}\n${arm64Preparation}\n${arm64Inputs}`;
  assert.match(ci, /windows-runtime:/u);
  assert.match(ci, /windows-shell:/u);
  assert.match(ci, /windows-package:/u);
  assert.match(ci, /needs: \[windows-runtime, windows-shell, windows-package, windows-x64-installer, windows-arm64-shared-core, windows-arm64-bootstrap, windows-arm64-foundation\]/u);
  assert.match(ci, /X64_INSTALLER_RESULT: \$\{\{ needs\.windows-x64-installer\.result \}\}/u);
  assert.ok(ci.includes('test "$X64_INSTALLER_RESULT" = success'));
  assert.match(ci, /ARM64_SHARED_RESULT: \$\{\{ needs\.windows-arm64-shared-core\.result \}\}/u);
  assert.match(ci, /ARM64_BOOTSTRAP_RESULT: \$\{\{ needs\.windows-arm64-bootstrap\.result \}\}/u);
  assert.match(ci, /ARM64_RESULT: \$\{\{ needs\.windows-arm64-foundation\.result \}\}/u);
  assert.ok(ci.includes('test "$ARM64_SHARED_RESULT" = success'));
  assert.ok(ci.includes('test "$ARM64_BOOTSTRAP_RESULT" = success'));
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
  assert.match(ci, /actions\/setup-dotnet@v6/u);
  assert.match(ci, /dotnet-version:\s*10\.0\.x/u);
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
  assert.match(ci, /Windows ARM64 uninstall\/reinstall lifecycle acceptance/u);
  assert.match(ci, /Windows ARM64 shared core parity suite/u);
  assert.match(ci, /Windows ARM64 headless runtime parity smoke/u);
  assert.match(ci, /tests\/unit\/task-capsule-store\.test\.js/u);
  assert.match(ci, /tests\/unit\/turn-budget-controller\.test\.js/u);
  assert.match(ci, /tests\/unit\/telegram-integration\.test\.js/u);
  assert.match(ci, /tests\/unit\/authenticated-http-integration\.test\.js/u);
  assert.match(ci, /tests\/unit\/equinox-local-file-transfer\.test\.js/u);
  assert.match(ci, /tests\/release\/equinox-local-windows-private-state\.test\.js/u);
  assert.match(ci, /POSIX-only mode\/path assertions/u);
  assert.match(ci, /Windows ARM64 stateful shell lifecycle acceptance/u);
  assert.match(ci, /windows-uninstall-handoff\/win-arm64/u);
  assert.match(ci, /UninstallHandoffHarness\.csproj --configuration Release --runtime win-arm64 --self-contained true -p:Platform=ARM64/u);
  const uninstallHarnessProject = await fs.readFile(path.join(ROOT, "tests", "windows", "EquinoxLocal.WindowsShell.UninstallHandoffHarness", "EquinoxLocal.WindowsShell.UninstallHandoffHarness.csproj"), "utf8");
  assert.match(uninstallHarnessProject, /<Platforms>x64;ARM64<\/Platforms>/u);
  assert.match(uninstallHarnessProject, /<PlatformTarget Condition=.*win-arm64.*>ARM64<\/PlatformTarget>/u);
  const uninstallHarnessSource = await fs.readFile(path.join(ROOT, "tests", "windows", "EquinoxLocal.WindowsShell.UninstallHandoffHarness", "Program.cs"), "utf8");
  assert.match(uninstallHarnessSource, /refuses non-empty or reparse-point per-user Equinox Local state/u);
  assert.match(uninstallHarnessSource, /DescribeInstallRootResidue/u);
  assert.match(uninstallHarnessSource, /Path\.GetRelativePath/u);
  assert.match(uninstallHarnessSource, /ContainsOnlyEmptyDirectories/u);
  assert.match(uninstallHarnessSource, /PruneEmptyDirectories/u);
  assert.match(uninstallHarnessSource, /helper\?\.WaitForExit\(5_000\)/u);
  assert.match(uninstallHarnessSource, /runtime\?\.WaitForExit\(5_000\)/u);
  assert.match(uninstallHarnessSource, /File\.Delete\(currentPointer\)/u);
  assert.match(uninstallHarnessSource, /cleanup left owned per-user state/u);
  assert.match(ci, /EQUINOX_TEST_NODE_EXE/u);
  assert.match(ci, /EquinoxLocal\.WindowsShell\.StartupHarness/u);
  assert.match(ci, /EquinoxLocal\.WindowsShell\.FolderPickerHarness/u);
  assert.match(ci, /EquinoxLocal\.WindowsShell\.PresentationHarness/u);
  assert.match(ci, /dotnet publish native\/windows\/EquinoxLocal\.WindowsShell\/EquinoxLocal\.WindowsShell\.csproj[^\n]*--runtime win-x64[^\n]*--self-contained true/u);
  assert.match(ci, /artifacts\/windows-shell\/win-x64/u);
  assert.match(ci, /coreclr\.dll/u);
  assert.match(ci, /hostfxr\.dll/u);
  assert.match(ci, /0x8664/u);
  assert.match(ci, /windows-arm64-shared-core:/u);
  assert.match(ci, /windows-arm64-bootstrap:/u);
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
  const factoryWinappSmokePath = path.join(ROOT, "factory", "local", "windows-winapp-smoke.ps1");
  const publicWinappSmokePath = path.join(ROOT, "tests", "release", "windows-winapp-smoke.ps1");
  const winappSmoke = await fs.readFile(
    await fs.access(factoryWinappSmokePath).then(() => factoryWinappSmokePath, () => publicWinappSmokePath),
    "utf8",
  );
  assert.match(winappSmoke, /function Invoke-WinappCaptured/u);
  assert.match(winappSmoke, /ErrorActionPreference = 'Continue'/u);
  assert.match(winappSmoke, /Set-ControlledFixtureForeground/u);
  assert.match(winappSmoke, /GetWindowThreadProcessId\(\$target, \[ref\]\$targetProcess\)/u);
  assert.match(winappSmoke, /AttachThreadInput\(\$targetThread, \$foregroundThread, \$true\)/u);
  assert.match(winappSmoke, /WINDOWS_WINAPP_FOREGROUND_RECOVERY/u);
  assert.match(winappSmoke, /GetDesktopName\(\$targetThread\)/u);
  assert.match(winappSmoke, /GetLastWin32Error\(\)/u);
  assert.match(winappSmoke, /target_session=\{14\} foreground_session=\{15\} current_session=\{16\}/u);
  assert.match(winappSmoke, /struct MOUSEINPUT/u);
  assert.match(winappSmoke, /FieldOffset\(0\)\] public MOUSEINPUT mi/u);
  assert.match(winappSmoke, /SendAltPulse\(\)/u);
  assert.match(winappSmoke, /if \(\$architecture -eq 'Arm64' -and -not \$setResult\)/u);
  assert.match(winappSmoke, /alt_input_count=\{25\} alt_input_error=\{26\} set_after_alt=\{27\}/u);
  assert.match(winappSmoke, /function Test-ProtectedHostedForegroundCeiling/u);
  assert.match(winappSmoke, /\$architecture -ne 'Arm64'/u);
  assert.match(winappSmoke, /\$env:GITHUB_ACTIONS -ne 'true'/u);
  assert.match(winappSmoke, /\$env:RUNNER_ENVIRONMENT -ne 'github-hosted'/u);
  assert.match(winappSmoke, /foreground_not_target/u);
  assert.match(winappSmoke, /\$evidence\.TargetPid -eq \$fixture\.Id/u);
  assert.match(winappSmoke, /\$evidence\.TargetProcess -eq 'EquinoxLocal\.WinappSmokeFixture'/u);
  assert.match(winappSmoke, /\$evidence\.ForegroundProcess -eq 'WWAHost'/u);
  assert.match(winappSmoke, /\$evidence\.CurrentProcess -eq 'powershell'/u);
  assert.match(winappSmoke, /\$evidence\.TargetSession -eq \$evidence\.ForegroundSession/u);
  assert.match(winappSmoke, /\$evidence\.TargetSession -eq \$evidence\.CurrentSession/u);
  assert.match(winappSmoke, /\$evidence\.TargetDesktop -eq 'Default'/u);
  assert.match(winappSmoke, /\$evidence\.CurrentDesktop -eq 'Default'/u);
  assert.match(winappSmoke, /\$evidence\.ForegroundDesktop -eq '<unavailable:5>'/u);
  assert.match(winappSmoke, /-not \$evidence\.AttachedTargetForeground/u);
  assert.match(winappSmoke, /\$evidence\.AttachError -eq 5/u);
  assert.match(winappSmoke, /\$evidence\.ShowResult -and/u);
  assert.match(winappSmoke, /\$evidence\.BringResult -and/u);
  assert.match(winappSmoke, /-not \$evidence\.SetResult/u);
  assert.match(winappSmoke, /\$evidence\.AltInputCount -eq 2/u);
  assert.match(winappSmoke, /\$evidence\.AltInputError -eq 0/u);
  assert.match(winappSmoke, /-not \$evidence\.SetAfterAltResult/u);
  assert.match(winappSmoke, /\$evidence\.AfterPid -eq \$evidence\.ForegroundPid/u);
  assert.match(winappSmoke, /\$evidence\.AfterThread -eq \$evidence\.ForegroundThread/u);
  assert.match(winappSmoke, /\$evidence\.AfterHandle -eq \$evidence\.ForegroundHandle/u);
  assert.match(winappSmoke, /reason=hosted_runner_protected_wwahost/u);
  assert.match(winappSmoke, /DesktopHelperPath/u);
  assert.match(winappSmoke, /Invoke-DesktopHelperCaptured/u);
  assert.match(winappSmoke, /AppLaunch/u);
  assert.match(winappSmoke, /AppOpen/u);
  assert.match(winappSmoke, /WINDOWS_DESKTOP_APP_OPEN_SMOKE_PASS/u);
  assert.match(winappSmoke, /AppList/u);
  assert.match(winappSmoke, /WindowMinimize/u);
  assert.match(winappSmoke, /WindowRestore/u);
  assert.match(winappSmoke, /WindowMaximize/u);
  assert.match(winappSmoke, /WindowSetBounds/u);
  assert.match(winappSmoke, /WindowMove/u);
  assert.match(winappSmoke, /WindowResize/u);
  assert.match(winappSmoke, /AppRelaunch/u);
  assert.match(winappSmoke, /WindowClose/u);
  assert.match(winappSmoke, /AppQuit/u);
  assert.match(winappSmoke, /WINDOWS_DESKTOP_LIFECYCLE_SMOKE_PASS/u);
  assert.match(ci, /release\/equinox-local-windows-desktop\.ps1/u);
  assert.match(ci, /-DesktopHelperPath/u);
});


test("Windows Main update handoff derives all worker paths from product-owned state and does not preemptively stop the shell", async () => {
  const [coordinator, handoff] = await Promise.all([
    source("SingleInstanceCoordinator.cs"),
    source("MainUpdateHandoff.cs"),
  ]);

  assert.match(coordinator, /StartsWith\("main-update:", StringComparison\.Ordinal\)/u);
  assert.match(coordinator, /MainUpdateHandoff\.Launch\(transactionId\)/u);
  const mainBranchStart = coordinator.indexOf('StartsWith("main-update:"');
  const nextBranchStart = coordinator.indexOf('StartsWith("activate-release:"', mainBranchStart);
  const mainBranch = coordinator.slice(mainBranchStart, nextBranchStart);
  assert.match(mainBranch, /WriteLineAsync\("ok"\)/u);
  assert.doesNotMatch(mainBranch, /UpdateShutdownRequested\?\.Invoke/u);

  assert.match(handoff, /Path\.Combine\(installRoot, "state", "main-update"\)/u);
  assert.match(handoff, /Path\.Combine\(transactionRoot, "install\.json"\)/u);
  assert.match(handoff, /Path\.Combine\(transactionRoot, "active\.json"\)/u);
  assert.match(handoff, /Path\.Combine\(transactionRoot, "receipts", \$"\{transactionId\}\.json"\)/u);
  assert.match(handoff, /Path\.Combine\(transactionRoot, "sources"\)/u);
  assert.match(handoff, /RequireExactSourceRoot/u);
  assert.match(handoff, /sametbasbug\/equinox-local/u);
  assert.match(handoff, /runtime", "node", "bin", "node\.exe"/u);
  assert.match(handoff, /Path\.Combine\(targetSourceRoot, "src", "equinox-local-main-update-worker\.js"\)/u);
  assert.match(handoff, /startInfo\.ArgumentList\.Add\("--transaction-id"\)/u);
  assert.match(handoff, /startInfo\.ArgumentList\.Add\("--source-root"\)/u);
  assert.match(handoff, /startInfo\.ArgumentList\.Add\("--transaction-root"\)/u);
  assert.doesNotMatch(handoff, /ResolveGitExecutable|where\.exe|gitDirectory/u);
  assert.match(handoff, /WindowsPowerShell", "v1\.0"/u);
  assert.match(handoff, /string\.Join\(Path\.PathSeparator, \[powershellDirectory, system32, systemRoot\]\)/u);
  assert.match(handoff, /Environment\.Clear\(\)/u);
  assert.match(handoff, /RandomNumberGenerator\.GetBytes\(32\)/u);
  assert.match(handoff, /EQUINOX_LOCAL_MAIN_WORKER_TOKEN/u);
  assert.match(handoff, /process\.StartTime\.ToUniversalTime\(\)\.Ticks/u);
  assert.match(handoff, /\.windows-worker\.json/u);
  assert.match(handoff, /RemoveStaleOwnershipOrRejectActive/u);
  assert.match(handoff, /Main update worker is already active for this transaction/u);
  assert.match(handoff, /FileStream\(temporaryPath, FileMode\.CreateNew/u);
  assert.match(handoff, /File\.Move\(temporaryPath, ownershipPath, overwrite: false\)/u);
  assert.match(handoff, /process\.Kill\(entireProcessTree: true\)/u);
  assert.doesNotMatch(handoff, /cmd\.exe/iu);
});

test("Windows shell update handoff acknowledges before draining the runtime and exposes rollback shutdown", async () => {
  const coordinator = await fs.readFile(path.join(ROOT, "native", "windows", "EquinoxLocal.WindowsShell", "SingleInstanceCoordinator.cs"), "utf8");
  const app = await fs.readFile(path.join(ROOT, "native", "windows", "EquinoxLocal.WindowsShell", "App.xaml.cs"), "utf8");
  const updateHarnessSource = await fs.readFile(path.join(ROOT, "tests", "windows", "EquinoxLocal.WindowsShell.UpdateHandoffHarness", "Program.cs"), "utf8");
  assert.match(updateHarnessSource, /helper\?\.WaitForExit\(5_000\)/u);
  assert.match(updateHarnessSource, /runtime\?\.WaitForExit\(5_000\)/u);
  assert.match(updateHarnessSource, /DeleteOwnedFixtureReleaseAsync\(releaseDir\)/u);
  assert.match(updateHarnessSource, /attempt < 20/u);
  assert.match(updateHarnessSource, /Task\.Delay\(100\)/u);
  assert.match(updateHarnessSource, /Could not clean exact update-handoff fixture release/u);
  assert.match(updateHarnessSource, /Directory\.EnumerateFileSystemEntries\(releasesRoot\)\.Any\(\)/u);
  assert.match(updateHarnessSource, /Directory\.EnumerateFileSystemEntries\(installRoot\)\.Any\(\)/u);
  const launchIndex = coordinator.indexOf("ManagedUpdateHandoff.Launch(version)");
  const ackIndex = coordinator.indexOf('WriteLineAsync("ok")', launchIndex);
  const shutdownIndex = coordinator.indexOf("UpdateShutdownRequested?.Invoke", ackIndex);
  assert.ok(launchIndex >= 0 && ackIndex > launchIndex && shutdownIndex > ackIndex);
  assert.match(coordinator, /shutdown-for-update/u);
  assert.match(app, /UpdateShutdownRequested/u);
  assert.match(app, /ExitApplicationAsync/u);
});
