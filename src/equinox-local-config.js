import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const EQUINOX_LOCAL_CONFIG_VERSION = 1;
export const DEFAULT_CONTROL_CENTER_PORT = 24891;
export const MAX_CONFIG_BYTES = 256 * 1024;
export const MAX_CONFIG_PROJECTS = 64;
export const MAX_CONFIG_FILE_ROOTS = 64;
export const CONFIG_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function assertPlainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} bir JSON nesnesi olmalı.`);
  }
  return value;
}

function assertSafeText(value, label, { min = 1, max = 120 } = {}) {
  if (typeof value !== "string") {
    throw new Error(`${label} metin olmalı.`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error(`${label} ${min}-${max} karakterlik kontrol-karaktersiz metin olmalı.`);
  }
  return trimmed;
}

function normalizeId(value, label) {
  const id = assertSafeText(value, label, { min: 1, max: 64 });
  if (!CONFIG_ID_PATTERN.test(id)) {
    throw new Error(`${label} küçük harf, sayı, nokta, alt çizgi veya tire içeren güvenli bir kimlik olmalı.`);
  }
  return id;
}

function normalizeAbsoluteRoot(value, label) {
  const root = assertSafeText(value, label, { min: 1, max: 1024 });
  if (!path.isAbsolute(root)) {
    throw new Error(`${label} mutlak bir dosya yolu olmalı.`);
  }
  const normalized = path.normalize(root);
  if (normalized === path.parse(normalized).root) {
    throw new Error(`${label} doğrudan dosya sistemi kökü olamaz.`);
  }
  return normalized;
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([left], [right]) => left.localeCompare(right)));
}

function normalizeProjects(rawProjects) {
  const source = assertPlainObject(rawProjects, "projects");
  const entries = Object.entries(source);
  if (entries.length < 1 || entries.length > MAX_CONFIG_PROJECTS) {
    throw new Error(`projects 1-${MAX_CONFIG_PROJECTS} kayıt içermeli.`);
  }

  return sortedObject(entries.map(([rawId, rawDefinition]) => {
    const id = normalizeId(rawId, "Proje kimliği");
    const definition = assertPlainObject(rawDefinition, `projects.${id}`);
    const allowedKeys = new Set(["name", "root", "worktrees"]);
    for (const key of Object.keys(definition)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`projects.${id}.${key} desteklenmiyor.`);
      }
    }
    return [id, Object.freeze({
      name: assertSafeText(definition.name, `projects.${id}.name`, { min: 1, max: 100 }),
      root: normalizeAbsoluteRoot(definition.root, `projects.${id}.root`),
      worktrees: definition.worktrees === undefined ? true : Boolean(definition.worktrees),
    })];
  }));
}

function normalizeFileRoots(rawFileRoots = {}) {
  const source = assertPlainObject(rawFileRoots, "fileRoots");
  const entries = Object.entries(source);
  if (entries.length > MAX_CONFIG_FILE_ROOTS) {
    throw new Error(`fileRoots en fazla ${MAX_CONFIG_FILE_ROOTS} kayıt içerebilir.`);
  }

  return sortedObject(entries.map(([rawId, rawDefinition]) => {
    const id = normalizeId(rawId, "Dosya kökü kimliği");
    const definition = assertPlainObject(rawDefinition, `fileRoots.${id}`);
    const allowedKeys = new Set(["name", "root", "access"]);
    for (const key of Object.keys(definition)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`fileRoots.${id}.${key} desteklenmiyor.`);
      }
    }
    const access = definition.access ?? "read-only";
    if (access !== "read-only") {
      throw new Error(`fileRoots.${id}.access V1'de yalnız read-only olabilir.`);
    }
    return [id, Object.freeze({
      name: assertSafeText(definition.name, `fileRoots.${id}.name`, { min: 1, max: 100 }),
      root: normalizeAbsoluteRoot(definition.root, `fileRoots.${id}.root`),
      access,
    })];
  }));
}

function assertUniqueConfiguredRoots(projects, fileRoots) {
  const seen = new Map();
  for (const [kind, definitions] of [["project", projects], ["fileRoot", fileRoots]]) {
    for (const [id, definition] of Object.entries(definitions)) {
      const key = process.platform === "darwin" ? definition.root.toLowerCase() : definition.root;
      const existing = seen.get(key);
      if (existing) {
        throw new Error(`Aynı klasör iki kez tanımlanamaz: ${existing.kind}.${existing.id} ve ${kind}.${id}`);
      }
      seen.set(key, { kind, id });
    }
  }
}

export function validateEquinoxLocalConfig(rawConfig) {
  const raw = assertPlainObject(rawConfig, "Equinox Local config");
  const allowedTopLevel = new Set(["version", "defaultProject", "runtime", "projects", "fileRoots", "controlCenter"]);
  for (const key of Object.keys(raw)) {
    if (!allowedTopLevel.has(key)) {
      throw new Error(`Config alanı desteklenmiyor: ${key}`);
    }
  }

  if (raw.version !== EQUINOX_LOCAL_CONFIG_VERSION) {
    throw new Error(`Desteklenmeyen config sürümü: ${raw.version}. Beklenen: ${EQUINOX_LOCAL_CONFIG_VERSION}.`);
  }

  const projects = normalizeProjects(raw.projects);
  const fileRoots = normalizeFileRoots(raw.fileRoots ?? {});
  for (const id of Object.keys(fileRoots)) {
    if (Object.hasOwn(projects, id)) {
      throw new Error(`Proje ve dosya kökü kimlikleri çakışamaz: ${id}`);
    }
  }
  assertUniqueConfiguredRoots(projects, fileRoots);

  const defaultProject = normalizeId(raw.defaultProject, "defaultProject");
  if (!Object.hasOwn(projects, defaultProject)) {
    throw new Error(`defaultProject tanımlı bir projeyi göstermeli: ${defaultProject}`);
  }

  const runtimeRaw = assertPlainObject(raw.runtime, "runtime");
  const runtimeKeys = new Set(["workspaceProject", "downloadsRoot"]);
  for (const key of Object.keys(runtimeRaw)) {
    if (!runtimeKeys.has(key)) {
      throw new Error(`runtime.${key} desteklenmiyor.`);
    }
  }
  const workspaceProject = normalizeId(runtimeRaw.workspaceProject, "runtime.workspaceProject");
  if (!Object.hasOwn(projects, workspaceProject)) {
    throw new Error(`runtime.workspaceProject tanımlı bir projeyi göstermeli: ${workspaceProject}`);
  }
  const downloadsRoot = normalizeId(runtimeRaw.downloadsRoot, "runtime.downloadsRoot");
  if (!Object.hasOwn(fileRoots, downloadsRoot)) {
    throw new Error(`runtime.downloadsRoot tanımlı bir read-only fileRoots kaydını göstermeli: ${downloadsRoot}`);
  }

  const controlRaw = raw.controlCenter === undefined
    ? {}
    : assertPlainObject(raw.controlCenter, "controlCenter");
  const controlKeys = new Set(["enabled", "port"]);
  for (const key of Object.keys(controlRaw)) {
    if (!controlKeys.has(key)) {
      throw new Error(`controlCenter.${key} desteklenmiyor.`);
    }
  }
  const enabled = controlRaw.enabled === undefined ? true : Boolean(controlRaw.enabled);
  const port = controlRaw.port === undefined ? DEFAULT_CONTROL_CENTER_PORT : controlRaw.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("controlCenter.port 1024-65535 arasında bir tam sayı olmalı.");
  }

  return Object.freeze({
    version: EQUINOX_LOCAL_CONFIG_VERSION,
    defaultProject,
    runtime: Object.freeze({ workspaceProject, downloadsRoot }),
    projects: Object.freeze(projects),
    fileRoots: Object.freeze(fileRoots),
    controlCenter: Object.freeze({ enabled, port }),
  });
}

export function serializeEquinoxLocalConfig(config) {
  const normalized = validateEquinoxLocalConfig(config);
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

export function equinoxLocalConfigRevision(config) {
  return createHash("sha256").update(serializeEquinoxLocalConfig(config), "utf8").digest("hex");
}

export function defaultEquinoxLocalConfigPath(homeDir = os.homedir()) {
  if (typeof homeDir !== "string" || !path.isAbsolute(homeDir)) {
    throw new Error("Equinox Local config için mutlak HOME yolu gerekli.");
  }
  return path.join(homeDir, "Library", "Application Support", "Equinox Local", "config.json");
}

async function readConfigFile(configPath) {
  const stat = await fs.lstat(configPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Equinox Local config bulunamadı: ${configPath}`);
    }
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Equinox Local config normal ve symlink olmayan bir dosya olmalı.");
  }
  if (stat.size <= 0 || stat.size > MAX_CONFIG_BYTES) {
    throw new Error(`Equinox Local config 1-${MAX_CONFIG_BYTES} bayt arasında olmalı.`);
  }
  const text = await fs.readFile(configPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Equinox Local config geçerli JSON değil: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateEquinoxLocalConfig(parsed);
}

export function createEquinoxLocalConfigManager({
  homeDir = os.homedir(),
  configPath = process.env.EQUINOX_LOCAL_CONFIG_PATH || defaultEquinoxLocalConfigPath(homeDir),
} = {}) {
  if (typeof configPath !== "string" || !path.isAbsolute(configPath)) {
    throw new Error("EQUINOX_LOCAL_CONFIG_PATH mutlak bir yol olmalı.");
  }

  const state = {
    configPath: path.normalize(configPath),
    config: null,
    revision: null,
    loadedAt: null,
  };

  const initialize = async () => {
    const config = await readConfigFile(state.configPath);
    state.config = config;
    state.revision = equinoxLocalConfigRevision(config);
    state.loadedAt = new Date().toISOString();
    return snapshot();
  };

  const requireConfig = () => {
    if (!state.config) {
      throw new Error("Equinox Local config manager henüz initialize edilmedi.");
    }
    return state.config;
  };

  const snapshot = () => {
    const config = requireConfig();
    return Object.freeze({
      configPath: state.configPath,
      revision: state.revision,
      loadedAt: state.loadedAt,
      config,
    });
  };

  const replacePersisted = async (nextConfig, { expectedRevision } = {}) => {
    const normalized = validateEquinoxLocalConfig(nextConfig);
    if (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/u.test(expectedRevision)) {
      throw new Error("Config güncellemesi için 64 karakterlik expectedRevision zorunludur.");
    }

    const currentOnDisk = await readConfigFile(state.configPath);
    const currentRevision = equinoxLocalConfigRevision(currentOnDisk);
    if (currentRevision !== expectedRevision || currentRevision !== state.revision) {
      throw new Error("Config revision guard eşleşmedi; config başka bir işlem tarafından değiştirilmiş olabilir.");
    }

    const parent = path.dirname(state.configPath);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    await fs.chmod(parent, 0o700).catch(() => {});
    const tempPath = path.join(parent, `.config.${process.pid}.${randomUUID()}.tmp`);
    const serialized = serializeEquinoxLocalConfig(normalized);
    try {
      await fs.writeFile(tempPath, serialized, { flag: "wx", mode: 0o600 });
      const existing = await fs.lstat(state.configPath);
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new Error("Mevcut config güvenli normal dosya değil.");
      }
      await fs.rename(tempPath, state.configPath);
      await fs.chmod(state.configPath, 0o600).catch(() => {});
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }

    const persistedRevision = equinoxLocalConfigRevision(normalized);
    return Object.freeze({
      configPath: state.configPath,
      previousRevision: state.revision,
      persistedRevision,
      restartRequired: true,
      config: normalized,
    });
  };

  return Object.freeze({
    initialize,
    snapshot,
    replacePersisted,
    get configPath() { return state.configPath; },
    get config() { return requireConfig(); },
    get revision() { requireConfig(); return state.revision; },
    get defaultProjectId() { return requireConfig().defaultProject; },
    get workspaceProjectId() { return requireConfig().runtime.workspaceProject; },
    get downloadsRootId() { return requireConfig().runtime.downloadsRoot; },
    get controlCenter() { return requireConfig().controlCenter; },
    getProjectDefinitions() { return requireConfig().projects; },
    getFileRootDefinitions() {
      const config = requireConfig();
      return Object.freeze({ ...config.projects, ...config.fileRoots });
    },
  });
}

export const __test = Object.freeze({
  assertPlainObject,
  normalizeId,
  normalizeAbsoluteRoot,
  readConfigFile,
});
