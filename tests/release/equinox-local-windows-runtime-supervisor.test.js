import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { windowsTunnelInitArguments, windowsTunnelReconnectDelay, runWindowsSupervisorChild, runWindowsShellRuntimeSupervisor } from "../../src/equinox-local-windows-runtime-supervisor.js";

const homeDir = "C:\\Users\\Example User";
const env = {
  LOCALAPPDATA: "C:\\Users\\Example User\\AppData\\Local",
  USERPROFILE: homeDir,
  SystemRoot: "C:\\Windows",
  EQUINOX_LOCAL_INSTALL_ROOT: "C:\\Users\\Example User\\AppData\\Local\\Equinox Local",
  EQUINOX_LOCAL_RELEASE_DIR: "C:\\Users\\Example User\\AppData\\Local\\Equinox Local\\releases\\6.0.1",
  OPENAI_API_KEY: "must-never-reach-child",
};
const serverPath = path.win32.join(env.EQUINOX_LOCAL_RELEASE_DIR, "server.js");
const tunnelId = "tunnel_0123456789abcdef0123456789abcdef";
const mk = (overrides={}) => ({
  platform: "win32",homeDir,env,serverPath,
  mkdirImpl: async()=>{}, protectProfileImpl: async()=>{},
  readTransportImpl: async()=>null,
  runChildImpl: async()=>({code:0,signal:null}),...overrides,
});

test("Windows runtime with no saved tunnel stays accessible in local-only onboarding", async()=>{
  const calls=[];
  const result=await runWindowsShellRuntimeSupervisor(mk({
    runChildImpl:async(cmd,args,opts)=>{calls.push({cmd,args,opts});return {code:0,signal:null};},
    execFileImpl:async()=>{throw new Error("no tunnel client permitted")},
  }));
  assert.equal(result.mode,"local-only");assert.equal(calls.length,1);
  assert.equal(calls[0].args[0],serverPath);
  assert.equal(calls[0].opts.env.EQUINOX_LOCAL_SUPERVISOR_MODE,"local-only");
  assert.equal(calls[0].opts.env.OPENAI_API_KEY,undefined);
});

test("Windows runtime with validated transport initializes and runs tunnel under native shell", async()=>{
  const events=[];
  const result=await runWindowsShellRuntimeSupervisor(mk({
    readTransportImpl:async(_paths,opts)=>{assert.equal(opts.platform,"win32");return {tunnelId};},
    mkdirImpl:async(pathName)=>events.push(["mkdir",pathName]),
    protectProfileImpl:async(input)=>events.push(["acl",input.type]),
    execFileImpl:async(cmd,args,opts)=>{events.push(["init",cmd,args,opts]);return {stdout:""};},
    runChildImpl:async(cmd,args,opts)=>{events.push(["run",cmd,args,opts]);return {code:0,terminatingSignal:"SIGTERM"};},
  }));
  assert.equal(result.mode,"tunnel");assert.deepEqual(events.map(x=>x[0]),["mkdir","acl","init","run"]);
  const init=events[2];assert.ok(init[1].endsWith("tunnel-client.exe"));
  assert.equal(init[2][init[2].indexOf("--tunnel-id")+1],tunnelId);
  assert.ok(init[2][init[2].indexOf("--control-plane-api-key-ref")+1].startsWith("file:"));
  assert.equal(init[3].env.OPENAI_API_KEY,undefined);
  assert.deepEqual(events[3][2].slice(0,3),["run","--profile","equinox-local"]);
  assert.equal(events[3][3].env.EQUINOX_LOCAL_SUPERVISOR_MODE,"tunnel");
});

test("Windows tunnel initialization failure leaves local-only Control Center reachable",async()=>{
  const events=[];
  const result=await runWindowsShellRuntimeSupervisor(mk({
    readTransportImpl:async()=>({tunnelId}),
    execFileImpl:async()=>{throw new Error("fixture invalid runtime secret")},
    runChildImpl:async(cmd,args,opts)=>{events.push({cmd,args,opts});return {code:0};},
  }));
  assert.equal(result.mode,"local-only");assert.equal(events.length,1);
  assert.deepEqual(events[0].args,[serverPath]);
});

test("Windows tunnel command bounds command paths and never embeds the Runtime API key",()=>{
  const paths={profileDir:"C:\\Profiles\\eq",runtimeKeyPath:"C:\\secrets\\runtime-key"};
  const args=windowsTunnelInitArguments({paths,tunnelId,nodePath:"C:\\Program Files\\node.exe",serverPath:"C:\\Program Files\\server.js"});
  assert.equal(args[args.indexOf("--mcp-command")+1], '"C:/Program Files/node.exe" "C:/Program Files/server.js"');
  assert.equal(args[args.indexOf("--control-plane-api-key-ref")+1],"file:C:\\secrets\\runtime-key");
  assert.throws(()=>windowsTunnelInitArguments({paths,tunnelId,nodePath:"C:\\Users\\%BAD%\\node.exe",serverPath:"C:\\server.js"}),/unsupported/u);
});

test("Windows runtime fails closed when native shell location identity drifts",async()=>{
  await assert.rejects(runWindowsShellRuntimeSupervisor(mk({env:{...env,EQUINOX_LOCAL_INSTALL_ROOT:"C:\\Other"}})),/invalid/u);
  await assert.rejects(runWindowsShellRuntimeSupervisor(mk({serverPath:"relative.js"})),/invalid/u);
  await assert.rejects(runWindowsShellRuntimeSupervisor(mk({platform:"darwin"})),/requires Windows/u);
});

test("Windows native shell launches guarded supervisor rather than permanently pinning local-only",async()=>{
 const {readFileSync}=await import("node:fs");
 const source=readFileSync(new URL("../../native/windows/EquinoxLocal.WindowsShell/RuntimeSupervisor.cs",import.meta.url),"utf8");
 assert.match(source,/supervisorPath = Path.Combine\(nativeReleaseDir, "equinox-local-windows-runtime-supervisor.js"\)/u);
 assert.match(source,/args = new\[\] \{ supervisorPath, serverPath \}/u);
 assert.doesNotMatch(source,/startInfo.Environment\["EQUINOX_LOCAL_SUPERVISOR_MODE"\] = "local-only"/u);
 assert.match(source,/ValidateReleaseFiles\(nodePath, serverPath, processGatePath, supervisorPath\)/u);
});


test("Windows tunnel reconnect uses bounded exponential backoff", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 10, 100].map(windowsTunnelReconnectDelay),
    [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  assert.throws(() => windowsTunnelReconnectDelay(0), /attempt/u);
});

test("configured Windows tunnel exit preserves local-only until preflight passes then restores tunnel", async () => {
  const events = [];
  let tunnelRuns = 0;
  const output = await runWindowsShellRuntimeSupervisor(mk({
    readTransportImpl: async () => ({ tunnelId }),
    execFileImpl: async (_exe, _args) => { events.push("init"); return { stdout: "" }; },
    runChildImpl: async (_exe, args, options) => {
      if (args[0] === "run") {
        tunnelRuns++;
        events.push("tunnel:" + tunnelRuns);
        return tunnelRuns === 1 ? { code: 1, signal: null } : { code: 0, terminatingSignal: "SIGTERM" };
      }
      assert.equal(options.env.EQUINOX_LOCAL_SUPERVISOR_MODE, "local-only");
      assert.equal(options.stdin, "pipe");
      assert.equal(options.reconnect.delayMs, 30_000);
      events.push("local-only");
      await options.reconnect.preflight();
      events.push("local-closed");
      return { code: 0, retryRequested: true };
    },
  }));
  assert.equal(output.mode, "tunnel");
  assert.deepEqual(events, ["init", "tunnel:1", "local-only", "init", "local-closed", "init", "tunnel:2"]);
});

test("configured Windows tunnel failure keeps local-only when no recovery signal arrives", async () => {
  let localStarted = false;
  const result = await runWindowsShellRuntimeSupervisor(mk({
    readTransportImpl: async () => ({ tunnelId }),
    execFileImpl: async () => { throw Error("fixture-secret-excluded"); },
    runChildImpl: async (_exe, args, options) => {
      assert.deepEqual(args, [serverPath]);
      assert.equal(options.reconnect.delayMs, 30_000);
      localStarted = true;
      return { code: 0, retryRequested: false };
    },
  }));
  assert.equal(localStarted, true);
  assert.equal(result.mode, "local-only");
});

test("local-only supervisor keeps an owned server alive on failed probe and gracefully closes on success", async () => {
  const child = new EventEmitter();
  const processLike = new EventEmitter();
  const events = [];
  let timer = null;
  let checks = 0;
  let opts;
  child.stdin = { end: () => { events.push("stdin-eof"); child.emit("exit", 0, null); } };
  child.killed = false;
  child.kill = () => { throw Error("Must not kill local-only server for probe"); };
  const promise = runWindowsSupervisorChild("C:\\node.exe", ["C:\\server.js"], {
    cwd: "C:\\", env: {}, stdin: "inherit", reconnect: {
      delayMs: 5,
      preflight: async () => { checks++; if (checks === 1) throw Error("network unavailable"); events.push("preflight-ready"); },
    },
  }, {
    spawnImpl: (_executable, _args, options) => { opts = options; return child; },
    processLike,
    setTimeoutImpl: (fn, delay) => { assert.equal(delay, 5); timer = fn; return 1; },
    clearTimeoutImpl: () => { timer = null; },
  });
  assert.deepEqual(opts.stdio, ["pipe", "inherit", "inherit"]);
  child.emit("spawn");
  await timer();
  assert.deepEqual(events, []);
  assert.equal(checks, 1);
  await timer();
  const result = await promise;
  assert.deepEqual(events, ["preflight-ready", "stdin-eof"]);
  assert.equal(result.retryRequested, true);
  assert.equal(processLike.listenerCount("SIGTERM"), 0);
  assert.equal(processLike.listenerCount("SIGINT"), 0);
});

test("tunnel preflight must not retry after intentional runtime termination", async () => {
  const child = new EventEmitter();
  const processLike = new EventEmitter();
  let timer = null;
  let probes = 0;
  child.killed = false;
  child.stdin = { end: () => { throw Error("Must not close after intentional termination"); } };
  child.kill = () => { child.killed = true; child.emit("exit", 143, null); };
  const promise = runWindowsSupervisorChild("C:\\node.exe", [], {
    env: {}, stdin: "inherit", reconnect: { delayMs: 5, preflight: async () => { probes++; } },
  }, { spawnImpl: () => child, processLike, setTimeoutImpl: fn => { timer = fn; return 1; }, clearTimeoutImpl: () => { timer = null; } });
  child.emit("spawn");
  processLike.emit("SIGTERM");
  const result = await promise;
  assert.equal(result.terminatingSignal, "SIGTERM");
  assert.equal(result.retryRequested, false);
  assert.equal(timer, null);
  assert.equal(probes, 0);
});
