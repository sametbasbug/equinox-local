import path from "node:path";
import { fileURLToPath } from "node:url";

import { equinoxLocalReleaseTarget, equinoxLocalWindowsPowerShellPath } from "./equinox-local-platform.js";
import { createWindowsJobObjectLease, resolveWindowsNativeOwnedProcessGatePath } from "./equinox-local-windows-job-object.js";

type ProcessEnv = Readonly<Record<string, unknown>>;
type ReleaseHost = {platform?: string; arch?: string};
type DarwinGroupHooks = {
  groupExists?: ((pid: number) => boolean | Promise<boolean>) | undefined;
  signalGroup?: ((pid: number, signal: string) => unknown) | undefined;
};
type BackgroundOwnershipOptions = ReleaseHost & DarwinGroupHooks;
type WindowsOwnedSet = {
  assign(pid: number): Promise<unknown>;
  status(): Promise<Record<string, unknown>>;
  terminate(exitCode: number): Promise<unknown>;
  close(): Promise<unknown>;
};
type OwnedChild = {
  pid?: number | undefined;
  stdin: {
    write(data: string, callback: (error?: Error | null) => void): unknown;
    end(): unknown;
  };
};
type OwnedTerminal = {
  pid?: number | undefined;
  write(data: string): unknown;
};
type ProcessOwnershipClaim = {implemented?: boolean | undefined; kind?: string | undefined};
function ownershipError(message: string, code: string) {
  return Object.assign(new Error(message), {code});
}

const WINDOWS_GATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "equinox-local-windows-process-gate.ps1");
const WINDOWS_PTY_GATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "equinox-local-windows-pty-gate.ps1");
const WINDOWS_PTY_INNER_READY_MARKER = "__EQUINOX_INNER_PTY_READY__";

function encodeWindowsOwnedProcess(command: string, args: readonly string[]): string {
  return Buffer.from(JSON.stringify({ command, args }), "utf8").toString("base64");
}

function encodeWindowsOwnedPty(command: string, args: readonly string[]): string {
  return Buffer.from(JSON.stringify({ command, args }), "utf8").toString("base64");
}

function unsupported(kind: string, platform: string) {
  return ownershipError(`Equinox Local ${kind} process ownership is not implemented on ${platform}.`, "EQUINOX_PROCESS_OWNERSHIP_UNIMPLEMENTED");
}

export function createBackgroundProcessOwnershipAdapter({
  platform = process.platform,
  arch = process.arch,
  groupExists,
  signalGroup,
}: BackgroundOwnershipOptions = {}) {
  equinoxLocalReleaseTarget({ platform, arch });
  if (platform === "darwin") {
    if (typeof groupExists !== "function" || typeof signalGroup !== "function") {
      throw new Error("Darwin background process ownership requires group probe and signal adapters.");
    }
    return Object.freeze({
      kind: "posix-process-group",
      implemented: true,
      detached: true,
      ownedSetExists(pid: number) { return groupExists!(pid); },
      signalOwnedSet(pid: number, signal: string) { return signalGroup!(pid, signal); },
    });
  }
  return Object.freeze({
    kind: "job-object",
    implemented: true,
    detached: false,
    async createOwnedSet(): Promise<WindowsOwnedSet> {
      return createWindowsJobObjectLease({ platform });
    },
    spawnSpec(command: string, args: readonly string[], env: ProcessEnv) {
      const nativeGate: string | null = resolveWindowsNativeOwnedProcessGatePath();
      if (nativeGate) {
        return Object.freeze({
          command: nativeGate,
          args: Object.freeze(["--owned-process-gate", command, ...args]),
          env: Object.freeze({ ...env }),
          stdin: "pipe",
        });
      }
      return Object.freeze({
        command: equinoxLocalWindowsPowerShellPath(env),
        args: Object.freeze([
          "-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", WINDOWS_GATE_PATH,
        ]),
        env: Object.freeze({
          ...env,
          EQUINOX_LOCAL_OWNED_PROCESS_SPEC: encodeWindowsOwnedProcess(command, args),
        }),
        stdin: "pipe",
      });
    },
    async attachAndRelease(ownedSet: WindowsOwnedSet, child: OwnedChild) {
      const pid = child?.pid;
      if (!ownedSet || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
        throw new Error("Windows owned process could not be attached before gate release.");
      }
      await ownedSet.assign(pid);
      await new Promise<void>((resolve, reject) => {
        child.stdin.write("EQUINOX_GO\n", (error) => error ? reject(error) : resolve());
      });
      child.stdin.end();
    },
    async ownedSetExists(ownedSet: WindowsOwnedSet | null | undefined) {
      if (!ownedSet) return false;
      const status = await ownedSet.status();
      return Number(status.activeProcesses) > 0;
    },
    async signalOwnedSet(ownedSet: WindowsOwnedSet | null | undefined, signal: string) {
      if (!ownedSet) throw new Error("Windows Job Object ownership handle is missing.");
      await ownedSet.terminate(signal === "SIGKILL" ? 137 : 143);
    },
    async closeOwnedSet(ownedSet: WindowsOwnedSet | null | undefined) {
      await ownedSet?.close?.();
    },
  });
}

export function createTerminalProcessOwnershipAdapter({
  platform = process.platform,
  arch = process.arch,
}: ReleaseHost = {}) {
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
    async createOwnedSet(): Promise<WindowsOwnedSet> {
      return createWindowsJobObjectLease({ platform });
    },
    spawnSpec(command: string, args: readonly string[], env: ProcessEnv) {
      // The gate is the interactive session (-NoExit -File), not a launcher
      // for a second child. Preserve the explicitly selected pwsh executable.
      // Direct terminal-manager callers may still use the PS5.1 short name.
      const shell = String(command).toLowerCase() === "powershell.exe"
        ? equinoxLocalWindowsPowerShellPath(env) : command;
      const leaf = path.win32.basename(shell).toLowerCase();
      if (!path.win32.isAbsolute(shell) || (leaf !== "powershell.exe" && leaf !== "pwsh.exe")) {
        throw new Error("Windows interactive shell requires an absolute PowerShell executable.");
      }
      return Object.freeze({
        command: shell,
        args: Object.freeze([
          // Keep the verified gate itself as the interactive ConPTY shell:
          // no second PowerShell process or desktop console window.
          "-NoLogo", "-NoProfile", "-NoExit", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", WINDOWS_PTY_GATE_PATH,
        ]),
        env: Object.freeze({
          ...env,
          EQUINOX_LOCAL_OWNED_PTY_SPEC: encodeWindowsOwnedPty(command, args),
          EQUINOX_LOCAL_PTY_READY_MARKER: WINDOWS_PTY_INNER_READY_MARKER,
        }),
        readyMarker: WINDOWS_PTY_INNER_READY_MARKER,
      });
    },
    async attachAndRelease(ownedSet: WindowsOwnedSet, terminal: OwnedTerminal) {
      if (!ownedSet || !terminal) {
        throw new Error("Windows PTY could not be attached before gate release.");
      }
      const deadline = Date.now() + 5_000;
      let pid: number | null = typeof terminal.pid === "number" && Number.isInteger(terminal.pid) && terminal.pid > 0 ? terminal.pid : null;
      while (!pid && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        pid = typeof terminal.pid === "number" && Number.isInteger(terminal.pid) && terminal.pid > 0 ? terminal.pid : null;
      }
      if (!pid) {
        throw new Error("Windows ConPTY process id did not become ready before Job Object assignment.");
      }
      await ownedSet.assign(pid);
      terminal.write("EQUINOX_GO\r");
      return pid;
    },
    async ownedSetExists(ownedSet: WindowsOwnedSet | null | undefined) {
      if (!ownedSet) return false;
      const status = await ownedSet.status();
      return Number(status.activeProcesses) > 0;
    },
    async signalOwnedSet(ownedSet: WindowsOwnedSet | null | undefined, signal: string) {
      if (!ownedSet) throw new Error("Windows PTY Job Object ownership handle is missing.");
      await ownedSet.terminate(signal === "SIGKILL" ? 137 : 143);
    },
    async closeOwnedSet(ownedSet: WindowsOwnedSet | null | undefined) {
      await ownedSet?.close?.();
    },
  });
}

export function assertProcessOwnershipImplemented<T extends ProcessOwnershipClaim>(adapter: T | null | undefined, purpose: string): T {
  if (adapter?.implemented === true) return adapter;
  const kind = adapter?.kind || "unknown";
  throw ownershipError(`Equinox Local ${purpose} requires an implemented process-ownership adapter (${kind}).`, "EQUINOX_PROCESS_OWNERSHIP_UNIMPLEMENTED");
}
