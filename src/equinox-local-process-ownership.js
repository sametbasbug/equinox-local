import { equinoxLocalReleaseTarget } from "./equinox-local-platform.js";

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
    implemented: false,
    detached: false,
    ownedSetExists() { return false; },
    signalOwnedSet() { throw unsupported("background", platform); },
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
