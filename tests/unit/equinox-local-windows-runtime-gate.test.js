import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const GATE = fileURLToPath(new URL("../../src/equinox-local-windows-runtime-gate.mjs", import.meta.url));

function encodedSpec(command, args) {
  return Buffer.from(JSON.stringify({ command, args }), "utf8").toString("base64");
}

function collect(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("runtime gate acknowledges the real child spawn and propagates its exit code", async () => {
  const marker = "EQUINOX_TEST_CHILD_STARTED";
  const child = spawn(process.execPath, [GATE], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      EQUINOX_LOCAL_OWNED_PROCESS_READY_MARKER: marker,
      EQUINOX_LOCAL_OWNED_PROCESS_SPEC: encodedSpec(process.execPath, ["-e", "setTimeout(() => process.exit(7), 40)"]),
    },
  });
  const resultPromise = collect(child);
  child.stdin.write("EQUINOX_GO\n");
  const result = await resultPromise;
  assert.equal(result.signal, null);
  assert.equal(result.code, 7);
  assert.match(result.stdout, new RegExp(`^${marker}\\n`, "u"));
  assert.equal(result.stderr, "");
});

test("runtime gate fails closed before spawning when release token is wrong", async () => {
  const child = spawn(process.execPath, [GATE], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      EQUINOX_LOCAL_OWNED_PROCESS_SPEC: encodedSpec(process.execPath, ["-e", "process.exit(0)"]),
    },
  });
  const resultPromise = collect(child);
  child.stdin.end("WRONG_TOKEN\n");
  const result = await resultPromise;
  assert.equal(result.signal, null);
  assert.equal(result.code, 125);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /runtime gate was not released/u);
});
