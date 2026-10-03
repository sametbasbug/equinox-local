import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { EQUINOX_LOCAL_VERSION } from "../../src/equinox-local-version.js";
import {
  assertReleaseBehaviorCheckout,
  parseReleaseBehaviorCli,
} from "../../scripts/release/release-behavior-cli.mjs";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);

function smokeArgs(overrides = {}) {
  const values = {
    "expected-sha": SHA,
    "previous-version": "5.2.0",
    version: EQUINOX_LOCAL_VERSION,
    target: "darwin-arm64",
    "previous-url": "https://local.sametbasbug.dev/downloads/updates/equinox-local-5.2.0-darwin-arm64.tar.gz",
    "previous-sha256": DIGEST,
    "previous-bytes": "123",
    "candidate-manifest": "/tmp/stable-darwin-arm64.json",
    ...overrides,
  };
  return ["managed-upgrade-smoke", ...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value])];
}

test("release behavior CLI keeps one high-level managed upgrade operation plus exact-SHA describe", () => {
  assert.deepEqual(parseReleaseBehaviorCli(["describe", "--expected-sha", SHA]), { operation: "describe", expectedSha: SHA });
  const parsed = parseReleaseBehaviorCli(smokeArgs({ "candidate-artifact": "/tmp/candidate.tar.gz" }));
  assert.equal(parsed.operation, "managed-upgrade-smoke");
  assert.equal(parsed.version, EQUINOX_LOCAL_VERSION);
  assert.equal(parsed.target, "darwin-arm64");
  assert.equal(parsed.previousArtifact.bytes, 123);
  assert.equal(parsed.candidateArtifactPath, "/tmp/candidate.tar.gz");
});

test("release behavior CLI rejects version, target, URL, digest and path drift before product mutation", () => {
  assert.throws(() => parseReleaseBehaviorCli(smokeArgs({ version: "9.9.9" })), /match canonical source version/u);
  assert.throws(() => parseReleaseBehaviorCli(smokeArgs({ target: "win32-x64" })), /only Darwin/u);
  assert.throws(() => parseReleaseBehaviorCli(smokeArgs({ "previous-url": "https://example.test/release.tar.gz" })), /pinned Equinox Local release URL/u);
  assert.throws(() => parseReleaseBehaviorCli(smokeArgs({ "previous-sha256": "x".repeat(64) })), /SHA-256/u);
  assert.throws(() => parseReleaseBehaviorCli(smokeArgs({ "candidate-manifest": "relative.json" })), /absolute path/u);
});

test("release behavior checkout validation binds canonical origin, clean worktree and exact HEAD", async () => {
  const root = await fs.mkdtemp("/tmp/equinox-release-behavior-contract-");
  try {
    const calls = [];
    const execFileImpl = async (_command, args) => {
      calls.push(args.join(" "));
      if (args.join(" ") === "rev-parse --show-toplevel") return { stdout: `${root}\n` };
      if (args.join(" ") === "remote get-url origin") return { stdout: "git@github.com:sametbasbug/equinox-local.git\n" };
      if (args[0] === "status") return { stdout: "" };
      if (args.join(" ") === "rev-parse HEAD") return { stdout: `${SHA}\n` };
      throw new Error(`Unexpected git call: ${args.join(" ")}`);
    };
    const result = await assertReleaseBehaviorCheckout({ expectedSha: SHA, rootDir: root, execFileImpl });
    assert.equal(result.sourceSha, SHA);
    assert.deepEqual(calls, [
      "rev-parse --show-toplevel",
      "remote get-url origin",
      "status --porcelain=v1 --untracked-files=all",
      "rev-parse HEAD",
    ]);
    await assert.rejects(
      assertReleaseBehaviorCheckout({
        expectedSha: SHA,
        rootDir: root,
        execFileImpl: async (_command, args) => args.join(" ") === "rev-parse --show-toplevel"
          ? { stdout: `${root}\n` }
          : args.join(" ") === "remote get-url origin"
            ? { stdout: "https://github.com/example/fork.git\n" }
            : { stdout: "" },
      }),
      /origin is not canonical/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("release behavior CLI source owns the updater/release-manager/activation boundary", async () => {
  const source = await fs.readFile(new URL("../../scripts/release/release-behavior-cli.mjs", import.meta.url), "utf8");
  assert.match(source, /prepareManagedEquinoxRelease/u);
  assert.match(source, /createEquinoxLocalUpdater/u);
  assert.match(source, /activatePreparedEquinoxRelease/u);
  assert.match(source, /EQUINOX_LOCAL_UPDATE_KEYS/u);
  assert.doesNotMatch(source, /factory\//u);
});
