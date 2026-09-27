import { randomUUID } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_STDERR_CHARS = 16_384;
const DEFAULT_HELPER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "equinox-local-windows-job-object.ps1");

function boundedTail(current, addition) {
  const combined = current + String(addition ?? "");
  return combined.length <= MAX_STDERR_CHARS ? combined : combined.slice(-MAX_STDERR_CHARS);
}

export async function createWindowsJobObjectLease({
  platform = process.platform,
  helperPath = DEFAULT_HELPER_PATH,
  spawnImpl = nodeSpawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (platform !== "win32") throw new Error("Windows Job Object leases are available only on win32.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error("Windows Job Object timeout is invalid.");

  const child = spawnImpl("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath,
  ], {
    windowsHide: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  let stdoutBuffer = "";
  let closed = false;
  const pending = new Map();

  child.stderr?.on("data", (chunk) => { stderr = boundedTail(stderr, chunk); });

  const failAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  child.once("error", (error) => {
    closed = true;
    failAll(error);
  });
  child.once("exit", (code, signal) => {
    closed = true;
    failAll(new Error(`Windows Job Object helper exited unexpectedly (${code ?? "null"}/${signal ?? "null"}). ${stderr}`.trim()));
  });

  const waitReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Windows Job Object helper readiness timed out. ${stderr}`.trim())), timeoutMs);
    timer.unref?.();
    pending.set("__ready__", { resolve, reject, timer });
  });

  child.stdout?.on("data", (chunk) => {
    stdoutBuffer += String(chunk ?? "");
    while (true) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); } catch { continue; }
      const key = response.ready === true ? "__ready__" : String(response.id ?? "");
      const request = pending.get(key);
      if (!request) continue;
      pending.delete(key);
      clearTimeout(request.timer);
      if (response.ok === true) request.resolve(response);
      else request.reject(new Error(String(response.error || "Windows Job Object helper request failed.")));
    }
  });

  await waitReady;

  const request = (op, payload = {}) => {
    if (closed || !child.stdin?.writable) return Promise.reject(new Error("Windows Job Object helper is not available."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Windows Job Object ${op} timed out. ${stderr}`.trim()));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`, (error) => {
        if (!error) return;
        const current = pending.get(id);
        if (!current) return;
        pending.delete(id);
        clearTimeout(current.timer);
        reject(error);
      });
    });
  };

  return Object.freeze({
    kind: "job-object",
    helperPid: Number.isInteger(child.pid) ? child.pid : null,
    async assign(pid) {
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Windows Job Object assignment requires a positive PID.");
      return request("assign", { pid });
    },
    async status() { return request("status"); },
    async terminate(exitCode = 1) {
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 0xffffffff) throw new Error("Windows Job Object exit code is invalid.");
      return request("terminate", { exitCode });
    },
    async close() {
      if (closed) return;
      await request("close");
      closed = true;
      child.stdin?.end();
    },
  });
}
