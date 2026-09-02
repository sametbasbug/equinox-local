import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  collectManagedReleaseSourceFiles,
  createDeterministicManagedReleaseArchive,
  EQUINOX_LOCAL_NODE_VERSION,
  EQUINOX_LOCAL_PEEKABOO_TEAM_ID,
  EQUINOX_LOCAL_PEEKABOO_VERSION,
  EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION,
  extractLocalModuleSpecifiers,
  NODE_DISTRIBUTIONS,
  PEEKABOO_DISTRIBUTION,
  TUNNEL_CLIENT_DISTRIBUTIONS,
} from "../../scripts/release/package-managed-release.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFile = promisify(execFileCallback);

test("managed release source graph follows local imports and excludes development-only surfaces", async () => {
  const files = await collectManagedReleaseSourceFiles(ROOT);
  for (const required of [
    "src/server.js",
    "src/equinox-local-bootstrap.js",
    "src/equinox-local-updater.js",
    "src/equinox-local-update-helper.js",
    "src/equinox-local-restart-helper.js",
    "src/equinox-local-uninstall.js",
    "src/equinox-local-uninstall-helper.js",
    "src/equinox-local-supervisor.js",
    "src/equinox-browser-native-host.js",
    "src/equinox-control-center.html",
    "src/equinox-control-center.css",
    "src/equinox-control-center.js",
    "equinox-local-app/EquinoxLocal.png",
    "src/equinox-local-native-app.js",
    "src/equinox-local-native-app-host.js",
    "package.json",
    "package-lock.json",
  ]) {
    assert.equal(files.includes(required), true, `${required} should be packaged`);
  }
  assert.equal(files.some((value) => value.includes(".test.")), false);
  assert.equal(files.some((value) => value.includes("reviewer")), false);
  assert.equal(files.some((value) => value.startsWith("backups/")), false);
  assert.equal(files.some((value) => value.startsWith("equinox-browser-dev/")), false);
});

test("local module parser finds static relative imports without treating packages as release files", () => {
  assert.deepEqual(
    extractLocalModuleSpecifiers(`
      import fs from "node:fs";
      import { thing } from "./thing.js";
      const later = import("../shared/module.js");
      import "external-package";
    `),
    ["../shared/module.js", "./thing.js"],
  );
});

test("pinned Node runtime metadata covers both supported macOS architectures", () => {
  assert.equal(EQUINOX_LOCAL_NODE_VERSION, "24.20.0");
  assert.deepEqual(Object.keys(NODE_DISTRIBUTIONS).sort(), ["darwin-arm64", "darwin-x64"]);
  assert.match(NODE_DISTRIBUTIONS["darwin-arm64"].sha256, /^[a-f0-9]{64}$/u);
  assert.match(NODE_DISTRIBUTIONS["darwin-x64"].sha256, /^[a-f0-9]{64}$/u);
  assert.equal(NODE_DISTRIBUTIONS["darwin-arm64"].fileArchitecture, "arm64");
  assert.equal(NODE_DISTRIBUTIONS["darwin-x64"].fileArchitecture, "x86_64");
});

test("pinned tunnel runtime metadata covers both supported macOS architectures", () => {
  assert.equal(EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION, "0.0.13");
  assert.deepEqual(Object.keys(TUNNEL_CLIENT_DISTRIBUTIONS).sort(), ["darwin-arm64", "darwin-x64"]);
  assert.match(TUNNEL_CLIENT_DISTRIBUTIONS["darwin-arm64"].sha256, /^[a-f0-9]{64}$/u);
  assert.match(TUNNEL_CLIENT_DISTRIBUTIONS["darwin-x64"].sha256, /^[a-f0-9]{64}$/u);
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["darwin-arm64"].fileArchitecture, "arm64");
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["darwin-x64"].fileArchitecture, "x86_64");
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["darwin-arm64"].filename, "tunnel-client-v0.0.13-darwin-arm64.zip");
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["darwin-x64"].filename, "tunnel-client-v0.0.13-darwin-amd64.zip");
});

test("pinned Peekaboo runtime metadata is universal and fixed to the verified OpenClaw release", () => {
  assert.equal(EQUINOX_LOCAL_PEEKABOO_VERSION, "4.2.2");
  assert.equal(EQUINOX_LOCAL_PEEKABOO_TEAM_ID, "FWJYW4S8P8");
  assert.equal(PEEKABOO_DISTRIBUTION.filename, "peekaboo-macos-universal.tar.gz");
  assert.equal(PEEKABOO_DISTRIBUTION.sha256, "80b1983a9a2468e715e176167b75aabb4f43feb4882d667ffccc9373d706602e");
  assert.deepEqual(PEEKABOO_DISTRIBUTION.architectures, ["arm64", "x86_64"]);
});

test("managed release archive is byte-reproducible across source mtimes and creation order", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-reproducible-release-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  async function buildFixture(name, reverse = false) {
    const transaction = path.join(root, name);
    const releaseDir = path.join(transaction, "release");
    const artifactPath = path.join(root, `${name}.tar.gz`);
    await fs.mkdir(path.join(releaseDir, "nested"), { recursive: true });
    const files = reverse
      ? [["nested/b.txt", "beta\n"], ["a.txt", "alpha\n"]]
      : [["a.txt", "alpha\n"], ["nested/b.txt", "beta\n"]];
    for (const [relative, content] of files) {
      await fs.writeFile(path.join(releaseDir, relative), content);
    }
    const skew = new Date(reverse ? "2026-08-25T04:00:00Z" : "2024-01-02T03:04:05Z");
    await fs.utimes(path.join(releaseDir, "a.txt"), skew, skew);
    await fs.utimes(path.join(releaseDir, "nested", "b.txt"), skew, skew);
    await createDeterministicManagedReleaseArchive({ transaction, releaseDir, artifactPath });
    return artifactPath;
  }

  const first = await buildFixture("first", false);
  const second = await buildFixture("second", true);
  assert.deepEqual(await fs.readFile(first), await fs.readFile(second));
  const { stdout } = await execFile("/usr/bin/tar", ["-tzf", first], { timeout: 5_000, maxBuffer: 1024 * 1024 });
  assert.deepEqual(stdout.trim().split(/\r?\n/u), ["release/", "release/a.txt", "release/nested/", "release/nested/b.txt"]);
});
