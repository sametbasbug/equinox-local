import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { watchSourceRuntime } from "../../scripts/release/watch-source-runtime.mjs";
import { sourceAppRuntimeWrapper } from "../../scripts/release/prepare-source-app-host.mjs";

const dead = { process_running: false, runtime_state: "stopped" };
test("source watchdog requires consecutive confirmed process loss, ignoring network readiness", async () => {
  const sequence = [dead, { process_running: true, ready: false }, dead, new Error("timeout"), dead, {}, dead, dead, dead];
  let probes = 0;
  await watchSourceRuntime({
    tunnelClient: "/fixture/client", tunnelRuntime: "fixture",
    sleep: async () => {}, report: () => {},
    execFileImpl: async (command, args, options) => {
      assert.equal(command, "/fixture/client");
      assert.deepEqual(args, ["runtimes", "status", "fixture", "--json"]);
      assert.equal(options.timeout, 5000);
      const item = sequence[probes++];
      assert.ok(item, "must terminate after confirmed process loss");
      if (item instanceof Error) throw item;
      return { stdout: JSON.stringify(item) };
    },
  });
  assert.equal(probes, sequence.length);
});

const macTest = process.platform === "darwin" ? test : test.skip;
for (const withPeekaboo of [false, true]) {
  macTest(`source wrapper exits for launchd when tunnel monitor exits (Peekaboo=${withPeekaboo})`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-watchdog-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const launcher = path.join(root, "launcher.sh");
    const monitor = path.join(root, "monitor.sh");
    const peekaboo = path.join(root, "peekaboo.sh");
    await fs.writeFile(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await fs.writeFile(monitor, "#!/bin/sh\nsleep 0.1\nexit 7\n", { mode: 0o700 });
    await fs.writeFile(peekaboo, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const wrapper = path.join(root, "wrapper.sh");
    await fs.writeFile(wrapper, sourceAppRuntimeWrapper(launcher, withPeekaboo ? peekaboo : "", { nodePath: monitor }));
    await assert.rejects(promisify(execFile)("/bin/bash", [wrapper], { timeout: 4000 }), (error) => {
      assert.equal(error.killed, false, "wrapper must exit itself, not hang until timeout");
      assert.equal(error.code, 7);
      return true;
    });
  });
}
