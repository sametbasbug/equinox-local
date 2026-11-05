import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";

export type RuntimeJobLease = {
  assign: (pid: number) => Promise<unknown>;
  terminate: (code: number) => Promise<unknown>;
  close: () => Promise<unknown>;
};
export type RuntimeLaunch = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  createJob?: () => Promise<RuntimeJobLease>;
  controlHelper?: string;
  readyMarker?: string;
};
export type RuntimeOwnerState = "stopped" | "starting" | "running" | "attention";
type OwnedRuntime = {
  child: ChildProcessWithoutNullStreams | null;
  exit: Promise<void>;
  exited: boolean;
  started: boolean;
  stopping: boolean;
  assigned: boolean;
  job?: RuntimeJobLease;
  generation: number;
};

async function requireFreeControlPort(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 24891 });
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Cannot establish whether the Control Center port is free.")), 1_500);
    socket.once("connect", () => finish(new Error("Another local runtime is already listening; refusing a second backend.")));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ECONNREFUSED" ? undefined : new Error("Control Center port ownership is unavailable."));
    });
  });
}

/** One serialized backend lifecycle beneath Electron; no renderer or generic execution API. */
export function createRuntimeOwner(
  resolveLaunch: () => Promise<RuntimeLaunch>,
  onState: (state: RuntimeOwnerState) => void,
) {
  let worker: OwnedRuntime | null = null;
  let tail = Promise.resolve();
  let desired = false;
  let generation = 0;
  let recoveries = 0;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

  function serialize(operation: () => Promise<void>): Promise<void> {
    const next = tail.then(operation);
    tail = next.catch(() => {});
    return next;
  }
  function cancelRecovery(): void {
    if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
  }

  async function retire(entry: OwnedRuntime): Promise<void> {
    entry.stopping = true;
    generation += 1;
    let terminationFailed = false;
    let leaseFailure: unknown;
    if (entry.job && entry.assigned) {
      try { await entry.job.terminate(0); } catch { terminationFailed = true; }
    }
    // A gate whose assignment failed is OUTSIDE the job; close its owned input and process directly.
    if (entry.child && !entry.exited && (!entry.job || !entry.assigned || terminationFailed)) {
      try { entry.child.stdin.end(); } catch { /* Direct-child exit is observed below. */ }
      try { entry.child.kill("SIGTERM"); } catch { /* A concurrent exit is harmless only when observed. */ }
    }
    // Always dispose the exact generation's lease, even when terminate rejected.
    if (entry.job) {
      try { await entry.job.close(); delete entry.job; entry.assigned = false; }
      catch (error) { leaseFailure = error; }
    }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entry.exit,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("Owned runtime did not finish shutting down; refusing replacement.")), 12_000);
        }),
      ]);
    } finally { if (deadline) clearTimeout(deadline); }
    if (leaseFailure) throw new Error("Native runtime lease disposal could not be established; refusing replacement.", { cause: leaseFailure });
    if (worker === entry) worker = null;
  }

  async function stopWorker(): Promise<void> {
    cancelRecovery();
    if (worker) await retire(worker);
    onState("stopped");
  }

  async function startWorker(): Promise<void> {
    if (!desired || worker) return;
    onState("starting");
    await requireFreeControlPort();
    const launch = await resolveLaunch();
    const nativeJob = await launch.createJob?.();
    // Retain the lease before attempting spawn, so cancellation or synchronous spawn failure cannot lose it.
    const entry: OwnedRuntime = {
      child: null, exit: Promise.resolve(), exited: true, started: false, stopping: false,
      assigned: false, generation: ++generation, ...(nativeJob ? { job: nativeJob } : {}),
    };
    worker = entry;
    if (!desired) { await retire(entry); return; }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: launch.cwd, env: launch.env, shell: false, windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      try { await retire(entry); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Runtime spawn and ownership cleanup failed."); }
      throw error;
    }
    entry.child = child;
    entry.exited = false;
    entry.exit = new Promise<void>((resolve) => child.once("close", () => { entry.exited = true; resolve(); }));
    let readyBuffer = "";
    let settled = false;
    let startupDeadline: ReturnType<typeof setTimeout> | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (startupDeadline) clearTimeout(startupDeadline);
        if (error) reject(error); else resolve();
      };
      startupDeadline = setTimeout(() => finish(new Error("Owned runtime startup timed out.")), 15_000);
      child.once("error", () => finish(new Error("Owned runtime could not start.")));
      child.once("close", () => finish(new Error("Owned runtime closed during startup.")));
      child.stdout.on("data", (chunk: Buffer) => {
        if (!launch.readyMarker || settled) return;
        readyBuffer += chunk.toString("utf8");
        if (readyBuffer.length > 16_384) { finish(new Error("Owned runtime startup response exceeded its limit.")); return; }
        let newline: number;
        while ((newline = readyBuffer.indexOf("\n")) >= 0) {
          const line = readyBuffer.slice(0, newline).replace(/\r$/u, "");
          readyBuffer = readyBuffer.slice(newline + 1);
          if (line === launch.readyMarker) { finish(); return; }
        }
      });
      child.stderr.resume();
      child.stdin.on("error", () => finish(new Error("Owned runtime input closed.")));
      child.once("spawn", () => {
        void (async () => {
          if (entry.job) {
            await entry.job.assign(child.pid!);
            entry.assigned = true;
            if (entry.stopping || entry.exited || worker !== entry || !desired || entry.generation !== generation) throw new Error("Runtime launch was retired.");
            child.stdin.write("EQUINOX_GO\n");
          }
          if (!launch.readyMarker) finish();
        })().catch(() => finish(new Error("Owned runtime could not acquire its native process ownership.")));
      });
    });
    child.once("close", () => {
      if (!entry.started || entry.stopping || worker !== entry || !desired) return;
      void serialize(async () => {
        if (worker !== entry || entry.stopping) return;
        // Cleanup comes BEFORE the recovery-budget decision, including when that budget is exhausted.
        await retire(entry);
        onState("attention");
        if (!desired) return;
        if (recoveries >= 3) { desired = false; return; }
        const delay = [250, 1_000, 2_000][recoveries++]!;
        recoveryTimer = setTimeout(() => {
          recoveryTimer = null;
          void serialize(startWorker).catch(() => { desired = false; onState("attention"); });
        }, delay);
      }).catch(() => { desired = false; onState("attention"); });
    });
    try {
      await ready;
      if (entry.exited || entry.stopping || entry.generation !== generation || !desired) throw new Error("Runtime launch was retired.");
      entry.started = true;
      onState("running");
    } catch (error) {
      desired = false;
      try { await retire(entry); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Runtime startup and ownership cleanup failed."); }
      onState("attention");
      throw error;
    }
  }

  return Object.freeze({
    start() {
      desired = true;
      recoveries = 0;
      cancelRecovery();
      return serialize(startWorker).catch((error) => { desired = false; onState("attention"); throw error; });
    },
    stop() {
      desired = false;
      cancelRecovery();
      return serialize(stopWorker).catch((error) => { onState("attention"); throw error; });
    },
    restart() {
      desired = true;
      recoveries = 0;
      cancelRecovery();
      return serialize(async () => { await stopWorker(); await startWorker(); })
        .catch((error) => { desired = false; onState("attention"); throw error; });
    },
  });
}
