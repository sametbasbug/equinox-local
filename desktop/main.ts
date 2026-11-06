import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification as DesktopNotification, screen, session, shell, Tray } from "electron";
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from "electron";
import fs from "node:fs";
import os from "node:os";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONTROL_ORIGIN, isControlDocument, mutateControl, readControlJson } from "./control-client.js";
import { createRuntimeOwner } from "./runtime-owner.js";
import type { RuntimeLaunch, RuntimeOwnerState } from "./runtime-owner.js";
import { resolveInstalledRuntime } from "./runtime-installation.js";
import type { InstalledRuntimeIdentity } from "./runtime-installation.js";
import { openLifecycleControl } from "./lifecycle-control.js";
import type { UninstallHandoff } from "./lifecycle-control.js";
import { prepareWindowsUninstallHandoff, UninstallCleanupError } from "./uninstall-handoff.js";
import { createCompanionController } from "./companion.js";
import type { CompanionController } from "./companion.js";
import { openShellPreferences } from "./shell-preferences.js";
import type { ShellPreferences, ShellPreferenceStore } from "./shell-preferences.js";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(directory);
const PINNED_ELECTRON = "46.0.0-alpha.5";
const applicationMetadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const runtimeRole = app.isPackaged ? applicationMetadata.equinoxRuntimeRole : "development";
if (!["development", "managed", "source"].includes(runtimeRole)) throw new Error("Unknown desktop application role.");
const development = runtimeRole === "development";
if (!development && applicationMetadata.equinoxDesktopSchema !== 1) throw new Error("Installed desktop metadata is not admitted.");
const installedIdentity: InstalledRuntimeIdentity | null = development ? null : runtimeRole === "managed"
  ? { role: "managed", sourceSha: applicationMetadata.equinoxSourceSha }
  : { role: "source" };
const execFile = promisify(execFileCallback);
let backgroundLaunch = process.argv.includes("--startup");
let revealOnFirstLoad = !backgroundLaunch;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let navigating = false;
let connected = false;
let rendererFailed = false;
let rendererRecoveryAttempts = 0;
let refreshInFlight = false;
let refreshRequested = false;
let mutationPending = false;
let pickerPending = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let language = "en";
let shellPreferences: ShellPreferenceStore | null = null;
let companion: CompanionController | null = null;
let status: Record<string, any> | null = null;
let runtimeOwner: ReturnType<typeof createRuntimeOwner> | null = null;
let lifecycleControl: Awaited<ReturnType<typeof openLifecycleControl>> | null = null;
let runtimeState: RuntimeOwnerState = "stopped";
let lifecycleBusy = false;
let systemOperationBusy = false;
let controlLost = false;
let initializationComplete = false;
let uninstallRequested = process.argv.includes("--uninstall");
let directUninstallOperation: Promise<void> | null = null;
let systemCleanupFailure: Error | null = null;
let uninstallLaunch: RuntimeLaunch | null = null;
let loginEnabled = false;
let loginAvailable = false;
let allowQuit = false;
let shutdownPromise: Promise<void> | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let restartPending = false;
let notificationBaselineEstablished = false;
let lastNotificationId: string | null = null;
const visibleNotifications = new Set<DesktopNotification>();

// Validate finite maintenance before any Chromium profile selection or readiness.
const installerLoginModes = process.argv.filter(value => value.startsWith("--installer-login="));
const installerProfileArgs = process.argv.filter(value => value.startsWith("--installer-profile="));
const installerMode = installerLoginModes[0]?.slice("--installer-login=".length);
let installerProfile: string | null = null;
try {
if (installerLoginModes.length || installerProfileArgs.length) {
  if (installerLoginModes.length !== 1 || installerProfileArgs.length !== 1 ||
      !["read", "cleanup", "enabled", "disabled"].includes(installerMode ?? "") || process.platform !== "darwin" ||
      (runtimeRole !== "managed" && runtimeRole !== "source") || !installedIdentity ||
      process.execPath !== path.join(app.getPath("home"), "Applications", "Equinox Local.app", "Contents", "MacOS", "applet") ||
      fs.realpathSync(process.execPath) !== process.execPath ||
      process.argv.some(value => value === "--startup" || value === "--uninstall" || value.startsWith("--migrate-startup=") || value.startsWith("--migrate-shell="))) {
    throw new Error("Invalid finite installer login invocation.");
  }
  installerProfile = installerProfileArgs[0]!.slice("--installer-profile=".length);
  // The Node parent creates this profile with os.tmpdir(). Cocoa may ignore
  // TMPDIR, so app.getPath("temp") can name a different canonical directory.
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const stat = fs.lstatSync(installerProfile);
  if (path.dirname(installerProfile) !== temporaryRoot ||
      !/^equinox-installer-login-[A-Za-z0-9]+$/u.test(path.basename(installerProfile)) ||
      fs.realpathSync(installerProfile) !== installerProfile || !stat.isDirectory() || stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700) {
    throw new Error("Installer profile is not a canonical current-user private temporary directory.");
  }
  // Ancestors must not permit another user to substitute the private directory.
  for (let current = temporaryRoot;; current = path.dirname(current)) {
    const ancestor = fs.lstatSync(current);
    if (!ancestor.isDirectory() || ancestor.isSymbolicLink() || ![0, process.getuid?.()].includes(ancestor.uid) ||
        ((ancestor.mode & 0o022) !== 0 && !(ancestor.uid === 0 && (ancestor.mode & 0o1000) !== 0))) {
      throw new Error("Unsafe installer profile ancestor.");
    }
    if (current === path.dirname(current)) break;
  }
  if (fs.readdirSync(installerProfile).length) throw new Error("Installer profile must be fresh and empty.");
  fs.mkdirSync(path.join(installerProfile, "userData"), { mode: 0o700 });
  fs.mkdirSync(path.join(installerProfile, "sessionData"), { mode: 0o700 });
}
} catch {
  // Invalid maintenance must not reach default storage or Electron's error UI.
  app.exit(1);
  process.exit(1);
}

// A source window must not share Chromium storage or acquire the installed app's identity.
const developmentProfile = process.env.EQUINOX_LOCAL_SHELL_DATA_DIR;
if (development && developmentProfile && !path.isAbsolute(developmentProfile)) {
  throw new Error("Development shell profile must be absolute.");
}
app.setName("Equinox Local");
app.setPath("userData", installerProfile ? path.join(installerProfile, "userData") : development
  ? developmentProfile || path.join(app.getPath("appData"), "Equinox Local", "state", "electron-development")
  : process.platform === "win32"
    ? path.join(path.dirname(path.dirname(path.dirname(process.execPath))), "Equinox Local", "state", "electron")
    : path.join(app.getPath("appData"), "Equinox Local", "state", "electron"));
if (installerProfile) app.setPath("sessionData", path.join(installerProfile, "sessionData"));
app.enableSandbox();
if (process.platform === "win32") app.disableHardwareAcceleration();

function text(english: string, turkish: string): string { return language === "tr" ? turkish : english; }

function trustedSender(event: IpcMainInvokeEvent): boolean {
  return Boolean(window && !window.isDestroyed()
    && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && isControlDocument(event.senderFrame.url));
}

async function openExternal(value: string): Promise<void> {
  let url: URL;
  try { url = new URL(value); } catch { return; }
  // These are the existing Control Center's destinations, not a general protocol launcher.
  const allowedHosts = new Set(["platform.openai.com", "chatgpt.com", "chromewebstore.google.com", "t.me"]);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !allowedHosts.has(url.hostname)) return;
  await shell.openExternal(url.href);
}

function showControlCenter(): void {
  if (!window || window.isDestroyed() || quitting) return;
  if (rendererFailed) {
    rendererRecoveryAttempts = 0;
    void refresh();
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function observeNativeNotification(value: unknown): void {
  // Development attaches to a resident host which already owns notifications.
  if (development || quitting) return;
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
  const id = typeof candidate?.id === "string" && candidate.id.length > 0 && candidate.id.length <= 512
    && !/[\x00-\x1f\x7f]/u.test(candidate.id) ? candidate.id : null;
  if (!notificationBaselineEstablished) {
    notificationBaselineEstablished = true; lastNotificationId = id; return;
  }
  if (id === lastNotificationId) return;
  lastNotificationId = id;
  if (!id || !candidate || typeof candidate.title !== "string" || typeof candidate.body !== "string") return;
  try {
    if (!DesktopNotification.isSupported()) return;
    // Retain only a bounded number of native objects, never status/task history.
    if (visibleNotifications.size >= 16) {
      const oldest = visibleNotifications.values().next().value;
      visibleNotifications.delete(oldest!); oldest?.close();
    }
    const notification = new DesktopNotification({
      title: candidate.title.slice(0, 160), body: candidate.body.slice(0, 1024), silent: false,
    });
    const taskId = typeof candidate.taskId === "string" && /^task-[a-z0-9-]{6,80}$/u.test(candidate.taskId)
      ? candidate.taskId : null;
    visibleNotifications.add(notification);
    const retire = () => { visibleNotifications.delete(notification); };
    notification.once("close", retire);
    notification.once("failed", retire);
    notification.once("click", () => {
      retire();
      if (quitting || !window || window.isDestroyed()) return;
      if (!taskId || navigating) { showControlCenter(); return; }
      const destination = new URL(`${CONTROL_ORIGIN}/`);
      destination.searchParams.set("section", "tasks");
      destination.searchParams.set("task", taskId);
      navigating = true;
      rendererRecoveryAttempts = 0;
      void window.loadURL(destination.href).then(() => { rendererFailed = false; })
        .catch(() => { rendererFailed = true; })
        .finally(() => { navigating = false; showControlCenter(); });
    });
    notification.show();
  } catch { /* Optional native notification failure must not stop the runtime. */ }
}

async function runMutation(route: string): Promise<void> {
  if (!connected || mutationPending || quitting) return;
  mutationPending = true;
  updateMenus();
  try {
    await mutateControl(route);
    await refresh();
  } catch {
    // A lost reply can follow a committed mutation. Never automatically repeat it.
    if (window && !window.isDestroyed()) await dialog.showMessageBox(window, {
      type: "warning", title: "Equinox Local",
      message: text("The operation could not be confirmed.", "İşlem doğrulanamadı."),
      detail: text("Check Control Center before trying again.", "Yeniden denemeden önce Kontrol Merkezi'ni kontrol edin."),
    });
  } finally {
    mutationPending = false;
    updateMenus();
  }
}

async function reportLifecycleFailure(): Promise<void> {
  if (window && !window.isDestroyed()) await dialog.showMessageBox(window, {
    type: "error", title: "Equinox Local",
    message: text("The application operation could not be completed.", "Uygulama işlemi tamamlanamadı."),
    detail: text("Review diagnostics or rerun the official installer. The operation was not automatically retried.", "Tanı kayıtlarını inceleyin veya resmî kurucuyu yeniden çalıştırın. İşlem otomatik tekrarlanmadı."),
  });
}

function drainRestart(): void {
  if (!restartPending || restartTimer || lifecycleBusy || systemOperationBusy || !initializationComplete || quitting || controlLost) return;
  restartPending = false;
  void runOwnerAction("restart");
}

async function runOwnerAction(action: "start" | "stop" | "restart"): Promise<void> {
  if (!runtimeOwner || !initializationComplete || lifecycleBusy || systemOperationBusy || quitting || (controlLost && action !== "stop")) return;
  if (action === "stop") {
    restartPending = false;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  }
  lifecycleBusy = true;
  updateMenus();
  try {
    await runtimeOwner[action]();
    if (action === "stop") { connected = false; status = null; }
  } catch { await reportLifecycleFailure(); }
  finally { lifecycleBusy = false; updateMenus(); drainRestart(); if (!quitting) void refresh(); }
}

async function readLoginPreference(): Promise<void> {
  if (development) return;
  if (process.platform === "win32") {
    if (!uninstallLaunch) throw new Error("Admitted runtime required for Windows startup ownership.");
    const helper = path.join(uninstallLaunch.cwd, "equinox-local-uninstall-helper.js");
    const script = "import {pathToFileURL} from 'node:url';const helper=await import(pathToFileURL(process.argv[2]).href);const value=await helper.readWindowsStartupRegistrationOwnership({expectedCommand:process.argv[3],env:process.env});process.stdout.write(JSON.stringify({enabled:value.enabled}));";
    const { stdout } = await execFile(uninstallLaunch.command, ["--input-type=module", "-e", script,
      "equinox-desktop", helper, `\"${process.execPath}\" --startup`], {
      cwd: uninstallLaunch.cwd, env: uninstallLaunch.env, windowsHide: true, timeout: 20_000, maxBuffer: 64 * 1024,
    });
    const value = JSON.parse(stdout) as { enabled?: unknown };
    if (typeof value.enabled !== "boolean") throw new Error("Invalid Windows startup ownership response.");
    const settings = app.getLoginItemSettings({ path: process.execPath, args: ["--startup"] });
    loginEnabled = value.enabled && settings.executableWillLaunchAtLogin;
  } else {
    const settings = app.getLoginItemSettings();
    loginEnabled = settings.openAtLogin && settings.status === "enabled";
  }
  loginAvailable = true;
}

async function changeLoginPreference(enabled: boolean): Promise<void> {
  if (development) return;
  if (systemOperationBusy || quitting || controlLost) throw new Error("Application preference operation is unavailable.");
  systemOperationBusy = true;
  updateMenus();
  try {
    await readLoginPreference(); // Refuse a foreign Windows Run command before writing.
    if (quitting || controlLost) throw new Error("Application ownership was lost before preference change.");
    app.setLoginItemSettings({ openAtLogin: enabled, ...(process.platform === "win32"
      ? { path: process.execPath, args: ["--startup"], name: "Equinox Local", enabled }
      : {}) });
    await readLoginPreference();
    if (quitting || controlLost || loginEnabled !== enabled) throw new Error("Login preference could not be confirmed or needs operating-system approval.");
  } finally { systemOperationBusy = false; updateMenus(); drainRestart(); }
}

function loseLifecycleOwnership(): void {
  controlLost = true;
  restartPending = false;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  runtimeState = "attention";
  if (runtimeOwner) void runtimeOwner.stop().catch(() => { runtimeState = "attention"; updateMenus(); });
  updateMenus();
}

function retainUninstallCleanupFailure(error: unknown): void {
  systemCleanupFailure = new Error("Owned uninstall cleanup could not be established.", { cause: error });
  loseLifecycleOwnership();
}

async function cancelUninstall(handoff: UninstallHandoff): Promise<void> {
  try { await handoff.cancel(); }
  catch (error) { retainUninstallCleanupFailure(error); throw error; }
}

async function prepareUninstall(removeUserData: boolean): Promise<UninstallHandoff> {
  if (process.platform !== "win32" || !uninstallLaunch || runtimeRole !== "managed" || quitting || controlLost) {
    throw new Error("Admitted Windows uninstall ownership is unavailable.");
  }
  try {
    const handoff = await prepareWindowsUninstallHandoff(uninstallLaunch, {
      removeUserData, ownerPid: process.pid, expectedStartupCommand: `\"${process.execPath}\" --startup`,
    });
    if (quitting || controlLost) { await cancelUninstall(handoff); throw new Error("Uninstall ownership was lost during preparation."); }
    return handoff;
  } catch (error) {
    if (error instanceof UninstallCleanupError) retainUninstallCleanupFailure(error);
    throw error;
  }
}

async function confirmUninstall(): Promise<void> {
  if (!window || runtimeRole !== "managed" || process.platform !== "win32" || lifecycleBusy || systemOperationBusy || quitting || controlLost) return;
  systemOperationBusy = true;
  updateMenus();
  try {
    const result = await dialog.showMessageBox(window, { type: "question", title: "Equinox Local",
      message: text("Uninstall Equinox Local?", "Equinox Local kaldırılsın mı?"),
      detail: text("Settings and user data will be preserved.", "Ayarlar ve kullanıcı verileri korunacak."),
      buttons: [text("Cancel", "Vazgeç"), text("Uninstall", "Kaldır")], defaultId: 0, cancelId: 0,
    });
    if (result.response !== 1 || quitting || controlLost) return;
    await readLoginPreference();
    if (quitting || controlLost) return;
    // Track only owned worker work, never this dialog or shutdownPromise.
    const operation = (async () => {
      const handoff = await prepareUninstall(false);
      try { await handoff.release(); }
      catch (error) {
        await cancelUninstall(handoff);
        throw new Error("Uninstall release failed; its prepared worker was retired.", { cause: error });
      }
    })();
    directUninstallOperation = operation;
    try { await operation; } finally { if (directUninstallOperation === operation) directUninstallOperation = null; }
    app.quit();
  } catch { loginAvailable = false; if (!quitting) await reportLifecycleFailure(); }
  finally { if (!systemCleanupFailure) systemOperationBusy = false; updateMenus(); drainRestart(); }
}

async function initializeOwner(): Promise<void> {
  if (!installedIdentity) return;
  const initial = await resolveInstalledRuntime(installedIdentity, process.resourcesPath);
  if (quitting) throw new Error("Application startup was cancelled.");
  let prepared: RuntimeLaunch | null = initial;
  uninstallLaunch = process.platform === "win32" ? initial : null;
  runtimeOwner = createRuntimeOwner(async () => {
    if (prepared) { const launch = prepared; prepared = null; return launch; }
    return await resolveInstalledRuntime(installedIdentity, process.resourcesPath);
  }, (state) => { runtimeState = state; updateMenus(); });
  lifecycleControl = await openLifecycleControl({
    ...(initial.controlHelper ? { helperPath: initial.controlHelper } : {}),
    onReopen: showControlCenter,
    onRestart: () => {
      if (quitting || controlLost) return;
      restartPending = true;
      if (restartTimer) return;
      // Leave time for the existing backend's one-way request/result to be sent.
      restartTimer = setTimeout(() => { restartTimer = null; drainRestart(); }, 1_000);
    },
    onShutdown: () => app.quit(),
    onUninstallShutdown: () => {
      void changeLoginPreference(false).then(() => app.quit()).catch(() => reportLifecycleFailure());
    },
    onUninstallRequest: async (removeUserData) => {
      if (!initializationComplete || !loginAvailable || runtimeRole !== "managed" || lifecycleBusy || systemOperationBusy || quitting || controlLost) return null;
      systemOperationBusy = true;
      updateMenus();
      try {
        const handoff = await prepareUninstall(removeUserData);
        return {
          release: async () => {
            await handoff.release();
            systemOperationBusy = false; updateMenus();
          },
          cancel: async () => {
            await cancelUninstall(handoff);
            systemOperationBusy = false; updateMenus(); drainRestart();
          },
        };
      } catch (error) {
        if (systemCleanupFailure) throw error;
        systemOperationBusy = false; updateMenus(); drainRestart();
        if (!quitting) void reportLifecycleFailure();
        return null;
      }
    },
    onUninstallAcknowledged: () => {
      restartPending = false;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      app.quit();
    },
    onFailure: loseLifecycleOwnership,
  });
  if (controlLost || quitting) { await lifecycleControl.close(); throw new Error("Application lifecycle ownership was lost."); }
  try { await readLoginPreference(); } catch { loginAvailable = false; }
  const migrations = process.argv.filter((value) => value.startsWith("--migrate-startup="));
  if (migrations.length > 1 || (migrations.length === 1 && !["--migrate-startup=enabled", "--migrate-startup=disabled"].includes(migrations[0]!))) {
    throw new Error("Invalid startup preference migration.");
  }
  if (migrations.length === 1) await changeLoginPreference(migrations[0] === "--migrate-startup=enabled");
  if (controlLost || quitting) throw new Error("Application lifecycle ownership was lost during initialization.");
}

function importLegacyShellPreferences(): void {
  if((runtimeRole!=="managed" && runtimeRole!=="source") || process.platform!=="darwin" || !installedIdentity || !shellPreferences || controlLost || quitting)return;
  let fd:number|undefined;
  try {
    // Revalidate storage on each finite startup/reopen attempt. An invalid store
    // remains protected; a recovered I/O failure is not permanently latched.
    if(!shellPreferences.refresh())throw new Error("Legacy GUI migration unavailable.");
    // Recover storage before retrying a real pending user move. A failed flush
    // retains both that motion and the handoff, rather than importing over it.
    companion?.applySavedPreferences();
    const file=path.join(app.getPath("userData"),"private-shell","legacy-shell-pending.json");
    const normal=(s:fs.Stats)=>s.isFile() && s.nlink===1 && s.uid===process.getuid?.() && (s.mode&0o077)===0 && s.size<=2048;
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|(fs.constants.O_NONBLOCK??0));
    const opened=fs.fstatSync(fd);
    const before=fs.lstatSync(file);
    if(!normal(before) || before.isSymbolicLink())throw new Error("Unsafe pending GUI handoff.");
    if(!normal(opened) || before.dev!==opened.dev || before.ino!==opened.ino)throw new Error("Pending GUI handoff changed.");
    const bytes=Buffer.alloc(2049);
    let count=0;
    while(count<bytes.length) {
      const read=fs.readSync(fd,bytes,count,bytes.length-count,count);
      if(!read)break;
      count+=read;
    }
    const readback=fs.fstatSync(fd);
    if(count>2048 || count!==opened.size || !normal(readback) || readback.size!==opened.size ||
       readback.mtimeMs!==opened.mtimeMs || readback.ctimeMs!==opened.ctimeMs)throw new Error("Pending GUI handoff changed while reading.");
    const parsed:unknown=JSON.parse(bytes.subarray(0,count).toString("utf8"));
    if(!parsed || typeof parsed!=="object" || Array.isArray(parsed))throw new Error("Invalid GUI migration.");
    const value=parsed as Record<string,unknown>;
    if(value.schemaVersion!==1 || Object.keys(value).some(key=>!["schemaVersion","visible","language","frame"].includes(key)) ||
       (value.visible!==undefined && typeof value.visible!=="boolean") ||
       (value.language!==undefined && value.language!=="en" && value.language!=="tr"))throw new Error("Invalid GUI migration fields.");
    let origin:{x:number;y:number}|undefined;
    if(value.frame!==undefined) {
      if(!value.frame || typeof value.frame!=="object" || Array.isArray(value.frame))throw new Error("Invalid legacy frame.");
      const frame=value.frame as Record<string,unknown>;
      if(Object.keys(frame).length!==4 || !["x","y","width","height"].every(key=>typeof frame[key]==="number" && Number.isFinite(frame[key]) && Math.abs(frame[key] as number)<=100_000) ||
         (frame.width as number)<=0 || (frame.height as number)<=0)throw new Error("Invalid legacy frame dimensions.");
      // AppKit global Y is bottom-origin; Electron uses primary-display top-origin.
      const primary=screen.getPrimaryDisplay().bounds;
      origin={x:Math.round(frame.x as number),y:Math.round(primary.y+primary.height-(frame.y as number)-(frame.height as number))};
      const point=origin;
      if(!screen.getAllDisplays().some(({workArea:a})=>point.x<a.x+a.width && point.x+132>a.x && point.y<a.y+a.height && point.y+142>a.y))origin=undefined;
    }
    const existing=shellPreferences.read();
    const patch:ShellPreferences={};
    if(existing.companionVisible===undefined && typeof value.visible==="boolean")patch.companionVisible=value.visible;
    if(existing.companionBounds===undefined && origin)patch.companionBounds=origin;
    if(existing.language===undefined && (value.language==="en" || value.language==="tr"))patch.language=value.language;
    // Even an empty merge requires an explicit durable readback, not an
    // in-memory completion: existing fields (including false) always win.
    if(!shellPreferences.write(patch))throw new Error("GUI migration could not be persisted.");
    language=shellPreferences.read().language??language;
    updateMenus();
    companion?.applySavedPreferences(shellPreferences.read());
    const current=fs.lstatSync(file), final=fs.fstatSync(fd);
    if(!normal(current) || current.dev!==opened.dev || current.ino!==opened.ino || current.size!==opened.size ||
       current.mtimeMs!==opened.mtimeMs || final.ctimeMs!==opened.ctimeMs)throw new Error("Pending GUI handoff changed before retirement.");
    fs.unlinkSync(file);
  } catch(error) {
    if((error as NodeJS.ErrnoException).code!=="ENOENT")process.stderr.write("Legacy GUI preference import unavailable; pending transfer retained and existing preferences were not reset.\n");
  } finally { if(fd!==undefined) { try { fs.closeSync(fd); } catch { /* Optional handoff cannot stop core startup. */ } } }
}

function cleanupPresentation(): void {
  try { companion?.dispose(); } catch { /* Optional companion cannot obstruct shutdown. */ }
  companion = null;
  restartPending = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  for (const notification of visibleNotifications) {
    try { notification.close(); } catch { /* Presentation cleanup is best effort. */ }
  }
  visibleNotifications.clear();
  tray?.destroy();
  tray = null;
}

function beginQuit(): void {
  if (shutdownPromise) return;
  quitting = true;
  restartPending = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  shutdownPromise = (async () => {
    await runtimeOwner?.stop();
    // Ordinary refusal has verified cleanup; terminal cleanup errors are retained below.
    await directUninstallOperation?.catch(() => {});
    await lifecycleControl?.close();
    if (systemCleanupFailure) throw systemCleanupFailure;
    allowQuit = true;
    cleanupPresentation();
    app.quit();
  })().catch(async () => {
    quitting = false; shutdownPromise = null; runtimeState = "attention";
    updateMenus();
    await reportLifecycleFailure();
  });
}

function updateMenus(): void {
  try {
    companion?.update({ connected, presentation: status?.presentation, language: language === "tr" ? "tr" : "en" });
  } catch { /* Optional presentation cannot block the core status/lifecycle. */ }
  const paused = status?.agentControl?.paused === true;
  const label = !development && (controlLost || runtimeState === "attention")
    ? text("Runtime needs attention", "Çalışma zamanı ilgilenmenizi gerektiriyor")
    : rendererFailed
    ? text("Control Center unavailable", "Kontrol Merkezi kullanılamıyor")
    : connected
    ? String(status?.presentation?.label || "Connected").replace(/[\r\n\x00-\x1f]/gu, " ").slice(0, 80)
    : text("Waiting for runtime", "Çalışma zamanı bekleniyor");
  const items: MenuItemConstructorOptions[] = [
    { label: `Equinox Local · ${label}`, enabled: false },
    { type: "separator" },
    { label: text("Open Control Center", "Kontrol Merkezi'ni aç"), click: showControlCenter },
    { label: companion?.isVisible() ? text("Hide Companion", "Companion'ı Gizle") : text("Show Companion", "Companion'ı Göster"),
      enabled: Boolean(companion) && !quitting,
      click: () => { companion?.setVisible(!companion.isVisible()); } },
    { label: paused ? text("Resume agent", "Ajanı sürdür") : text("Emergency Stop", "Acil durdur"),
      enabled: connected && !mutationPending,
      click: () => { void runMutation(paused ? "/api/v1/agent/resume" : "/api/v1/agent/pause"); } },
    { label: text("Open Agent Browser", "Ajan Tarayıcısını aç"), enabled: connected && !mutationPending,
      click: () => { void runMutation("/api/v1/browser/agent/open"); } },
    { label: text("Restart runtime", "Çalışma zamanını yeniden başlat"),
      enabled: !lifecycleBusy && !systemOperationBusy && !mutationPending && (connected || Boolean(initializationComplete && runtimeOwner && !controlLost)),
      click: () => { if (connected) void runMutation("/api/v1/runtime/restart"); else void runOwnerAction("restart"); } },
    ...(!development ? [
      { label: text("Start runtime", "Çalışma zamanını başlat"), enabled: Boolean(initializationComplete && runtimeOwner && !controlLost) && !lifecycleBusy && !systemOperationBusy && runtimeState !== "running",
        click: () => { void runOwnerAction("start"); } },
      { label: text("Stop runtime", "Çalışma zamanını durdur"), enabled: Boolean(initializationComplete && runtimeOwner) && !lifecycleBusy && !systemOperationBusy,
        click: () => { void runOwnerAction("stop"); } },
      { label: text("Start at login", "Oturum açılışında başlat"), type: "checkbox" as const, checked: loginEnabled,
        enabled: initializationComplete && loginAvailable && !lifecycleBusy && !systemOperationBusy && !controlLost,
        click: () => { void changeLoginPreference(!loginEnabled).catch(() => reportLifecycleFailure()); } },
    ] : []),
    { type: "separator" },
    { label: development ? text("Close development shell", "Geliştirme kabuğunu kapat") : text("Quit Equinox Local", "Equinox Local'dan çık"),
      click: () => app.quit() },
  ];
  tray?.setContextMenu(Menu.buildFromTemplate(items));
  tray?.setToolTip(`Equinox Local · ${label}`.slice(0, 127));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Equinox Local", submenu: items },
    { role: "editMenu" },
    { label: text("View", "Görünüm"), submenu: [
      { role: "reload" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" },
    ] },
    { role: "windowMenu" },
  ]));
}

async function refresh(): Promise<void> {
  if (quitting) return;
  if (!development && (runtimeState !== "running" || controlLost)) {
    connected = false; status = null; updateMenus(); return;
  }
  if (refreshInFlight) { refreshRequested = true; return; }
  refreshInFlight = true;
  if (timer) { clearTimeout(timer); timer = null; }
  try {
    const payload = await readControlJson("/api/v1/status");
    if (!development && (runtimeState !== "running" || controlLost)) return;
    if (payload.ok !== true || !payload.status || typeof payload.status !== "object") throw new Error("Invalid runtime status.");
    status = payload.status;
    connected = true;
    observeNativeNotification(status?.presentation?.notification);
    if (window && !window.isDestroyed() && !navigating
      && (rendererFailed || !isControlDocument(window.webContents.getURL()))
      && rendererRecoveryAttempts < 3) {
      navigating = true;
      if (rendererFailed) rendererRecoveryAttempts += 1;
      try {
        await window.loadURL(`${CONTROL_ORIGIN}/`);
        rendererFailed = false;
      } catch {
        rendererFailed = true;
      } finally { navigating = false; }
    }
  } catch {
    connected = false;
    status = null;
  } finally {
    refreshInFlight = false;
    updateMenus();
    const delay = refreshRequested ? 0 : connected ? 8_000 : 3_000;
    refreshRequested = false;
    if (!quitting) timer = setTimeout(() => { void refresh(); }, delay);
  }
}

function createWindow(): void {
  const privateSession = session.fromPartition(development ? "persist:equinox-development" : "persist:equinox-control-center");
  privateSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  privateSession.setPermissionCheckHandler(() => false);
  privateSession.on("will-download", (event) => event.preventDefault());
  // The UI only needs its existing backend. External links are opened by the OS, never loaded here.
  privateSession.webRequest.onBeforeRequest((details, reply) => {
    try {
      const url = new URL(details.url);
      reply({ cancel: url.origin !== CONTROL_ORIGIN });
    } catch { reply({ cancel: true }); }
  });
  window = new BrowserWindow({
    title: "Equinox Local", width: 1180, height: 760, minWidth: 920, minHeight: 620,
    show: false, backgroundColor: "#19191d",
    icon: path.join(root, "app", "EquinoxLocal.png"),
    webPreferences: {
      preload: path.join(directory, "preload.cjs"),
      session: privateSession, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webviewTag: false, webSecurity: true, allowRunningInsecureContent: false,
      spellcheck: false, devTools: development,
    },
  });
  // Session is supplied explicitly; no external page or subframe may become a privileged host.
  const contents = window.webContents;
  contents.setWindowOpenHandler(({ url }) => {
    void openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isControlDocument(url)) return;
    event.preventDefault();
    void openExternal(url).catch(() => {});
  });
  contents.on("will-redirect", (event, url) => { if (!isControlDocument(url)) event.preventDefault(); });
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame || !isControlDocument(event.url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("did-finish-load", () => {
    if (!isControlDocument(contents.getURL())) return;
    window?.setTitle("Equinox Local");
    if (revealOnFirstLoad) {
      revealOnFirstLoad = false;
      if (development) window?.showInactive();
      else window?.show();
    }
  });
  contents.on("page-title-updated", (event) => { event.preventDefault(); window?.setTitle("Equinox Local"); });
  contents.on("render-process-gone", () => {
    rendererFailed = true;
    updateMenus();
    void refresh();
  });
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    revealOnFirstLoad = false;
    window?.hide();
  });
  window.on("closed", () => { window = null; });
  const trayImage = process.platform === "darwin"
    ? nativeImage.createFromPath(path.join(root, "app", "EquinoxLocalMenuBar.png")).resize({ width: 18, height: 18 })
    : nativeImage.createFromPath(path.join(root, "app", "EquinoxLocal.png")).resize({ width: 32, height: 32 });
  if (process.platform === "darwin") trayImage.setTemplateImage(true);
  tray = new Tray(trayImage);
  tray.on("double-click", showControlCenter);
  updateMenus();
}

ipcMain.handle("equinox-shell:pick-folder", async (event) => {
  if (!trustedSender(event)) throw new Error("Untrusted folder picker request.");
  if (pickerPending || quitting || !window) throw new Error("Folder picker is unavailable.");
  pickerPending = true;
  try {
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    if (!trustedSender(event)) throw new Error("Folder picker document changed.");
    if (result.canceled || result.filePaths.length !== 1) return { cancelled: true, path: null };
    const selected = await fs.promises.realpath(result.filePaths[0]!);
    const stat = await fs.promises.stat(selected);
    if (!stat.isDirectory() || selected === path.parse(selected).root) throw new Error("Choose a folder, not a filesystem root.");
    return { cancelled: false, path: selected };
  } finally { pickerPending = false; }
});
ipcMain.handle("equinox-shell:language", (event, value: unknown) => {
  if (!trustedSender(event) || (value !== "en" && value !== "tr")) return;
  language = value;
  shellPreferences?.write({ language: value });
  updateMenus();
});
// Finite readonly preference adapter; no file path or configuration crosses the bridge.
ipcMain.on("equinox-shell:language-snapshot", (event) => {
  event.returnValue = trustedSender(event) ? (language === "tr" ? "tr" : "en") : null;
});

if (process.versions.electron !== PINNED_ELECTRON || !process.versions.node.startsWith("26.")) {
  throw new Error("Equinox Local requires the pinned Electron 46 alpha.5 with Node 26.");
}
if (installerProfile) {
  // Finite installer-only maintenance. No single-instance handoff, UI, socket,
  // backend or owner is initialized. The caller waits for real process exit.
  const mode = installerMode;
  {
    const deadline = setTimeout(() => app.exit(1), 15_000);
    void app.whenReady().then(async () => {
      await resolveInstalledRuntime(installedIdentity!, process.resourcesPath);
      if (mode === "cleanup" || mode === "disabled" || mode === "enabled") app.setLoginItemSettings({ openAtLogin: mode === "enabled" });
      const settings = app.getLoginItemSettings();
      // Disabled-by-user/approval-pending registrations are not successful writes.
      if ((mode === "cleanup" || mode === "disabled") && (settings.openAtLogin || settings.status !== "not-registered")) {
        throw new Error("Installer login unregister readback failed.");
      }
      const enabled = settings.openAtLogin && settings.status === "enabled";
      if (mode === "enabled" && !enabled)throw new Error("Installer login registration needs operating-system approval or could not be confirmed.");
      process.stdout.write(JSON.stringify({ mode, enabled }) + "\n", () => {
        clearTimeout(deadline); app.exit(0);
      });
    }).catch(() => { clearTimeout(deadline); app.exit(1); });
  }
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (initializationComplete) {
      importLegacyShellPreferences();
      // The finite installer helper may just have applied startup intent.
      void readLoginPreference().then(updateMenus).catch(() => { loginAvailable = false; updateMenus(); });
    }
    if (argv.includes("--uninstall")) {
      if (systemOperationBusy || quitting || controlLost) return;
      uninstallRequested = true;
      if (initializationComplete) { uninstallRequested = false; void confirmUninstall(); }
    } else if (!argv.includes("--startup")) showControlCenter();
  });
  app.on("activate", () => {
    if (initializationComplete) {
      importLegacyShellPreferences();
      void readLoginPreference().then(updateMenus).catch(() => { loginAvailable = false; updateMenus(); });
    }
    showControlCenter();
  });
  app.on("before-quit", (event) => {
    if (development || allowQuit) {
      quitting = true;
      cleanupPresentation();
      return; // Development closes only its own shell, never the user's Factory.
    }
    event.preventDefault();
    beginQuit();
  });
  app.on("window-all-closed", () => { /* Resident until explicit Quit on both operating systems. */ });
  void app.whenReady().then(async () => {
    language = app.getLocale().toLowerCase().startsWith("tr") ? "tr" : "en";
    shellPreferences = openShellPreferences(path.join(app.getPath("userData"), "private-shell"));
    language = shellPreferences.read().language ?? language;
    if (process.platform === "win32") app.setAppUserModelId(development ? "dev.equinox.local.development" : "dev.equinox.local");
    if (!development && process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin) {
      backgroundLaunch = true; revealOnFirstLoad = false;
    }
    createWindow();
    process.stdout.write(`[Equinox Local shell] Electron ${process.versions.electron}; Node ${process.versions.node}; source=${development}\n`);
    try {
      await initializeOwner();
      if (controlLost || quitting) throw new Error("Application lifecycle ownership was lost before companion initialization.");
      importLegacyShellPreferences();
      // Admitted installed roles default on; attach-only development never auto-shows a second resident pet.
      // Maintenance never reaches this branch. Optional local UI failures do not prevent owner startup.
      try {
        companion = createCompanionController({ directory, preferences: shellPreferences!,
          language: language === "tr" ? "tr" : "en", autoShow: !development,
          openControlCenter: showControlCenter, onVisibilityChanged: updateMenus });
      } catch { companion = null; }
      if (uninstallRequested) { uninstallRequested = false; await confirmUninstall(); }
      if (controlLost || quitting) throw new Error("Application lifecycle ownership was lost before backend startup.");
      lifecycleBusy = true;
      initializationComplete = true;
      try { await runtimeOwner?.start(); } finally { lifecycleBusy = false; drainRestart(); }
      if (controlLost || quitting) throw new Error("Application lifecycle ownership was lost during backend startup.");
      updateMenus();
      drainRestart();
      void refresh();
    } catch {
      runtimeState = "attention";
      updateMenus();
      if (!quitting && !backgroundLaunch) await reportLifecycleFailure();
    }
  }).catch(() => {
    process.stderr.write("Equinox Local shell could not start.\n");
    app.exit(1);
  });
}
