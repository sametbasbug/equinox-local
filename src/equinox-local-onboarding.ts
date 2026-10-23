type ManagedInstallation = {
  managed?: boolean;
  selfUpdateSupported?: boolean;
  installRoot?: string;
  releaseDir?: string;
};
type OnboardingState = Readonly<{
  version: number;
  firstAgentCommandAt: string | null;
  completedAt: string | null;
}>;
type SupervisorPaths = ReturnType<typeof managedSupervisorPaths>;
type StateRead = Readonly<{exists: boolean; state: OnboardingState}>;
type OnboardingInput = Readonly<{tunnelId: string; runtimeKey: string}>;
type ManagedOptions = {
  installation?: ManagedInstallation;
  homeDir?: string | undefined;
};
type OnboardingStatusOptions = ManagedOptions & {
  supervisorMode?: string | null;
  browserUser?: {ready?: boolean; consentAccepted?: boolean; controlEnabled?: boolean} | null;
  reconcileCompletion?: boolean;
  now?: () => number;
};
type AgentCommandOptions = ManagedOptions & {
  supervisorMode?: string | null;
  now?: () => number;
};
type TunnelConfigOptions = ManagedOptions & {
  tunnelId?: unknown;
  runtimeKey?: unknown;
};
type OnboardingWriteOptions = {windowsHelperPath?: string | undefined};

import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { protectWindowsPrivateStatePath } from "./equinox-local-private-state.js";

import {
  readBoundedNormalFile,
  SAFE_FILE_ERROR_CODES,
} from "./equinox-local-safe-file.js";
import {
  managedSupervisorPaths,
  readSupervisorTransport,
  TUNNEL_ID_PATTERN,
} from "./equinox-local-supervisor.js";

const MAX_RUNTIME_KEY_BYTES = 4 * 1024;
const MAX_ONBOARDING_STATE_BYTES = 8 * 1024;
const MIN_RUNTIME_KEY_CHARS = 16;
const ONBOARDING_STATE_VERSION = 1;

function assertManagedInstallation(installation: ManagedInstallation | undefined): asserts installation is ManagedInstallation & {installRoot: string; releaseDir: string} {
  if (
    !installation?.managed ||
    !installation?.selfUpdateSupported ||
    typeof installation.installRoot !== "string" ||
    typeof installation.releaseDir !== "string"
  ) {
    throw new Error("Tunnel onboarding is available only for a managed Equinox Local installation.");
  }
}

async function ensurePrivateDirectory(directory: string) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Equinox Local onboarding directory is unsafe.");
  }
  await fs.chmod(directory, 0o700);
}

async function readOptionalNormalFile(filePath: string, { maxBytes = MAX_RUNTIME_KEY_BYTES }: {maxBytes?: number} = {}): Promise<Buffer | null> {
  try {
    const { data } = await readBoundedNormalFile(filePath, {
      minBytes: 1,
      maxBytes,
      label: "Existing onboarding file",
    });
    return data as Buffer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    if (
      (error as NodeJS.ErrnoException)?.code === SAFE_FILE_ERROR_CODES.notNormal ||
      (error as NodeJS.ErrnoException)?.code === SAFE_FILE_ERROR_CODES.tooSmall ||
      (error as NodeJS.ErrnoException)?.code === SAFE_FILE_ERROR_CODES.tooLarge
    ) {
      throw new Error("Existing onboarding file is unsafe.");
    }
    throw error;
  }
}

function defaultOnboardingState(): OnboardingState {
  return Object.freeze({
    version: ONBOARDING_STATE_VERSION,
    firstAgentCommandAt: null,
    completedAt: null,
  });
}

function normalizeTimestamp(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`Existing onboarding ${field} is invalid.`);
  }
  return new Date(value).toISOString();
}

function normalizeOnboardingState(value: unknown): OnboardingState {
  const state = value as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Array.isArray(value) || state?.version !== ONBOARDING_STATE_VERSION) {
    throw new Error("Existing onboarding state is invalid.");
  }
  const allowed = new Set(["version", "firstAgentCommandAt", "completedAt"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error("Existing onboarding state is invalid.");
  return Object.freeze({
    version: ONBOARDING_STATE_VERSION,
    firstAgentCommandAt: normalizeTimestamp(state?.firstAgentCommandAt, "firstAgentCommandAt"),
    completedAt: normalizeTimestamp(state?.completedAt, "completedAt"),
  });
}

async function readOnboardingState(paths: SupervisorPaths): Promise<StateRead> {
  const raw = await readOptionalNormalFile(paths.onboardingStatePath, { maxBytes: MAX_ONBOARDING_STATE_BYTES });
  if (!raw) return Object.freeze({ exists: false, state: defaultOnboardingState() });
  try {
    return Object.freeze({ exists: true, state: normalizeOnboardingState(JSON.parse(raw.toString("utf8"))) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Existing onboarding")) throw error;
    throw new Error("Existing onboarding state is invalid.");
  }
}

async function writeOnboardingState(paths: SupervisorPaths, state: OnboardingState, options: OnboardingWriteOptions = {}): Promise<OnboardingState> {
  const normalized = normalizeOnboardingState(state);
  await atomicWrite(paths.onboardingStatePath, `${JSON.stringify(normalized, null, 2)}\n`, 0o600, options);
  return normalized;
}

export async function initializeManagedOnboardingState({
  installation,
  homeDir = process.env.HOME,
}: ManagedOptions = {}) {
  assertManagedInstallation(installation);
  const paths = managedSupervisorPaths(homeDir);
  if (path.resolve(paths.installRoot) !== path.resolve(installation.installRoot!)) {
    throw new Error("Managed onboarding root does not match the active installation.");
  }
  const existing = await readOnboardingState(paths);
  if (existing.exists) return Object.freeze({ created: false, state: existing.state });
  // First-install loads the onboarding module from staging, which has been
  // renamed into the admitted release by the time credentials are persisted.
  // Pass the promoted native helper path instead of a now-missing staging path.
  const windowsHelperPath = process.platform === "win32"
    ? path.win32.join(installation.releaseDir, "equinox-local-windows-private-state.ps1")
    : undefined;
  const state = await writeOnboardingState(paths, defaultOnboardingState(), { windowsHelperPath });
  return Object.freeze({ created: true, state });
}

async function atomicWrite(filePath: string, contents: string | Buffer, mode = 0o600, { windowsHelperPath }: OnboardingWriteOptions = {}) {
  const parent = path.dirname(filePath);
  await ensurePrivateDirectory(parent);
  const temp = path.join(parent, `.equinox-onboarding-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temp, contents, { flag: "wx", mode });
    if (process.platform === "win32") {
      // Protect temporary bytes BEFORE they become the active credential;
      // Windows chmod(0600) does not establish current-user ACL isolation.
      await protectWindowsPrivateStatePath({ target: temp, type: "file", ...(windowsHelperPath ? { helperPath: windowsHelperPath } : {}) });
    }
    await fs.rename(temp, filePath);
    if (process.platform !== "win32") await fs.chmod(filePath, mode);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function validateRuntimeKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("Runtime API key must be text.");
  if (value.length < MIN_RUNTIME_KEY_CHARS || Buffer.byteLength(value, "utf8") > MAX_RUNTIME_KEY_BYTES) {
    throw new Error("Runtime API key has an invalid length.");
  }
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Runtime API key contains unsupported whitespace or control characters.");
  }
  return value;
}

export function validateTunnelOnboardingInput(body: unknown): Readonly<OnboardingInput> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Tunnel onboarding body must be a JSON object.");
  }
  const keys = Object.keys(body).sort();
  if (keys.length !== 2 || keys[0] !== "runtimeKey" || keys[1] !== "tunnelId") {
    throw new Error("Tunnel onboarding accepts only tunnelId and runtimeKey.");
  }
  if (typeof (body as Record<string, unknown>).tunnelId !== "string" || !TUNNEL_ID_PATTERN.test((body as Record<string, string>).tunnelId!)) {
    throw new Error("Tunnel ID must be tunnel_ followed by 32 lowercase hexadecimal characters.");
  }
  return Object.freeze({
    tunnelId: (body as Record<string, string>).tunnelId!,
    runtimeKey: validateRuntimeKey((body as Record<string, unknown>).runtimeKey),
  });
}

export async function getManagedOnboardingStatus({
  installation,
  homeDir = process.env.HOME,
  supervisorMode = process.env.EQUINOX_LOCAL_SUPERVISOR_MODE || null,
  browserUser = null,
  reconcileCompletion = false,
  now = () => Date.now(),
}: OnboardingStatusOptions = {}) {
  if (!installation?.managed || !installation?.selfUpdateSupported) {
    return Object.freeze({
      available: false,
      managed: false,
      transportConfigured: false,
      supervisorMode: "source",
      connectedThroughTunnel: false,
      needsAttention: false,
      setupComplete: true,
      firstAgentCommandAt: null,
      completedAt: null,
    });
  }
  const paths = managedSupervisorPaths(homeDir);
  if (path.resolve(paths.installRoot) !== path.resolve(installation.installRoot!)) {
    throw new Error("Managed onboarding root does not match the active installation.");
  }

  let transport = null;
  let transportError = null;
  try {
    transport = await readSupervisorTransport(paths);
  } catch (error) {
    transportError = error instanceof Error ? error.message : String(error);
  }
  const normalizedMode = supervisorMode === "tunnel" ? "tunnel" : "local-only";
  const connectedThroughTunnel = Boolean(transport && normalizedMode === "tunnel");
  const browserConnected = browserUser?.ready === true;
  const browserConsentAccepted = browserUser?.consentAccepted === true;
  const browserControlEnabled = browserUser?.controlEnabled === true;
  const stored = await readOnboardingState(paths);
  const legacyCompleted = !stored.exists;
  let state = stored.state;
  const canComplete = Boolean(
    connectedThroughTunnel &&
    browserConnected &&
    browserConsentAccepted &&
    browserControlEnabled &&
    state.firstAgentCommandAt
  );
  if (reconcileCompletion && !state.completedAt && canComplete) {
    state = await writeOnboardingState(paths, {
      ...state,
      completedAt: new Date(now()).toISOString(),
    });
  }

  return Object.freeze({
    available: true,
    managed: true,
    transportConfigured: Boolean(transport),
    tunnelId: transport?.tunnelId ?? null,
    supervisorMode: normalizedMode,
    connectedThroughTunnel,
    needsAttention: Boolean(transportError || (transport && normalizedMode !== "tunnel")),
    issue: transportError ? "Tunnel configuration needs attention." : null,
    setupComplete: legacyCompleted || Boolean(state.completedAt),
    legacyCompleted,
    firstAgentCommandAt: state.firstAgentCommandAt,
    completedAt: state.completedAt,
    browserRequired: true,
    browserConnected,
    browserConsentAccepted,
    browserControlEnabled,
    agentCommandReceived: Boolean(state.firstAgentCommandAt),
  });
}

export async function recordManagedAgentCommand({
  installation,
  homeDir = process.env.HOME,
  supervisorMode = process.env.EQUINOX_LOCAL_SUPERVISOR_MODE || null,
  now = () => Date.now(),
}: AgentCommandOptions = {}) {
  if (!installation?.managed || !installation?.selfUpdateSupported || supervisorMode !== "tunnel") {
    return Object.freeze({ recorded: false, reason: "not-managed-tunnel" });
  }
  const paths = managedSupervisorPaths(homeDir);
  if (path.resolve(paths.installRoot) !== path.resolve(installation.installRoot!)) {
    throw new Error("Managed onboarding root does not match the active installation.");
  }
  const transport = await readSupervisorTransport(paths);
  if (!transport) return Object.freeze({ recorded: false, reason: "transport-not-configured" });
  const stored = await readOnboardingState(paths);
  if (!stored.exists) return Object.freeze({ recorded: false, reason: "legacy-complete" });
  const state = stored.state;
  if (state.firstAgentCommandAt) {
    return Object.freeze({ recorded: false, reason: "already-recorded", firstAgentCommandAt: state.firstAgentCommandAt });
  }
  const firstAgentCommandAt = new Date(now()).toISOString();
  await writeOnboardingState(paths, { ...state, firstAgentCommandAt });
  return Object.freeze({ recorded: true, firstAgentCommandAt });
}

export async function configureManagedTunnel({
  installation,
  homeDir = process.env.HOME,
  tunnelId,
  runtimeKey,
}: TunnelConfigOptions = {}) {
  assertManagedInstallation(installation);
  const input = validateTunnelOnboardingInput({ tunnelId, runtimeKey });
  const paths = managedSupervisorPaths(homeDir);
  if (path.resolve(paths.installRoot) !== path.resolve(installation.installRoot!)) {
    throw new Error("Managed onboarding root does not match the active installation.");
  }

  await ensurePrivateDirectory(paths.installRoot);
  await ensurePrivateDirectory(path.dirname(paths.runtimeKeyPath));

  const previousKey = await readOptionalNormalFile(paths.runtimeKeyPath);
  const previousConfig = await readOptionalNormalFile(paths.transportConfigPath, { maxBytes: 16 * 1024 });
  const transport = `${JSON.stringify({
    version: 1,
    mode: "openai-tunnel",
    tunnelId: input.tunnelId,
  }, null, 2)}\n`;

  try {
    await atomicWrite(paths.runtimeKeyPath, input.runtimeKey, 0o600);
    await atomicWrite(paths.transportConfigPath, transport, 0o600);
  } catch (error) {
    try {
      if (previousKey) await atomicWrite(paths.runtimeKeyPath, previousKey, 0o600);
      else await fs.rm(paths.runtimeKeyPath, { force: true });
      if (previousConfig) await atomicWrite(paths.transportConfigPath, previousConfig, 0o600);
      else await fs.rm(paths.transportConfigPath, { force: true });
    } catch {
      // Preserve the original failure; the next status read will fail closed if rollback also failed.
    }
    throw error;
  }

  return Object.freeze({
    configured: true,
    tunnelId: input.tunnelId,
    restartRequired: true,
  });
}
