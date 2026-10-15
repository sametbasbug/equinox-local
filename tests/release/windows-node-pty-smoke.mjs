import assert from "node:assert/strict";
import { spawn as spawnProcess } from "node:child_process";
import { writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  const packagedRoot = process.env.EQUINOX_WINDOWS_NODE_PTY_ROOT;
  const moduleSpecifier = packagedRoot
    ? pathToFileURL(path.join(packagedRoot, "lib", "index.js")).href
    : "node-pty";
  const module = await import(moduleSpecifier);
  trace("import-node-pty:ok");
  const spawnPty = module.spawn ?? module.default?.spawn;
  assert.equal(typeof spawnPty, "function", "node-pty spawn is unavailable");

  trace("spawn:start");
  // Execute a fixed challenge script inside the actual PTY shell. An
  // interactive prompt need not exist on a hosted native ARM64 runner;
  // explicitly signal readiness once the PowerShell command is executing.
  // The marker echoed by PowerShell is not success: require the response
  // after we send a separate, fixed token through ConPTY input.
  const readyMarker = "__EQUINOX_CONPTY_READY__";
  const ping = "__EQUINOX_CONPTY_PING__";
  const success = "__EQUINOX_CONPTY_OK__";
  const challengeScript = `[Console]::Out.WriteLine('${readyMarker}'); $line = [Console]::ReadLine(); if ($line -ceq '${ping}') { [Console]::Out.WriteLine('${success}'); exit 0 }; exit 3`;
  const terminal = spawnPty("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", challengeScript], {
    name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConpty: true,
  });
  trace(`spawn:ok pid=${terminal.pid ?? "unknown"}`);
  let output = "";
  let sawData = false;
  let sentCommand = false;
  const completed = new Promise((resolve, reject) => {
    terminal.onData((data) => {
      if (!sawData) { sawData = true; trace("data:first"); }
      output += data;
      // First PTY data may be a shell banner, ANSI sequence or partial
      // output. Send input only after the running child itself emits ready.
      if (!sentCommand && output.includes(readyMarker)) {
        sentCommand = true;
        trace("child:ready");
        trace("write:start");
        terminal.write(`${ping}\r`);
        trace("write:return");
      }
    });
    terminal.onExit(({ exitCode }) => {
      trace(`exit:${exitCode}`);
      exitCode === 0 ? resolve() : reject(new Error(`Windows node-pty host exited ${exitCode}.`));
    });
  });
  await completed;
  trace("completed");
  trace("transport-dispose:start");
  terminal.kill();
  trace("transport-dispose:return");
  assert.equal(sentCommand, true, "ConPTY never displayed the running PowerShell readiness marker.");
  assert.match(output, /__EQUINOX_CONPTY_OK__/u);
  process.stdout.write(`${JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, conpty: true }, null, 2)}\n`);
}

if (process.env[CHILD_FLAG] === "1") {
  await runNativeConptySmoke();
} else {
  await runExternallyBoundedChild();
}
