import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CHILD_FLAG = "EQUINOX_WINDOWS_NODE_PTY_SMOKE_CHILD";
const CHILD_TIMEOUT_MS = 20_000;
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;

if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
  throw new Error(`Windows node-pty smoke requires native Windows x64/ARM64; got ${process.platform}-${process.arch}.`);
}

function appendBounded(current, chunk, streamName) {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") > MAX_CHILD_OUTPUT_BYTES) {
    throw new Error(`Windows node-pty smoke ${streamName} exceeded ${MAX_CHILD_OUTPUT_BYTES} bytes.`);
  }
  return next;
}

function trace(stage) {
  writeSync(2, `[equinox-conpty-smoke] ${stage}\n`);
}

function terminateChildTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const killer = spawnProcess("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  killer.on("error", () => {});
}

async function runExternallyBoundedChild() {
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawnProcess(process.execPath, [scriptPath], {
    env: { ...process.env, [CHILD_FLAG]: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let outputError = null;
  child.stdout.on("data", (chunk) => {
    try { stdout = appendBounded(stdout, chunk, "stdout"); } catch (error) { outputError = error; terminateChildTree(child.pid); }
  });
  child.stderr.on("data", (chunk) => {
    try { stderr = appendBounded(stderr, chunk, "stderr"); } catch (error) { outputError = error; terminateChildTree(child.pid); }
  });

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const diagnostic = `stdout:\n${stdout || "<empty>"}\nstderr:\n${stderr || "<empty>"}`;
      terminateChildTree(child.pid);
      reject(new Error(`Windows node-pty/ConPTY smoke child exceeded ${CHILD_TIMEOUT_MS} ms.\n${diagnostic}`));
    }, CHILD_TIMEOUT_MS);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  if (outputError) throw outputError;
  if (result.code !== 0) {
    throw new Error(`Windows node-pty/ConPTY smoke child failed (code=${result.code}, signal=${result.signal ?? "none"}).\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  assert.match(stdout, /"conpty": true/u);
  assert.match(stdout, new RegExp(`"arch": "${process.arch}"`, "u"));
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

async function runNativeConptySmoke() {
  trace("child:start");
  trace("import-node-pty:start");
  const module = await import("node-pty");
  trace("import-node-pty:ok");
  const spawnPty = module.spawn ?? module.default?.spawn;
  assert.equal(typeof spawnPty, "function", "node-pty spawn is unavailable");

  trace("spawn:start");
  const terminal = spawnPty("powershell.exe", ["-NoLogo", "-NoProfile"], {
    name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConpty: true,
  });
  trace(`spawn:ok pid=${terminal.pid ?? "unknown"}`);
  let output = "";
  let sawData = false;
  const completed = new Promise((resolve, reject) => {
    terminal.onData((data) => {
      if (!sawData) { sawData = true; trace("data:first"); }
      output += data;
    });
    terminal.onExit(({ exitCode }) => {
      trace(`exit:${exitCode}`);
      exitCode === 0 ? resolve() : reject(new Error(`Windows node-pty host exited ${exitCode}.`));
    });
  });
  trace("write:start");
  terminal.write('Write-Output "__EQUINOX_CONPTY_OK__"; exit\r');
  trace("write:return");
  await completed;
  trace("completed");
  trace("transport-dispose:start");
  terminal.kill();
  trace("transport-dispose:return");
  assert.match(output, /__EQUINOX_CONPTY_OK__/u);
  process.stdout.write(`${JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, conpty: true }, null, 2)}\n`);
}

if (process.env[CHILD_FLAG] === "1") {
  await runNativeConptySmoke();
} else {
  await runExternallyBoundedChild();
}
