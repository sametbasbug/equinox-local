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
  resolveManagedReleaseSourceSha,
  TUNNEL_CLIENT_DISTRIBUTIONS,
} from "../../scripts/release/package-managed-release.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFile = promisify(execFileCallback);

test("managed release provenance binds packaging to an exact clean Git HEAD", async () => {
  const root = "/tmp/equinox-release-source";
  const sha = "a".repeat(40);
  const calls = [];
  const clean = await resolveManagedReleaseSourceSha(root, {
    execFileImpl: async (command, args) => {
      calls.push([command, args]);
      if (args.includes("rev-parse")) return { stdout: `${sha}\n` };
      return { stdout: "" };
    },
  });
  assert.equal(clean, sha);
  assert.deepEqual(calls.map(([, args]) => args.slice(2)), [
    ["rev-parse", "HEAD"],
    ["status", "--porcelain=v1", "--untracked-files=normal"],
  ]);

  await assert.rejects(resolveManagedReleaseSourceSha(root, {
    execFileImpl: async (_command, args) => args.includes("rev-parse")
      ? { stdout: `${sha}\n` }
      : { stdout: " M src/server.js\n" },
  }), /must be clean/u);

  await assert.rejects(resolveManagedReleaseSourceSha(root, {
    execFileImpl: async () => ({ stdout: "not-a-sha\n" }),
  }), /source SHA is invalid/u);
});

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
    "app/EquinoxLocal.png",
    "app/EquinoxLocalMenuBar.png",
    "app/EquinoxCompanionNyx.webp",
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
  assert.equal(files.some((value) => value.startsWith("factory/browser/")), false);
});

test("managed release source graph includes the complete browser UI dependency graph", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-ui-source-graph-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixtureFiles = [
    "src/server.js", "src/equinox-local-bootstrap.js", "src/equinox-local-first-install.js",
    "src/equinox-browser-native-host.js", "src/equinox-local-update-helper.js",
    "src/equinox-local-restart-helper.js", "src/equinox-local-uninstall-helper.js",
    "src/equinox-local-supervisor.js", "src/equinox-control-center.html",
    "src/equinox-control-center.css", "src/equinox-control-center.js",
    "app/EquinoxLocal.png", "app/EquinoxLocalMenuBar.png", "app/EquinoxCompanionNyx.webp",
    "package.json", "package-lock.json", "src/ui-dependency.js", "src/ui-leaf.js",
  ];
  for (const relative of fixtureFiles) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), "");
  }
  await fs.writeFile(path.join(root, "src/equinox-control-center.js"), 'import { label } from "./ui-dependency.js";\n');
  await fs.writeFile(path.join(root, "src/ui-dependency.js"), 'export { label } from "./ui-leaf.js";\n');
  await fs.writeFile(path.join(root, "src/ui-leaf.js"), 'export const label = "fixture";\n');

  const files = await collectManagedReleaseSourceFiles(root);
  assert.equal(files.includes("src/ui-dependency.js"), true, "UI imports must ship with the managed release");
  assert.equal(files.includes("src/ui-leaf.js"), true, "transitive UI imports must ship with the managed release");
  assert.equal(files.filter((file) => file === "src/equinox-control-center.js").length, 1);
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

test("pinned Node runtime metadata covers all four production release targets", () => {
  assert.equal(EQUINOX_LOCAL_NODE_VERSION, "26.11.1");
  assert.deepEqual(Object.keys(NODE_DISTRIBUTIONS).sort(), ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]);
  assert.match(NODE_DISTRIBUTIONS["darwin-arm64"].sha256, /^[a-f0-9]{64}$/u);
  assert.match(NODE_DISTRIBUTIONS["darwin-x64"].sha256, /^[a-f0-9]{64}$/u);
  assert.equal(NODE_DISTRIBUTIONS["darwin-arm64"].fileArchitecture, "arm64");
  assert.equal(NODE_DISTRIBUTIONS["darwin-x64"].fileArchitecture, "x86_64");
  assert.equal(NODE_DISTRIBUTIONS["win32-arm64"].filename, "node-v26.11.1-win-arm64.zip");
  assert.equal(NODE_DISTRIBUTIONS["win32-arm64"].sha256, "8dd03add3ed431eb436306f9abe946434bce928d2bf967b04117dc3755051208");
  assert.equal(NODE_DISTRIBUTIONS["win32-arm64"].fileArchitecture, "arm64");
  assert.equal(NODE_DISTRIBUTIONS["win32-x64"].filename, "node-v26.11.1-win-x64.zip");
  assert.equal(NODE_DISTRIBUTIONS["win32-x64"].sha256, "97f36a8a9684ff0d3e35758b4610fef5b628a5880e96f2ccc11240e5daf9934e");
  assert.equal(NODE_DISTRIBUTIONS["win32-x64"].fileArchitecture, "x86_64");
});

test("pinned tunnel runtime metadata covers all four production release targets", () => {
  assert.equal(EQUINOX_LOCAL_TUNNEL_CLIENT_VERSION, "0.0.16");
  assert.deepEqual(Object.keys(TUNNEL_CLIENT_DISTRIBUTIONS).sort(), ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]);
  assert.match(TUNNEL_CLIENT_DISTRIBUTIONS["darwin-arm64"].sha256, /^[a-f0-9]{64}$/u);
  assert.match(TUNNEL_CLIENT_DISTRIBUTIONS["darwin-x64"].sha256, /^[a-f0-9]{64}$/u);
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["darwin-arm64"].fileArchitecture, "arm64");
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["darwin-x64"].fileArchitecture, "x86_64");
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["darwin-arm64"].filename, "tunnel-client-v0.0.16-darwin-arm64.zip");
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["darwin-x64"].filename, "tunnel-client-v0.0.16-darwin-amd64.zip");
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["win32-arm64"].assetTag, "windows-arm64");
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["win32-arm64"].filename, "tunnel-client-v0.0.16-windows-arm64.zip");
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["win32-arm64"].sha256, "ecd748288b9bd9cc8f5a963855eb143f4788b831475156703d0bafdcd2dcb149");
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["win32-arm64"].fileArchitecture, "arm64");
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["win32-x64"].assetTag, "windows-amd64");
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["win32-x64"].filename, "tunnel-client-v0.0.16-windows-amd64.zip");
  assert.equal(TUNNEL_CLIENT_DISTRIBUTIONS["win32-x64"].sha256, "edef7241b0c647fcb30f1a80ff376b6b25c51927960f257a3f01e21b17c2aba6");
});

test("pinned Peekaboo runtime metadata is universal and fixed to the verified OpenClaw release", () => {
  assert.equal(EQUINOX_LOCAL_PEEKABOO_VERSION, "4.9.0");
  assert.equal(EQUINOX_LOCAL_PEEKABOO_TEAM_ID, "FWJYW4S8P8");
  assert.equal(PEEKABOO_DISTRIBUTION.filename, "peekaboo-macos-universal.tar.gz");
  assert.equal(PEEKABOO_DISTRIBUTION.sha256, "64884da09af4f707267ee5ee7364f31c34bfeb8a6f1404478e1babc9ff412230");
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

test("third-party runtimes are pinned downloads, not vendored source trees", async () => {
  const packageSource = await fs.readFile(new URL("../../scripts/release/package-managed-release-windows.mjs", import.meta.url), "utf8");
  assert.match(packageSource, /licenses.*microsoft-winapp-cli\.txt/u);
  assert.doesNotMatch(packageSource, /third_party/u);
  await fs.access(new URL("../../licenses/microsoft-winapp-cli.txt", import.meta.url));
  await fs.access(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url));
  await assert.rejects(fs.lstat(new URL("../../third_party", import.meta.url)), { code: "ENOENT" });
});
