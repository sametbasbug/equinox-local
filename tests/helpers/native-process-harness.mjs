import assert from "node:assert/strict";
import { spawn } from "node:child_process";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

export async function terminateTrackedProcess(child, {
  label = "tracked test process",
  termTimeoutMs = 2_000,
  killTimeoutMs = 2_000,
} = {}) {
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid < 1) return;

  if (child.exitCode === null && child.signalCode === null && pidAlive(pid)) {
    child.kill("SIGTERM");
    if (!(await waitForExit(child, termTimeoutMs)) && pidAlive(pid)) {
      child.kill("SIGKILL");
      await waitForExit(child, killTimeoutMs);
    }
  }

  assert.equal(child.exitCode !== null || child.signalCode !== null, true, `${label} did not report an exit`);
  assert.equal(pidAlive(pid), false, `${label} PID ${pid} is still alive after cleanup`);
}

export async function spawnTrackedProcess(t, command, args = [], options = {}, {
  label = "tracked test process",
  startupMs = 1_000,
} = {}) {
  const child = spawn(command, args, options);
  t.after(async () => terminateTrackedProcess(child, { label }));

  await new Promise((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });

  assert.equal(Number.isInteger(child.pid) && child.pid > 0, true, `${label} did not receive a PID`);
  await sleep(startupMs);
  assert.equal(pidAlive(child.pid), true, `${label} exited during startup verification`);
  return child;
}
