import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);
const launcher = fileURLToPath(new URL("../../scripts/release/start-main-source-runtime.sh", import.meta.url));
const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;

async function fixture(t, { stableConfig = true } = {}) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "equinox-main-launcher-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const source = path.join(root, "source");
  const state = path.join(home, "Library/Application Support/Equinox Local Developer/main-update");
  const runtimeState = path.join(home, "Library/Application Support/Equinox Local Developer/runtime");
  const nodeAlias = path.join(home, ".local/share/equinox-local-developer/bin/node");
  const pinnedNode = path.join(root, "pinned Node runtime/node");
  const keyFile = path.join(home, ".config/tunnel-client/secrets/equinox-local-runtime-key");
  const trace = path.join(root, "tunnel.calls");
  const watchdogMarker = path.join(root, "watchdog.started");
  const client = path.join(root, "tunnel-client");
  const config = stableConfig ? path.join(runtimeState, "source-runtime.conf") : path.join(root, "runtime.conf");
  const pointer = path.join(state, "current-source.conf");
  await fs.mkdir(path.dirname(nodeAlias), { recursive: true });
  await fs.mkdir(path.dirname(pinnedNode), { recursive: true });
  await fs.mkdir(path.dirname(keyFile), { recursive: true });
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(config), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(source, "src"), { recursive: true });
  await fs.mkdir(path.join(source, "scripts/release"), { recursive: true });
  await fs.writeFile(pinnedNode, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o700 });
  await fs.symlink(pinnedNode, nodeAlias);
  await fs.writeFile(keyFile, "fixture-only\n", { mode: 0o600 });
  await fs.writeFile(path.join(source, "src/server.js"), "export {};\n");
  await fs.writeFile(path.join(source, "scripts/release/watch-source-runtime.mjs"), `import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(watchdogMarker)}, process.argv[2]);\n`);
  await fs.writeFile(client, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(trace)}\ncase "$1:$2" in\n  runtimes:list) printf 'fixture-runtime fixture-tunnel\\n' ;;\n  runtimes:status) printf 'fixture-runtime ready\\n' ;;\n  runtimes:stop|runtimes:connect) ;;\n  *) exit 17 ;;\nesac\n`, { mode: 0o700 });
  await fs.writeFile(config, `launchAgentLabel=dev.equinox.fixture\ntunnelRuntime=fixture-runtime\ntunnelClient=${client}\nsourceLauncher=${launcher}\nsourceLauncherOwnsLifecycle=1\n`, { mode: 0o600 });
  const git = async (...args) => execFile("git", ["-C", source, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await git("add", ".");
  await git("commit", "-m", "fixture");
  await git("remote", "add", "origin", "https://github.com/sametbasbug/equinox-local.git");
  const { stdout } = await git("rev-parse", "HEAD");
  await fs.writeFile(pointer, `schemaVersion=1\nsourceRoot=${source}\nsha=${stdout.trim()}\n`, { mode: 0o600 });
  return { root, home, source, nodeAlias, keyFile, config, pointer, trace, watchdogMarker };
}

async function run(f, extraEnv = {}) {
  return execFile("/bin/zsh", [launcher], {
    timeout: 15_000,
    env: { ...process.env, HOME: f.home, EQUINOX_LOCAL_MAIN_SOURCE_POINTER: f.pointer, ...extraEnv },
  });
}

test("canonical main launcher accepts executable Node alias and reaches owned watchdog", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await fixture(t);
  assert.equal((await fs.lstat(f.nodeAlias)).isSymbolicLink(), true);
  await run(f);
  const calls = await fs.readFile(f.trace, "utf8");
  assert.match(calls, /runtimes connect/u);
  assert.ok(calls.includes(`--mcp-command ${f.nodeAlias} ${f.source}/src/server.js`));
  assert.equal(await fs.readFile(f.watchdogMarker, "utf8"), f.config);
});

test("stable Application Support config wins over a legacy inherited config path", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await fixture(t);
  await run(f, { EQUINOX_LOCAL_DEV_RUNTIME_CONFIG: path.join(f.root, "missing-legacy-private.conf") });
  assert.equal(await fs.readFile(f.watchdogMarker, "utf8"), f.config);
});

test("launcher rejects a dangling Node alias before touching tunnel", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await fixture(t);
  await fs.rm(await fs.realpath(f.nodeAlias));
  await assert.rejects(run(f), (error) => /Developer Node runtime is unavailable/u.test(error.stderr));
  await assert.rejects(fs.stat(f.trace), { code: "ENOENT" });
});

test("launcher rejects symlinked runtime key before touching tunnel", { skip: process.platform !== "darwin" }, async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, "key-target");
  await fs.rename(f.keyFile, target);
  await fs.symlink(target, f.keyFile);
  await assert.rejects(run(f), (error) => /Main source runtime dependency is unavailable/u.test(error.stderr));
  await assert.rejects(fs.stat(f.trace), { code: "ENOENT" });
});
