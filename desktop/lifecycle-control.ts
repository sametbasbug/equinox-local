import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type UninstallHandoff = { release: () => Promise<void>; cancel: () => Promise<void> };
export type LifecycleControlOptions = {
  helperPath?: string;
  onReopen: () => void;
  onRestart: () => void;
  onShutdown: () => void;
  onUninstallShutdown: () => void;
  // Null is an ordinary refusal with verified cleanup; rejection means cleanup is unconfirmed.
  onUninstallRequest: (removeUserData: boolean) => Promise<UninstallHandoff | null>;
  onUninstallAcknowledged: () => void;
  onFailure: () => void;
};
type Control = { close: () => Promise<void> };
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Private application IPC only. helperPath must come from the admitted runtime plan. */
export async function openLifecycleControl(options: LifecycleControlOptions): Promise<Control> {
  let closing = false;
  let failed = false;
  const failure = () => {
    if (!failed) { failed = true; if (!closing) options.onFailure(); }
  };
  const dispatch = (command: string): boolean => {
    if (closing || failed) return false;
    if (command === "reopen") options.onReopen();
    else if (command === "restart-runtime") options.onRestart();
    else if (command === "shutdown-for-update") options.onShutdown();
    else if (command === "shutdown-for-uninstall" && process.platform === "darwin") options.onUninstallShutdown();
    else return false;
    return true;
  };
  if (process.platform === "win32") {
    if (!options.helperPath || !path.isAbsolute(options.helperPath)) throw new Error("Admitted shell-control helper path required.");
    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const child = spawn(options.helperPath, ["--shell-control"], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false,
      shell: false, cwd: path.dirname(options.helperPath), env,
    });
    let exited = false;
    let ready = false;
    let buffer = "";
    type Pending = { id: string; handoff?: UninstallHandoff; replySent: boolean; done: Promise<void>; finish: () => void };
    let pending: Pending | undefined;
    const operations = new Set<Promise<void>>();
    let cleanupFailure: Error | null = null;
    const cancel = async (handoff: UninstallHandoff) => {
      try { await handoff.cancel(); }
      catch (error) { cleanupFailure = new Error("Prepared uninstall cleanup was not verified.", { cause: error }); throw error; }
    };
    const track = (action: Promise<void>) => {
      const tracked = action.catch(() => broken()).finally(() => operations.delete(tracked));
      operations.add(tracked);
    };
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const started = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const broken = () => {
      rejectReady(new Error("Native lifecycle control failed or refused ownership."));
      if (pending) {
        const request = pending; pending = undefined;
        if (request.handoff) track(cancel(request.handoff));
        request.finish();
      }
      failure();
    };
    const exit = new Promise<void>((resolve) => child.once("close", () => { exited = true; resolve(); broken(); }));
    child.once("error", () => { broken(); });
    child.stdin.on("error", broken);
    child.stdin.once("close", broken);
    child.stdout.on("error", broken);
    child.stdout.once("end", broken);
    child.stdout.once("close", broken);
    // Drain, never retain or log helper diagnostics.
    child.stderr.resume();
    child.stderr.on("error", broken);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (failed) return;
      for (const character of chunk) {
        if (character !== "\n") {
          buffer += character;
          if (Buffer.byteLength(buffer) > 512) { broken(); return; }
          continue;
        }
        const line = buffer; buffer = "";
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (!ready) {
            if (message.event !== "ready") throw new Error("Not ready");
            ready = true; resolveReady(); continue;
          }
          if (message.event === "acknowledged") {
            if (!pending || message.id !== pending.id || typeof message.ok !== "boolean") throw new Error("Unexpected acknowledgement");
            const request = pending;
            if (message.ok && (!request.replySent || !request.handoff)) throw new Error("Unprepared uninstall acknowledgement");
            pending = undefined;
            track((async () => {
              try {
                if (request.handoff) {
                  if (message.ok) {
                    try { await request.handoff.release(); }
                    catch (error) { await cancel(request.handoff); throw error; }
                    options.onUninstallAcknowledged();
                  } else await cancel(request.handoff);
                }
              } finally { request.finish(); }
            })());
            continue;
          }
          if (closing) continue; // Still drain a previously issued uninstall acknowledgement before teardown.
          if (message.event !== "request" || typeof message.id !== "string" || !/^[1-9][0-9]{0,19}$/u.test(message.id) || typeof message.command !== "string" || pending) throw new Error("Invalid request");
          if (message.command === "uninstall:preserve-user-data" || message.command === "uninstall:remove-user-data") {
            let finish!: () => void;
            const done = new Promise<void>((resolve) => { finish = resolve; });
            const deadline = setTimeout(broken, 7_000);
            const request: Pending = { id: message.id, replySent: false, done,
              finish: () => { clearTimeout(deadline); finish(); } };
            pending = request;
            track((async () => {
              let handoff: UninstallHandoff | null = null;
              try { handoff = await options.onUninstallRequest(message.command === "uninstall:remove-user-data"); }
              catch (error) {
                cleanupFailure = new Error("Uninstall preparation cleanup was not verified.", { cause: error });
                broken();
                return;
              }
              if (pending !== request || failed) { if (handoff) await cancel(handoff); return; }
              if (closing && handoff) { await cancel(handoff); handoff = null; }
              if (handoff) request.handoff = handoff;
              request.replySent = true;
              child.stdin.write(`ack:${request.id}:${handoff ? "ok" : "error"}\n`);
            })());
          } else if (!dispatch(message.command)) throw new Error("Unknown request");
        } catch { broken(); return; }
      }
    });
    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => closePromise ??= (async () => {
      closing = true;
      // If success was already issued, consume its matching flushed acknowledgement
      // before closing the helper. Preparation not yet accepted is cancelled instead.
      await pending?.done;
      await Promise.all([...operations]);
      try { if (!exited) child.stdin.end("close\n"); } catch { /* Still verify or terminate the exact owned child below. */ }
      await Promise.race([exit, delay(1_000)]);
      if (!exited) {
        // ChildProcess.kill targets only this unreaped child, never a discovered PID.
        child.kill("SIGKILL");
        await Promise.race([exit, delay(2_000)]);
      }
      if (!exited && child.pid !== undefined) throw new Error("Native lifecycle helper exit could not be verified.");
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (cleanupFailure) throw new Error("Prepared uninstall cleanup could not be verified.", { cause: cleanupFailure });
    })();
    const timer = setTimeout(broken, 3_000);
    try { await started; } catch (error) { await close(); throw error; } finally { clearTimeout(timer); }
    return { close };
  }
  if (process.platform !== "darwin") throw new Error("Desktop lifecycle control requires macOS or Windows.");
  const uid = process.getuid!();
  const home = os.homedir();
  if (await fs.realpath(home) !== home) throw new Error("Canonical home directory required.");
  let directory = home;
  for (const part of ["Library", "Application Support", "Equinox Local", "state"]) {
    directory = path.join(directory, part);
    try { await fs.mkdir(directory, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.uid !== uid || await fs.realpath(directory) !== directory) throw new Error("Unsafe lifecycle parent directory.");
  }
  const parent = await fs.lstat(directory);
  if ((parent.mode & 0o777) !== 0o700) throw new Error("Lifecycle state directory must be private (0700).");
  const socketPath = path.join(directory, "desktop-control.sock");
  // Recover only this user's exact stale socket; an active or foreign endpoint is never replaced.
  let previous: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  try { previous = await fs.lstat(socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous) {
    if (!previous.isSocket() || previous.uid !== uid || (previous.mode & 0o777) !== 0o600) throw new Error("Foreign lifecycle endpoint; refusing ownership.");
    await new Promise<void>((resolve, reject) => {
      const probe = net.createConnection(socketPath);
      const timer = setTimeout(() => { probe.destroy(); reject(new Error("Lifecycle ownership could not be established.")); }, 1_000);
      probe.once("connect", () => { clearTimeout(timer); probe.destroy(); reject(new Error("Another application owner is already active.")); });
      probe.once("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer); probe.destroy();
        if (error.code === "ECONNREFUSED") resolve(); else reject(new Error("Lifecycle endpoint could not be safely retired."));
      });
    });
    const stale = await fs.lstat(socketPath);
    if (!stale.isSocket() || stale.uid !== uid || stale.dev !== previous.dev || stale.ino !== previous.ino) throw new Error("Lifecycle endpoint changed during stale-owner inspection.");
    await fs.unlink(socketPath);
  }
  // libuv unlinks its bind name on close. Publish a hard link so that it never
  // automatically unlinks the canonical endpoint (which might have been replaced).
  const bindPath = path.join(directory, `.${randomBytes(8).toString("hex")}`);
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    if (closing || failed || clients.size >= 16) { socket.destroy(); return; }
    clients.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => clients.delete(socket));
    const timer = setTimeout(() => socket.destroy(), 3_000);
    socket.once("close", () => clearTimeout(timer));
    let line = "";
    socket.on("data", (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 10) {
          socket.removeAllListeners("data");
          const command = line.replace(/\r$/u, "");
          const invoke = () => { try { dispatch(command); } catch { failure(); } };
          if (command === "shutdown-for-update" || command === "shutdown-for-uninstall") socket.end(`owner:${process.pid}\n`, invoke);
          else { socket.end(); invoke(); }
          return;
        }
        if (byte > 127 || line.length >= 128) { socket.destroy(); return; }
        line += String.fromCharCode(byte);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(bindPath, () => { server.removeListener("error", reject); resolve(); });
  });
  server.on("error", failure);
  server.on("close", failure);
  let owned: Awaited<ReturnType<typeof fs.lstat>> | null = null;
  const unlinkOwned = async () => {
    if (!owned) return;
    try {
      const current = await fs.lstat(socketPath);
      if (current.isSocket() && current.uid === uid && current.dev === owned.dev && current.ino === owned.ino) await fs.unlink(socketPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= (async () => {
    closing = true;
    for (const client of clients) client.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await unlinkOwned();
  })();
  try {
    owned = await fs.lstat(bindPath);
    if (!owned.isSocket() || owned.uid !== uid) throw new Error("Lifecycle bind socket is not owned.");
    await fs.chmod(bindPath, 0o600);
    await fs.link(bindPath, socketPath); // Atomic refusal if another owner won.
  } catch (error) { await close(); throw error; }
  return { close };
}
