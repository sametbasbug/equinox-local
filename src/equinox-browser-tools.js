import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { PNG } from "pngjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SCREENSHOT_PNG_BYTES = 32 * 1024 * 1024;
const SCREENSHOT_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/u;
const SCREENSHOT_CAPTURE_ID_PATTERN = /^capture-\d{13}-[0-9a-f-]{36}$/u;
const SCREENSHOT_RETENTION_MS = 60 * 60 * 1000;
const SCREENSHOT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const SCREENSHOT_MAX_CAPTURE_DIRS = 24;
const SCREENSHOT_MAX_TREE_ENTRIES = 100;
const MAX_BROWSER_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const SAFE_DOWNLOAD_DANGERS = new Set(["safe", "deep_scanned_safe"]);

function validateScreenshotName(value, label) {
  if (typeof value !== "string" || !SCREENSHOT_NAME_PATTERN.test(value)) {
    throw new Error(`${label} küçük harf, sayı, nokta, alt çizgi veya tire içermeli ve 1-80 karakter olmalı.`);
  }
  return value;
}

function decodeScreenshotPng(data) {
  const encoded = String(data || "");
  if (!encoded) throw new Error("Equinox Browser boş screenshot verisi döndürdü.");
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0 || buffer.length > MAX_SCREENSHOT_PNG_BYTES) {
    throw new Error(`Screenshot PNG ${MAX_SCREENSHOT_PNG_BYTES / 1024 / 1024} MB güvenlik sınırını aşıyor.`);
  }
  if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Equinox Browser screenshot çıktısı geçerli PNG imzası taşımıyor.");
  }
  let png;
  try {
    png = PNG.sync.read(buffer, { checkCRC: true, skipRescale: false });
  } catch (error) {
    throw new Error(`Equinox Browser screenshot PNG çıktısı çözümlenemedi: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { buffer, png };
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function writeScreenshotAtomic({ absolutePath, buffer }) {
  const parent = path.dirname(absolutePath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(parent, `.${path.basename(absolutePath)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, buffer, { flag: "wx", mode: 0o600 });
    await fs.link(temporaryPath, absolutePath);
    await fs.unlink(temporaryPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function inspectScreenshotCapture(root, captureDir) {
  if (!isInside(root, captureDir)) return { safe: false, reason: "outside-root" };
  const rootStat = await fs.lstat(captureDir).catch(() => null);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) return { safe: false, reason: "invalid-root" };
  const stack = [captureDir];
  let entriesSeen = 0;
  let bytes = 0;
  let mtimeMs = rootStat.mtimeMs;
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > SCREENSHOT_MAX_TREE_ENTRIES) return { safe: false, reason: "too-many-entries" };
      const absolute = path.join(current, entry.name);
      if (!isInside(root, absolute) || entry.isSymbolicLink?.()) return { safe: false, reason: "unsafe-entry" };
      const stat = await fs.lstat(absolute);
      mtimeMs = Math.max(mtimeMs, stat.mtimeMs);
      if (stat.isDirectory()) stack.push(absolute);
      else if (stat.isFile()) bytes += stat.size;
      else return { safe: false, reason: "unsupported-entry" };
    }
  }
  return { safe: true, bytes, mtimeMs };
}

async function pruneScreenshotStorage(screenshotRoot, nowMs = Date.now()) {
  await fs.mkdir(screenshotRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(screenshotRoot, 0o700).catch(() => {});
  const entries = await fs.readdir(screenshotRoot, { withFileTypes: true });
  const captures = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SCREENSHOT_CAPTURE_ID_PATTERN.test(entry.name)) continue;
    const absolute = path.join(screenshotRoot, entry.name);
    const inspected = await inspectScreenshotCapture(screenshotRoot, absolute);
    if (inspected.safe) captures.push({ id: entry.name, absolute, ...inspected });
  }

  const removed = [];
  const removeCapture = async (capture, reason) => {
    await fs.rm(capture.absolute, { recursive: true, force: true });
    removed.push({ id: capture.id, bytes: capture.bytes, reason });
  };

  const retained = [];
  for (const capture of captures) {
    if (nowMs - capture.mtimeMs >= SCREENSHOT_RETENTION_MS) await removeCapture(capture, "retention");
    else retained.push(capture);
  }
  retained.sort((a, b) => (a.mtimeMs - b.mtimeMs) || a.id.localeCompare(b.id));
  let totalBytes = retained.reduce((sum, item) => sum + item.bytes, 0);
  while (retained.length > SCREENSHOT_MAX_CAPTURE_DIRS || totalBytes > SCREENSHOT_MAX_TOTAL_BYTES) {
    const oldest = retained.shift();
    if (!oldest) break;
    await removeCapture(oldest, "quota");
    totalBytes -= oldest.bytes;
  }
  return {
    removedCaptures: removed.length,
    reclaimedBytes: removed.reduce((sum, item) => sum + item.bytes, 0),
    retainedCaptures: retained.length,
    retainedBytes: totalBytes,
  };
}

function screenshotTarget(screenshotRoot, { captureId, collection, name }) {
  const relativePath = path.join("browser-screenshots", captureId, collection, `${name}.png`);
  const absolutePath = path.join(screenshotRoot, captureId, collection, `${name}.png`);
  if (!isInside(screenshotRoot, absolutePath)) throw new Error("Screenshot hedefi runtime kökünün dışına çıkıyor.");
  return { relativePath, absolutePath };
}

function resolveScreenshotPath(screenshotRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() !== relativePath) {
    throw new Error("Screenshot yolu geçersiz.");
  }
  const normalized = relativePath.split("/");
  if (normalized.length !== 4 || normalized[0] !== "browser-screenshots") {
    throw new Error("Yalnız Equinox Browser runtime screenshot yolları silinebilir.");
  }
  const [, captureId, collection, filename] = normalized;
  if (!SCREENSHOT_CAPTURE_ID_PATTERN.test(captureId) || !SCREENSHOT_NAME_PATTERN.test(collection) || !filename.endsWith(".png")) {
    throw new Error("Screenshot runtime yolu beklenen biçimde değil.");
  }
  const name = filename.slice(0, -4);
  if (!SCREENSHOT_NAME_PATTERN.test(name)) throw new Error("Screenshot dosya adı beklenen biçimde değil.");
  const absolutePath = path.join(screenshotRoot, captureId, collection, filename);
  if (!isInside(screenshotRoot, absolutePath)) throw new Error("Screenshot yolu runtime kökünün dışına çıkıyor.");
  return { absolutePath, captureDir: path.join(screenshotRoot, captureId), collectionDir: path.join(screenshotRoot, captureId, collection) };
}

async function sha256File(absolutePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export async function inspectBrowserDownloadFile({
  downloadsRoot,
  absolutePath,
  expectedSize,
  maxBytes = MAX_BROWSER_DOWNLOAD_BYTES,
} = {}) {
  if (typeof downloadsRoot !== "string" || !path.isAbsolute(downloadsRoot)) {
    throw new Error("Downloads güvenli kökü geçersiz.");
  }
  if (typeof absolutePath !== "string" || !path.isAbsolute(absolutePath)) {
    throw new Error("Chrome download dosya yolu geçersiz.");
  }
  const rootPath = path.resolve(downloadsRoot);
  const candidate = path.resolve(absolutePath);
  if (!isInside(rootPath, candidate)) {
    throw new Error("Chrome download dosyası izinli Downloads kökünün dışında.");
  }
  const lstat = await fs.lstat(candidate);
  if (!lstat.isFile() || lstat.isSymbolicLink()) {
    throw new Error("Chrome download çıktısı normal ve symlink olmayan bir dosya olmalı.");
  }
  const rootRealPath = await fs.realpath(rootPath);
  const realCandidate = await fs.realpath(candidate);
  if (!isInside(rootRealPath, realCandidate)) {
    throw new Error("Chrome download dosyası sembolik bağlantı üzerinden Downloads kökünün dışına çıkıyor.");
  }
  const stat = await fs.stat(realCandidate);
  const limit = Math.max(1, Number(maxBytes) || MAX_BROWSER_DOWNLOAD_BYTES);
  if (stat.size > limit) {
    throw new Error(`Chrome download dosyası ${Math.floor(limit / 1024 / 1024)} MB güvenlik sınırını aşıyor.`);
  }
  if (Number.isFinite(expectedSize) && expectedSize >= 0 && stat.size !== expectedSize) {
    throw new Error("Chrome download tamamlanma boyutu ile diskteki dosya boyutu uyuşmuyor.");
  }
  return {
    absolutePath: realCandidate,
    name: path.basename(realCandidate),
    relativePath: path.relative(rootRealPath, realCandidate),
    bytes: stat.size,
    sha256: await sha256File(realCandidate),
  };
}

export async function registerEquinoxBrowserTools({
  registerTextTool,
  registerRawTool,
  z,
  fileRootSchema,
  resolveUploadFile,
  downloadsRoot,
  screenshotRoot,
  screenshotProjectId,
  bridge: rawBridge,
  isBrowserAccessEnabled = () => true,
  ensureAgentBrowserReady = null,
  getAgentBrowserStatus = null,
  withMutationLocks,
  textResult,
  errorResult,
} = {}) {
  if (
    typeof registerTextTool !== "function" ||
    typeof registerRawTool !== "function" ||
    !z || !fileRootSchema || !rawBridge ||
    typeof resolveUploadFile !== "function" ||
    typeof downloadsRoot !== "string" ||
    !path.isAbsolute(downloadsRoot) ||
    typeof screenshotRoot !== "string" ||
    !path.isAbsolute(screenshotRoot) ||
    typeof screenshotProjectId !== "string" ||
    !screenshotProjectId.trim() ||
    typeof isBrowserAccessEnabled !== "function" ||
    (ensureAgentBrowserReady !== null && typeof ensureAgentBrowserReady !== "function") ||
    (getAgentBrowserStatus !== null && typeof getAgentBrowserStatus !== "function") ||
    typeof withMutationLocks !== "function" ||
    typeof textResult !== "function" ||
    typeof errorResult !== "function"
  ) {
    throw new Error("Equinox Browser tool registration bağımlılıkları eksik.");
  }

  const assertBrowserAccess = () => {
    if (!isBrowserAccessEnabled()) {
      throw new Error("Browser automation access is disabled in Control Center.");
    }
  };
  const browserContextStorage = new AsyncLocalStorage();
  const browserTargetSchema = () => z.enum(["agent", "user"])
    .default("agent")
    .describe("Tarayıcı hedefi. Varsayılan agent: ajanın izole Agent Browser profili. user yalnız kullanıcının kişisel Chrome profilini özellikle kullanmak gerektiğinde seçilmelidir.");
  const browserLockKey = () => `browser:${browserContextStorage.getStore() ?? "agent"}`;
  const requireAgentBrowserContext = (operation = "Bu işlem") => {
    const context = browserContextStorage.getStore() ?? "agent";
    if (context !== "agent") {
      throw new Error(`${operation} yalnız Agent Browser'da kullanılabilir; Your Browser bookmark verileri ürün API'sinde bilinçli olarak kapalıdır.`);
    }
  };
  const baseWithMutationLocks = withMutationLocks;
  withMutationLocks = (locks, callback) => baseWithMutationLocks(
    locks.map((lock) => lock === "browser:user" ? browserLockKey() : lock).sort(),
    callback,
  );
  const nonTargetedTools = new Set([
    "equinox_browser_status",
    "equinox_browser_screenshot_delete",
  ]);
  const baseRegisterTextTool = registerTextTool;
  const baseRegisterRawTool = registerRawTool;
  const wrapBrowserRegistration = (register, name, definition, handler, options) => {
    if (nonTargetedTools.has(name)) return register(name, definition, handler, options);
    const inputSchema = {
      target: browserTargetSchema(),
      ...(definition.inputSchema ?? {}),
    };
    return register(
      name,
      { ...definition, inputSchema },
      async (args = {}, ...rest) => {
        const target = args?.target === "user" ? "user" : "agent";
        const { target: _target, ...forwarded } = args ?? {};
        return await browserContextStorage.run(target, async () => handler(forwarded, ...rest));
      },
      options,
    );
  };
  registerTextTool = (name, definition, handler, options) =>
    wrapBrowserRegistration(baseRegisterTextTool, name, definition, handler, options);
  registerRawTool = (name, definition, handler, options) =>
    wrapBrowserRegistration(baseRegisterRawTool, name, definition, handler, options);
  const bridge = new Proxy(rawBridge, {
    get(target, property, receiver) {
      if (property === "call") {
        return async (method, args = {}, options = {}) => {
          assertBrowserAccess();
          const context = browserContextStorage.getStore() ?? "agent";
          if (
            context === "agent" &&
            typeof ensureAgentBrowserReady === "function" &&
            typeof rawBridge.readyFor === "function" &&
            !rawBridge.readyFor("agent")
          ) {
            await ensureAgentBrowserReady();
          }
          return target.call(method, args, {
            ...options,
            context,
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const optionalTabId = () => z.number().int().positive().optional()
    .describe("İsteğe bağlı Chrome tab kimliği; verilmezse aktif sekme kullanılır");

  const jsonText = (value) => textResult(JSON.stringify(value ?? null, null, 2));
  const canonicalTabMetadata = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const { id, ...rest } = value;
    if (Number.isInteger(rest.tabId)) return rest;
    if (!Number.isInteger(id)) return value;
    return {
      tabId: id,
      ...rest,
    };
  };
  const boundedAfterSchema = () => z.object({
    wait_for: z.enum(["dom_stable", "network_idle"]).optional(),
    snapshot: z.enum(["delta", "full"]).optional(),
    quiet_ms: z.number().int().min(100).max(5_000).default(500),
    timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
  }).optional().describe("Tek bounded post-action wait ve/veya snapshot; macro değildir");
  const mapBoundedAfter = (after) => {
    if (!after) return null;
    const mapped = {
      ...(after.wait_for ? { waitFor: after.wait_for } : {}),
      ...(after.snapshot ? { snapshot: after.snapshot } : {}),
      quietMs: after.quiet_ms ?? 500,
      timeoutMs: after.timeout_ms ?? 10_000,
    };
    if (!mapped.waitFor && !mapped.snapshot) {
      throw new Error("after alanında wait_for ve/veya snapshot verilmelidir.");
    }
    return mapped;
  };
  const requireFeatureVersion = (result, field, minimum, message) => {
    const version = Number(result?.[field]);
    if (!Number.isFinite(version) || version < minimum) throw new Error(message);
    return version;
  };
  const requireCapabilityVersion = async (field, minimum, message) => {
    const context = browserContextStorage.getStore() ?? "agent";
    const snapshot = typeof rawBridge.snapshot === "function" ? rawBridge.snapshot() : null;
    const extension = snapshot?.contexts?.[context]?.extension
      ?? (context === "user" ? snapshot?.extension : null);
    return requireFeatureVersion(
      extension?.capabilityVersions,
      field,
      minimum,
      message,
    );
  };

  const projectSnapshotToolOutput = (value, output = "compact") => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    if (value.outputMode === output) return value;
    if (output === "both") return { ...value, outputMode: output, outputProjectedLocally: true };
    const common = {
      tab: value.tab,
      snapshotVersion: value.snapshotVersion,
      deltaVersion: value.deltaVersion,
      restricted: value.restricted,
      pageKind: value.pageKind,
      debuggerSupported: value.debuggerSupported,
      ...(value.reason ? { reason: value.reason } : {}),
      ...(value.snapshot ? { snapshot: value.snapshot } : {}),
      ...(Number.isInteger(value.refCount) ? { refCount: value.refCount } : {}),
      ...(Number.isInteger(value.elementCount) ? { elementCount: value.elementCount } : {}),
      ...(Number.isInteger(value.returnedElementCount) ? { returnedElementCount: value.returnedElementCount } : {}),
      ...(typeof value.truncated === "boolean" ? { truncated: value.truncated } : {}),
      ...(typeof value.deltaOnly === "boolean" ? { deltaOnly: value.deltaOnly } : {}),
      outputMode: output,
      outputProjectedLocally: true,
    };
    if (output === "compact") {
      if (value.deltaOnly && value.delta) return { ...common, delta: value.delta };
      return { ...common, text: value.text || "" };
    }
    if (output === "text") {
      return {
        tab: value.tab,
        snapshotVersion: value.snapshotVersion,
        restricted: value.restricted,
        pageKind: value.pageKind,
        debuggerSupported: value.debuggerSupported,
        ...(value.reason ? { reason: value.reason } : {}),
        ...(value.snapshot ? { snapshot: value.snapshot } : {}),
        outputMode: output,
        outputProjectedLocally: true,
        text: value.text || "",
      };
    }
    return { ...common, frames: value.frames || [], delta: value.delta ?? null, elements: value.elements || [] };
  };
  const agentBrowserAvailability = ({ accessEnabled, local }) => {
    const lifecycle = typeof getAgentBrowserStatus === "function" ? getAgentBrowserStatus() : null;
    const localAgent = local?.contexts?.agent ?? null;
    const ready = Boolean(localAgent?.ready);
    const supported = lifecycle?.supported ?? null;
    const pairing = Boolean(lifecycle?.pairing);
    const lastLaunchError = lifecycle?.lastLaunchError ?? null;
    const launchable = Boolean(
      accessEnabled && supported !== false && typeof ensureAgentBrowserReady === "function",
    );
    const state = ready
      ? "ready"
      : lastLaunchError
        ? "error"
        : pairing
          ? "setup_required"
          : "idle";
    return {
      state,
      ready,
      launchable,
      autoLaunchOnUse: launchable,
      supported,
      pairing,
      lastLaunchError,
    };
  };

  registerTextTool(
    "equinox_browser_status",
    {
      description:
        "Equinox Browser'ın iki ayrı context'ini salt okunur gösterir: varsayılan izole Agent Browser ve kullanıcının kişisel User Browser profili. Context'ler arasında sessiz fallback yapılmaz.",
      inputSchema: {},
      annotations: {
        title: "Equinox Browser durumu",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const accessEnabled = Boolean(isBrowserAccessEnabled());
        const local = rawBridge.snapshot();
        const remoteByContext = { agent: null, user: null };
        if (accessEnabled) {
          for (const context of ["agent", "user"]) {
            if (!local.contexts?.[context]?.ready) continue;
            try {
              remoteByContext[context] = await rawBridge.call("status", {}, {
                timeoutMs: 5_000,
                context,
              });
            } catch {
              // A context may disconnect between the local snapshot and the bounded status call.
            }
          }
        }
        return jsonText({
          accessEnabled,
          defaultTarget: "agent",
          agentBrowser: agentBrowserAvailability({ accessEnabled, local }),
          local,
          remote: remoteByContext.user,
          contexts: {
            agent: { local: local.contexts?.agent ?? null, remote: remoteByContext.agent },
            user: { local: local.contexts?.user ?? null, remote: remoteByContext.user },
          },
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_reload_extension",
    {
      description:
        "Equinox Browser unpacked extension service worker'ına kendini güvenli biçimde reload etmesini söyler. Geliştirme sırasında extension kaynak kodu değiştikten sonra chrome://extensions üzerinde manuel Reload ihtiyacını kaldırmak için kullanılır.",
      inputSchema: {},
      annotations: {
        title: "Equinox Browser extension reload",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return await withMutationLocks(["browser:user"], async () =>
          jsonText(await bridge.call("self.reload", {}, { timeoutMs: 5_000 })));
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_tabs",
    {
      description:
        "Chrome'daki mevcut sekmeleri Equinox Browser extension üzerinden listeler. Yeni sekme oluşturmaz ve debugger attach etmez; her sekmede pageKind ve debuggerSupported ön sınıflandırmasını da döndürür.",
      inputSchema: {},
      annotations: {
        title: "Equinox Browser sekmeleri",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return jsonText(await bridge.call("tabs.list"));
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_activate",
    {
      description: "Belirtilen mevcut Chrome sekmesini aktif hale getirir; yeni sekme yaratmaz.",
      inputSchema: {
        tab_id: z.number().int().positive().describe("Aktif hale getirilecek Chrome tab kimliği"),
      },
      annotations: {
        title: "Equinox Browser sekme etkinleştir",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () =>
          jsonText(await bridge.call("tabs.activate", { tabId: tab_id })));
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_open",
    {
      description:
        "Aktif veya seçilen mevcut Chrome sekmesini aynı tab kimliğini koruyarak HTTP(S) URL'sine ya da Chrome New Tab'a götürür. Yeni sekme yaratmaz; chrome://settings, chrome://extensions ve file:// hedefleri güvenlik nedeniyle açıkça reddedilir.",
      inputSchema: {
        url: z.string().min(1).max(4_000).describe("Açılacak http(s) URL veya chrome://newtab/"),
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser URL aç",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () =>
          jsonText(await bridge.call("open", { tabId: tab_id, url })));
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_navigate",
    {
      description:
        "Aktif veya seçilen desteklenen web sekmesini CDP Page.navigate ile HTTP(S) URL'sine götürür. Aktif observation session'ı korunur; ignore_cache yalnız bu navigation süresince cache'i geçici kapatır.",
      inputSchema: {
        url: z.string().min(1).max(4_000).describe("Açılacak http(s) URL"),
        ignore_cache: z.boolean().default(false),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser navigate", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, ignore_cache = false, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion(
            "navigation",
            1,
            "Observation-preserving navigate için Equinox Browser uzantısının güncel sürümü gerekiyor.",
          );
          const result = await bridge.call("navigate", { tabId: tab_id, url, ignoreCache: ignore_cache });
          const version = Number(result?.navigationVersion);
          if (!Number.isFinite(version) || version < 1) {
            throw new Error("Observation-preserving navigate için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          return jsonText(canonicalTabMetadata(result));
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_reload",
    {
      description:
        "Aktif veya seçilen desteklenen web sekmesini CDP Page.reload ile yeniler. İsteğe bağlı ignore_cache cache'i bu reload için atlar ve aktif observation session'ını korur.",
      inputSchema: {
        ignore_cache: z.boolean().default(false),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser yenile", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ ignore_cache = false, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion(
            "navigation",
            1,
            "Browser reload için Equinox Browser uzantısının güncel sürümü gerekiyor.",
          );
          const result = await bridge.call("reload", { tabId: tab_id, ignoreCache: ignore_cache });
          const version = Number(result?.navigationVersion);
          if (!Number.isFinite(version) || version < 1) {
            throw new Error("Browser reload için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          return jsonText(canonicalTabMetadata(result));
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_emulate",
    {
      description:
        "Seçilen desteklenen web sekmesinde bounded device/mobile emulation uygular. Width/height/DPR/mobile/touch değerleri Chrome Emulation domain'ine güvenli sınırlarla iletilir; raw CDP veya koordinat kaçış yüzeyi açmaz.",
      inputSchema: {
        width: z.number().int().min(240).max(3840),
        height: z.number().int().min(240).max(2400),
        device_scale_factor: z.number().min(1).max(3).default(1),
        mobile: z.boolean().default(false),
        touch: z.boolean().default(false),
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser cihaz emülasyonu",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ width, height, device_scale_factor = 1, mobile = false, touch = false, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion(
            "emulation",
            1,
            "Device/mobile emulation için Equinox Browser uzantısının güncel sürümü gerekiyor.",
          );
          const result = await bridge.call("emulate", {
            tabId: tab_id,
            width,
            height,
            deviceScaleFactor: device_scale_factor,
            mobile,
            touch,
          });
          requireFeatureVersion(
            result,
            "emulationVersion",
            1,
            "Device/mobile emulation için Equinox Browser uzantısının güncel sürümü gerekiyor.",
          );
          return jsonText(result);
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_clear_emulation",
    {
      description: "Seçilen desteklenen web sekmesindeki device metrics ve touch emulation override'larını temizler.",
      inputSchema: { tab_id: optionalTabId() },
      annotations: { title: "Equinox Browser emülasyonu temizle", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion("emulation", 1, "Emulation temizleme için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          const result = await bridge.call("emulation.clear", { tabId: tab_id });
          requireFeatureVersion(result, "emulationVersion", 1, "Emulation temizleme için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          return jsonText(result);
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_new_tab",
    {
      description:
        "Equinox Browser context'inde yeni Chrome sekmesi oluşturur. URL verilmezse Chrome New Tab açılır. Sonuç yeni tabId/windowId bilgisini döndürür; mevcut sekmeyi yeniden kullanmaz.",
      inputSchema: {
        url: z.string().min(1).max(4_000).optional()
          .describe("İsteğe bağlı http(s) URL; verilmezse chrome://newtab/"),
        active: z.boolean().default(true).describe("Yeni sekmeyi aktif hale getir"),
      },
      annotations: {
        title: "Equinox Browser yeni sekme",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url, active = true }) => {
      try {
        return await withMutationLocks(["browser:user"], async () => {
          const result = await bridge.call("tabs.create", {
            url: url || "chrome://newtab/",
            active,
          });
          return jsonText(canonicalTabMetadata(result));
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_back",
    {
      description:
        "Aktif veya seçilen Chrome sekmesini kendi geçmişinde bir adım geri götürür. Context'ler arasında fallback yapmaz ve son sekme metadata'sını döndürür.",
      inputSchema: {
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser geri",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () => {
          const result = await bridge.call("history.back", { tabId: tab_id });
          return jsonText(canonicalTabMetadata(result));
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_forward",
    {
      description:
        "Aktif veya seçilen Chrome sekmesini kendi geçmişinde bir adım ileri götürür. Context'ler arasında fallback yapmaz ve son sekme metadata'sını döndürür.",
      inputSchema: {
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser ileri",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () => {
          const result = await bridge.call("history.forward", { tabId: tab_id });
          return jsonText(canonicalTabMetadata(result));
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_snapshot",
    {
      description:
        "Web sayfasının Accessibility ağacından ajan dostu snapshot ve @eN etkileşim referansları üretir. Snapshot v2; içerik modu, document/viewport kapsamı, node sınırı, rol/query filtresi ve önceki bir root ref alt ağacını destekler. since_snapshot_id verilirse aynı filtre projeksiyonundaki bounded önceki snapshot'a göre yalnız delta döner ve aynı document içindeki korunmuş ref'leri bildirir. Chrome New Tab, Web Store ve browser-owned interstitial/internal sayfalarda structured restricted metadata döner; Chrome PDF Viewer OOPIF üzerinden desteklenir.",
      inputSchema: {
        tab_id: optionalTabId(),
        include_readable: z.boolean().default(true)
          .describe("Geriye uyumluluk alanı. mode verilmezse true=balanced, false=interactive davranışı seçilir."),
        mode: z.enum(["interactive", "readable", "balanced"]).optional()
          .describe("Snapshot içeriği: yalnız etkileşimli, yalnız okunabilir veya dengeli birleşim"),
        scope: z.enum(["document", "viewport"]).default("document")
          .describe("Tüm document veya yalnız görünür viewport ile kesişen öğeler"),
        max_nodes: z.number().int().min(1).max(250).default(250)
          .describe("Snapshot'a eklenecek en fazla öğe sayısı"),
        root_ref: z.string().regex(/^@e\d+$/).optional()
          .describe("Önceki geçerli snapshot'taki etkileşimli bir ref'in erişilebilirlik alt ağacına daralt"),
        roles: z.array(z.string().min(1).max(100)).max(50).optional()
          .describe("İsteğe bağlı exact accessibility role filtresi"),
        query: z.string().min(1).max(1_000).optional()
          .describe("Role, accessible name veya value içinde büyük/küçük harf duyarsız metin filtresi"),
        since_snapshot_id: z.string().min(1).max(240).optional()
          .describe("Aynı sekmedeki bounded snapshot geçmişinden base id; aynı filtrelerle delta snapshot üretir"),
        output: z.enum(["compact", "structured", "text", "both"]).default("compact")
          .describe("Model çıktısı biçimi. compact varsayılanı duplicate structured veriyi taşımadan @ref metnini ve gerekli metadata'yı döndürür."),
      },
      annotations: {
        title: "Equinox Browser snapshot",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      tab_id,
      include_readable = true,
      mode,
      scope = "document",
      max_nodes = 250,
      root_ref,
      roles,
      query,
      since_snapshot_id,
      output = "compact",
    }) => {
      try {
        const advancedRequested = Boolean(
          mode || scope !== "document" || max_nodes !== 250 || root_ref || roles?.length || query || since_snapshot_id,
        );
        const snapshotArgs = {
          tabId: tab_id,
          includeReadable: include_readable,
          ...(mode ? { mode } : {}),
          ...(scope !== "document" ? { scope } : {}),
          ...(max_nodes !== 250 ? { maxNodes: max_nodes } : {}),
          ...(root_ref ? { rootRef: root_ref } : {}),
          ...(roles?.length ? { roles } : {}),
          ...(query ? { query } : {}),
          ...(since_snapshot_id ? { sinceSnapshotId: since_snapshot_id } : {}),
          output,
        };
        const result = await bridge.call("snapshot", snapshotArgs);
        const snapshotVersion = Number(result?.snapshotVersion);
        if (advancedRequested && (!Number.isFinite(snapshotVersion) || snapshotVersion < 2)) {
          throw new Error(
            "Bu Snapshot v2 filtresi için Equinox Browser uzantısının güncel sürümü gerekiyor. Uzantı güncellendikten sonra tekrar deneyin.",
          );
        }
        if (since_snapshot_id) {
          const deltaVersion = Number(result?.deltaVersion);
          if (!Number.isFinite(deltaVersion) || deltaVersion < 1 || result?.deltaOnly !== true) {
            throw new Error(
              "Delta snapshot için Equinox Browser uzantısının güncel sürümü gerekiyor. Uzantı güncellendikten sonra tekrar deneyin.",
            );
          }
        }
        return jsonText(projectSnapshotToolOutput(result, output));
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_screenshot",
    {
      description:
        "Seçilen web sekmesinin PNG screenshot'ını first-party Equinox Browser ile CSS-pixel 1x ölçekte alır ve workspace altındaki runtime-owned ephemeral storage'a kaydeder. Varsayılan viewport, full_page, geçerli snapshot ref'i veya page-coordinate clip seçilebilir. Artifact'lar 1 saat retention ve 256 MB / 24 capture hard quota ile otomatik temizlenir.",
      inputSchema: {
        name: z.string().regex(SCREENSHOT_NAME_PATTERN).describe("Çıktı dosya adı; .png eklenir"),
        collection: z.string().regex(SCREENSHOT_NAME_PATTERN).default("captures"),
        full_page: z.boolean().default(false),
        ref: z.string().regex(/^@e\d+$/).optional()
          .describe("Son geçerli snapshot'taki öğeyi kırp; OOPIF ref'leri güvenli biçimde reddedilir"),
        clip: z.object({
          x: z.number().min(0).max(32_000),
          y: z.number().min(0).max(32_000),
          width: z.number().positive().max(32_000),
          height: z.number().positive().max(32_000),
        }).optional().describe("CSS page koordinatlarında bounded screenshot bölgesi"),
        annotate_refs: z.boolean().default(false)
          .describe("Son geçerli snapshot'taki görünür root-session @eN ref'lerini PNG üzerine etiketle; OOPIF ref'leri güvenli biçimde atlanır"),
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser screenshot",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name, collection, full_page = false, ref, clip, annotate_refs = false, tab_id }) => {
      try {
        validateScreenshotName(name, "Screenshot adı");
        validateScreenshotName(collection, "Screenshot koleksiyonu");
        const scopeCount = [full_page === true, Boolean(ref), Boolean(clip)].filter(Boolean).length;
        if (scopeCount > 1) {
          throw new Error("full_page, ref ve clip alanlarından en fazla biri verilmelidir.");
        }
        return await withMutationLocks(["browser:screenshot-storage", "browser:user"].sort(), async () => {
          const cleanupBefore = await pruneScreenshotStorage(screenshotRoot);
          const captured = await bridge.call(
            "screenshot",
            {
              tabId: tab_id,
              fullPage: full_page,
              ...(ref ? { ref } : {}),
              ...(clip ? { clip } : {}),
              ...(annotate_refs ? { annotateRefs: true } : {}),
            },
            { timeoutMs: full_page ? 120_000 : 45_000 },
          );
          const screenshotVersion = Number(captured?.screenshotVersion);
          if ((ref || clip) && (!Number.isFinite(screenshotVersion) || screenshotVersion < 2)) {
            throw new Error(
              "Ref/clip screenshot için Equinox Browser uzantısının güncel sürümü gerekiyor. Uzantı güncellendikten sonra tekrar deneyin.",
            );
          }
          if (annotate_refs && (!Number.isFinite(screenshotVersion) || screenshotVersion < 3)) {
            throw new Error(
              "annotate_refs screenshot için Equinox Browser uzantısının güncel sürümü gerekiyor. Uzantı güncellendikten sonra tekrar deneyin.",
            );
          }
          const { data, ...captureMetadata } = captured || {};
          const { buffer, png } = decodeScreenshotPng(data);
          const captureId = `capture-${Date.now()}-${randomUUID()}`;
          const destination = screenshotTarget(screenshotRoot, { captureId, collection, name });
          await writeScreenshotAtomic({ absolutePath: destination.absolutePath, buffer });
          const createdAtMs = Date.now();
          const sha256 = createHash("sha256").update(buffer).digest("hex");
          const cleanupAfter = await pruneScreenshotStorage(screenshotRoot, createdAtMs);
          return jsonText({
            ...captureMetadata,
            project: screenshotProjectId,
            storage: "ephemeral",
            path: destination.relativePath,
            bytes: buffer.length,
            sha256,
            width: png.width,
            height: png.height,
            retentionMinutes: SCREENSHOT_RETENTION_MS / 60_000,
            expiresAt: new Date(createdAtMs + SCREENSHOT_RETENTION_MS).toISOString(),
            storageQuota: {
              maxBytes: SCREENSHOT_MAX_TOTAL_BYTES,
              maxCaptures: SCREENSHOT_MAX_CAPTURE_DIRS,
            },
            cleanup: {
              removedCaptures: cleanupBefore.removedCaptures + cleanupAfter.removedCaptures,
              reclaimedBytes: cleanupBefore.reclaimedBytes + cleanupAfter.reclaimedBytes,
            },
          });
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_screenshot_delete",
    {
      description:
        "Equinox Browser'ın runtime-owned ephemeral screenshot artifact'ını, capture sonucundaki SHA-256 ile doğrulayıp güvenli biçimde siler. Generic 10 MB file_hash/delete_file sınırını kullanmaz ve yalnız browser-screenshots runtime köküne erişebilir.",
      inputSchema: {
        path: z.string().min(1).max(300),
        expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
      },
      annotations: {
        title: "Equinox Browser screenshot sil",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path: relativePath, expected_sha256 }) => {
      try {
        return await withMutationLocks(["browser:screenshot-storage"], async () => {
          const resolved = resolveScreenshotPath(screenshotRoot, relativePath);
          const stat = await fs.lstat(resolved.absolutePath).catch((error) => {
            if (error?.code === "ENOENT") throw new Error("Screenshot artifact bulunamadı.");
            throw error;
          });
          if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Screenshot artifact normal bir dosya değil.");
          if (stat.size > MAX_SCREENSHOT_PNG_BYTES) throw new Error("Screenshot artifact beklenen 32 MB sınırını aşıyor.");
          const actualSha256 = await sha256File(resolved.absolutePath);
          if (actualSha256.toLowerCase() !== expected_sha256.toLowerCase()) {
            throw new Error("Screenshot SHA-256 doğrulaması başarısız; dosya silinmedi.");
          }
          await fs.unlink(resolved.absolutePath);
          await fs.rmdir(resolved.collectionDir).catch((error) => {
            if (!new Set(["ENOENT", "ENOTEMPTY"]).has(error?.code)) throw error;
          });
          await fs.rmdir(resolved.captureDir).catch((error) => {
            if (!new Set(["ENOENT", "ENOTEMPTY"]).has(error?.code)) throw error;
          });
          return jsonText({
            removed: relativePath,
            bytes: stat.size,
            sha256: actualSha256,
          });
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_find",
    {
      description: "Accessibility snapshot üzerinde isim/değer ve isteğe bağlı rolle semantik arama yapar; eşleşmeler varsa mevcut @ref'leri döndürür.",
      inputSchema: {
        query: z.string().min(1).max(10_000),
        role: z.string().min(1).max(100).optional(),
        exact: z.boolean().default(false),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser semantik bul", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ query, role, exact, tab_id }) => {
      try {
        return jsonText(await bridge.call("find", { tabId: tab_id, query, role, exact }));
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_reacquire",
    {
      description:
        "Eski bir @eN ref'i için aynı document generation içinde güvenli semantik yeniden edinme yapar. Araç fresh interactive snapshot alır; yalnız tek exact role/name/value/frame eşleşmesinde yeni ref döndürür. Hiçbir action gerçekleştirmez; ambiguous/not_found sonuçlarında newRef null kalır.",
      inputSchema: {
        old_ref: z.string().regex(/^@e\d+$/).describe("Yeniden edinilecek eski snapshot ref'i"),
        from_snapshot_id: z.string().min(1).max(240).optional()
          .describe("İsteğe bağlı kaynak snapshot id; verilmezse bounded geçmişte aynı document içindeki en yeni eşleşme kullanılır"),
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser ref yeniden edin",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ old_ref, from_snapshot_id, tab_id }) => {
      try {
        const result = await bridge.call("reacquire", {
          tabId: tab_id,
          oldRef: old_ref,
          ...(from_snapshot_id ? { fromSnapshotId: from_snapshot_id } : {}),
        });
        const reacquireVersion = Number(result?.reacquireVersion);
        if (!Number.isFinite(reacquireVersion) || reacquireVersion < 1) {
          throw new Error(
            "Safe ref reacquire için Equinox Browser uzantısının güncel sürümü gerekiyor. Uzantı güncellendikten sonra tekrar deneyin.",
          );
        }
        return jsonText(result);
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_click",
    {
      description:
        "Son Equinox Browser snapshot'ındaki @eN referansına Chrome Input domainiyle gerçek mouse click gönderir. left/right/middle button, bounded modifier ve press-release delay semantiğini destekler. İsteğe bağlı bounded after yalnız tek wait ve full/delta snapshot zinciri kurabilir; uzun macro çalıştırmaz. Aynı user gesture sırasında açılan tab/popup ve başlayan Chrome download kayıtlarını bounded metadata olarak döndürür.",
      inputSchema: {
        ref: z.string().regex(/^@e\d+$/).describe("Snapshot referansı; örneğin @e3"),
        button: z.enum(["left", "right", "middle"]).default("left"),
        modifiers: z.array(z.enum(["shift", "ctrl", "meta", "alt"])).max(4).default([]),
        delay_ms: z.number().int().min(0).max(1_000).default(0)
          .describe("Mouse press ile release arasındaki bounded gecikme"),
        after: boundedAfterSchema(),
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser tıkla",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ ref, button = "left", modifiers = [], delay_ms = 0, after, tab_id }) => {
      try {
        const afterArgs = mapBoundedAfter(after);
        const richRequested = button !== "left" || modifiers.length > 0 || delay_ms > 0;
        return await withMutationLocks(["browser:user"], async () => {
          if (richRequested) {
            await requireCapabilityVersion(
              "click",
              2,
              "Gelişmiş click button/modifier/delay semantiği için Equinox Browser uzantısının güncel sürümü gerekiyor.",
            );
          }
          const result = await bridge.call("click", {
            tabId: tab_id,
            ref,
            ...(richRequested ? { button, modifiers, delayMs: delay_ms } : {}),
            ...(afterArgs ? { after: afterArgs } : {}),
          });
          if (richRequested) {
            requireFeatureVersion(
              result,
              "clickVersion",
              2,
              "Gelişmiş click button/modifier/delay semantiği için Equinox Browser uzantısının güncel sürümü gerekiyor.",
            );
          }
          if (afterArgs) {
            requireFeatureVersion(
              result,
              "compoundActionVersion",
              1,
              "Controlled click after için Equinox Browser uzantısının güncel sürümü gerekiyor. Uzantı güncellendikten sonra tekrar deneyin.",
            );
          }
          return jsonText(result);
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_tap",
    {
      description:
        "Son Equinox Browser snapshot'ındaki semantic @ref'e gerçek CDP touch tap gönderir. Hedef görünür/actionable olmalı; ham koordinat kabul etmez ve stale ref'lerde fail-closed kalır.",
      inputSchema: {
        ref: z.string().regex(/^@e\d+$/),
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser dokun",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ ref, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion("touchGesture", 1, "Touch tap için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          const result = await bridge.call("tap", { tabId: tab_id, ref });
          requireFeatureVersion(result, "touchGestureVersion", 1, "Touch tap için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          return jsonText(result);
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_swipe",
    {
      description:
        "Viewport merkezinden veya isteğe bağlı semantic @ref merkezinden gerçek bounded touch swipe gönderir. Yalnız yön ve mesafe kabul eder; ham x/y koordinat kaçış yüzeyi yoktur. direction parmağın hareket yönüdür.",
      inputSchema: {
        direction: z.enum(["up", "down", "left", "right"]),
        distance_px: z.number().int().min(40).max(1_200).default(400),
        ref: z.string().regex(/^@e\d+$/).optional(),
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser kaydır",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ direction, distance_px = 400, ref, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion("touchGesture", 1, "Touch swipe için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          const result = await bridge.call("swipe", {
            tabId: tab_id,
            direction,
            distance: distance_px,
            ...(ref ? { ref } : {}),
          });
          requireFeatureVersion(result, "touchGestureVersion", 1, "Touch swipe için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          return jsonText(result);
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_double_click",
    {
      description:
        "Son Equinox Browser snapshot'ındaki @eN referansına gerçek iki tıklık Chrome mouse dizisi gönderir. Tek tıkla ayrı davranan grid, editör, canvas ve dosya benzeri arayüzlerde gerçek double-click semantiği sağlar. İsteğe bağlı bounded after alanı click ile aynı wait/snapshot zincirini destekler.",
      inputSchema: {
        ref: z.string().regex(/^@e\d+$/).describe("Snapshot referansı; örneğin @e3"),
        after: z.object({
          wait_for: z.enum(["dom_stable", "network_idle"]).optional(),
          snapshot: z.enum(["delta", "full"]).optional(),
          quiet_ms: z.number().int().min(100).max(5_000).default(500),
          timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
        }).optional().describe("Tek bounded post-action wait ve/veya snapshot; macro değildir"),
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser çift tıkla",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ ref, after, tab_id }) => {
      try {
        const afterArgs = after
          ? {
              ...(after.wait_for ? { waitFor: after.wait_for } : {}),
              ...(after.snapshot ? { snapshot: after.snapshot } : {}),
              quietMs: after.quiet_ms ?? 500,
              timeoutMs: after.timeout_ms ?? 10_000,
            }
          : null;
        if (afterArgs && !afterArgs.waitFor && !afterArgs.snapshot) {
          throw new Error("after alanında wait_for ve/veya snapshot verilmelidir.");
        }
        return await withMutationLocks(["browser:user"], async () => {
          const result = await bridge.call("double_click", {
            tabId: tab_id,
            ref,
            ...(afterArgs ? { after: afterArgs } : {}),
          });
          const version = Number(result?.doubleClickVersion);
          if (!Number.isFinite(version) || version < 1) {
            throw new Error(
              "Double click için Equinox Browser uzantısının güncel sürümü gerekiyor. Uzantı güncellendikten sonra tekrar deneyin.",
            );
          }
          return jsonText(result);
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_drag",
    {
      description:
        "Aynı güncel snapshot'taki source_ref öğesinden target_ref öğesine bounded semantic drag uygular. pointer modu gerçek mouse press/move/release dizisiyle Kanban, slider ve canvas gibi arayüzleri; html5 modu Chrome'un intercept ettiği gerçek DragData payload'ını dragEnter/dragOver/drop ile taşıyarak HTML5 dropzone'ları hedefler. Koordinat, cross-frame/OOPIF veya stale-ref fallback yapmaz.",
      inputSchema: {
        source_ref: z.string().regex(/^@e\d+$/).describe("Sürüklemenin başlayacağı güncel snapshot ref'i"),
        target_ref: z.string().regex(/^@e\d+$/).describe("Sürüklemenin biteceği güncel snapshot ref'i"),
        mode: z.enum(["pointer", "html5"]).default("pointer")
          .describe("pointer=mouse drag; html5=Chrome DragData interception + native drag/drop events"),
        steps: z.number().int().min(2).max(32).default(8)
          .describe("Kaynak ile hedef arasında gönderilecek bounded mouse move adımı"),
        duration_ms: z.number().int().min(100).max(2_000).default(350)
          .describe("Drag başlangıcındaki mouse hareketinin yaklaşık toplam süresi"),
        after: boundedAfterSchema(),
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser sürükle",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ source_ref, target_ref, mode = "pointer", steps = 8, duration_ms = 350, after, tab_id }) => {
      try {
        const afterArgs = mapBoundedAfter(after);
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion(
            mode === "html5" ? "html5Drag" : "pointerDrag",
            1,
            mode === "html5"
              ? "Semantic HTML5 drag/drop için Equinox Browser uzantısının güncel sürümü gerekiyor."
              : "Semantic pointer drag için Equinox Browser uzantısının güncel sürümü gerekiyor.",
          );
          if (afterArgs) {
            await requireCapabilityVersion("compoundAction", 2, "Drag after zinciri için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          const result = await bridge.call("drag", {
            tabId: tab_id,
            sourceRef: source_ref,
            targetRef: target_ref,
            mode,
            steps,
            durationMs: duration_ms,
            ...(afterArgs ? { after: afterArgs } : {}),
          });
          if (mode === "html5") {
            requireFeatureVersion(
              result,
              "html5DragVersion",
              1,
              "Semantic HTML5 drag/drop için Equinox Browser uzantısının güncel sürümü gerekiyor. Uzantı güncellendikten sonra tekrar deneyin.",
            );
          } else {
            requireFeatureVersion(
              result,
              "pointerDragVersion",
              1,
              "Semantic pointer drag için Equinox Browser uzantısının güncel sürümü gerekiyor. Uzantı güncellendikten sonra tekrar deneyin.",
            );
          }
          if (afterArgs) {
            requireFeatureVersion(
              result,
              "compoundActionVersion",
              2,
              "Drag after zinciri için Equinox Browser uzantısının güncel sürümü gerekiyor.",
            );
          }
          return jsonText(result);
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_hover",
    {
      description: "Son snapshot'taki @eN referansının üzerine Chrome Input domainiyle mouse taşır; hover sonrası yeni snapshot alınmalıdır.",
      inputSchema: {
        ref: z.string().regex(/^@e\d+$/).describe("Snapshot referansı"),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser hover", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ ref, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion(
            "actionability",
            1,
            "Hit-test doğrulamalı hover için Equinox Browser uzantısının güncel sürümü gerekiyor.",
          );
          const result = await bridge.call("hover", { tabId: tab_id, ref });
          requireFeatureVersion(
            result,
            "actionabilityVersion",
            1,
            "Hit-test doğrulamalı hover için Equinox Browser uzantısının güncel sürümü gerekiyor.",
          );
          return jsonText(result);
        });
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_scroll_into_view",
    {
      description:
        "Güncel snapshot @ref'ini semantic olarak viewport içine getirir ve gerçek hit-test ile etkileşilebilir bir nokta doğrular. Koordinat fallback yapmaz; sonraki DOM action öncesi fresh snapshot önerilir.",
      inputSchema: {
        ref: z.string().regex(/^@e\d+$/),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser görünür alana getir", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ ref, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion(
            "actionability",
            1,
            "Semantic scroll_into_view için Equinox Browser uzantısının güncel sürümü gerekiyor.",
          );
          const result = await bridge.call("scroll_into_view", { tabId: tab_id, ref });
          requireFeatureVersion(
            result,
            "actionabilityVersion",
            1,
            "Semantic scroll_into_view için Equinox Browser uzantısının güncel sürümü gerekiyor.",
          );
          return jsonText(result);
        });
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_ref_info",
    {
      description:
        "Güncel semantic @ref için bounded canlı actionability/state metadata döndürür: exists/visible/enabled, role/name, frame/session, box ve uygun kontrollerde checked/selected/expanded/editable/readOnly/value. Generic DOM dump değildir.",
      inputSchema: {
        ref: z.string().regex(/^@e\d+$/),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser ref bilgisi", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ ref, tab_id }) => {
      try {
        const result = await bridge.call("ref_info", { tabId: tab_id, ref });
        requireFeatureVersion(
          result,
          "actionabilityVersion",
          1,
          "Semantic ref_info için Equinox Browser uzantısının güncel sürümü gerekiyor.",
        );
        return jsonText(result);
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_scroll",
    {
      description: "Web sekmesini Chrome Input mouseWheel ile kaydırır. İsteğe bağlı @ref verilirse kaydırma o öğe üzerinde yapılır.",
      inputSchema: {
        direction: z.enum(["up", "down", "left", "right"]).default("down"),
        pixels: z.number().int().positive().max(20_000).default(600),
        ref: z.string().regex(/^@e\d+$/).optional(),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser kaydır", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ direction, pixels, ref, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () =>
          jsonText(await bridge.call("scroll", { tabId: tab_id, direction, pixels, ref })));
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_select",
    {
      description: "Son snapshot'taki select/combobox @ref üzerinde option value veya görünen label ile seçim yapar.",
      inputSchema: {
        ref: z.string().regex(/^@e\d+$/),
        option: z.string().min(1).max(10_000).describe("Option value veya görünen label"),
        after: boundedAfterSchema(),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser seçenek seç", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ ref, option, after, tab_id }) => {
      try {
        const afterArgs = mapBoundedAfter(after);
        return await withMutationLocks(["browser:user"], async () => {
          if (afterArgs) {
            await requireCapabilityVersion("compoundAction", 2, "Select after zinciri için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          const result = await bridge.call("select", {
            tabId: tab_id,
            ref,
            option,
            ...(afterArgs ? { after: afterArgs } : {}),
          });
          if (afterArgs) {
            requireFeatureVersion(result, "compoundActionVersion", 2, "Select after zinciri için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          return jsonText(result);
        });
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_check",
    {
      description: "Checkbox/switch/radio benzeri son snapshot @ref'ini istenen checked durumuna getirir.",
      inputSchema: {
        ref: z.string().regex(/^@e\d+$/),
        checked: z.boolean().default(true),
        after: boundedAfterSchema(),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser işaretle", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ ref, checked, after, tab_id }) => {
      try {
        const afterArgs = mapBoundedAfter(after);
        return await withMutationLocks(["browser:user"], async () => {
          if (afterArgs) {
            await requireCapabilityVersion("compoundAction", 2, "Check after zinciri için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          const result = await bridge.call("check", {
            tabId: tab_id,
            ref,
            checked,
            ...(afterArgs ? { after: afterArgs } : {}),
          });
          if (afterArgs) {
            requireFeatureVersion(result, "compoundActionVersion", 2, "Check after zinciri için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          return jsonText(result);
        });
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_wait",
    {
      description:
        "Sekmede tek bir bounded koşulu bekler: süre, body metni, URL, canlı snapshot ref durumu, filtrelenmiş network response, DOM kararlılığı, ilgili ağ trafiğinin sakinleşmesi veya bilinen snapshot'tan sonra sayfa değişimi. Stale ref'ler navigasyon sonrası fail-closed kalır.",
      inputSchema: {
        milliseconds: z.number().int().min(0).max(60_000).optional(),
        text: z.string().min(1).max(10_000).optional(),
        url_contains: z.string().min(1).max(4_000).optional(),
        ref_visible: z.string().regex(/^@e\d+$/).optional(),
        ref_hidden: z.string().regex(/^@e\d+$/).optional(),
        ref_exists: z.string().regex(/^@e\d+$/).optional(),
        ref_enabled: z.string().regex(/^@e\d+$/).optional(),
        network_response: z.object({
          url_contains: z.string().min(1).max(4_000).optional(),
          method: z.string().regex(/^[A-Za-z]{1,16}$/).optional(),
          status: z.number().int().min(100).max(599).optional(),
          resource_type: z.enum(["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch", "prefetch", "eventsource", "websocket", "manifest", "signedexchange", "ping", "cspviolationreport", "preflight", "fedcm", "other"]).optional(),
        }).optional().describe("Bir sonraki eşleşen response metadata eventini bekler; body/header/cookie döndürmez."),
        network_idle: z.literal(true).optional()
          .describe("İlgili kısa ömürlü ağ istekleri quiet_ms boyunca yoksa tamamlanır; WebSocket/EventSource/Media beklemeyi sonsuza dek açık tutmaz."),
        dom_stable: z.literal(true).optional()
          .describe("Anlamlı DOM mutation sayacı quiet_ms boyunca değişmezse tamamlanır."),
        snapshot_changed: z.string().min(1).max(240).optional()
          .describe("Daha önce bu sekmeden alınmış bounded snapshot id; document generation, URL veya anlamlı DOM mutation değişince tamamlanır."),
        quiet_ms: z.number().int().min(100).max(5_000).default(500)
          .describe("dom_stable ve network_idle için sessizlik penceresi"),
        timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser bekle", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({
      milliseconds,
      text,
      url_contains,
      ref_visible,
      ref_hidden,
      ref_exists,
      ref_enabled,
      network_response,
      network_idle,
      dom_stable,
      snapshot_changed,
      quiet_ms = 500,
      timeout_ms = 10_000,
      tab_id,
    }) => {
      try {
        const conditionCount = [
          milliseconds != null,
          Boolean(text),
          Boolean(url_contains),
          Boolean(ref_visible),
          Boolean(ref_hidden),
          Boolean(ref_exists),
          Boolean(ref_enabled),
          Boolean(network_response),
          network_idle === true,
          dom_stable === true,
          Boolean(snapshot_changed),
        ].filter(Boolean).length;
        if (conditionCount !== 1) {
          throw new Error(
            "milliseconds, text, url_contains, ref_visible, ref_hidden, ref_exists, ref_enabled, network_response, network_idle, dom_stable veya snapshot_changed alanlarından tam olarak biri verilmelidir.",
          );
        }
        const smartRequested = Boolean(
          ref_visible || ref_hidden || ref_exists || ref_enabled || network_response || network_idle || dom_stable || snapshot_changed,
        );
        if (network_response) await requireCapabilityVersion("observation", 2, "Network response wait için Equinox Browser uzantısının güncel sürümü gerekiyor.");
        const waitArgs = {
          tabId: tab_id,
          milliseconds,
          text,
          urlContains: url_contains,
          timeoutMs: timeout_ms,
          ...(ref_visible ? { refVisible: ref_visible } : {}),
          ...(ref_hidden ? { refHidden: ref_hidden } : {}),
          ...(ref_exists ? { refExists: ref_exists } : {}),
          ...(ref_enabled ? { refEnabled: ref_enabled } : {}),
          ...(network_response ? { networkResponse: {
            ...(network_response.url_contains ? { urlContains: network_response.url_contains } : {}),
            ...(network_response.method ? { method: network_response.method } : {}),
            ...(network_response.status != null ? { status: network_response.status } : {}),
            ...(network_response.resource_type ? { resourceType: network_response.resource_type } : {}),
          } } : {}),
          ...(network_idle === true ? { networkIdle: true, quietMs: quiet_ms } : {}),
          ...(dom_stable === true ? { domStable: true, quietMs: quiet_ms } : {}),
          ...(snapshot_changed ? { snapshotChanged: snapshot_changed } : {}),
        };
        const result = await bridge.call(
          "wait",
          waitArgs,
          { timeoutMs: Math.min(65_000, timeout_ms + 5_000) },
        );
        const waitVersion = Number(result?.waitVersion);
        if (smartRequested && (!Number.isFinite(waitVersion) || waitVersion < 2)) {
          throw new Error(
            "Bu Smart Wait koşulu için Equinox Browser uzantısının güncel sürümü gerekiyor. Uzantı güncellendikten sonra tekrar deneyin.",
          );
        }
        if (network_response) {
          requireFeatureVersion(result, "observationVersion", 2, "Network response wait için Equinox Browser uzantısının güncel sürümü gerekiyor.");
        }
        return jsonText(result);
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_fill",
    {
      description:
        "Son snapshot'taki textbox/searchbox benzeri @eN referansını doldurur ve input/change olaylarını dispatch eder.",
      inputSchema: {
        ref: z.string().regex(/^@e\d+$/).describe("Snapshot referansı"),
        value: z.string().max(100_000).describe("Yazılacak değer"),
        after: boundedAfterSchema(),
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser alan doldur",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ ref, value, after, tab_id }) => {
      try {
        const afterArgs = mapBoundedAfter(after);
        return await withMutationLocks(["browser:user"], async () => {
          if (afterArgs) {
            await requireCapabilityVersion("compoundAction", 2, "Fill after zinciri için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          const result = await bridge.call("fill", {
            tabId: tab_id,
            ref,
            value,
            ...(afterArgs ? { after: afterArgs } : {}),
          });
          if (afterArgs) {
            requireFeatureVersion(result, "compoundActionVersion", 2, "Fill after zinciri için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          return jsonText(result);
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_press",
    {
      description:
        "Aktif veya seçilen web sekmesine Chrome Input domainiyle klavye tuşu/chord gönderir; ör. Enter, Escape, cmd+a, shift+Tab. İsteğe bağlı semantic ref verilirse önce o öğeyi scroll/hit-test/focus ile doğrular ve aynı frame/OOPIF session'ına tuşu yollar.",
      inputSchema: {
        key: z.string().min(1).max(80).describe("Tuş veya chord; ör. Enter, cmd+a"),
        ref: z.string().regex(/^@e\d+$/).optional(),
        after: boundedAfterSchema(),
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser tuş gönder",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ key, ref, after, tab_id }) => {
      try {
        const afterArgs = mapBoundedAfter(after);
        return await withMutationLocks(["browser:user"], async () => {
          if (ref) {
            await requireCapabilityVersion("input", 1, "Ref-targeted keyboard input için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          if (afterArgs) {
            await requireCapabilityVersion("compoundAction", 2, "Press after zinciri için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          const result = await bridge.call("press", {
            tabId: tab_id,
            key,
            ...(ref ? { ref } : {}),
            ...(afterArgs ? { after: afterArgs } : {}),
          });
          if (ref) {
            requireFeatureVersion(result, "inputVersion", 1, "Ref-targeted keyboard input için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          if (afterArgs) {
            requireFeatureVersion(result, "compoundActionVersion", 2, "Press after zinciri için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          return jsonText(result);
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_type_text",
    {
      description:
        "Güncel editable semantic @ref'e gerçek sequential Chrome key event'leriyle metin yazar; emoji/IME/karmaşık veya büyük metinde aynı focused frame session'ında Input.insertText kullanır. Mevcut içeriği temizlemez; replace için fill kullanın.",
      inputSchema: {
        ref: z.string().regex(/^@e\d+$/),
        text: z.string().max(100_000),
        delay_ms: z.number().int().min(0).max(200).default(0)
          .describe("Sequential key event'ler arasındaki bounded gecikme"),
        after: boundedAfterSchema(),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser metin yaz", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ ref, text, delay_ms = 0, after, tab_id }) => {
      try {
        const afterArgs = mapBoundedAfter(after);
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion("input", 1, "Gerçek type_text input için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          if (afterArgs) {
            await requireCapabilityVersion("compoundAction", 2, "Type text after zinciri için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          const result = await bridge.call("type_text", {
            tabId: tab_id,
            ref,
            text,
            delayMs: delay_ms,
            ...(afterArgs ? { after: afterArgs } : {}),
          });
          requireFeatureVersion(result, "inputVersion", 1, "Gerçek type_text input için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          if (afterArgs) {
            requireFeatureVersion(result, "compoundActionVersion", 2, "Type text after zinciri için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          }
          return jsonText(result);
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerRawTool(
    "equinox_browser_eval",
    {
      description:
        "Seçilen web sekmesinde JavaScript ifadesini Runtime.evaluate ile çalıştırır. Chrome internal sayfalarında çalışmaz.",
      inputSchema: {
        expression: z.string().min(1).max(200_000).describe("Çalıştırılacak JavaScript ifadesi"),
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser JavaScript değerlendir",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ expression, tab_id }) => {
      try {
        return jsonText(await bridge.call("eval", { tabId: tab_id, expression }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTextTool(
    "equinox_browser_observe_start",
    {
      description: "Seçilen web sekmesinde console, network ve JavaScript dialog eventlerini yakalamak için cursor destekli kalıcı bounded observation session başlatır.",
      inputSchema: { tab_id: optionalTabId() },
      annotations: { title: "Equinox Browser gözlemi başlat", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ tab_id }) => {
      try {
        await requireCapabilityVersion("observation", 2, "Observation v2 için Equinox Browser uzantısının güncel sürümü gerekiyor.");
        const result = await bridge.call("observe.start", { tabId: tab_id });
        requireFeatureVersion(result, "observationVersion", 2, "Observation v2 için Equinox Browser uzantısının güncel sürümü gerekiyor.");
        return jsonText(result);
      }
      catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_observe_stop",
    {
      description: "Seçilen sekmenin observation session'ını ve debugger attachment'ını kapatır; Chrome açık kalır.",
      inputSchema: { tab_id: optionalTabId() },
      annotations: { title: "Equinox Browser gözlemi durdur", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ tab_id }) => {
      try { return jsonText(await bridge.call("observe.stop", { tabId: tab_id })); }
      catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_console",
    {
      description: "Aktif observation session'daki bounded console/exception eventlerini stable cursor ve isteğe bağlı level/query filtreleriyle okur.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
        clear: z.boolean().default(false),
        after_cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        level: z.enum(["log", "debug", "info", "error", "warning", "dir", "dirxml", "table", "trace", "clear", "startgroup", "startgroupcollapsed", "endgroup", "assert", "profile", "profileend", "count", "timeend"]).optional(),
        query: z.string().min(1).max(1_000).optional(),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser console", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ limit, clear, after_cursor, level, query, tab_id }) => {
      try {
        if (clear && after_cursor != null) throw new Error("clear ile after_cursor birlikte kullanılamaz; cursor ilerletmeyi kullanın.");
        await requireCapabilityVersion("observation", 2, "Console observation v2 için Equinox Browser uzantısının güncel sürümü gerekiyor.");
        const result = await bridge.call("console.read", {
          tabId: tab_id,
          limit,
          clear,
          ...(after_cursor != null ? { afterCursor: after_cursor } : {}),
          ...(level ? { level } : {}),
          ...(query ? { query } : {}),
        });
        requireFeatureVersion(result, "observationVersion", 2, "Console observation v2 için Equinox Browser uzantısının güncel sürümü gerekiyor.");
        return jsonText(result);
      }
      catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_network",
    {
      description: "Aktif observation session'daki bounded request/response/failure eventlerini stable cursor ve URL/method/status/resource-type filtreleriyle, body/header taşımadan okur; hassas query parametreleri redakte edilir.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
        clear: z.boolean().default(false),
        after_cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
        url_contains: z.string().min(1).max(4_000).optional(),
        method: z.string().regex(/^[A-Za-z]{1,16}$/).optional(),
        status: z.number().int().min(100).max(599).optional(),
        resource_type: z.enum(["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch", "prefetch", "eventsource", "websocket", "manifest", "signedexchange", "ping", "cspviolationreport", "preflight", "fedcm", "other"]).optional(),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser network", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ limit, clear, after_cursor, url_contains, method, status, resource_type, tab_id }) => {
      try {
        if (clear && after_cursor != null) throw new Error("clear ile after_cursor birlikte kullanılamaz; cursor ilerletmeyi kullanın.");
        await requireCapabilityVersion("observation", 2, "Network observation v2 için Equinox Browser uzantısının güncel sürümü gerekiyor.");
        const result = await bridge.call("network.read", {
          tabId: tab_id,
          limit,
          clear,
          ...(after_cursor != null ? { afterCursor: after_cursor } : {}),
          ...(url_contains ? { urlContains: url_contains } : {}),
          ...(method ? { method } : {}),
          ...(status != null ? { status } : {}),
          ...(resource_type ? { resourceType: resource_type } : {}),
        });
        requireFeatureVersion(result, "observationVersion", 2, "Network observation v2 için Equinox Browser uzantısının güncel sürümü gerekiyor.");
        return jsonText(result);
      }
      catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_bookmarks_list",
    {
      description: "Yalnız izole Agent Browser profilindeki tek bookmark klasörünün doğrudan çocuklarını bounded biçimde listeler. Root çağrısı klasörleri gösterir; bir klasörün içini görmek için dönen folder id ile tekrar çağır. Sonuçlar okunabilir bookmark path bilgisi taşır. Tüm tree'yi dökmez; target=user açıkça reddedilir.",
      inputSchema: {
        parent_id: z.string().min(1).max(128).default("0"),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: { title: "Agent Browser bookmark klasörü", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ parent_id = "0", limit = 50 }) => {
      try {
        requireAgentBrowserContext("Bookmark listeleme");
        await requireCapabilityVersion("bookmarks", 2, "Agent Browser bookmark yönetimi için Equinox Browser uzantısının güncel sürümü gerekiyor.");
        const result = await bridge.call("bookmarks.list", { parentId: parent_id, limit });
        requireFeatureVersion(result, "bookmarksVersion", 2, "Agent Browser bookmark yönetimi için Equinox Browser uzantısının güncel sürümü gerekiyor.");
        return jsonText(result);
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_bookmarks_search",
    {
      description: "Agent Browser bookmark ağacının tamamında bookmark/folder adı ve URL için bounded global arama yapar. Önceden kaydedilmiş veya tekrar ziyaret edilen bir site söz konusuysa web'de sıfırdan aramadan önce bunu kullan. Sonuçlar hangi klasörde olduklarını okunabilir path ile gösterir; en fazla 100 kayıttır ve hassas URL query değerleri redakte edilir.",
      inputSchema: {
        query: z.string().min(1).max(500),
        limit: z.number().int().min(1).max(100).default(50),
      },
      annotations: { title: "Agent Browser bookmark ara", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, limit = 50 }) => {
      try {
        requireAgentBrowserContext("Bookmark arama");
        await requireCapabilityVersion("bookmarks", 2, "Agent Browser bookmark yönetimi için Equinox Browser uzantısının güncel sürümü gerekiyor.");
        const result = await bridge.call("bookmarks.search", { query, limit });
        requireFeatureVersion(result, "bookmarksVersion", 2, "Agent Browser bookmark yönetimi için Equinox Browser uzantısının güncel sürümü gerekiyor.");
        return jsonText(result);
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_bookmark_add",
    {
      description: "Yalnız Agent Browser profilinde HTTP(S) bookmark oluşturur. Sık kullanılan veya sonraki görevlerde tekrar ziyaret edilmesi beklenen siteleri Agent Browser'ın kalıcı navigasyon hafızasına kaydetmek için kullan. Ham javascript/file URL kabul etmez; target=user fail-closed kalır.",
      inputSchema: {
        title: z.string().min(1).max(500),
        url: z.string().min(1).max(4_000),
        parent_id: z.string().min(1).max(128).optional(),
        index: z.number().int().min(0).max(100_000).optional(),
      },
      annotations: { title: "Agent Browser bookmark ekle", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, url, parent_id, index }) => {
      try {
        requireAgentBrowserContext("Bookmark ekleme");
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion("bookmarks", 2, "Agent Browser bookmark yönetimi için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          const result = await bridge.call("bookmarks.add", {
            title,
            url,
            ...(parent_id ? { parentId: parent_id } : {}),
            ...(index != null ? { index } : {}),
          });
          requireFeatureVersion(result, "bookmarksVersion", 2, "Agent Browser bookmark yönetimi için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          return jsonText(result);
        });
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_bookmark_folder_create",
    {
      description: "Yalnız Agent Browser profilinde bounded adlı bookmark klasörü oluşturur; target=user ürün API'sinde kapalıdır.",
      inputSchema: {
        title: z.string().min(1).max(500),
        parent_id: z.string().min(1).max(128).optional(),
        index: z.number().int().min(0).max(100_000).optional(),
      },
      annotations: { title: "Agent Browser bookmark klasörü oluştur", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, parent_id, index }) => {
      try {
        requireAgentBrowserContext("Bookmark klasörü oluşturma");
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion("bookmarks", 2, "Agent Browser bookmark yönetimi için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          const result = await bridge.call("bookmarks.folder_create", {
            title,
            ...(parent_id ? { parentId: parent_id } : {}),
            ...(index != null ? { index } : {}),
          });
          requireFeatureVersion(result, "bookmarksVersion", 2, "Agent Browser bookmark yönetimi için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          return jsonText(result);
        });
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_bookmark_update_move",
    {
      description: "Yalnız Agent Browser profilindeki tek bookmark/folder'ı yeniden adlandırır, bookmark URL'sini HTTP(S) olarak günceller ve/veya başka bookmark klasörüne taşır. En az bir değişiklik zorunludur.",
      inputSchema: {
        id: z.string().min(1).max(128),
        title: z.string().max(500).optional(),
        url: z.string().min(1).max(4_000).optional(),
        parent_id: z.string().min(1).max(128).optional(),
        index: z.number().int().min(0).max(100_000).optional(),
      },
      annotations: { title: "Agent Browser bookmark güncelle/taşı", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, title, url, parent_id, index }) => {
      try {
        requireAgentBrowserContext("Bookmark güncelleme/taşıma");
        if (title == null && url == null && parent_id == null && index == null) throw new Error("En az bir bookmark değişikliği verilmelidir.");
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion("bookmarks", 2, "Agent Browser bookmark yönetimi için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          const result = await bridge.call("bookmarks.update_move", {
            id,
            ...(title != null ? { title } : {}),
            ...(url != null ? { url } : {}),
            ...(parent_id != null ? { parentId: parent_id } : {}),
            ...(index != null ? { index } : {}),
          });
          requireFeatureVersion(result, "bookmarksVersion", 2, "Agent Browser bookmark yönetimi için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          return jsonText(result);
        });
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_bookmark_remove",
    {
      description: "Yalnız Agent Browser profilindeki tek bookmark veya klasörü kaldırır. Dolu klasör için recursive açıkça true verilmedikçe Chrome işlemi reddeder.",
      inputSchema: {
        id: z.string().min(1).max(128),
        recursive: z.boolean().default(false),
      },
      annotations: { title: "Agent Browser bookmark kaldır", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, recursive = false }) => {
      try {
        requireAgentBrowserContext("Bookmark silme");
        return await withMutationLocks(["browser:user"], async () => {
          await requireCapabilityVersion("bookmarks", 2, "Agent Browser bookmark yönetimi için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          const result = await bridge.call("bookmarks.remove", { id, recursive });
          requireFeatureVersion(result, "bookmarksVersion", 2, "Agent Browser bookmark yönetimi için Equinox Browser uzantısının güncel sürümü gerekiyor.");
          return jsonText(result);
        });
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_dialog",
    {
      description: "Seçilen web sekmesindeki JavaScript alert/confirm/prompt durumunu observation gerektirmeden okur veya açık dialogu accept/dismiss eder. Equinox Browser dialog açılışlarını debugger attach süresince first-class state olarak izler.",
      inputSchema: {
        action: z.enum(["status", "accept", "dismiss"]).default("status"),
        prompt_text: z.string().max(20_000).optional(),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser dialog", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ action, prompt_text, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () =>
          jsonText(await bridge.call("dialog", { tabId: tab_id, action, promptText: prompt_text })));
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_close",
    {
      description:
        "Seçilen Chrome sekmesini kapatır. Chrome genelindeki gerçekten son sekmeyse Chrome'u kapatmak yerine aynı sekmeyi New Tab'a sıfırlar; başka Chrome sekmesi varken popup penceresinin tek sekmesi normal biçimde kapanır.",
      inputSchema: {
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser sekme kapat",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () =>
          jsonText(await bridge.call("close", { tabId: tab_id })));
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerRawTool(
    "equinox_browser_upload_file",
    {
      description:
        "İzinli Equinox Local dosya kökünden normal dosyayı first-party Equinox Browser ile file input'a yükler. Ham mutlak yol kabul etmez.",
      inputSchema: {
        source_root: fileRootSchema.describe("Yüklenecek dosyanın izinli Equinox Local kökü"),
        path: z.string().min(1).max(300).describe("İzinli köke göre göreli dosya yolu"),
        ref: z.string().regex(/^@e\d+$/).optional().describe("Snapshot'taki file input @ref"),
        selector: z.string().min(1).max(300).optional().describe("Alternatif CSS file-input selector"),
        tab_id: optionalTabId(),
      },
      annotations: {
        title: "Equinox Browser güvenli dosya yükle",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ source_root, path, ref, selector, tab_id }) => {
      try {
        if (!ref && !selector) throw new Error("ref veya selector zorunludur.");
        const source = await resolveUploadFile(source_root, path);
        return await withMutationLocks(["browser:user"], async () =>
          jsonText(await bridge.call("upload", {
            tabId: tab_id,
            ref,
            selector,
            files: [source.absolutePath],
          })));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  registerTextTool(
    "equinox_browser_download_wait",
    {
      description:
        "Chrome'da page/user action ile başlamış tek bir download'ın tamamlanmasını bounded biçimde bekler; yalnız güvenli Downloads kökündeki normal dosyayı doğrulayıp ad, MIME, boyut ve SHA-256 döndürür. Absolute dosya yolu model çıktısına çıkarılmaz.",
      inputSchema: {
        download_id: z.number().int().nonnegative().describe("equinox_browser_click downloadsStarted sonucundaki Chrome download kimliği"),
        timeout_ms: z.number().int().min(100).max(60_000).default(60_000),
      },
      annotations: {
        title: "Equinox Browser download doğrula",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ download_id, timeout_ms }) => {
      try {
        const terminal = await bridge.call(
          "downloads.wait",
          { downloadId: download_id, timeoutMs: timeout_ms },
          { timeoutMs: Math.min(timeout_ms + 5_000, 65_000) },
        );
        const download = terminal?.download;
        if (!download || download.id !== download_id) {
          throw new Error("Chrome download kaydı doğrulanamadı.");
        }
        if (download.state === "interrupted") {
          throw new Error(`Chrome download kesildi${download.error ? ` (${download.error})` : ""}.`);
        }
        if (download.state !== "complete") {
          throw new Error(`Chrome download terminal durumda değil: ${download.state || "unknown"}.`);
        }
        if (!SAFE_DOWNLOAD_DANGERS.has(String(download.danger || ""))) {
          throw new Error(`Chrome download güvenli kabul edilmedi (danger=${download.danger || "unknown"}).`);
        }
        if (download.exists === false) {
          throw new Error("Chrome download tamamlandı ancak dosya artık diskte bulunmuyor.");
        }
        const inspected = await inspectBrowserDownloadFile({
          downloadsRoot,
          absolutePath: download.filename,
          expectedSize: Number.isFinite(download.fileSize) && download.fileSize >= 0
            ? download.fileSize
            : undefined,
        });
        return jsonText({
          downloadId: download.id,
          name: inspected.name,
          mimeType: download.mimeType || null,
          bytes: inspected.bytes,
          sha256: inspected.sha256,
          state: download.state,
          danger: download.danger,
          startTime: download.startTime || null,
          endTime: download.endTime || null,
          sourceRoot: "downloads",
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_disconnect",
    {
      description:
        "Equinox Browser'ın web sekmelerindeki debugger attachment'larını kapatır. Chrome ve extension açık kalır; Native Messaging köprüsünü sökmez.",
      inputSchema: {},
      annotations: {
        title: "Equinox Browser debugger bağlantılarını bırak",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return jsonText(await bridge.call("disconnect"));
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );
}
