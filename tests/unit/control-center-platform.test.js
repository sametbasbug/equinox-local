import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chooseLocalFolder, __test } from "../../src/control-center-platform.js";

test("folder picker is a fixed macOS osascript flow and returns a resolved directory", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-picker-"));
  const selected = path.join(tempRoot, "project");
  await fs.mkdir(selected);
  try {
    let invocation = null;
    const result = await chooseLocalFolder({
      platform: "darwin",
      execFileAsync: async (command, args, options) => {
        invocation = { command, args, options };
        return { stdout: `${selected}\n`, stderr: "" };
      },
    });
    assert.equal(result, await fs.realpath(selected));
    assert.equal(invocation.command, "/usr/bin/osascript");
    assert.deepEqual(invocation.args, ["-e", __test.PICK_FOLDER_SCRIPT]);
    assert.equal(invocation.options.timeout, 120_000);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("folder picker cancellation returns null without inventing a path", async () => {
  const result = await chooseLocalFolder({
    platform: "darwin",
    execFileAsync: async () => ({ stdout: "\n", stderr: "" }),
  });
  assert.equal(result, null);
});

test("folder picker fails closed off macOS", async () => {
  await assert.rejects(
    chooseLocalFolder({ platform: "linux", execFileAsync: async () => ({ stdout: "/tmp/x\n" }) }),
    (error) => error?.statusCode === 501 && /macOS/u.test(error.message),
  );
});
