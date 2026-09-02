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
  const bridge = new Proxy(rawBridge, {
    get(target, property, receiver) {
      if (property === "call") {
        return async (...args) => {
          assertBrowserAccess();
          return target.call(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const optionalTabId = () => z.number().int().positive().optional()
    .describe("İsteğe bağlı Chrome tab kimliği; verilmezse aktif sekme kullanılır");

  const jsonText = (value) => textResult(JSON.stringify(value ?? null, null, 2));

  registerTextTool(
    "equinox_browser_status",
    {
      description:
        "Birinci taraf Equinox Browser extension + Native Messaging köprüsünün durumunu salt okunur gösterir.",
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
        let remote = null;
        if (accessEnabled && local.ready) {
          remote = await rawBridge.call("status", {}, { timeoutMs: 5_000 });
        }
        return jsonText({ accessEnabled, local, remote });
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
    "equinox_browser_snapshot",
    {
      description:
        "Web sayfasının Accessibility ağacından ajan dostu snapshot ve @eN etkileşim referansları üretir. Chrome New Tab, Web Store ve browser-owned interstitial/internal sayfalarda structured restricted metadata döner; Chrome PDF Viewer OOPIF üzerinden desteklenir.",
      inputSchema: {
        tab_id: optionalTabId(),
        include_readable: z.boolean().default(true)
          .describe("Başlık ve okunabilir metin rollerini de snapshot'a dahil et"),
      },
      annotations: {
        title: "Equinox Browser snapshot",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ tab_id, include_readable }) => {
      try {
        return jsonText(await bridge.call("snapshot", {
          tabId: tab_id,
          includeReadable: include_readable,
        }));
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
        "Seçilen web sekmesinin PNG screenshot'ını first-party Equinox Browser ile CSS-pixel 1x ölçekte alır ve workspace altındaki runtime-owned ephemeral storage'a kaydeder. Artifact'lar 1 saat retention ve 256 MB / 24 capture hard quota ile otomatik temizlenir.",
      inputSchema: {
        name: z.string().regex(SCREENSHOT_NAME_PATTERN).describe("Çıktı dosya adı; .png eklenir"),
        collection: z.string().regex(SCREENSHOT_NAME_PATTERN).default("captures"),
        full_page: z.boolean().default(false),
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
    async ({ name, collection, full_page, tab_id }) => {
      try {
        validateScreenshotName(name, "Screenshot adı");
        validateScreenshotName(collection, "Screenshot koleksiyonu");
        return await withMutationLocks(["browser:screenshot-storage", "browser:user"].sort(), async () => {
          const cleanupBefore = await pruneScreenshotStorage(screenshotRoot);
          const captured = await bridge.call(
            "screenshot",
            { tabId: tab_id, fullPage: full_page },
            { timeoutMs: full_page ? 120_000 : 45_000 },
          );
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
    "equinox_browser_click",
    {
      description:
        "Son Equinox Browser snapshot'ındaki @eN referansına Chrome Input domainiyle gerçek mouse click gönderir. Aynı user gesture sırasında açılan tab/popup ve başlayan Chrome download kayıtlarını bounded metadata olarak döndürür; downloadsStarted içindeki id tamamlanınca equinox_browser_download_wait ile güvenli dosya metadata/hash alınabilir. DOM değişiminden sonra yeni snapshot alınmalıdır.",
      inputSchema: {
        ref: z.string().regex(/^@e\d+$/).describe("Snapshot referansı; örneğin @e3"),
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
    async ({ ref, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () =>
          jsonText(await bridge.call("click", { tabId: tab_id, ref })));
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
        return await withMutationLocks(["browser:user"], async () =>
          jsonText(await bridge.call("hover", { tabId: tab_id, ref })));
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
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser seçenek seç", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ ref, option, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () =>
          jsonText(await bridge.call("select", { tabId: tab_id, ref, option })));
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
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser işaretle", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ ref, checked, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () =>
          jsonText(await bridge.call("check", { tabId: tab_id, ref, checked })));
      } catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_wait",
    {
      description: "Sekmede süre, görünür body metni veya URL parçası için bounded bekleme yapar. Tam olarak bir koşul verilmelidir.",
      inputSchema: {
        milliseconds: z.number().int().min(0).max(60_000).optional(),
        text: z.string().min(1).max(10_000).optional(),
        url_contains: z.string().min(1).max(4_000).optional(),
        timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser bekle", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ milliseconds, text, url_contains, timeout_ms, tab_id }) => {
      try {
        const conditionCount = [milliseconds != null, Boolean(text), Boolean(url_contains)].filter(Boolean).length;
        if (conditionCount !== 1) throw new Error("milliseconds, text veya url_contains alanlarından tam olarak biri verilmelidir.");
        return jsonText(await bridge.call("wait", {
          tabId: tab_id,
          milliseconds,
          text,
          urlContains: url_contains,
          timeoutMs: timeout_ms,
        }, { timeoutMs: Math.min(65_000, timeout_ms + 5_000) }));
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
    async ({ ref, value, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () =>
          jsonText(await bridge.call("fill", { tabId: tab_id, ref, value })));
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
        "Aktif veya seçilen web sekmesine Chrome Input domainiyle klavye tuşu/chord gönderir; ör. Enter, Escape, cmd+a, shift+Tab.",
      inputSchema: {
        key: z.string().min(1).max(80).describe("Tuş veya chord; ör. Enter, cmd+a"),
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
    async ({ key, tab_id }) => {
      try {
        return await withMutationLocks(["browser:user"], async () =>
          jsonText(await bridge.call("press", { tabId: tab_id, key })));
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
      description: "Seçilen web sekmesinde console, network ve JavaScript dialog eventlerini yakalamak için kalıcı bounded observation session başlatır.",
      inputSchema: { tab_id: optionalTabId() },
      annotations: { title: "Equinox Browser gözlemi başlat", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ tab_id }) => {
      try { return jsonText(await bridge.call("observe.start", { tabId: tab_id })); }
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
      description: "Aktif observation session'da yakalanan bounded console ve uncaught exception eventlerini okur.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
        clear: z.boolean().default(false),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser console", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ limit, clear, tab_id }) => {
      try { return jsonText(await bridge.call("console.read", { tabId: tab_id, limit, clear })); }
      catch (error) { return errorResult(error); }
    },
    { projectAware: false },
  );

  registerTextTool(
    "equinox_browser_network",
    {
      description: "Aktif observation session'da yakalanan bounded request/response/failure eventlerini header taşımadan okur; hassas query parametreleri redakte edilir.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
        clear: z.boolean().default(false),
        tab_id: optionalTabId(),
      },
      annotations: { title: "Equinox Browser network", readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ limit, clear, tab_id }) => {
      try { return jsonText(await bridge.call("network.read", { tabId: tab_id, limit, clear })); }
      catch (error) { return errorResult(error); }
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
