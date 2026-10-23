import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { resolveMainSourceRuntime } from "../../scripts/release/resolve-main-source-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const POINTER = path.join(ROOT, "nonexistent-fixture-pointer.conf");
const CONFIG = path.join(ROOT, "nonexistent-fixture-runtime.conf");
const SOURCE = path.join(ROOT, "fixture-managed-source");
const SHA = "a".repeat(40);

function fixture(overrides = {}) {
  const calls = [];
  const config = Object.freeze({ tunnelClient: "/fixture/tunnel-client", tunnelRuntime: "fixture" });
  return {
    calls,
    config,
    input: {
      pointerPath: POINTER,
      configPath: CONFIG,
      readPointer: async (pointerPath) => {
        calls.push(["pointer", pointerPath]);
        return { sourceRoot: SOURCE, sha: SHA };
      },
      readConfig: async ({ configPath }) => {
        calls.push(["config", configPath]);
        return { configured: true, configPath, config };
      },
      ...overrides,
    },
  };
}

test("Main source resolver accepts only the injected validated pointer and configured runtime", async () => {
  const { calls, config, input } = fixture();
  const result = await resolveMainSourceRuntime(input);
  assert.deepEqual(result, { sourceRoot: SOURCE, sha: SHA, configPath: CONFIG, config });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(calls, [["pointer", POINTER], ["config", CONFIG]]);
});

test("Main source resolver rejects relative or missing paths before reading private state", async () => {
  for (const overrides of [
    { pointerPath: "relative.conf" },
    { pointerPath: undefined },
    { configPath: "relative.conf" },
    { configPath: undefined },
  ]) {
    const { input, calls } = fixture(overrides);
    await assert.rejects(resolveMainSourceRuntime(input), /must be absolute/u);
    assert.deepEqual(calls, [], "rejected arguments must not read any source pointer or config");
  }
});

test("Main source resolver rejects unconfigured runtime even with a valid injected pointer", async () => {
  const { input } = fixture({
    readConfig: async ({ configPath }) => ({ configured: false, configPath, config: null }),
  });
  await assert.rejects(resolveMainSourceRuntime(input), /runtime config is unavailable/u);
});

test("Main source resolver propagates pointer and runtime config read failures", async () => {
  const badPointer = fixture({ readPointer: async () => { throw new Error("unsafe source pointer"); } });
  await assert.rejects(resolveMainSourceRuntime(badPointer.input), /unsafe source pointer/u);
  const badConfig = fixture({ readConfig: async () => { throw new Error("unsafe runtime config"); } });
  await assert.rejects(resolveMainSourceRuntime(badConfig.input), /unsafe runtime config/u);
});

test("Main source resolver CLI rejects relative paths without exposing config on stdout", async () => {
  const script = path.join(ROOT, "scripts/release/resolve-main-source-runtime.mjs");
  await assert.rejects(promisify(execFile)(process.execPath, [script, "relative-pointer.conf", CONFIG], {
    cwd: ROOT,
    timeout: 5000,
    maxBuffer: 16 * 1024,
  }), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.match(error.stderr, /Main source runtime pointer path must be absolute/u);
    return true;
  });
});
