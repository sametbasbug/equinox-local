import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const EQUINOX_AGENT_BROWSER_CONTEXT = "agent";
export const EQUINOX_BROWSER_STORE_URL = "https://chromewebstore.google.com/detail/equinox-browser/npdneefcobilfkjlihghjgjnknenhfoj";

const DARWIN_OPEN_BINARY = "/usr/bin/open";
const DARWIN_PS_BINARY = "/bin/ps";
const DARWIN_CHROME_MAIN_PROCESS_FRAGMENT = "/Google Chrome.app/Contents/MacOS/Google Chrome ";
const WINDOWS_POWERSHELL_BINARY = "powershell.exe";
const WINDOWS_TASKKILL_BINARY = "taskkill.exe";
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const CHROME_APP_NAME = "Google Chrome";
const NATIVE_HOST_NAME = "dev.equinox.browser";
const PRODUCTION_EXTENSION_ORIGIN = "chrome-extension://npdneefcobilfkjlihghjgjnknenhfoj/";
const READY_MARKER = ".equinox-agent-browser-ready";
const DEFAULT_READY_TIMEOUT_MS = 8_000;
const WINDOWS_CHROME_PROCESS_QUERY = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
const WINDOWS_CHROME_LAUNCH_SCRIPT = "$profileArg = '--user-data-dir=\"' + $env:EQUINOX_AGENT_PROFILE + '\"'; Start-Process -FilePath $env:EQUINOX_AGENT_CHROME -ArgumentList @($profileArg,'--no-first-run','--no-default-browser-check',$env:EQUINOX_AGENT_URL) | Out-Null";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function supportedPlatform(platform) {
  return platform === "darwin" || platform === "win32";
}

function pathApiFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function requireAbsoluteForPlatform(value, platform, label) {
  const pathApi = pathApiFor(platform);
  if (typeof value !== "string" || !pathApi.isAbsolute(value)) throw new Error(`${label} geçersiz.`);
  return pathApi.normalize(value);
}

function defaultAgentBrowserRoot(homeDir) {
  if (typeof homeDir !== "string" || !path.posix.isAbsolute(homeDir)) {
    throw new Error("Agent Browser için geçerli bir home dizini gerekli.");
  }
  return path.posix.join(homeDir, "Library", "Application Support", "Equinox Local", "Agent Browser");
}

async function ensurePrivateDirectory(directory, { platform = process.platform } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Agent Browser profil kökü güvenli bir klasör değil.");
  }
  if (platform === "darwin") await fs.chmod(directory, 0o700);
}

function agentNativeMessagingPaths(homeDir, profileRoot) {
  const applicationSupport = path.join(homeDir, "Library", "Application Support");
  const manifestRoot = path.join(profileRoot, "NativeMessagingHosts");
  return Object.freeze({
    hostWrapperPath: path.join(applicationSupport, "Equinox Local", "equinox-browser-native-host"),
    manifestRoot,
    manifestPath: path.join(manifestRoot, `${NATIVE_HOST_NAME}.json`),
  });
}

function agentNativeMessagingManifest(hostWrapperPath) {
  return `${JSON.stringify({
    name: NATIVE_HOST_NAME,
    description: "Equinox Browser native messaging bridge",
    path: hostWrapperPath,
    type: "stdio",
    allowed_origins: [PRODUCTION_EXTENSION_ORIGIN],
  }, null, 2)}\n`;
}

async function assertSafeNativeHostWrapper(hostWrapperPath) {
  const stat = await fs.lstat(hostWrapperPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Equinox Browser Native Messaging host kurulumu eksik veya güvenli değil.");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (Number.isInteger(uid) && stat.uid !== uid) {
    throw new Error("Equinox Browser Native Messaging host sahipliği geçersiz.");
  }
  if ((stat.mode & 0o022) !== 0 || (stat.mode & 0o100) === 0) {
    throw new Error("Equinox Browser Native Messaging host izinleri güvenli değil.");
  }
}

async function atomicWritePrivateManifest(manifestPath, content) {
  const parent = path.dirname(manifestPath);
  const temporary = path.join(parent, `.${NATIVE_HOST_NAME}-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, manifestPath);
    await fs.chmod(manifestPath, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function ensureAgentBrowserNativeMessagingManifest({ homeDir, profileRoot } = {}) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) {
    throw new Error("Agent Browser Native Messaging kurulumu için geçerli HOME gerekli.");
  }
  if (typeof profileRoot !== "string" || !path.isAbsolute(profileRoot)) {
    throw new Error("Agent Browser Native Messaging kurulumu için geçerli profil kökü gerekli.");
  }
  await ensurePrivateDirectory(profileRoot, { platform: "darwin" });
  const paths = agentNativeMessagingPaths(homeDir, profileRoot);
  await assertSafeNativeHostWrapper(paths.hostWrapperPath);
  await ensurePrivateDirectory(paths.manifestRoot, { platform: "darwin" });
  await atomicWritePrivateManifest(paths.manifestPath, agentNativeMessagingManifest(paths.hostWrapperPath));
  return Object.freeze({ manifestPath: paths.manifestPath, hostWrapperPath: paths.hostWrapperPath });
}

async function hasReadyMarker(profileRoot) {
  const marker = path.join(profileRoot, READY_MARKER);
  const stat = await fs.lstat(marker).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Agent Browser hazır işareti güvenli bir normal dosya değil.");
  return true;
}

async function writeReadyMarker(profileRoot, { platform = process.platform } = {}) {
  const marker = path.join(profileRoot, READY_MARKER);
  const temporary = path.join(profileRoot, `${READY_MARKER}.tmp`);
  await fs.rm(temporary, { force: true }).catch(() => {});
  try {
    await fs.writeFile(temporary, "ready\n", { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, marker);
    if (platform === "darwin") await fs.chmod(marker, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function buildAgentBrowserLaunchArgs(profileRoot, { setup = false } = {}) {
  if (typeof profileRoot !== "string" || !path.isAbsolute(profileRoot)) throw new Error("Agent Browser profil kökü geçersiz.");
  return [
    "-na", CHROME_APP_NAME, "--args", `--user-data-dir=${profileRoot}`,
    "--no-first-run", "--no-default-browser-check", setup ? EQUINOX_BROWSER_STORE_URL : "about:blank",
  ];
}

export function buildWindowsAgentBrowserLaunchArgs(profileRoot, { setup = false } = {}) {
  const normalized = requireAbsoluteForPlatform(profileRoot, "win32", "Agent Browser profil kökü");
  return [
    `--user-data-dir=${normalized}`,
    "--no-first-run",
    "--no-default-browser-check",
    setup ? EQUINOX_BROWSER_STORE_URL : "about:blank",
  ];
}

export function windowsChromeInstallCandidates(env = process.env) {
  const roots = [env?.LOCALAPPDATA, env?.ProgramFiles, env?.["ProgramFiles(x86)"]];
  const seen = new Set();
  const candidates = [];
  for (const root of roots) {
    if (typeof root !== "string" || !path.win32.isAbsolute(root)) continue;
    const candidate = path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe");
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
  }
  return Object.freeze(candidates);
}

export async function discoverWindowsChrome({ env = process.env, fsImpl = fs } = {}) {
  for (const candidate of windowsChromeInstallCandidates(env)) {
    const stat = await fsImpl.lstat(candidate).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (stat?.isFile?.() && !stat.isSymbolicLink?.()) return candidate;
  }
  throw new Error("Google Chrome güvenilir Windows kurulum yollarında bulunamadı.");
}

export function parseAgentBrowserMainPids(psOutput, profileRoot) {
  if (typeof profileRoot !== "string" || !path.isAbsolute(profileRoot)) throw new Error("Agent Browser profil kökü geçersiz.");
  const profileFlag = `--user-data-dir=${profileRoot}`;
  return String(psOutput || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    .filter((line) => line.includes(profileFlag))
    .filter((line) => line.includes(DARWIN_CHROME_MAIN_PROCESS_FRAGMENT))
    .filter((line) => !line.includes("/Helpers/"))
    .map((line) => Number.parseInt(line.match(/^(\d+)\s+/u)?.[1] || "", 10))
    .filter((pid) => Number.isInteger(pid) && pid > 1);
}

export function parseWindowsAgentBrowserMainPids(jsonOutput, profileRoot, chromePath) {
  const normalizedProfile = requireAbsoluteForPlatform(profileRoot, "win32", "Agent Browser profil kökü").toLowerCase();
  const normalizedChrome = requireAbsoluteForPlatform(chromePath, "win32", "Chrome executable").toLowerCase();
  if (!String(jsonOutput || "").trim()) return [];
  let decoded;
  try { decoded = JSON.parse(String(jsonOutput)); } catch { throw new Error("Windows Chrome process inventory JSON is invalid."); }
  const rows = Array.isArray(decoded) ? decoded : [decoded];
  const profileFlag = `--user-data-dir=${normalizedProfile}`;
  return rows.filter((row) => row && typeof row === "object")
    .filter((row) => typeof row.ExecutablePath === "string" && path.win32.normalize(row.ExecutablePath).toLowerCase() === normalizedChrome)
    .filter((row) => {
      const command = String(row.CommandLine || "").replaceAll('"', "").toLowerCase();
      return command.includes(profileFlag) && !/(?:^|\s)--type=/u.test(command);
    })
    .map((row) => Number(row.ProcessId))
    .filter((pid) => Number.isInteger(pid) && pid > 1);
}

export function createEquinoxAgentBrowser({
  bridge,
  homeDir = process.env.HOME,
  profileRoot = null,
  platform = process.platform,
  env = process.env,
  execFileAsync,
  signalProcess = process.kill.bind(process),
  recordEvent = () => {},
} = {}) {
  if (!bridge?.readyFor || !bridge?.waitUntilReady || !bridge?.expectContext || !bridge?.cancelExpectedContext) {
    throw new Error("Agent Browser için context-aware Equinox Browser bridge gerekli.");
  }
  if (typeof execFileAsync !== "function") throw new Error("Agent Browser için execFileAsync gerekli.");
  if (typeof signalProcess !== "function") throw new Error("Agent Browser için signalProcess gerekli.");
  if (typeof recordEvent !== "function") throw new Error("Agent Browser recordEvent fonksiyonu geçersiz.");

  const resolvedProfileRoot = profileRoot == null
    ? defaultAgentBrowserRoot(homeDir)
    : requireAbsoluteForPlatform(profileRoot, platform, "Agent Browser profil kökü");
  let lastLaunchAt = null;
  let lastLaunchSetup = null;
  let lastLaunchError = null;
  let setupComplete = null;
  let lastChromePath = null;

  function emit(type, data = {}) {
    try {
      const result = recordEvent({ component: "agent-browser", type, at: new Date().toISOString(), ...data });
      if (result && typeof result.catch === "function") void result.catch(() => {});
    } catch {}
  }

  async function resolveWindowsChrome() {
    const chromePath = await discoverWindowsChrome({ env });
    lastChromePath = chromePath;
    return chromePath;
  }

  async function launch({ setup = false } = {}) {
    if (!supportedPlatform(platform)) throw new Error("Agent Browser bu platformda desteklenmiyor.");
    await ensurePrivateDirectory(resolvedProfileRoot, { platform });
    if (platform === "darwin") await ensureAgentBrowserNativeMessagingManifest({ homeDir, profileRoot: resolvedProfileRoot });
    bridge.expectContext(EQUINOX_AGENT_BROWSER_CONTEXT);
    setupComplete = await hasReadyMarker(resolvedProfileRoot);
    const shouldSetup = Boolean(setup || !setupComplete);
    try {
      if (platform === "darwin") {
        await execFileAsync(DARWIN_OPEN_BINARY, buildAgentBrowserLaunchArgs(resolvedProfileRoot, { setup: shouldSetup }), {
          timeout: 10_000, maxBuffer: 64 * 1024,
          env: { HOME: homeDir, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        });
      } else {
        const chromePath = await resolveWindowsChrome();
        const chromeArgs = buildWindowsAgentBrowserLaunchArgs(resolvedProfileRoot, { setup: shouldSetup });
        await execFileAsync(WINDOWS_POWERSHELL_BINARY, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CHROME_LAUNCH_SCRIPT], {
          timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true,
          env: {
            ...env,
            EQUINOX_AGENT_CHROME: chromePath,
            EQUINOX_AGENT_PROFILE: resolvedProfileRoot,
            EQUINOX_AGENT_URL: chromeArgs.at(-1),
          },
        });
      }
      lastLaunchAt = new Date().toISOString();
      lastLaunchSetup = shouldSetup;
      lastLaunchError = null;
      emit("launch_requested", { setup: shouldSetup, platform });
      return snapshot();
    } catch (error) {
      bridge.cancelExpectedContext();
      lastLaunchError = errorMessage(error).slice(0, 500);
      emit("launch_failed", { message: lastLaunchError, platform });
      throw new Error(`Agent Browser başlatılamadı: ${lastLaunchError}`);
    }
  }

  async function listMainProcessPids() {
    if (platform === "darwin") {
      const { stdout = "" } = await execFileAsync(DARWIN_PS_BINARY, ["-axo", "pid=,command="], {
        timeout: 5_000, maxBuffer: 512 * 1024,
        env: { HOME: homeDir, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      });
      return parseAgentBrowserMainPids(stdout, resolvedProfileRoot);
    }
    const chromePath = lastChromePath ?? await resolveWindowsChrome();
    const { stdout = "" } = await execFileAsync(WINDOWS_POWERSHELL_BINARY, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CHROME_PROCESS_QUERY], {
      timeout: 5_000, maxBuffer: 512 * 1024, windowsHide: true, env,
    });
    return parseWindowsAgentBrowserMainPids(stdout, resolvedProfileRoot, chromePath);
  }

  function processAlive(pid) {
    try { signalProcess(pid, 0); return true; }
    catch (error) { if (error?.code === "ESRCH") return false; throw error; }
  }

  async function shutdown({ timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS } = {}) {
    if (!supportedPlatform(platform)) throw new Error("Agent Browser bu platformda desteklenmiyor.");
    const boundedTimeout = Math.min(15_000, Math.max(500, Number(timeoutMs) || DEFAULT_SHUTDOWN_TIMEOUT_MS));
    bridge.cancelExpectedContext();
    const pids = await listMainProcessPids();
    if (pids.length === 0) {
      if (bridge.readyFor(EQUINOX_AGENT_BROWSER_CONTEXT)) {
        throw new Error("Agent Browser bridge bağlı görünüyor ancak exact Agent Browser ana process'i bulunamadı; güvenli kapanış reddedildi.");
      }
      emit("shutdown_noop", {});
      return { ...snapshot(), stopped: true, alreadyStopped: true, processId: null };
    }
    if (pids.length !== 1) throw new Error("Agent Browser ana process eşleşmesi belirsiz; güvenli kapanış reddedildi.");
    const [pid] = pids;
    let forced = false;
    if (platform === "darwin") {
      signalProcess(pid, "SIGTERM");
    } else {
      const options = { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true, env };
      try {
        await execFileAsync(WINDOWS_TASKKILL_BINARY, ["/PID", String(pid), "/T"], options);
      } catch (error) {
        if (!processAlive(pid)) {
          emit("shutdown_graceful_race", { platform });
        } else {
          forced = true;
          emit("shutdown_force_fallback", { platform });
          await execFileAsync(WINDOWS_TASKKILL_BINARY, ["/PID", String(pid), "/T", "/F"], options);
        }
      }
    }
    emit("shutdown_requested", { platform, forced });
    const deadline = Date.now() + boundedTimeout;
    while (Date.now() < deadline) {
      if (!processAlive(pid) && !bridge.readyFor(EQUINOX_AGENT_BROWSER_CONTEXT)) {
        emit("shutdown_complete", { platform });
        return { ...snapshot(), stopped: true, alreadyStopped: false, processId: pid };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Agent Browser güvenli kapanış süresinde tamamen durmadı.");
  }

  async function ensureReady({ timeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
    if (bridge.readyFor(EQUINOX_AGENT_BROWSER_CONTEXT)) {
      await ensurePrivateDirectory(resolvedProfileRoot, { platform });
      await writeReadyMarker(resolvedProfileRoot, { platform });
      setupComplete = true;
      return bridge.snapshotContext(EQUINOX_AGENT_BROWSER_CONTEXT);
    }
    await launch({ setup: false });
    try {
      const ready = await bridge.waitUntilReady(timeoutMs, { context: EQUINOX_AGENT_BROWSER_CONTEXT });
      bridge.cancelExpectedContext();
      await writeReadyMarker(resolvedProfileRoot, { platform });
      setupComplete = true;
      emit("ready", { extensionVersion: ready.extension?.extensionVersion ?? null });
      return ready;
    } catch (error) {
      const pairing = bridge.snapshot().pairing;
      const detail = pairing
        ? "Agent Browser açıldı ancak Equinox Browser uzantısı bu izole profile henüz bağlanmadı. Açılan Chrome Web Store sekmesinden uzantıyı kurup izin ekranını tamamlayın."
        : "Agent Browser açıldı ancak Equinox Browser bağlantısı hazır olmadı.";
      throw new Error(`${detail} (${errorMessage(error)})`);
    }
  }

  async function status() {
    setupComplete = supportedPlatform(platform) ? await hasReadyMarker(resolvedProfileRoot) : false;
    return snapshot();
  }

  function snapshot() {
    const browser = bridge.snapshotContext(EQUINOX_AGENT_BROWSER_CONTEXT);
    return {
      supported: supportedPlatform(platform),
      context: EQUINOX_AGENT_BROWSER_CONTEXT,
      isolated: true,
      ready: Boolean(browser.ready),
      extensionVersion: browser.extension?.extensionVersion ?? null,
      connectedAt: browser.connectedAt ?? null,
      pairing: bridge.snapshot().pairing?.context === EQUINOX_AGENT_BROWSER_CONTEXT,
      setupComplete,
      lastLaunchAt,
      lastLaunchSetup,
      lastLaunchError,
      chromePath: lastChromePath,
      storeUrl: EQUINOX_BROWSER_STORE_URL,
    };
  }

  return Object.freeze({ launch, ensureReady, shutdown, status, snapshot });
}
