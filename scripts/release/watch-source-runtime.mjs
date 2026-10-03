import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSourceRuntimeConfig } from "../../src/equinox-local-source-runtime.js";

const execFile = promisify(execFileCallback);

// Observe the existing alias, not remote readiness: a network outage must not
// restart a live runtime. launchd remains the sole restart owner.
export async function watchSourceRuntime({
  tunnelClient,
  tunnelRuntime,
  execFileImpl = execFile,
  sleep = delay,
  intervalMs = 5_000,
  failureLimit = 3,
  report = (message) => process.stderr.write(`[Equinox Local source watchdog] ${message}\n`),
} = {}) {
  let failures = 0;
  while (true) {
    await sleep(intervalMs);
    let stopped = false;
    try {
      const { stdout } = await execFileImpl(tunnelClient, ["runtimes", "status", tunnelRuntime, "--json"], {
        timeout: 5_000,
        maxBuffer: 256 * 1024,
        env: { ...process.env, NO_COLOR: "1" },
      });
      const status = JSON.parse(stdout);
      stopped = status.process_running === false && status.runtime_state === "stopped";
      // A valid live process clears the consecutive-loss window. Uncertain
      // probes do not authorize killing a possibly healthy runtime.
      if (!stopped) failures = 0;
    } catch {
      failures = 0;
      report("Status probe unavailable; leaving runtime untouched.");
    }
    if (stopped && ++failures >= failureLimit) {
      report("Tunnel process is stopped; releasing app host for launchd recovery.");
      return;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const loaded = await readSourceRuntimeConfig({ configPath: process.argv[2] });
    if (!loaded.configured) throw new Error("Source runtime configuration missing.");
    await watchSourceRuntime(loaded.config);
    process.exitCode = 1;
  } catch {
    process.stderr.write("[Equinox Local source watchdog] Unable to monitor source runtime.\n");
    process.exitCode = 1;
  }
}
