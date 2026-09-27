import path from "node:path";
import { fileURLToPath } from "node:url";

import { equinoxLocalReleaseTarget } from "./equinox-local-platform.js";
import { createWindowsJobObjectLease } from "./equinox-local-windows-job-object.js";

const WINDOWS_GATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "equinox-local-windows-process-gate.ps1");
const WINDOWS_PTY_GATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "equinox-local-windows-pty-gate.ps1");
const WINDOWS_PTY_INNER_READY_MARKER = "__EQUINOX_INNER_PTY_READY__";

function encodeWindowsOwnedProcess(command, args) {
  return Buffer.from(JSON.stringify({ command, args }), "utf8").toString("base64");
}

function encodeWindowsOwnedPty(command, args) {
  return Buffer.from(JSON.stringify({ command, args }), "utf8").toString("base64");
}

function unsupported(kind, platform) {
  const error = new Error(`Equinox Local ${kind} process ownership is not implemented on ${platform}.`);
  error.code = "EQUINOX_PROCESS_OWNERSHIP_UNIMPLEMENTED";
  return error;
}

export function createBackgroundProcessOwnershipAdapter({
  platform = process.platform,
  arch = process.arch,
  groupExists,
  signalGroup,
} = {}) {
  equinoxLocalReleaseTarget({ platform, arch });
  if (platform === "darwin") {
    if (typeof groupExists !== "function" || typeof signalGroup !== "function") {
      throw new Error("Darwin background process ownership requires group probe and signal adapters.");
    }
    return Object.freeze({
      kind: "posix-process-group",
      implemented: true,
      detached: true,
      ownedSetExists(pid) { return groupExists(pid); },
      signalOwnedSet(pid, signal) { return signalGroup(pid, signal); },
    });
  }
  return Object.freeze({
    kind: "job-object",
    implemented: true,
    detached: false,
    async createOwnedSet() {
      return createWindowsJobObjectLease({ platform });
    },
    spawnSpec(command, args, env) {
      return Object.freeze({
        command: "powershell.exe",
        args: Object.freeze([
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WINDOWS_GATE_PATH,
        ]),
        env: Object.freeze({
          ...env,
          EQUINOX_LOCAL_OWNED_PROCESS_SPEC: encodeWindowsOwnedProcess(command, args),
        }),
        stdin: "pipe",
      });
    },
    async attachAndRelease(ownedSet, child) {
      if (!ownedSet || !Number.isInteger(child?.pid) || child.pid <= 0) {
        throw new Error("Windows owned process could not be attached before gate release.");
      }
      await ownedSet.assign(child.pid);
      await new Promise((resolve, reject) => {
        child.stdin.write("EQUINOX_GO\n", (error) => error ? reject(error) : resolve());
      });
      child.stdin.end();
    },
    async ownedSetExists(ownedSet) {
      if (!ownedSet) return false;
      const status = await ownedSet.status();
      return Number(status.activeProcesses) > 0;
    },
    async signalOwnedSet(ownedSet, signal) {
      if (!ownedSet) throw new Error("Windows Job Object ownership handle is missing.");
      await ownedSet.terminate(signal === "SIGKILL" ? 137 : 143);
    },
    async closeOwnedSet(ownedSet) {
      await ownedSet?.close?.();
    },
  });
}

export function createTerminalProcessOwnershipAdapter({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  equinoxLocalReleaseTarget({ platform, arch });
  if (platform === "darwin") {
    return Object.freeze({
      kind: "posix-session-or-tty",
      implemented: true,
      requiresVerifiedOwnership: true,
      gracefulSignal: "SIGHUP",
      forceSignal: "SIGKILL",
    });
  }
  return Object.freeze({
    kind: "job-object",
    implemented: true,
    requiresVerifiedOwnership: true,
    gracefulSignal: "SIGTERM",
    forceSignal: "SIGKILL",
    async createOwnedSet() {
      return createWindowsJobObjectLease({ platform });
    },
    spawnSpec(command, args, env) {
      return Object.freeze({
        command: "powershell.exe",
        args: Object.freeze([
          "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WINDOWS_PTY_GATE_PATH,
        ]),
        env: Object.freeze({
          ...env,
          EQUINOX_LOCAL_OWNED_PTY_SPEC: encodeWindowsOwnedPty(command, args),
          EQUINOX_LOCAL_PTY_READY_MARKER: WINDOWS_PTY_INNER_READY_MARKER,
        }),
        readyMarker: WINDOWS_PTY_INNER_READY_MARKER,
      });
    },
    async attachAndRelease(ownedSet, terminal) {
      if (!ownedSet || !terminal) {
        throw new Error("Windows PTY could not be attached before gate release.");
      }
      const deadline = Date.now() + 5_000;
      let pid = Number.isInteger(terminal.pid) && terminal.pid > 0 ? terminal.pid : null;
      while (!pid && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        pid = Number.isInteger(terminal.pid) && terminal.pid > 0 ? terminal.pid : null;
      }
      if (!pid) {
        throw new Error("Windows ConPTY process id did not become ready before Job Object assignment.");
      }
      await ownedSet.assign(pid);
      terminal.write("EQUINOX_GO\r");
      return pid;
    },
    async ownedSetExists(ownedSet) {
      if (!ownedSet) return false;
      const status = await ownedSet.status();
      return Number(status.activeProcesses) > 0;
    },
    async signalOwnedSet(ownedSet, signal) {
      if (!ownedSet) throw new Error("Windows PTY Job Object ownership handle is missing.");
      await ownedSet.terminate(signal === "SIGKILL" ? 137 : 143);
    },
    async closeOwnedSet(ownedSet) {
      await ownedSet?.close?.();
    },
  });
}

export function assertProcessOwnershipImplemented(adapter, purpose) {
  if (adapter?.implemented === true) return adapter;
  const kind = adapter?.kind || "unknown";
  const error = new Error(`Equinox Local ${purpose} requires an implemented process-ownership adapter (${kind}).`);
  error.code = "EQUINOX_PROCESS_OWNERSHIP_UNIMPLEMENTED";
  throw error;
}
