import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  enrollEquinoxLocalManagedSource,
  installPrebuiltDependencies,
  rollbackEquinoxLocalManagedSourceEnrollment,
} from "../../src/equinox-local-managed-source-enrollment.js";
import { equinoxLocalManagedSourcePaths } from "../../src/equinox-local-managed-source-installation.js";

const SHA = "a".repeat(40);

async function fixture(t) {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-enroll-"));
  const homeDir = await fs.realpath(temporaryHome);
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const appDataRoot = path.join(homeDir, "Library", "Application Support", "Equinox Local");
  await fs.mkdir(appDataRoot, { recursive: true, mode: 0o700 });
  const paths = equinoxLocalManagedSourcePaths({ platform: "darwin", arch: "arm64", homeDir, env: {} });
  const runtimeRoot = path.join(appDataRoot, "runtime");
  const contract = Object.freeze({
    target: "darwin-arm64",
    runtimeRoot,
    ambientPathDiscovery: false,
    gitPath: path.join(runtimeRoot, "toolchain", "git", "bin", "git"),
    nodePath: path.join(runtimeRoot, "toolchain", "node", "bin", "node"),
    npmPath: path.join(runtimeRoot, "toolchain", "node", "npm-cli.js"),
  });
  return { homeDir, paths, contract };
}

function inspectorForSha() {
  return async (root) => {
    let stat;
    try { stat = await fs.lstat(root); } catch (error) { if (error?.code === "ENOENT") throw error; throw error; }
    if (!stat.isDirectory()) return { eligible: false };
    return { eligible: true, currentSha: SHA, sourceRoot: root };
  };
}

test("fresh enrollment binds exact Stable source SHA and writes install stamp last", async (t) => {
  const f = await fixture(t);
  const events = [];
  const result = await enrollEquinoxLocalManagedSource({
    bootstrapSha: SHA,
    target: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    homeDir: f.homeDir,
    env: {},
    provisionToolchainImpl: async (value) => { events.push(["provision", value.target]); await fs.mkdir(f.contract.runtimeRoot, { recursive: true }); return { contract: f.contract }; },
    execFileImpl: async (command, args) => {
      events.push(["exec", command, [...args]]);
      if (command !== f.contract.gitPath) throw new Error(`unexpected command ${command}`);
      if (args[0] === "clone") await fs.mkdir(args.at(-1), { recursive: true });
      return { stdout: "", stderr: "" };
    },
    inspectCheckoutImpl: inspectorForSha(),
    installDependenciesImpl: async (root, contract) => { events.push(["dependencies", root, contract.nodePath, contract.npmPath]); },
    validateSourceImpl: async (root) => { events.push(["validate", root]); },
    writePointerImpl: async (pointerPath, value, options) => {
      events.push(["pointer", pointerPath, value.sha, options.gitPath]);
      await assert.rejects(fs.lstat(f.paths.installStampPath), { code: "ENOENT" });
      await fs.writeFile(pointerPath, `schemaVersion=1\nsourceRoot=${value.sourceRoot}\nsha=${value.sha}\n`, { mode: 0o600 });
      return value;
    },
    randomBytesImpl: () => Buffer.alloc(8, 0xab),
  });

  assert.equal(result.status, "enrolled");
  assert.equal(result.bootstrapSha, SHA);
  assert.equal(result.sourceRoot, path.join(f.paths.mainTransactionRoot, "sources", SHA));
  assert.deepEqual(events[0], ["provision", "darwin-arm64"]);
  const clone = events.find((event) => event[0] === "exec" && event[2][0] === "clone");
  assert.equal(clone[1], f.contract.gitPath);
  assert.equal(clone[2].includes("https://github.com/sametbasbug/equinox-local.git"), true);
  const checkout = events.find((event) => event[0] === "exec" && event[2].includes("checkout"));
  assert.equal(checkout[2].at(-1), SHA);
  assert.equal(events.some((event) => event[0] === "dependencies" && event[2] === f.contract.nodePath && event[3] === f.contract.npmPath), true);
  assert.equal(events.at(-1)[0], "pointer");
  const stamp = JSON.parse(await fs.readFile(f.paths.installStampPath, "utf8"));
  assert.deepEqual(stamp, { schemaVersion: 1, channel: "main", repository: "sametbasbug/equinox-local", branch: "main", bootstrapSha: SHA });
  assert.equal((await fs.stat(f.paths.installStampPath)).mode & 0o077, 0);
  assert.deepEqual(await fs.readdir(path.join(f.paths.mainTransactionRoot, "enrollment-staging")), []);
});

test("enrollment failure before commit point preserves Stable identity and cleans staging", async (t) => {
  const f = await fixture(t);
  await assert.rejects(enrollEquinoxLocalManagedSource({
    bootstrapSha: SHA,
    target: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    homeDir: f.homeDir,
    env: {},
    provisionToolchainImpl: async () => { await fs.mkdir(f.contract.runtimeRoot, { recursive: true }); return { contract: f.contract }; },
    execFileImpl: async (_command, args) => { if (args[0] === "clone") await fs.mkdir(args.at(-1), { recursive: true }); return { stdout: "", stderr: "" }; },
    inspectCheckoutImpl: inspectorForSha(),
    installDependenciesImpl: async () => {},
    validateSourceImpl: async () => { throw new Error("synthetic validation failure"); },
    randomBytesImpl: () => Buffer.alloc(8, 0xcd),
  }), /synthetic validation failure/u);
  await assert.rejects(fs.lstat(f.paths.installStampPath), { code: "ENOENT" });
  await assert.rejects(fs.lstat(f.paths.sourcePointerPath), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(path.join(f.paths.mainTransactionRoot, "enrollment-staging")), []);
});

test("enrollment rollback removes identity state but preserves reusable source and toolchain", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.contract.runtimeRoot, { recursive: true });
  await fs.mkdir(path.join(f.paths.mainTransactionRoot, "sources", SHA), { recursive: true });
  await fs.writeFile(f.paths.installStampPath, `${JSON.stringify({
    schemaVersion: 1, channel: "main", repository: "sametbasbug/equinox-local", branch: "main", bootstrapSha: SHA,
  })}\n`, { mode: 0o600 });
  await fs.writeFile(f.paths.sourcePointerPath, `schemaVersion=1\nsourceRoot=${path.join(f.paths.mainTransactionRoot, "sources", SHA)}\nsha=${SHA}\n`, { mode: 0o600 });

  const result = await rollbackEquinoxLocalManagedSourceEnrollment({
    bootstrapSha: SHA,
    target: "darwin-arm64",
    platform: "darwin",
    arch: "arm64",
    homeDir: f.homeDir,
    env: {},
    readPointerImpl: async () => ({ sourceRoot: path.join(f.paths.mainTransactionRoot, "sources", SHA), sha: SHA }),
  });
  assert.equal(result.rolledBack, true);
  await assert.rejects(fs.lstat(f.paths.installStampPath), { code: "ENOENT" });
  await assert.rejects(fs.lstat(f.paths.sourcePointerPath), { code: "ENOENT" });
  assert.equal((await fs.stat(path.join(f.paths.mainTransactionRoot, "sources", SHA))).isDirectory(), true);
  assert.equal((await fs.stat(f.contract.runtimeRoot)).isDirectory(), true);
});

test("prebuilt dependency install never exposes node-gyp fallback", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-prebuild-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nodePty = path.join(root, "node_modules", "node-pty");
  await fs.mkdir(path.join(nodePty, "scripts"), { recursive: true });
  await fs.writeFile(path.join(nodePty, "scripts", "prebuild.js"), "// fixture\n");
  await fs.writeFile(path.join(nodePty, "scripts", "post-install.js"), "// fixture\n");
  const calls = [];
  const contract = { nodePath: "/owned/node", npmPath: "/owned/npm-cli.js" };
  await installPrebuiltDependencies(root, contract, { execFileImpl: async (command, args, options) => { calls.push({ command, args: [...args], cwd: options.cwd, env: options.env }); return { stdout: "", stderr: "" }; } });
  assert.deepEqual(calls[0].args, [contract.npmPath, "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  assert.equal(calls[0].command, contract.nodePath);
  assert.equal(calls[0].env.npm_config_build_from_source, "false");
  assert.equal(calls[1].args[0], path.join(nodePty, "scripts", "prebuild.js"));
  assert.equal(calls[2].args[0], path.join(nodePty, "scripts", "post-install.js"));
  assert.equal(calls.some((call) => call.command.includes("node-gyp") || call.args.some((arg) => String(arg).includes("node-gyp"))), false);
});
