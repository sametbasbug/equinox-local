import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const EQUINOX_AGENT_BROWSER_CONTEXT = "agent";
export const EQUINOX_BROWSER_STORE_URL = "https://chromewebstore.google.com/detail/equinox-browser/npdneefcobilfkjlihghjgjnknenhfoj";

const OPEN_BINARY = "/usr/bin/open";
const CHROME_APP_NAME = "Google Chrome";
const NATIVE_HOST_NAME = "dev.equinox.browser";
const PRODUCTION_EXTENSION_ORIGIN = "chrome-extension://npdneefcobilfkjlihghjgjnknenhfoj/";
const READY_MARKER = ".equinox-agent-browser-ready";
const DEFAULT_READY_TIMEOUT_MS = 8_000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function agentBrowserRoot(homeDir) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) {
    throw new Error("Agent Browser için geçerli bir home dizini gerekli.");
  }
  return path.join(homeDir, "Library", "Application Support", "Equinox Local", "Agent Browser");
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Agent Browser profil kökü güvenli bir klasör değil.");
  }
  await fs.chmod(directory, 0o700);
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
  const existing = await fs.lstat(manifestPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("Agent Browser Native Messaging manifest yolu güvenli bir normal dosya değil.");
    }
    if (Number.isInteger(uid) && existing.uid !== uid) {
      throw new Error("Agent Browser Native Messaging manifest sahipliği geçersiz.");
    }
    const current = await fs.readFile(manifestPath, "utf8");
    if (current === content) {
      await fs.chmod(manifestPath, 0o600);
      return;
    }
  }

  const temporary = path.join(
    parent,
    `.${NATIVE_HOST_NAME}-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
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
  await ensurePrivateDirectory(profileRoot);
  const paths = agentNativeMessagingPaths(homeDir, profileRoot);
  await assertSafeNativeHostWrapper(paths.hostWrapperPath);
  await ensurePrivateDirectory(paths.manifestRoot);
  await atomicWritePrivateManifest(
    paths.manifestPath,
    agentNativeMessagingManifest(paths.hostWrapperPath),
  );
  return Object.freeze({
    manifestPath: paths.manifestPath,
    hostWrapperPath: paths.hostWrapperPath,
  });
}

async function hasReadyMarker(profileRoot) {
  const marker = path.join(profileRoot, READY_MARKER);
  const stat = await fs.lstat(marker).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Agent Browser hazır işareti güvenli bir normal dosya değil.");
  }
  return true;
}

async function writeReadyMarker(profileRoot) {
  const marker = path.join(profileRoot, READY_MARKER);
  const temporary = path.join(profileRoot, `${READY_MARKER}.tmp`);
  await fs.rm(temporary, { force: true }).catch(() => {});
  try {
    await fs.writeFile(temporary, "ready\n", { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, marker);
    await fs.chmod(marker, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export function buildAgentBrowserLaunchArgs(profileRoot, { setup = false } = {}) {
  if (typeof profileRoot !== "string" || !path.isAbsolute(profileRoot)) {
    throw new Error("Agent Browser profil kökü geçersiz.");
  }
  return [
    "-na",
    CHROME_APP_NAME,
    "--args",
    `--user-data-dir=${profileRoot}`,
    "--no-first-run",
    "--no-default-browser-check",
    setup ? EQUINOX_BROWSER_STORE_URL : "about:blank",
  ];
}

export function createEquinoxAgentBrowser({
  bridge,
  homeDir = process.env.HOME,
  platform = process.platform,
  execFileAsync,
  recordEvent = () => {},
} = {}) {
  if (!bridge?.readyFor || !bridge?.waitUntilReady || !bridge?.expectContext || !bridge?.cancelExpectedContext) {
    throw new Error("Agent Browser için context-aware Equinox Browser bridge gerekli.");
  }
  if (typeof execFileAsync !== "function") {
    throw new Error("Agent Browser için execFileAsync gerekli.");
  }
  if (typeof recordEvent !== "function") {
    throw new Error("Agent Browser recordEvent fonksiyonu geçersiz.");
  }

  const profileRoot = agentBrowserRoot(homeDir);
  let lastLaunchAt = null;
  let lastLaunchSetup = null;
  let lastLaunchError = null;

  function emit(type, data = {}) {
    try {
      const result = recordEvent({
        component: "agent-browser",
        type,
        at: new Date().toISOString(),
        ...data,
      });
      if (result && typeof result.catch === "function") void result.catch(() => {});
    } catch {
      // Observability must never block browser startup.
    }
  }

  async function launch({ setup = false } = {}) {
    if (platform !== "darwin") {
      throw new Error("Agent Browser şu anda yalnız macOS üzerinde destekleniyor.");
    }
    await ensurePrivateDirectory(profileRoot);
    await ensureAgentBrowserNativeMessagingManifest({ homeDir, profileRoot });
    bridge.expectContext(EQUINOX_AGENT_BROWSER_CONTEXT);
    const shouldSetup = Boolean(setup || !(await hasReadyMarker(profileRoot)));
    try {
      await execFileAsync(OPEN_BINARY, buildAgentBrowserLaunchArgs(profileRoot, { setup: shouldSetup }), {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        env: {
          HOME: homeDir,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        },
      });
      lastLaunchAt = new Date().toISOString();
      lastLaunchSetup = shouldSetup;
      lastLaunchError = null;
      emit("launch_requested", { setup: shouldSetup });
      return snapshot();
    } catch (error) {
      bridge.cancelExpectedContext();
      lastLaunchError = errorMessage(error).slice(0, 500);
      emit("launch_failed", { message: lastLaunchError });
      throw new Error(`Agent Browser başlatılamadı: ${lastLaunchError}`);
    }
  }

  async function ensureReady({ timeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
    if (bridge.readyFor(EQUINOX_AGENT_BROWSER_CONTEXT)) {
      await ensurePrivateDirectory(profileRoot);
      await writeReadyMarker(profileRoot);
      return bridge.snapshotContext(EQUINOX_AGENT_BROWSER_CONTEXT);
    }

    await launch({ setup: false });
    try {
      const ready = await bridge.waitUntilReady(timeoutMs, { context: EQUINOX_AGENT_BROWSER_CONTEXT });
      bridge.cancelExpectedContext();
      await writeReadyMarker(profileRoot);
      emit("ready", {
        extensionVersion: ready.extension?.extensionVersion ?? null,
      });
      return ready;
    } catch (error) {
      const pairing = bridge.snapshot().pairing;
      const detail = pairing
        ? "Agent Browser açıldı ancak Equinox Browser uzantısı bu izole profile henüz bağlanmadı. Açılan Chrome Web Store sekmesinden uzantıyı kurup izin ekranını tamamlayın."
        : "Agent Browser açıldı ancak Equinox Browser bağlantısı hazır olmadı.";
      throw new Error(`${detail} (${errorMessage(error)})`);
    }
  }

  function snapshot() {
    const browser = bridge.snapshotContext(EQUINOX_AGENT_BROWSER_CONTEXT);
    return {
      supported: platform === "darwin",
      context: EQUINOX_AGENT_BROWSER_CONTEXT,
      isolated: true,
      ready: Boolean(browser.ready),
      extensionVersion: browser.extension?.extensionVersion ?? null,
      connectedAt: browser.connectedAt ?? null,
      pairing: bridge.snapshot().pairing?.context === EQUINOX_AGENT_BROWSER_CONTEXT,
      lastLaunchAt,
      lastLaunchSetup,
      lastLaunchError,
      storeUrl: EQUINOX_BROWSER_STORE_URL,
    };
  }

  return Object.freeze({
    launch,
    ensureReady,
    snapshot,
  });
}
