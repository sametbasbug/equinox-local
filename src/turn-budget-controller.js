import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const TURN_BUDGET_DEFAULTS = Object.freeze({
  enabled: true,
  cutoffMinutes: 22,
  checkpointLeadMinutes: 4,
  finalizeLeadMinutes: 2,
  maxCutoffMinutes: 120,
  minCutoffMinutes: 5,
  fallbackResetMinutes: 5,
  minFallbackResetMinutes: 1,
  maxFallbackResetMinutes: 120,
  finalizationReserveMs: 60_000,
});

function normalizeSettings(value = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Turn Budget settings must be an object.");
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") throw new Error("Turn Budget enabled must be true or false.");
  const cutoffMinutes = value.cutoffMinutes === undefined ? TURN_BUDGET_DEFAULTS.cutoffMinutes : value.cutoffMinutes;
  if (!Number.isInteger(cutoffMinutes) || cutoffMinutes < TURN_BUDGET_DEFAULTS.minCutoffMinutes || cutoffMinutes > TURN_BUDGET_DEFAULTS.maxCutoffMinutes) {
    throw new Error(`Turn Budget cutoffMinutes must be between ${TURN_BUDGET_DEFAULTS.minCutoffMinutes} and ${TURN_BUDGET_DEFAULTS.maxCutoffMinutes}.`);
  }
  const fallbackResetMinutes = value.fallbackResetMinutes === undefined
    ? TURN_BUDGET_DEFAULTS.fallbackResetMinutes
    : value.fallbackResetMinutes;
  if (
    !Number.isInteger(fallbackResetMinutes) ||
    fallbackResetMinutes < TURN_BUDGET_DEFAULTS.minFallbackResetMinutes ||
    fallbackResetMinutes > TURN_BUDGET_DEFAULTS.maxFallbackResetMinutes ||
    fallbackResetMinutes > cutoffMinutes
  ) {
    throw new Error(`Turn Budget fallbackResetMinutes must be between ${TURN_BUDGET_DEFAULTS.minFallbackResetMinutes} and cutoffMinutes (${cutoffMinutes}).`);
  }
  return Object.freeze({ enabled, cutoffMinutes, fallbackResetMinutes });
}

export function defaultTurnBudgetSettingsPath(homeDir = os.homedir()) {
  return path.join(homeDir, "Library", "Application Support", "Equinox Local", "turn-budget.json");
}

async function readSettingsFile(settingsPath, fsImpl) {
  try { return normalizeSettings(JSON.parse(await fsImpl.readFile(settingsPath, "utf8"))); }
  catch (error) { if (error?.code === "ENOENT") return normalizeSettings(); throw error; }
}

function stageForElapsed(elapsedMs, cutoffMinutes) {
  const cutoffMs = cutoffMinutes * 60_000;
  const checkpointAt = Math.max(0, cutoffMs - TURN_BUDGET_DEFAULTS.checkpointLeadMinutes * 60_000);
  const finalizeAt = Math.max(checkpointAt, cutoffMs - TURN_BUDGET_DEFAULTS.finalizeLeadMinutes * 60_000);
  if (elapsedMs >= cutoffMs) return "overdue";
  if (elapsedMs >= finalizeAt) return "finalize";
  if (elapsedMs >= checkpointAt) return "checkpoint";
  return "running";
}

function clampWaitMs(waitMs, remainingMs) {
  if (!Number.isInteger(waitMs) || waitMs < 0) return waitMs;
  if (remainingMs > TURN_BUDGET_DEFAULTS.finalizeLeadMinutes * 60_000) return waitMs;
  const cap = Math.max(5_000, remainingMs - TURN_BUDGET_DEFAULTS.finalizationReserveMs);
  return Math.max(0, Math.min(waitMs, cap));
}

function noticeFor({ stage, cutoffMinutes, elapsedMs, remainingMs, source, firstNotice }) {
  const elapsedMin = Math.max(0, elapsedMs / 60_000);
  const remainingMin = Math.max(0, remainingMs / 60_000);
  if (firstNotice) return `[Equinox Local · Turn Budget] This assistant turn has a ${cutoffMinutes}-minute safety cutoff starting from the first Equinox Local use${source === "browser" ? " and is bound to the current ChatGPT assistant turn" : ""}. Plan long work so you can checkpoint and send a normal final response before the platform hard stop.`;
  if (stage === "checkpoint") return `[Equinox Local · Turn Budget] About ${remainingMin.toFixed(1)} minutes remain before the ${cutoffMinutes}-minute safety cutoff. Do not start a new major subtask. Finish the current safe checkpoint and prepare Task Capsule/continuation state if more work will remain.`;
  if (stage === "finalize") return `[Equinox Local · Turn Budget] FINALIZATION WINDOW: about ${remainingMin.toFixed(1)} minutes remain before the ${cutoffMinutes}-minute safety cutoff (${elapsedMin.toFixed(1)}m elapsed). Finish the current safe checkpoint now. If work remains, update the Task Capsule and arm Auto Continue, then send the user a normal final response. Avoid long tool waits.`;
  if (stage === "overdue") return `[Equinox Local · Turn Budget] SAFETY CUTOFF REACHED (${cutoffMinutes}m). Do not start or continue substantial work. Persist the current checkpoint, arm Auto Continue if needed, and send the user a normal final response immediately.`;
  return null;
}

function appendNotice(result, notice) {
  if (!notice || !result || typeof result !== "object") return result;
  const content = Array.isArray(result.content) ? result.content.map((item) => ({ ...item })) : [];
  const textIndex = content.findIndex((item) => item?.type === "text" && typeof item.text === "string");
  if (textIndex >= 0) content[textIndex].text = `${content[textIndex].text}\n\n${notice}`;
  else content.push({ type: "text", text: notice });
  const next = { ...result, content };
  if (result.structuredContent && typeof result.structuredContent === "object" && typeof result.structuredContent.text === "string") {
    next.structuredContent = { ...result.structuredContent, text: `${result.structuredContent.text}\n\n${notice}` };
  }
  return next;
}

export function createTurnBudgetController({ settingsPath = defaultTurnBudgetSettingsPath(), fsImpl = fs, now = () => Date.now(), resolveTurnIdentity = async () => null } = {}) {
  let settings = normalizeSettings();
  let active = null;

  async function initialize() { settings = await readSettingsFile(settingsPath, fsImpl); return snapshot(); }
  async function updateSettings(next) {
    const normalized = normalizeSettings(next);
    const parent = path.dirname(settingsPath);
    await fsImpl.mkdir(parent, { recursive: true, mode: 0o700 });
    await fsImpl.chmod(parent, 0o700).catch(() => {});
    await fsImpl.writeFile(settingsPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
    await fsImpl.chmod(settingsPath, 0o600).catch(() => {});
    settings = normalized;
    if (!settings.enabled) active = null;
    return snapshot();
  }
  function expireStaleFallback(timestamp = now()) {
    if (
      active?.source === "fallback" &&
      timestamp - active.lastInvocationAtMs >= settings.fallbackResetMinutes * 60_000
    ) {
      active = null;
      return true;
    }
    return false;
  }

  async function resolveIdentitySafe() {
    try {
      const result = await resolveTurnIdentity();
      if (!result || typeof result !== "object") return Object.freeze({ status: "unknown" });
      if (result.status === "idle") {
        const idleContexts = Array.isArray(result.idleContexts)
          ? result.idleContexts.filter((value) => value === "agent" || value === "user")
          : [];
        return Object.freeze({ status: "idle", idleContexts: Object.freeze([...new Set(idleContexts)]) });
      }
      if (!result.assistantTurnKey) return Object.freeze({ status: "unknown" });
      const context = result.browserContext || "unknown";
      const conversationId = result.conversationId || "unknown";
      const userEpoch = typeof result.userEpoch === "string" && result.userEpoch ? result.userEpoch : null;
      const turnKey = userEpoch ? `user:${userEpoch}` : `assistant:${result.assistantTurnKey}`;
      return Object.freeze({
        status: "active",
        identity: Object.freeze({
          key: `${context}:${conversationId}:${turnKey}`,
          browserContext: context,
          title: typeof result.title === "string" ? result.title.slice(0, 160) : "ChatGPT",
        }),
      });
    } catch {
      return Object.freeze({ status: "unknown" });
    }
  }
  async function prepareInvocation(toolName, input) {
    const timestamp = now();
    if (!settings.enabled) { active = null; return Object.freeze({ input, firstNotice: false, waitClamped: false }); }
    expireStaleFallback(timestamp);
    const probe = await resolveIdentitySafe();
    const identity = probe.status === "active" ? probe.identity : null;
    if (identity) {
      if (!active || active.key !== identity.key) active = { key: identity.key, source: "browser", browserContext: identity.browserContext, title: identity.title, startedAtMs: timestamp, lastInvocationAtMs: timestamp, notices: new Set() };
    } else if (!active) {
      active = { key: `fallback:${timestamp}`, source: "fallback", browserContext: null, title: null, startedAtMs: timestamp, lastInvocationAtMs: timestamp, notices: new Set() };
    }
    active.lastInvocationAtMs = timestamp;
    const elapsedMs = Math.max(0, timestamp - active.startedAtMs);
    const remainingMs = Math.max(0, settings.cutoffMinutes * 60_000 - elapsedMs);
    let adjustedInput = input;
    let waitClamped = false;
    if (toolName === "runtime_call" && input && typeof input === "object" && input.arguments && typeof input.arguments === "object") {
      const originalWait = input.arguments.wait_ms;
      const adjustedWait = clampWaitMs(originalWait, remainingMs);
      if (Number.isInteger(originalWait) && Number.isInteger(adjustedWait) && adjustedWait < originalWait) {
        adjustedInput = { ...input, arguments: { ...input.arguments, wait_ms: adjustedWait } };
        waitClamped = true;
      }
    }
    return Object.freeze({ input: adjustedInput, firstNotice: !active.notices.has("start"), waitClamped });
  }
  function decorateResult(result, context = {}) {
    if (!settings.enabled || !active) return result;
    const timestamp = now();
    active.lastInvocationAtMs = timestamp;
    const elapsedMs = Math.max(0, timestamp - active.startedAtMs);
    const cutoffMs = settings.cutoffMinutes * 60_000;
    const remainingMs = Math.max(0, cutoffMs - elapsedMs);
    const stage = stageForElapsed(elapsedMs, settings.cutoffMinutes);
    const notices = [];
    if (context.firstNotice && !active.notices.has("start")) { active.notices.add("start"); notices.push(noticeFor({ stage, cutoffMinutes: settings.cutoffMinutes, elapsedMs, remainingMs, source: active.source, firstNotice: true })); }
    if (stage !== "running" && !active.notices.has(stage)) { active.notices.add(stage); notices.push(noticeFor({ stage, cutoffMinutes: settings.cutoffMinutes, elapsedMs, remainingMs, source: active.source, firstNotice: false })); }
    if (context.waitClamped) notices.push("[Equinox Local · Turn Budget] A requested blocking wait was shortened so control returns before the safety cutoff.");
    return appendNotice(result, notices.filter(Boolean).join("\n"));
  }
  async function refreshSnapshot() {
    if (!settings.enabled) return snapshot();
    const timestamp = now();
    expireStaleFallback(timestamp);
    if (!active) return snapshot();
    const probe = await resolveIdentitySafe();
    if (active?.source === "browser") {
      if (probe.status === "idle" && probe.idleContexts.includes(active.browserContext)) {
        active = null;
      } else if (probe.status === "active" && probe.identity.key !== active.key) {
        // A different assistant turn is generating, but Turn Budget starts only on that turn's first Local call.
        active = null;
      }
    }
    return snapshot();
  }

  function snapshot() {
    const timestamp = now();
    if (settings.enabled) expireStaleFallback(timestamp);
    const base = { enabled: settings.enabled, cutoffMinutes: settings.cutoffMinutes, fallbackResetMinutes: settings.fallbackResetMinutes };
    if (!settings.enabled) return Object.freeze({ ...base, active: null });
    if (!active) return Object.freeze({ ...base, active: null });
    const elapsedMs = Math.max(0, timestamp - active.startedAtMs);
    const cutoffMs = settings.cutoffMinutes * 60_000;
    return Object.freeze({ ...base, active: Object.freeze({ source: active.source, browserContext: active.browserContext, title: active.title, startedAt: new Date(active.startedAtMs).toISOString(), elapsedMs, remainingMs: Math.max(0, cutoffMs - elapsedMs), stage: stageForElapsed(elapsedMs, settings.cutoffMinutes) }) });
  }
  return Object.freeze({ initialize, updateSettings, prepareInvocation, decorateResult, refreshSnapshot, snapshot });
}

export const __test = Object.freeze({ normalizeSettings, stageForElapsed, clampWaitMs, appendNotice });
