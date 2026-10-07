import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  provisionEquinoxLocalToolchain,
  toolchainFetchForArtifact,
  validateToolchainTarListing,
} from "../../src/equinox-local-toolchain-provisioner.js";

function verbose(type, size, name, linkTarget = null) {
  const suffix = linkTarget === null ? name : `${name} -> ${linkTarget}`;
  return `${type}rwxr-xr-x 0 user group ${size} Jan 01 00:00 ${suffix}`;
}


test("M8 toolchain network policy permits only the exact GitHub release CDN redirect", async () => {
  const artifact = { url: "https://github.com/desktop/dugite-native/releases/download/v1/file.tar.gz" };
  const calls = [];
  const trusted = toolchainFetchForArtifact(artifact, async (url, options) => {
    calls.push([String(url), options.redirect]);
    if (calls.length === 1) {
      return {
        status: 302,
        headers: { get: (name) => name === "location" ? "https://release-assets.githubusercontent.com/github-production-release-asset/1/token" : null },
      };
    }
    return { status: 200 };
  });
  assert.equal((await trusted(artifact.url, { redirect: "error" })).status, 200);
  assert.deepEqual(calls.map(([, redirect]) => redirect), ["manual", "error"]);

  const hostile = toolchainFetchForArtifact(artifact, async () => ({
    status: 302,
    headers: { get: () => "https://example.com/payload" },
  }));
  await assert.rejects(hostile(artifact.url), /not trusted/u);
  assert.throws(() => toolchainFetchForArtifact({ url: "http://github.com/file" }, async () => {}), /HTTPS/u);
});

test("M8 tar inspection accepts bounded internal Node/Dugite symlinks", () => {
  const result = validateToolchainTarListing({
    expectedRoot: "node-v26.10.0-darwin-arm64",
    namesOutput: [
      "node-v26.10.0-darwin-arm64/",
      "node-v26.10.0-darwin-arm64/bin/",
      "node-v26.10.0-darwin-arm64/bin/node",
      "node-v26.10.0-darwin-arm64/bin/npm",
      "node-v26.10.0-darwin-arm64/lib/node_modules/npm/bin/npm-cli.js",
    ].join("\n"),
    verboseOutput: [
      verbose("d", 0, "node-v26.10.0-darwin-arm64/"),
      verbose("d", 0, "node-v26.10.0-darwin-arm64/bin/"),
      verbose("-", 10, "node-v26.10.0-darwin-arm64/bin/node"),
      verbose("l", 0, "node-v26.10.0-darwin-arm64/bin/npm", "../lib/node_modules/npm/bin/npm-cli.js"),
      verbose("-", 5, "node-v26.10.0-darwin-arm64/lib/node_modules/npm/bin/npm-cli.js"),
    ].join("\n"),
  });
  assert.deepEqual(result, { entryCount: 5, extractedBytes: 15 });

  assert.deepEqual(validateToolchainTarListing({
    expectedRoot: ".",
    namesOutput: "./bin/git\n./libexec/git-core/git-fetch\n",
    verboseOutput: [
      verbose("-", 10, "./bin/git"),
      verbose("l", 0, "./libexec/git-core/git-fetch", "git"),
    ].join("\n"),
  }), { entryCount: 2, extractedBytes: 10 });
});

test("M8 tar inspection rejects root escape, traversal, unsafe symlinks and symlink descendants", () => {
  const cases = [
    {
      namesOutput: "other/file\n",
      verboseOutput: verbose("-", 1, "other/file"),
      expectedRoot: "root",
      pattern: /expected root/u,
    },
    {
      namesOutput: "root/../escape\n",
      verboseOutput: verbose("-", 1, "root/../escape"),
      expectedRoot: "root",
      pattern: /traversal/u,
    },
    {
      namesOutput: "root/link\n",
      verboseOutput: verbose("l", 0, "root/link", "../../escape"),
      expectedRoot: "root",
      pattern: /symbolic link escapes/u,
    },
    {
      namesOutput: "root/link\nroot/link/file\n",
      verboseOutput: [verbose("l", 0, "root/link", "target"), verbose("-", 1, "root/link/file")].join("\n"),
      expectedRoot: "root",
      pattern: /beneath a symbolic link/u,
    },
    {
      namesOutput: "root/device\n",
      verboseOutput: verbose("c", 0, "root/device"),
      expectedRoot: "root",
      pattern: /only regular files/u,
    },
  ];
  for (const fixture of cases) assert.throws(() => validateToolchainTarListing(fixture), fixture.pattern);
});

async function createFixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-toolchain-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, runtimeRoot: path.join(base, "runtime") };
}

async function fakeExtract({ extractionRoot, component }) {
  const root = component.archiveRoot === "." ? extractionRoot : path.join(extractionRoot, component.archiveRoot);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if (component.component === "git") {
    await fs.mkdir(path.join(root, "bin"), { recursive: true });
    await fs.writeFile(path.join(root, "bin", "git"), "git\n", { mode: 0o700 });
  } else {
    await fs.mkdir(path.join(root, "bin"), { recursive: true });
    await fs.mkdir(path.join(root, "lib", "node_modules", "npm", "bin"), { recursive: true });
    await fs.writeFile(path.join(root, "bin", "node"), "node\n", { mode: 0o700 });
    await fs.writeFile(path.join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js"), "npm\n");
    await fs.writeFile(path.join(root, "lib", "node_modules", "npm", "bin", "npx-cli.js"), "npx\n");
  }
}

function fakeExec(command) {
  if (command.endsWith("/git")) return Promise.resolve({ stdout: "git version 2.53.0\n", stderr: "" });
  if (command.endsWith("/node")) return Promise.resolve({ stdout: "v26.10.0\n", stderr: "" });
  throw new Error(`unexpected executable: ${command}`);
}


test("M8 Windows provisioner rejects a non-absolute or renamed ZIP helper before filesystem mutation", async () => {
  await assert.rejects(provisionEquinoxLocalToolchain({
    runtimeRoot: "C:\\Users\\fixture\\Equinox Local\\runtime",
    target: "win32-x64",
    platform: "win32",
    windowsZipHelperPath: "relative\\equinox-local-windows-release-zip.ps1",
  }), /ZIP helper path is invalid/u);
  await assert.rejects(provisionEquinoxLocalToolchain({
    runtimeRoot: "C:\\Users\\fixture\\Equinox Local\\runtime",
    target: "win32-x64",
    platform: "win32",
    windowsZipHelperPath: "C:\\Users\\fixture\\other.ps1",
  }), /ZIP helper path is invalid/u);
});

test("M8 provisioner installs atomically, stamps exact distributions and reuses them", async (t) => {
  const f = await createFixture(t);
  const downloads = [];
  const result = await provisionEquinoxLocalToolchain({
    runtimeRoot: f.runtimeRoot,
    target: "darwin-arm64",
    platform: "darwin",
    downloadImpl: async (artifact, destination) => {
      downloads.push(artifact.filename);
      await fs.writeFile(destination, "archive");
    },
    extractComponentImpl: fakeExtract,
    execFileImpl: fakeExec,
  });
  assert.deepEqual(result.components.map(({ component, status }) => [component, status]), [["git", "installed"], ["node", "installed"]]);
  assert.equal(downloads.length, 2);
  assert.equal((await fs.readdir(path.dirname(result.contract.git.root))).some((name) => name.startsWith(".install-")), false);
  const gitStamp = JSON.parse(await fs.readFile(path.join(result.contract.git.root, ".equinox-toolchain-component.json"), "utf8"));
  assert.equal(gitStamp.artifact.sha256, result.contract.git.distribution.sha256);

  downloads.length = 0;
  const reused = await provisionEquinoxLocalToolchain({
    runtimeRoot: f.runtimeRoot,
    target: "darwin-arm64",
    platform: "darwin",
    downloadImpl: async () => { throw new Error("must not download"); },
    extractComponentImpl: async () => { throw new Error("must not extract"); },
    execFileImpl: fakeExec,
  });
  assert.deepEqual(reused.components.map(({ status }) => status), ["reused", "reused"]);
  assert.equal(downloads.length, 0);
});

test("M8 provisioner starts independent Git and Node component downloads concurrently", async (t) => {
  const f = await createFixture(t);
  const started = [];
  let releaseBoth;
  const bothStarted = new Promise((resolve) => { releaseBoth = resolve; });
  const provision = provisionEquinoxLocalToolchain({
    runtimeRoot: f.runtimeRoot,
    target: "darwin-arm64",
    platform: "darwin",
    downloadImpl: async (artifact, destination) => {
      started.push(artifact.filename);
      if (started.length === 2) releaseBoth();
      await bothStarted;
      await fs.writeFile(destination, "archive");
    },
    extractComponentImpl: fakeExtract,
    execFileImpl: fakeExec,
  });
  await Promise.race([
    bothStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("toolchain component downloads did not overlap")), 250)),
  ]);
  const result = await provision;
  assert.equal(started.length, 2);
  assert.deepEqual(result.components.map(({ component }) => component), ["git", "node"]);
});

test("M8 provisioner fails closed on symlinked ancestors and cleans failed transactions", async (t) => {
  const f = await createFixture(t);
  await fs.mkdir(f.runtimeRoot);
  await fs.mkdir(path.join(f.runtimeRoot, "toolchain"));
  const outside = path.join(f.base, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(f.runtimeRoot, "toolchain", "git"));

  await assert.rejects(provisionEquinoxLocalToolchain({
    runtimeRoot: f.runtimeRoot,
    target: "darwin-arm64",
    platform: "darwin",
    downloadImpl: async () => assert.fail("network must not be reached"),
    extractComponentImpl: fakeExtract,
    execFileImpl: fakeExec,
  }), /directory is unsafe/u);

  await fs.rm(path.join(f.runtimeRoot, "toolchain", "git"));
  await assert.rejects(provisionEquinoxLocalToolchain({
    runtimeRoot: f.runtimeRoot,
    target: "darwin-arm64",
    platform: "darwin",
    downloadImpl: async () => { throw new Error("download failed"); },
    extractComponentImpl: fakeExtract,
    execFileImpl: fakeExec,
  }), /download failed/u);
  const gitVersionRoot = path.join(f.runtimeRoot, "toolchain", "git", "2.53.0-4");
  assert.equal((await fs.readdir(gitVersionRoot)).some((name) => name.startsWith(".install-")), false);
});

test("M8 provisioner rejects tampered installed stamps without replacing the component", async (t) => {
  const f = await createFixture(t);
  const first = await provisionEquinoxLocalToolchain({
    runtimeRoot: f.runtimeRoot,
    target: "darwin-arm64",
    platform: "darwin",
    downloadImpl: async (_artifact, destination) => fs.writeFile(destination, "archive"),
    extractComponentImpl: fakeExtract,
    execFileImpl: fakeExec,
  });
  const stamp = path.join(first.contract.git.root, ".equinox-toolchain-component.json");
  const parsed = JSON.parse(await fs.readFile(stamp, "utf8"));
  parsed.artifact.sha256 = "0".repeat(64);
  await fs.writeFile(stamp, `${JSON.stringify(parsed)}\n`);

  await assert.rejects(provisionEquinoxLocalToolchain({
    runtimeRoot: f.runtimeRoot,
    target: "darwin-arm64",
    platform: "darwin",
    downloadImpl: async () => assert.fail("tampered component must not be auto-replaced"),
    extractComponentImpl: fakeExtract,
    execFileImpl: fakeExec,
  }), /stamp does not match/u);
});
