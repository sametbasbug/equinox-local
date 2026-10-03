import net from "node:net";

export const EQUINOX_LOCAL_WINDOWS_SHELL_PIPE = String.raw`\\.\pipe\EquinoxLocal.WindowsShell.Reopen`;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_ACK_TIMEOUT_MS = 5_000;

function requestOneWayShellCommand({
  platform,
  connectImpl,
  timeoutMs,
  command,
  platformError,
  timeoutBoundsError,
  timeoutError,
  connectionError,
  result,
}) {
  if (platform !== "win32") throw new Error(platformError);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15_000) {
    throw new Error(timeoutBoundsError);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connectImpl({ path: EQUINOX_LOCAL_WINDOWS_SHELL_PIPE });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("error");
      socket.removeAllListeners("connect");
      if (error) reject(error);
      else resolve(result());
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error(timeoutError));
    }, timeoutMs);
    socket.once("error", (error) => finish(new Error(`${connectionError}${error.message}`)));
    socket.once("connect", () => {
      socket.end(command, () => finish());
    });
  });
}

function requestAcknowledgedShellCommand({
  connectImpl,
  timeoutMs,
  command,
  timeoutError,
  connectionError,
  replyBoundError,
  refusalPrefix,
  invalidReplyError,
  result,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = "";
    const socket = connectImpl({ path: EQUINOX_LOCAL_WINDOWS_SHELL_PIPE });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy?.();
      if (error) reject(error);
      else resolve(result());
    };
    const timer = setTimeout(() => finish(new Error(timeoutError)), timeoutMs);
    socket.setEncoding?.("utf8");
    socket.once("error", (error) => finish(new Error(`${connectionError}${error.message}`)));
    socket.on("data", (chunk) => {
      response += String(chunk);
      const newline = response.indexOf("\n");
      if (newline < 0) {
        if (response.length > 512) finish(new Error(replyBoundError));
        return;
      }
      const line = response.slice(0, newline).trim();
      if (line === "ok") finish();
      else if (line.startsWith("error:")) {
        finish(new Error(`${refusalPrefix}${line.slice(6, 306)}`));
      } else finish(new Error(invalidReplyError));
    });
    socket.once("connect", () => socket.write(command));
  });
}

export async function requestWindowsShellRuntimeRestart({
  platform = process.platform,
  connectImpl = net.createConnection,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return await requestOneWayShellCommand({
    platform,
    connectImpl,
    timeoutMs,
    command: "restart-runtime\n",
    platformError: "Windows shell runtime restart is available only on Windows.",
    timeoutBoundsError: "Windows shell restart timeout is out of bounds.",
    timeoutError: "Equinox Local Windows shell did not accept the runtime restart request in time.",
    connectionError: "Equinox Local Windows shell restart request failed: ",
    result: () => Object.freeze({ requested: true }),
  });
}

export async function requestWindowsShellUpdateShutdown({
  platform = process.platform,
  connectImpl = net.createConnection,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  return await requestOneWayShellCommand({
    platform,
    connectImpl,
    timeoutMs,
    command: "shutdown-for-update\n",
    platformError: "Windows shell update shutdown is available only on Windows.",
    timeoutBoundsError: "Windows shell update shutdown timeout is out of bounds.",
    timeoutError: "Equinox Local Windows shell did not accept the update shutdown request in time.",
    connectionError: "Equinox Local Windows update shutdown request failed: ",
    result: () => Object.freeze({ requested: true }),
  });
}

export async function requestWindowsShellManagedActivation(version, {
  platform = process.platform,
  connectImpl = net.createConnection,
  timeoutMs = DEFAULT_ACK_TIMEOUT_MS,
} = {}) {
  if (platform !== "win32") throw new Error("Windows managed activation handoff is available only on Windows.");
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error("Windows managed activation requires an exact semantic version.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15_000) {
    throw new Error("Windows managed activation handoff timeout is out of bounds.");
  }
  return await requestAcknowledgedShellCommand({
    connectImpl,
    timeoutMs,
    command: `activate-release:${version}\n`,
    timeoutError: "Equinox Local Windows shell did not acknowledge the managed activation handoff in time.",
    connectionError: "Equinox Local Windows activation handoff failed: ",
    replyBoundError: "Equinox Local Windows activation handoff reply exceeded the bound.",
    refusalPrefix: "Equinox Local Windows activation handoff was refused: ",
    invalidReplyError: "Equinox Local Windows activation handoff returned an invalid reply.",
    result: () => Object.freeze({ requested: true, version }),
  });
}

export async function requestWindowsShellManagedUninstall(removeUserData, {
  platform = process.platform,
  connectImpl = net.createConnection,
  timeoutMs = DEFAULT_ACK_TIMEOUT_MS,
} = {}) {
  if (platform !== "win32") throw new Error("Windows managed uninstall handoff is available only on Windows.");
  if (typeof removeUserData !== "boolean") throw new Error("Windows managed uninstall requires an explicit data policy.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15_000) throw new Error("Windows managed uninstall handoff timeout is out of bounds.");
  const mode = removeUserData ? "remove-user-data" : "preserve-user-data";
  return await requestAcknowledgedShellCommand({
    connectImpl,
    timeoutMs,
    command: `uninstall:${mode}\n`,
    timeoutError: "Equinox Local Windows shell did not acknowledge the managed uninstall handoff in time.",
    connectionError: "Equinox Local Windows uninstall handoff failed: ",
    replyBoundError: "Equinox Local Windows uninstall handoff reply exceeded the bound.",
    refusalPrefix: "Equinox Local Windows uninstall handoff was refused: ",
    invalidReplyError: "Equinox Local Windows uninstall handoff returned an invalid reply.",
    result: () => Object.freeze({ requested: true, removeUserData }),
  });
}
