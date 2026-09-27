import path from "node:path";
import { fileURLToPath } from "node:url";

import { equinoxLocalReleaseTarget } from "./equinox-local-platform.js";
import { createWindowsJobObjectLease } from "./equinox-local-windows-job-object.js";

const WINDOWS_GATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "equinox-local-windows-process-gate.ps1");

function encodeWindowsOwnedProcess(command, args) {
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
    implemented: false,
    requiresVerifiedOwnership: true,
    gracefulSignal: null,
    forceSignal: null,
  });
}

export function assertProcessOwnershipImplemented(adapter, purpose) {
  if (adapter?.implemented === true) return adapter;
  const kind = adapter?.kind || "unknown";
  const error = new Error(`Equinox Local ${purpose} requires an implemented process-ownership adapter (${kind}).`);
  error.code = "EQUINOX_PROCESS_OWNERSHIP_UNIMPLEMENTED";
  throw error;
}
