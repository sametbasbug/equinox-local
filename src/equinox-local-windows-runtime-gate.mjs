import { spawn } from "node:child_process";

const GO = "EQUINOX_GO";
const READY_ENV = "EQUINOX_LOCAL_OWNED_PROCESS_READY_MARKER";
const SPEC_ENV = "EQUINOX_LOCAL_OWNED_PROCESS_SPEC";

function fail(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function readGateLine() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
    };
    const finish = (value) => {
      cleanup();
      resolve(value.replace(/\r$/u, ""));
    };
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) finish(buffer.slice(0, newline));
    };
    const onEnd = () => finish(buffer);
    const onError = (error) => { cleanup(); reject(error); };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume();
  });
}

let gate;
try {
  gate = await readGateLine();
} catch (error) {
  fail(`Equinox Windows runtime gate input failed: ${error instanceof Error ? error.message : error}`, 125);
}
if (gate !== GO) fail("Equinox Windows runtime gate was not released.", 125);
process.stdin.pause();

const encoded = String(process.env[SPEC_ENV] ?? "").trim();
if (!encoded) fail("Equinox Windows runtime payload is missing.", 126);

let spec;
try {
  spec = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
} catch {
  fail("Equinox Windows runtime payload is invalid.", 127);
}
if (!spec || typeof spec.command !== "string" || !spec.command.trim() || !Array.isArray(spec.args) || spec.args.some((value) => typeof value !== "string")) {
  fail("Equinox Windows runtime payload is invalid.", 127);
}

const readyMarker = String(process.env[READY_ENV] ?? "").trim();
if (readyMarker && !/^[A-Z0-9_]{1,96}$/u.test(readyMarker)) fail("Equinox Windows runtime ready marker is invalid.", 127);

const exitCode = await new Promise((resolve) => {
  let spawned = false;
  const child = spawn(spec.command, spec.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["inherit", "inherit", "inherit"],
    windowsHide: true,
    shell: false,
  });
  child.once("spawn", () => {
    spawned = true;
    if (readyMarker) process.stdout.write(`${readyMarker}\n`);
  });
  child.once("error", (error) => {
    process.stderr.write(`Equinox Windows runtime child failed to start: ${error instanceof Error ? error.message : error}\n`);
    resolve(127);
  });
  child.once("exit", (code) => resolve(Number.isInteger(code) ? code : (spawned ? 128 : 127)));
});
process.exitCode = exitCode;
