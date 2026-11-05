import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  requestWindowsShellRuntimeRestart,
  requestWindowsShellUpdateShutdown,
} from "./equinox-local-windows-shell-control.js";

type DesktopControlOptions = Readonly<{
  platform?: string;
  homeDir?: string;
  timeoutMs?: number;
}>;

async function requestMacCommand(command: "restart-runtime" | "shutdown-for-update" | "shutdown-for-uninstall", {
  homeDir = os.homedir(), timeoutMs = 3_000,
}: DesktopControlOptions): Promise<Readonly<{ requested: true; ownerPid?: number }>> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 15_000) throw new Error("Desktop lifecycle timeout is out of bounds.");
  const uid = process.getuid?.();
  if (uid === undefined || !path.isAbsolute(homeDir) || await fs.realpath(homeDir) !== homeDir) throw new Error("Canonical current-user home required.");
  let directory = homeDir;
  for (const part of ["Library", "Application Support", "Equinox Local", "state"]) {
    directory = path.join(directory, part);
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.uid !== uid || await fs.realpath(directory) !== directory) throw new Error("Unsafe desktop lifecycle directory.");
  }
  const parent = await fs.lstat(directory);
  if ((parent.mode & 0o777) !== 0o700) throw new Error("Desktop lifecycle state directory is not private.");
  const socketPath = path.join(directory, "desktop-control.sock");
  const endpoint = await fs.lstat(socketPath);
  if (!endpoint.isSocket() || endpoint.uid !== uid || (endpoint.mode & 0o777) !== 0o600) throw new Error("Unsafe desktop lifecycle socket.");
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    let receipt = "";
    const acknowledged = command !== "restart-runtime";
    const finish = (error?: Error, ownerPid?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(Object.freeze({ requested: true, ...(ownerPid === undefined ? {} : { ownerPid }) }));
    };
    const timer = setTimeout(() => finish(new Error("Desktop lifecycle write timed out.")), timeoutMs);
    socket.once("error", finish);
    socket.once("close", () => { if (!settled) finish(new Error("Desktop lifecycle transport closed before write completion.")); });
    socket.on("data", (chunk: Buffer) => {
      if (!acknowledged || settled) return;
      if (Buffer.byteLength(receipt) + chunk.length > 64 || chunk.some((byte) => byte > 127)) {
        finish(new Error("Invalid desktop shutdown receipt.")); return;
      }
      receipt += chunk.toString("ascii");
    });
    socket.once("end", () => {
      if (!acknowledged || settled) return;
      const match = /^owner:([1-9][0-9]{0,9})\n$/u.exec(receipt);
      const ownerPid = match ? Number(match[1]) : 0;
      if (!Number.isSafeInteger(ownerPid) || ownerPid < 1 || ownerPid > 2_147_483_647) finish(new Error("Invalid desktop shutdown owner."));
      else finish(undefined, ownerPid);
    });
    // Restart remains one-way. Shutdown returns the exact owner to wait for, not an exit claim.
    socket.once("connect", () => {
      if (acknowledged) socket.write(`${command}\n`);
      else socket.end(`${command}\n`, () => finish());
    });
  });
}

export async function requestDesktopRuntimeRestart(options: DesktopControlOptions = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return await requestWindowsShellRuntimeRestart({ platform, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
  if (platform !== "darwin") throw new Error("Desktop runtime restart requires macOS or Windows.");
  return await requestMacCommand("restart-runtime", options);
}

export async function requestDesktopUpdateShutdown(options: DesktopControlOptions = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return await requestWindowsShellUpdateShutdown({ platform, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
  if (platform !== "darwin") throw new Error("Desktop update shutdown requires macOS or Windows.");
  return await requestMacCommand("shutdown-for-update", options);
}

export async function requestDesktopUninstallShutdown(options: DesktopControlOptions = {}) {
  if ((options.platform ?? process.platform) !== "darwin") throw new Error("Desktop uninstall shutdown requires macOS.");
  const response = await requestMacCommand("shutdown-for-uninstall", options);
  if (response.ownerPid === undefined) throw new Error("Desktop uninstall owner receipt is missing.");
  return Object.freeze({ requested: true as const, ownerPid: response.ownerPid });
}
