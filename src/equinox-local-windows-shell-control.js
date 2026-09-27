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
