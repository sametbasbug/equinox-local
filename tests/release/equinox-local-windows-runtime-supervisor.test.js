import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { windowsTunnelInitArguments, runWindowsShellRuntimeSupervisor } from "../../src/equinox-local-windows-runtime-supervisor.js";

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
  assert.equal(args[args.indexOf("--mcp-command")+1],'"C:\\Program Files\\node.exe" "C:\\Program Files\\server.js"');
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
