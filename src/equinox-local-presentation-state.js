const SUCCESS_STATE_WINDOW_MS = 60_000;
const COMPLETION_NOTIFICATION_WINDOW_MS = 5 * 60_000;
const MAX_TITLE_CHARS = 120;

function boundedTitle(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "Untitled task";
  return text.length <= MAX_TITLE_CHARS ? text : `${text.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

function timeMs(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function newest(tasks, predicate) {
  return tasks
    .filter(predicate)
    .sort((left, right) => timeMs(right.updatedAt) - timeMs(left.updatedAt))[0] ?? null;
}

function taskSummary(task) {
  if (!task) return null;
  return Object.freeze({
    taskId: task.taskId,
    title: boundedTitle(task.title),
    status: task.status,
    checkpointRevision: task.checkpointRevision,
    updatedAt: task.updatedAt ?? null,
    freshResumeStatus: task.freshResume?.status ?? null,
    continuationStatus: task.continuation?.status ?? null,
  });
}

function notificationFor({ tasks, healthState, nowMs }) {
  const freshResumeTask = newest(
    tasks,
    (task) => task.status === "active" && task.freshResume?.status === "ambiguous",
  );
  if (freshResumeTask) {
    const resumeKey = freshResumeTask.freshResume?.resumeId
      ?? `checkpoint-${freshResumeTask.checkpointRevision}`;
    return Object.freeze({
      id: `fresh-resume-attention:${freshResumeTask.taskId}:${resumeKey}`,
      kind: "fresh_resume_attention",
      title: "Equinox Local needs attention",
      body: `${boundedTitle(freshResumeTask.title)} needs Fresh Chat Resume recovery.`,
      taskId: freshResumeTask.taskId,
    });
  }

  if (["ATTENTION REQUIRED", "ATTENTION_REQUIRED", "CRITICAL"].includes(healthState)) {
    return Object.freeze({
      id: `runtime-attention:${healthState}`,
      kind: "runtime_attention",
      title: "Equinox Local needs attention",
      body: "Runtime health requires your attention. Open Control Center for details.",
      taskId: null,
    });
  }

  const completedTask = newest(tasks, (task) => task.status === "completed" && Boolean(task.completedAt));
  if (
    completedTask
    && nowMs >= timeMs(completedTask.completedAt)
    && nowMs - timeMs(completedTask.completedAt) <= COMPLETION_NOTIFICATION_WINDOW_MS
  ) {
    return Object.freeze({
      id: `task-completed:${completedTask.taskId}:${completedTask.completedAt}`,
      kind: "task_completed",
      title: "Task completed",
      body: boundedTitle(completedTask.title),
      taskId: completedTask.taskId,
    });
  }

  return null;
}

export function deriveEquinoxLocalPresentationState({ status, tasks = [], now = Date.now() } = {}) {
  const safeStatus = status && typeof status === "object" ? status : {};
  const safeTasks = Array.isArray(tasks) ? tasks.filter((task) => task && typeof task === "object") : [];
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const healthState = String(safeStatus.health?.state ?? "UNKNOWN").toUpperCase();
  const paused = safeStatus.agentControl?.paused === true || safeStatus.agentControl?.state === "PAUSED";
  const activeWork = safeStatus.agentControl?.activeWork ?? {};
  const activeWorkCount = Number.isInteger(activeWork.total)
    ? Math.max(0, activeWork.total)
    : Math.max(0, Number(activeWork.terminals ?? 0)) + Math.max(0, Number(activeWork.processes ?? 0));
  const agentBrowserReady = safeStatus.browser?.contexts?.agent?.ready === true;
  const activeTask = newest(safeTasks, (task) => task.status === "active");
  const attentionTask = newest(
    safeTasks,
    (task) => task.status === "active" && task.freshResume?.status === "ambiguous",
  );
  const waitingTask = newest(
    safeTasks,
    (task) => task.status === "active" && (
      ["prepared", "creating"].includes(task.freshResume?.status)
      || ["armed", "delivering"].includes(task.continuation?.status)
    ),
  );
  const latestCompletedTask = newest(safeTasks, (task) => task.status === "completed" && Boolean(task.completedAt));
  const completedAtMs = latestCompletedTask ? timeMs(latestCompletedTask.completedAt) : 0;
  const recentlyCompleted = latestCompletedTask
    && nowMs >= completedAtMs
    && nowMs - completedAtMs <= SUCCESS_STATE_WINDOW_MS;
  const healthNeedsAttention = healthState !== "HEALTHY";

  let state = "idle";
  let label = "Idle";
  let detail = "Ready for agent work";

  if (paused) {
    state = "emergency_stopped";
    label = "Emergency Stopped";
    detail = "Agent mutations are paused";
  } else if (attentionTask || healthNeedsAttention) {
    state = "needs_attention";
    label = "Needs Attention";
    detail = attentionTask
      ? `${boundedTitle(attentionTask.title)} needs recovery`
      : "Runtime health needs attention";
  } else if (waitingTask) {
    state = "waiting";
    label = "Waiting";
    detail = `${boundedTitle(waitingTask.title)} is waiting for continuation`;
  } else if (activeWorkCount > 0) {
    state = "working";
    label = "Working";
    detail = `${activeWorkCount} managed operation${activeWorkCount === 1 ? "" : "s"} active`;
  } else if (recentlyCompleted) {
    state = "success";
    label = "Completed";
    detail = boundedTitle(latestCompletedTask.title);
  }

  return Object.freeze({
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    state,
    label,
    detail,
    task: taskSummary(activeTask ?? (recentlyCompleted ? latestCompletedTask : null)),
    runtime: Object.freeze({
      healthState,
      paused,
      activeWorkCount,
    }),
    browser: Object.freeze({
      agentReady: agentBrowserReady,
    }),
    notification: notificationFor({ tasks: safeTasks, healthState, nowMs }),
  });
}
