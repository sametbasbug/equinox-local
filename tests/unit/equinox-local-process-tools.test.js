import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";

import { createLocalPortInspector, registerProcessTools } from "../../src/equinox-local-process-tools.js";

function createHarness(overrides = {}) {
  const registrations = new Map();
  const calls = [];
  const manager = {
    start(input) {
      calls.push(["start", input]);
      return { processId: "proc-1" };
    },
    async readLogs(input) {
      calls.push(["readLogs", input]);
      return {
        process: { processId: input.processId, running: true },
        output: "ready",
        nextCursor: 5,
      };
    },
    list() {
      calls.push(["list"]);
      return [
        { processId: "proc-1", running: true },
        { processId: "proc-2", running: false },
      ];
    },
    async waitForExit(input) {
      calls.push(["waitForExit", input]);
      if (input.processId === "missing") {
        throw new Error("Bilinmeyen süreç kimliği: missing");
      }
      return {
        processId: input.processId,
        running: input.processId === "proc-running",
        exitCode: input.processId === "proc-signal" ? null : 7,
        signal: input.processId === "proc-signal" ? "SIGTERM" : null,
      };
    },
    snapshotOutput(input) {
      calls.push(["snapshotOutput", input]);
      const running = input.processId === "proc-running";
      return {
        process: {
          processId: input.processId,
          running,
          exitCode: running || input.processId === "proc-signal" ? null : 7,
          signal: input.processId === "proc-signal" ? "SIGTERM" : null,
          spawnError: null,
        },
        nextCursor: 12,
        stdout: "out",
        stderr: "err",
        combinedOutput: "[stdout] out[stderr] err",
        stdoutTruncated: false,
        stderrTruncated: false,
        combinedOutputTruncated: false,
        stdoutDroppedChars: 0,
        stderrDroppedChars: 0,
        combinedOutputDroppedChars: 0,
      };
    },
    async stop(input) {
      calls.push(["stop", input]);
      return { processId: input.processId, running: false };
    },
  };

  const textResult = (text) => ({ content: [{ type: "text", text }] });
  const errorResult = (error) => ({
    content: [{ type: "text", text: `Hata: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  });

  registerProcessTools({
    registerTextTool(name, config, handler, options = {}) {
      registrations.set(name, { config, handler, options });
    },
    z,
    processManager: manager,
    inspectLocalPort: async (input) => {
      calls.push(["inspectLocalPort", input]);
      return { probe: { listening: true }, listeners: [{ pid: 42 }], lsofError: null, managedProcesses: [], suggestedUrl: `http://${input.host}:${input.port}/` };
    },
    agentAccess: { terminal: true },
    safeResolve: async (value) => `/tmp/project/${value === "." ? "" : value}`.replace(/\/$/u, ""),
    fsImpl: { stat: async () => ({ isDirectory: () => true }) },
    getActiveProjectId: () => "local",
    getActiveProjectName: () => "Equinox Local",
    getActiveProjectRoot: () => "/tmp/project",
    runtimeEnv: {
      PATH: "/custom/bin",
      HOME: "/tmp/home",
      OPENAI_API_KEY: "should-not-leak",
      GH_TOKEN: "should-not-leak",
    },
    textResult,
    errorResult,
    ...overrides,
  });

  return { registrations, calls };
}

function parseText(result) {
  return JSON.parse(result.content[0].text);
}

test("process tools preserve start routing, env projection and initial logs", async () => {
  const harness = createHarness();
  assert.deepEqual([...harness.registrations.keys()], [
    "process_start",
    "process_list",
    "process_logs",
    "process_wait",
    "process_stop",
    "port_status",
  ]);

  const result = parseText(await harness.registrations.get("process_start").handler({
    command: "npm",
    args: ["run", "dev"],
    cwd: ".",
    env: { PORT: "3000", NPM_TOKEN: "should-not-leak", SAFE_FLAG: "yes" },
    label: "preview",
    expected_ports: [3000],
    startup_wait_ms: 750,
  }));
  assert.equal(result.ok, true);
  assert.equal(result.initialOutput, "ready");
  assert.equal(result.nextCursor, 5);

  const [, startInput] = harness.calls[0];
  assert.equal(startInput.projectId, "local");
  assert.equal(startInput.cwd, "/tmp/project");
  assert.equal(startInput.command, "npm");
  assert.deepEqual(startInput.args, ["run", "dev"]);
  assert.deepEqual(startInput.expectedPorts, [3000]);
  assert.equal(startInput.env.PORT, "3000");
  assert.equal(startInput.env.SAFE_FLAG, "yes");
  assert.equal(startInput.env.OPENAI_API_KEY, undefined);
  assert.equal(startInput.env.GH_TOKEN, undefined);
  assert.equal(startInput.env.NPM_TOKEN, undefined);
  assert.equal(startInput.env.EQUINOX_PROJECT_ROOT, "/tmp/project");
  assert.equal(startInput.env.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/custom/bin");
  assert.deepEqual(harness.calls[1], [
    "readLogs",
    { processId: "proc-1", cursor: 0, maxChars: 20_000, stripAnsiCodes: true, waitMs: 750 },
  ]);
});

test("process list/logs/stop adapters preserve filtering and mutation scope", async () => {
  const harness = createHarness();
  const list = harness.registrations.get("process_list");
  assert.equal(list.options.projectAware, false);
  const running = parseText(await list.handler({ state: "running" }));
  assert.equal(running.count, 1);
  assert.equal(running.processes[0].processId, "proc-1");

  const logs = harness.registrations.get("process_logs");
  assert.deepEqual(parseText(await logs.handler({
    process_id: "proc-1",
    cursor: 2,
    max_chars: 500,
    strip_ansi: false,
    wait_ms: 25,
  })), {
    process: { processId: "proc-1", running: true },
    output: "ready",
    nextCursor: 5,
  });

  const stop = harness.registrations.get("process_stop");
  assert.deepEqual(stop.options, { projectAware: false, mutationScopes: ["global"] });
  assert.equal(parseText(await stop.handler({
    process_id: "proc-1",
    force: true,
    remove: false,
  })).process.running, false);
});


test("process wait reuses managed lifecycle, preserves timeout state and bounded output", async () => {
  const harness = createHarness();
  const wait = harness.registrations.get("process_wait");
  assert.equal(wait.options.projectAware, false);
  assert.equal(wait.config.annotations.readOnlyHint, true);

  const completed = parseText(await wait.handler({
    process_id: "proc-exited",
    wait_ms: 30_000,
    max_chars: 4_000,
    strip_ansi: true,
  }));
  assert.equal(completed.completed, true);
  assert.equal(completed.waitExpired, false);
  assert.equal(completed.process.exitCode, 7);
  assert.equal(completed.process.signal, null);
  assert.equal(completed.combinedOutput, "[stdout] out[stderr] err");
  assert.equal(completed.nextCursor, 12);
  assert.equal("stdout" in completed, false);
  assert.equal("stderr" in completed, false);
  assert.deepEqual(harness.calls.slice(-2), [
    ["waitForExit", { processId: "proc-exited", waitMs: 30_000 }],
    ["snapshotOutput", { processId: "proc-exited", maxChars: 4_000, stripAnsiCodes: true }],
  ]);

  const running = parseText(await wait.handler({
    process_id: "proc-running",
    wait_ms: 25,
    max_chars: 1_000,
    strip_ansi: false,
  }));
  assert.equal(running.completed, false);
  assert.equal(running.waitExpired, true);
  assert.equal(running.process.running, true);
  assert.equal(harness.calls.some(([name]) => name === "stop"), false);

  const nonblocking = parseText(await wait.handler({
    process_id: "proc-running",
    wait_ms: 0,
    max_chars: 1_000,
    strip_ansi: true,
  }));
  assert.equal(nonblocking.completed, false);
  assert.equal(nonblocking.waitExpired, false);

  const signaled = parseText(await wait.handler({
    process_id: "proc-signal",
    wait_ms: 1,
    max_chars: 1_000,
    strip_ansi: true,
  }));
  assert.equal(signaled.completed, true);
  assert.equal(signaled.process.exitCode, null);
  assert.equal(signaled.process.signal, "SIGTERM");

  const missing = await wait.handler({
    process_id: "missing",
    wait_ms: 1,
    max_chars: 1_000,
    strip_ansi: true,
  });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Bilinmeyen süreç kimliği/u);
});

test("port status restores the advertised read-only loopback inspection adapter", async () => {
  const harness = createHarness();
  const portStatus = harness.registrations.get("port_status");
  assert.equal(portStatus.options.projectAware, false);
  assert.equal(portStatus.config.annotations.readOnlyHint, true);
  const result = parseText(await portStatus.handler({ port: 4321, host: "127.0.0.1", timeout_ms: 750 }));
  assert.equal(result.ok, true);
  assert.equal(result.probe.listening, true);
  assert.deepEqual(harness.calls.at(-1), ["inspectLocalPort", { port: 4321, host: "127.0.0.1", timeoutMs: 750 }]);
});

test("local port inspector preserves lsof evidence on Unix and skips lsof on Windows", async () => {
  const calls = [];
  const processManager = { findByPort: (port) => [{ processId: `proc-${port}` }] };
  const probeTcpPortImpl = async (input) => ({ ...input, listening: true });
  const execFileImpl = async (...args) => {
    calls.push(args);
    return { stdout: "p42\ncnode\nn127.0.0.1:4321\n" };
  };
  const unix = createLocalPortInspector({ processManager, platform: "darwin", probeTcpPortImpl, execFileImpl });
  const unixResult = await unix({ port: 4321, host: "127.0.0.1", timeoutMs: 500 });
  assert.equal(unixResult.listeners[0].pid, 42);
  assert.equal(unixResult.managedProcesses[0].processId, "proc-4321");
  assert.equal(calls.length, 1);

  const windows = createLocalPortInspector({ processManager, platform: "win32", probeTcpPortImpl, execFileImpl });
  const windowsResult = await windows({ port: 4321, host: "::1", timeoutMs: 500 });
  assert.deepEqual(windowsResult.listeners, []);
  assert.equal(windowsResult.lsofError, null);
  assert.equal(windowsResult.suggestedUrl, "http://[::1]:4321/");
  assert.equal(calls.length, 1);
});

test("process start fails closed when process access is disabled", async () => {
  const harness = createHarness({ agentAccess: { terminal: false } });
  const result = await harness.registrations.get("process_start").handler({
    command: "npm",
    args: [],
    cwd: ".",
    expected_ports: [],
    startup_wait_ms: 0,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Terminal ve süreç erişimi Control Center'da kapalı/u);
  assert.equal(harness.calls.length, 0);
});

test("process tools retain exact readonly/global mutation contract and strict bounded Zod admission", () => {
  const {registrations}=createHarness();
  const expected=[
    ["process_start",false,undefined],
    ["process_list",true,undefined],
    ["process_logs",true,undefined],
    ["process_wait",true,undefined],
    ["process_stop",false,["global"]],
    ["port_status",true,undefined],
  ];
  for(const [name,readOnlyHint,mutationScopes] of expected){
    const {config,options}=registrations.get(name);
    assert.equal(config.annotations.readOnlyHint,readOnlyHint,name);
    assert.equal(config.annotations.openWorldHint,name==="process_start",name);
    assert.deepEqual(options.mutationScopes,mutationScopes,name);
    assert.equal(options.projectAware,name==="process_start"?undefined:false,name);
  }
  const start=z.object(registrations.get("process_start").config.inputSchema);
  const valid=start.parse({command:"npm",cwd:".",env:{SAFE_FLAG:"yes"},expected_ports:[3000]});
  assert.deepEqual(valid.args,[]);
  assert.equal(valid.startup_wait_ms,500);
  assert.deepEqual(valid.expected_ports,[3000]);
  for(const input of [
    {command:""},{command:"x".repeat(501)},{command:"npm",args:Array(101).fill("x")},
    {command:"npm",args:["x".repeat(2001)]},
    {command:"npm",env:{"BAD-ENV":"bad"}},
    {command:"npm",env:{BAD:"x".repeat(10001)}},
    {command:"npm",expected_ports:[0]},
    {command:"npm",expected_ports:[65536]},
    {command:"npm",expected_ports:Array(17).fill(3000)},
    {command:"npm",startup_wait_ms:5001},
    {command:"npm",startup_wait_ms:-1},
  ]) assert.equal(start.safeParse(input).success,false,JSON.stringify(input).slice(0,130));

  const wait=z.object(registrations.get("process_wait").config.inputSchema);
  assert.equal(wait.parse({process_id:"proc-a"}).wait_ms,30000);
  assert.equal(wait.safeParse({process_id:"proc-a",wait_ms:120001}).success,false);
  const logs=z.object(registrations.get("process_logs").config.inputSchema);
  assert.equal(logs.safeParse({process_id:"proc-a",max_chars:160001}).success,false);
  assert.equal(logs.safeParse({process_id:"proc-a",cursor:-1}).success,false);
  const port=z.object(registrations.get("port_status").config.inputSchema);
  assert.equal(port.parse({port:3000}).host,"127.0.0.1");
  for(const invalid of [{port:80,host:"0.0.0.0"},{port:0},{port:65536},{port:80,timeout_ms:5001}]){
    assert.equal(port.safeParse(invalid).success,false);
  }
});

test("process start refuses unsafe access, refused project roots and non-directory paths before managed process creation", async()=>{
  const seen=[];
  const rejection=createHarness({
    safeResolve:async cwd=>{seen.push(["resolve",cwd]);throw Error("selected Agent Access denies root")},
    fsImpl:{stat:async()=>{throw Error("fs.stat must not run")}},
  });
  const input={command:"npm",args:["run","dev"],cwd:"../outside",expected_ports:[],startup_wait_ms:0};
  const denied=await rejection.registrations.get("process_start").handler(input);
  assert.equal(denied.isError,true);
  assert.match(denied.content[0].text,/Agent Access denies root/u);
  assert.deepEqual(seen,[["resolve","../outside"]]);
  assert.equal(rejection.calls.length,0);

  const nondirectory=createHarness({
    safeResolve:async cwd=>{seen.push(["resolve",cwd]);return "/fixture/safe-file"},
    fsImpl:{stat:async file=>{seen.push(["stat",file]);return {isDirectory:()=>false}}},
  });
  const file=await nondirectory.registrations.get("process_start").handler(input);
  assert.equal(file.isError,true);
  assert.match(file.content[0].text,/klasör değil/u);
  assert.equal(nondirectory.calls.length,0);
  assert.deepEqual(seen.slice(-2),[["resolve","../outside"],["stat","/fixture/safe-file"]]);
});

test("process wait and stop forward errors once and never perform an implicit stop or retry", async()=>{
  const events=[];
  const base={
    async waitForExit(input){events.push(["wait",input]);throw Error("fixture wait rejected")},
    snapshotOutput(){events.push(["snapshot"]);throw Error("snapshot must not run")},
    async stop(input){events.push(["stop",input]);throw Error("fixture stop rejected")},
    list(){return []},
    findByPort(){return []},
  };
  const {registrations}=createHarness({processManager:base});
  const wait=await registrations.get("process_wait").handler({
    process_id:"proc-1",wait_ms:10,max_chars:100,strip_ansi:true,
  });
  assert.equal(wait.isError,true);
  assert.match(wait.content[0].text,/fixture wait rejected/u);
  assert.deepEqual(events,[["wait",{processId:"proc-1",waitMs:10}]]);
  const stop=await registrations.get("process_stop").handler({process_id:"proc-1",force:true,remove:true});
  assert.equal(stop.isError,true);
  assert.match(stop.content[0].text,/fixture stop rejected/u);
  assert.deepEqual(events.at(-1),["stop",{processId:"proc-1",force:true,remove:true}]);
  assert.equal(events.filter(([event])=>event==="stop").length,1);
});

test("loopback port inspector uses pinned Unix lsof environment, treats no-listener exit as empty and never spawns on Windows",async()=>{
  const calls=[];
  const probeTcpPortImpl=async params=>{calls.push(["probe",params]);return {listening:false}};
  const processManager={findByPort:port=>{calls.push(["managed",port]);return []}};
  const execFileImpl=async(file,args,options)=>{
    calls.push(["lsof",file,args,options]);
    throw Object.assign(Error("fixture no listener"),{code:1});
  };
  const unix=createLocalPortInspector({platform:"darwin",probeTcpPortImpl,processManager,execFileImpl});
  const noListener=await unix({host:"::1",port:4500,timeoutMs:250});
  assert.equal(noListener.lsofError,null);
  assert.deepEqual(noListener.listeners,[]);
  assert.equal(noListener.suggestedUrl,"http://[::1]:4500/");
  assert.deepEqual(calls[1],[
    "lsof","/usr/sbin/lsof",["-nP","-iTCP:4500","-sTCP:LISTEN","-Fpcn"],
    {timeout:5000,maxBuffer:1024*1024,env:{PATH:"/usr/sbin:/usr/bin:/bin",LC_ALL:"C"}},
  ]);
  calls.length=0;
  const windows=createLocalPortInspector({
    platform:"win32",probeTcpPortImpl,processManager,
    execFileImpl:async()=>{throw Error("Windows must not spawn lsof")},
  });
  const observed=await windows({host:"127.0.0.1",port:4567,timeoutMs:300});
  assert.equal(observed.lsofError,null);
  assert.equal(observed.suggestedUrl,"http://127.0.0.1:4567/");
  assert.equal(calls.some(([kind])=>kind==="lsof"),false);
  const missing=createLocalPortInspector({platform:"darwin",probeTcpPortImpl,processManager});
  const output=await missing({host:"localhost",port:4000,timeoutMs:1000});
  assert.match(output.lsofError,/requires execFileImpl/u);
});
