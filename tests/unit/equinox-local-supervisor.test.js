import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  managedSupervisorPaths,
  readSupervisorTransport,
  resolveSupervisorRelease,
  runManagedSupervisor,
  shellQuote,
  supervisorChildEnvironment,
  tunnelInitArguments,
} from "../../src/equinox-local-supervisor.js";
import { equinoxLocalUpdateTarget } from "../../src/equinox-local-updater.js";

async function makeFixture({ transport = false, malformedTransport = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-supervisor-"));
  const homeDir = path.join(root, "User Home");
  const paths = managedSupervisorPaths(homeDir);
  const releaseDir = path.join(paths.releasesRoot, "4.2.0");
  const nodeBinary = path.join(releaseDir, "runtime", "node", "bin", "node");
  const tunnelDir = path.join(releaseDir, "runtime", "tunnel");
  await fs.mkdir(path.dirname(nodeBinary), { recursive: true });
  await fs.mkdir(tunnelDir, { recursive: true });
  await fs.writeFile(path.join(releaseDir, "release.json"), JSON.stringify({
    schemaVersion: 1,
    version: "4.2.0",
    target: equinoxLocalUpdateTarget(),
    nodeVersion: "24.19.0",
    tunnelClientVersion: "0.0.12",
    serverEntry: "server.js",
  }));
  await fs.writeFile(path.join(releaseDir, "server.js"), "// fixture\n");
  await fs.writeFile(nodeBinary, "fixture node\n");
  await fs.chmod(nodeBinary, 0o755);
  for (const name of ["tunnel-client", "cloudflared"]) {
    const binary = path.join(tunnelDir, name);
    await fs.writeFile(binary, `${name}\n`);
    await fs.chmod(binary, 0o755);
  }
  await fs.mkdir(paths.installRoot, { recursive: true });
  await fs.symlink("releases/4.2.0", paths.currentLink, "dir");

  if (transport || malformedTransport) {
    await fs.mkdir(path.dirname(paths.runtimeKeyPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(paths.runtimeKeyPath, "sk-runtime-fixture\n", { mode: 0o600 });
    await fs.writeFile(paths.transportConfigPath, malformedTransport
      ? "not json\n"
      : `${JSON.stringify({ version: 1, mode: "openai-tunnel", tunnelId: "tunnel_0123456789abcdef0123456789abcdef" }, null, 2)}\n`,
    { mode: 0o600 });
  }
  return { root, homeDir, paths, releaseDir, nodeBinary, tunnelDir };
}

test("managed supervisor resolves only the current target-specific release", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const release = await resolveSupervisorRelease(fixture.paths);
  assert.equal(release.version, "4.2.0");
  assert.equal(release.releaseDir, await fs.realpath(fixture.releaseDir));
  assert.equal(release.metadata.target, equinoxLocalUpdateTarget());
});

test("transport config is optional and requires a private fixed runtime key", async (t) => {
  const absent = await makeFixture();
  t.after(() => fs.rm(absent.root, { recursive: true, force: true }));
  assert.equal(await readSupervisorTransport(absent.paths), null);

  const configured = await makeFixture({ transport: true });
  t.after(() => fs.rm(configured.root, { recursive: true, force: true }));
  const transport = await readSupervisorTransport(configured.paths);
  assert.equal(transport.mode, "openai-tunnel");
  assert.equal(transport.tunnelId, "tunnel_0123456789abcdef0123456789abcdef");
  await fs.chmod(configured.paths.runtimeKeyPath, 0o644);
  await assert.rejects(readSupervisorTransport(configured.paths), /permissions/u);
});

test("supervisor child environment keeps managed paths but drops provider credentials", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const env = supervisorChildEnvironment({
    paths: fixture.paths,
    releaseDir: fixture.releaseDir,
    sourceEnv: {
      USER: "example",
      TMPDIR: "/tmp/example",
      OPENAI_API_KEY: "must-not-leak",
      GITHUB_TOKEN: "must-not-leak",
    },
  });
  assert.equal(env.HOME, fixture.homeDir);
  assert.equal(env.EQUINOX_LOCAL_RELEASE_DIR, fixture.releaseDir);
  assert.equal(env.USER, "example");
  assert.equal("OPENAI_API_KEY" in env, false);
  assert.equal("GITHUB_TOKEN" in env, false);
});

test("tunnel profile init uses the fixed secret file and safely quoted managed command", async (t) => {
  const fixture = await makeFixture({ transport: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const transport = await readSupervisorTransport(fixture.paths);
  const args = tunnelInitArguments({ paths: fixture.paths, releaseDir: fixture.releaseDir, transport });
  assert.equal(args[0], "init");
  assert.equal(args.includes("--force"), true);
  assert.equal(args.includes(`file:${fixture.paths.runtimeKeyPath}`), true);
  const command = args[args.indexOf("--mcp-command") + 1];
  assert.match(command, /^'.*node' '.*server\.js'$/u);
  assert.equal(shellQuote("a'b"), `'a'\"'\"'b'`);
});

test("local-only mode keeps Control Center available before tunnel onboarding", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const children = [];
  const result = await runManagedSupervisor({
    homeDir: fixture.homeDir,
    sourceEnv: { EQUINOX_LOCAL_INSTALL_ROOT: fixture.paths.installRoot, USER: "example" },
    execFileImpl: async () => { throw new Error("must not initialize tunnel"); },
    runChildImpl: async (...args) => {
      children.push(args);
      return { code: 0, signal: null, terminatingSignal: "SIGTERM" };
    },
  });
  assert.equal(result.mode, "local-only");
  assert.equal(children.length, 1);
  const realReleaseDir = await fs.realpath(fixture.releaseDir);
  assert.equal(children[0][0], path.join(realReleaseDir, "runtime", "node", "bin", "node"));
  assert.deepEqual(children[0][1], [path.join(realReleaseDir, "server.js")]);
  assert.equal(children[0][2].stdio[0], "pipe");
  assert.equal(children[0][2].env.EQUINOX_LOCAL_RELEASE_DIR, fixture.releaseDir);
  assert.equal(children[0][2].env.EQUINOX_LOCAL_SUPERVISOR_MODE, "local-only");
});

test("configured tunnel mode materializes a profile and supervises the bundled tunnel runtime", async (t) => {
  const fixture = await makeFixture({ transport: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const initCalls = [];
  const children = [];
  const result = await runManagedSupervisor({
    homeDir: fixture.homeDir,
    sourceEnv: { EQUINOX_LOCAL_INSTALL_ROOT: fixture.paths.installRoot, USER: "example" },
    execFileImpl: async (...args) => initCalls.push(args),
    runChildImpl: async (...args) => {
      children.push(args);
      return { code: null, signal: "SIGTERM", terminatingSignal: "SIGTERM" };
    },
  });
  assert.equal(result.mode, "tunnel");
  assert.equal(initCalls.length, 1);
  const realReleaseDir = await fs.realpath(fixture.releaseDir);
  const tunnelBinary = path.join(realReleaseDir, "runtime", "tunnel", "tunnel-client");
  assert.equal(initCalls[0][0], tunnelBinary);
  assert.equal(children.length, 1);
  assert.equal(children[0][0], tunnelBinary);
  assert.deepEqual(children[0][1], ["run", "--profile", "equinox-local", "--profile-dir", fixture.paths.profileDir]);
  assert.equal(children[0][2].env.EQUINOX_LOCAL_RELEASE_DIR, fixture.releaseDir);
  assert.equal(children[0][2].env.EQUINOX_LOCAL_SUPERVISOR_MODE, "tunnel");
});

test("malformed tunnel configuration fails closed to local-only mode", async (t) => {
  const fixture = await makeFixture({ malformedTransport: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  let tunnelInitCalls = 0;
  const result = await runManagedSupervisor({
    homeDir: fixture.homeDir,
    sourceEnv: { EQUINOX_LOCAL_INSTALL_ROOT: fixture.paths.installRoot },
    execFileImpl: async () => { tunnelInitCalls += 1; },
    runChildImpl: async () => ({ code: 0, signal: null, terminatingSignal: "SIGTERM" }),
  });
  assert.equal(result.mode, "local-only");
  assert.equal(tunnelInitCalls, 0);
});
