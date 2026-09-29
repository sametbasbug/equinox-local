import net from "node:net";

export const EQUINOX_LOCAL_WINDOWS_SHELL_PIPE = String.raw`\\.\pipe\EquinoxLocal.WindowsShell.Reopen`;
const DEFAULT_TIMEOUT_MS = 3_000;

export async function requestWindowsShellRuntimeRestart({
  platform = process.platform,
  connectImpl = net.createConnection,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (platform !== "win32") throw new Error("Windows shell runtime restart is available only on Windows.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15_000) {
    throw new Error("Windows shell restart timeout is out of bounds.");
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    const socket = connectImpl({ path: EQUINOX_LOCAL_WINDOWS_SHELL_PIPE });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("error");
      socket.removeAllListeners("connect");
      if (error) reject(error);
      else resolve(Object.freeze({ requested: true }));
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("Equinox Local Windows shell did not accept the runtime restart request in time."));
    }, timeoutMs);
    socket.once("error", (error) => finish(new Error(`Equinox Local Windows shell restart request failed: ${error.message}`)));
    socket.once("connect", () => {
      socket.end("restart-runtime\n", () => finish());
    });
  });
}

export async function requestWindowsShellUpdateShutdown({
  platform = process.platform,
  connectImpl = net.createConnection,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (platform !== "win32") throw new Error("Windows shell update shutdown is available only on Windows.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15_000) {
    throw new Error("Windows shell update shutdown timeout is out of bounds.");
  }
  return await new Promise((resolve, reject) => {
    let settled = false;
    const socket = connectImpl({ path: EQUINOX_LOCAL_WINDOWS_SHELL_PIPE });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners("error");
      socket.removeAllListeners("connect");
      if (error) reject(error);
      else resolve(Object.freeze({ requested: true }));
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error("Equinox Local Windows shell did not accept the update shutdown request in time."));
    }, timeoutMs);
    socket.once("error", (error) => finish(new Error(`Equinox Local Windows update shutdown request failed: ${error.message}`)));
    socket.once("connect", () => {
      socket.end("shutdown-for-update\n", () => finish());
    });
  });
}

export async function requestWindowsShellManagedActivation(version, {
  platform = process.platform,
  connectImpl = net.createConnection,
  timeoutMs = 5_000,
} = {}) {
  if (platform !== "win32") throw new Error("Windows managed activation handoff is available only on Windows.");
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error("Windows managed activation requires an exact semantic version.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15_000) {
    throw new Error("Windows managed activation handoff timeout is out of bounds.");
  }
  return await new Promise((resolve, reject) => {
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
      else resolve(Object.freeze({ requested: true, version }));
    };
    const timer = setTimeout(() => finish(new Error("Equinox Local Windows shell did not acknowledge the managed activation handoff in time.")), timeoutMs);
    socket.setEncoding?.("utf8");
    socket.once("error", (error) => finish(new Error(`Equinox Local Windows activation handoff failed: ${error.message}`)));
    socket.on("data", (chunk) => {
      response += String(chunk);
      const newline = response.indexOf("\n");
      if (newline < 0) {
        if (response.length > 512) finish(new Error("Equinox Local Windows activation handoff reply exceeded the bound."));
        return;
      }
      const line = response.slice(0, newline).trim();
      if (line === "ok") finish();
      else if (line.startsWith("error:")) finish(new Error(`Equinox Local Windows activation handoff was refused: ${line.slice(6, 306)}`));
      else finish(new Error("Equinox Local Windows activation handoff returned an invalid reply."));
    });
    socket.once("connect", () => socket.write(`activate-release:${version}\n`));
  });
}
