import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";

import { registerTerminalTools } from "../../src/equinox-local-terminal-tools.js";
import { equinoxLocalWindowsPowerShellPath } from "../../src/equinox-local-platform.js";

function createHarness(overrides = {}) {
  const registrations = new Map();
  const calls = [];
  const events = [];
  const manager = {
    async start(input) {
      calls.push(["start", input]);
      return { sessionId: "term-1", cwd: input.cwd, shell: input.shell };
    },
    list() {
      calls.push(["list"]);
      return [{ sessionId: "term-1" }];
    },
    async read(input) {
      calls.push(["read", input]);
      return { nextCursor: 12, output: "hello" };
    },
    write(input) {
      calls.push(["write", input]);
      return { sessionId: input.sessionId };
    },
    resize(input) {
      calls.push(["resize", input]);
      return { sessionId: input.sessionId, cols: input.cols, rows: input.rows };
    },
    async stop(input) {
      calls.push(["stop", input]);
      return { sessionId: input.sessionId, running: false };
    },
  };
  let processSequence = 0;
  let processStarted = false;
  const processState = {
    processId: "proc-exec-1",
    projectId: "local",
    projectName: "Equinox Local",
    cwd: "/tmp/project",
    command: "/bin/zsh",
    args: [],
    purpose: "terminal_exec",
    running: true,
    exitCode: null,
    signal: null,
    spawnError: null,
  };
  const processManager = {
    start(input) {
      calls.push(["processStart", input]);
      processSequence += 1;
      processStarted = true;
      Object.assign(processState, {
        processId: `proc-exec-${processSequence}`,
        projectId: input.projectId,
        projectName: input.projectName,
        cwd: input.cwd,
        command: input.command,
        args: [...input.args],
        purpose: input.purpose,
        running: true,
        exitCode: null,
        signal: null,
        spawnError: null,
      });
      return { ...processState, args: [...processState.args] };
    },
    list() {
      calls.push(["processList"]);
      return processStarted ? [{ ...processState, args: [...processState.args] }] : [];
    },
    async waitForExit(input) {
      calls.push(["processWait", input]);
      processState.running = false;
      processState.exitCode = 0;
      return { ...processState };
    },
    snapshotOutput(input) {
      calls.push(["processSnapshot", input]);
      return {
        process: { ...processState },
        nextCursor: 12,
        stdout: "ok\n",
        stderr: "",
        combinedOutput: "[stdout] ok\n",
        stdoutTruncated: false,
        stderrTruncated: false,
        combinedOutputTruncated: false,
        stdoutDroppedChars: 0,
        stderrDroppedChars: 0,
        combinedOutputDroppedChars: 0,
      };
    },
    async stop(input) {
      calls.push(["processStop", input]);
      processState.running = false;
      if (input.remove) processStarted = false;
      return { ...processState, running: false };
    },
  };

  const textResult = (text) => ({ content: [{ type: "text", text }] });
  const errorResult = (error) => ({
    content: [{ type: "text", text: `Hata: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  });

  registerTerminalTools({
    registerTextTool(name, config, handler, options = {}) {
      registrations.set(name, { config, handler, options });
    },
    z,
    terminalManager: manager,
    processManager,
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
    recordEvent: async (event) => { events.push(event); },
    textResult,
    errorResult,
    ...overrides,
  });

  return { registrations, calls, manager, processManager, processState, events };
}

function parseText(result) {
  return JSON.parse(result.content[0].text);
}

test("terminal tools preserve registration metadata and start routing", async () => {
  const harness = createHarness();
  assert.deepEqual([...harness.registrations.keys()], [
    "terminal_exec",
    "terminal_start",
    "terminal_list",
    "terminal_read",
    "terminal_write",
    "terminal_resize",
    "terminal_stop",
  ]);

  const exec = harness.registrations.get("terminal_exec");
  assert.doesNotMatch(exec.config.description, /PowerShell/u, "macOS agents must not see Windows-only guidance");
  assert.equal(exec.config.annotations.openWorldHint, true);
  assert.equal(exec.config.annotations.destructiveHint, true);
  assert.deepEqual(exec.options, { mutationScopes: ["global"] });
  const execResult = parseText(await exec.handler({
    command: "git status && rg terminal src",
    cwd: ".",
    wait_ms: 30_000,
    max_output_chars: 40_000,
  }));
  assert.equal(execResult.ok, true);
  assert.equal(execResult.stdout, "ok\n");
  assert.equal(execResult.combinedOutput, "[stdout] ok\n");
  assert.equal(execResult.projectId, "local");
  assert.equal(execResult.projectName, "Equinox Local");
  assert.equal(execResult.initialCwd, "/tmp/project");
  assert.equal(execResult.completed, true);
  assert.equal(execResult.promoted, false);
  const processStart = harness.calls.find(([name]) => name === "processStart");
  assert.ok(processStart);
  assert.equal(processStart[1].cwd, "/tmp/project");
  assert.equal(processStart[1].command, "/bin/zsh");
  assert.deepEqual(processStart[1].args, ["-lc", "git status && rg terminal src"]);
  assert.equal(processStart[1].purpose, "terminal_exec");
  assert.equal(processStart[1].env.OPENAI_API_KEY, undefined);
  assert.equal(processStart[1].env.GH_TOKEN, undefined);
  assert.equal(processStart[1].env.PAGER, "cat");
  assert.equal(processStart[1].env.GIT_PAGER, "cat");
  assert.equal(processStart[1].env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(processStart[1].env.NO_COLOR, "1");
  assert.ok(harness.calls.some(([name, input]) => name === "processStop" && input.remove === true));
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0].type, "terminal.exec_completed");
  assert.equal(harness.events[0].projectId, "local");
  assert.equal("command" in harness.events[0].details, false);
  assert.equal("cwd" in harness.events[0].details, false);
  assert.equal("stdout" in harness.events[0].details, false);

  const start = harness.registrations.get("terminal_start");
  assert.equal(start.config.annotations.openWorldHint, true);
  const result = parseText(await start.handler({
    cwd: ".",
    shell: "zsh",
    cols: 120,
    rows: 30,
    label: "audit",
  }));
  assert.equal(result.ok, true);
  assert.equal(result.session.shell, "/bin/zsh");

  const [, input] = harness.calls.find(([name]) => name === "start");
  assert.equal(input.projectId, "local");
  assert.equal(input.projectName, "Equinox Local");
  assert.equal(input.cwd, "/tmp/project");
  assert.equal(input.shell, "/bin/zsh");
  assert.deepEqual(input.shellArgs, ["-l"]);
  assert.equal(input.env.EQUINOX_PROJECT_ID, "local");
  assert.equal(input.env.EQUINOX_PROJECT_ROOT, "/tmp/project");
  assert.equal(input.env.OPENAI_API_KEY, undefined);
  assert.equal(input.env.GH_TOKEN, undefined);
  assert.equal(
    input.env.PATH,
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/custom/bin",
  );
});

test("terminal tools route Windows finite and interactive shells through the shared platform contract", async () => {
  const harness = createHarness({
    platform: "win32",
    arch: "x64",
    runtimeEnv: { PATH: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\Example" },
  });

  const exec = harness.registrations.get("terminal_exec");
  assert.match(exec.config.description, /process_start/u);
  assert.match(exec.config.description, /görünür konsol penceresi açılmamalıdır/u);
  const execResult = parseText(await exec.handler({
    command: "Write-Output ok", cwd: ".", wait_ms: 30_000, max_output_chars: 40_000,
  }));
  assert.equal(execResult.ok, true);
  const processStart = harness.calls.find(([name]) => name === "processStart");
  assert.equal(processStart[1].command, equinoxLocalWindowsPowerShellPath({SystemRoot: "C:\\Windows"}));
  assert.deepEqual(processStart[1].args.slice(0, 6), ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand"]);
  assert.equal(Buffer.from(processStart[1].args[6], "base64").toString("utf16le"), "$ProgressPreference = 'SilentlyContinue'; Write-Output ok");
  assert.equal(processStart[1].env.PATH, "C:\\Windows\\System32");

  const start = harness.registrations.get("terminal_start");
  const parsed = start.config.inputSchema.shell.safeParse("powershell");
  assert.equal(parsed.success, true);
  assert.equal(start.config.inputSchema.shell.safeParse("pwsh").success, true);
  assert.equal(exec.config.inputSchema.shell.safeParse("pwsh").success, true);
  assert.equal(exec.config.inputSchema.shell.safeParse("cmd").success, true);
  assert.equal(start.config.inputSchema.shell.safeParse("cmd").success, false,
    "cmd must be finite-only; interactive ConPTY remains a PowerShell session");
  assert.equal(start.config.inputSchema.shell.safeParse("zsh").success, false);
  const result = parseText(await start.handler({ cwd: ".", shell: "powershell", cols: 120, rows: 30 }));
  assert.equal(result.ok, true);
  const terminalStart = harness.calls.find(([name]) => name === "start");
  assert.equal(terminalStart[1].shell, equinoxLocalWindowsPowerShellPath({SystemRoot: "C:\\Windows"}));
  assert.deepEqual(terminalStart[1].shellArgs, ["-NoLogo", "-NoProfile"]);
  assert.equal(terminalStart[1].env.PATH, "C:\\Windows\\System32");
});

test("Windows finite and interactive tools repair malformed inherited PATHEXT before PS5", async () => {
  const harness = createHarness({
    platform: "win32", arch: "x64",
    runtimeEnv: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", PATHEXT: ".CPL" },
  });
  const exec = harness.registrations.get("terminal_exec");
  const start = harness.registrations.get("terminal_start");
  await exec.handler({ command: "Write-Output 'ok'", cwd: ".", wait_ms: 30, max_output_chars: 500 });
  await start.handler({ shell: "powershell", cwd: ".", cols: 80, rows: 25 });
  assert.equal(harness.calls.find(([op]) => op === "processStart")[1].env.PATHEXT, ".COM;.EXE;.BAT;.CMD;.CPL");
  assert.equal(harness.calls.find(([op]) => op === "start")[1].env.PATHEXT, ".COM;.EXE;.BAT;.CMD;.CPL");
});

test("Windows finite cmd selection uses managed native process without PowerShell", async () => {
  const harness = createHarness({
    platform: "win32", arch: "x64",
    runtimeEnv: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32" },
  });
  const exec = harness.registrations.get("terminal_exec");
  const result = parseText(await exec.handler({
    shell: "cmd", command: "echo NATIVE_OK & exit /b 27", cwd: ".",
    wait_ms: 2000, max_output_chars: 2000,
  }));
  assert.equal(result.ok, true);
  const started = harness.calls.find(([type]) => type === "processStart")[1];
  assert.equal(started.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(started.args, ["/d", "/v:off", "/s", "/c", "echo NATIVE_OK & exit /b 27"]);
  assert.equal(started.purpose, "terminal_exec");
});

test("terminal_exec promotes an unfinished command without killing or restarting it", async () => {
  const harness = createHarness();
  harness.processManager.waitForExit = async (input) => {
    harness.calls.push(["processWait", input]);
    return { ...harness.processState, running: true };
  };

  const result = parseText(await harness.registrations.get("terminal_exec").handler({
    command: "npm test",
    cwd: ".",
    wait_ms: 25,
    max_output_chars: 5000,
  }));

  assert.equal(result.ok, true);
  assert.equal(result.completed, false);
  assert.equal(result.promoted, true);
  assert.equal(result.processId, "proc-exec-1");
  assert.equal(result.nextCursor, 12);
  assert.match(result.next, /process_logs/u);
  assert.equal(harness.calls.filter(([name]) => name === "processStart").length, 1);
  assert.equal(harness.calls.some(([name]) => name === "processStop"), false);
  assert.equal(harness.events.at(-1).type, "terminal.exec_promoted");
});


test("terminal_exec reuses one promoted exact managed process across a replayed delivery", async () => {
  let currentTime = 1_000;
  const harness = createHarness({ now: () => currentTime });
  harness.processManager.waitForExit = async (input) => {
    harness.calls.push(["processWait", input]);
    return { ...harness.processState, running: true };
  };
  const exec = harness.registrations.get("terminal_exec");
  const input = { command: "npm run gate:public", cwd: ".", wait_ms: 120_000, max_output_chars: 5000 };

  const first = parseText(await exec.handler(input));
  assert.equal(first.promoted, true);
  assert.equal(first.processId, "proc-exec-1");

  currentTime += 2_000;
  const replay = parseText(await exec.handler(input));
  assert.equal(replay.promoted, true);
  assert.equal(replay.replayRecovered, true);
  assert.equal(replay.processId, "proc-exec-1");
  assert.equal(harness.calls.filter(([name]) => name === "processStart").length, 1);
  assert.equal(harness.calls.filter(([name]) => name === "processWait").length, 1);
});


test("terminal_exec replay lease expires even while an identical managed process is still running", async () => {
  let currentTime = 1_000;
  const harness = createHarness({ now: () => currentTime });
  harness.processManager.waitForExit = async (input) => {
    harness.calls.push(["processWait", input]);
    return { ...harness.processState, running: true };
  };
  const exec = harness.registrations.get("terminal_exec");
  const input = { command: "npm run gate:public", cwd: ".", wait_ms: 120_000, max_output_chars: 5000 };

  assert.equal(parseText(await exec.handler(input)).processId, "proc-exec-1");
  currentTime += 5 * 60 * 1000 + 1;
  assert.equal(parseText(await exec.handler(input)).processId, "proc-exec-2");
  assert.equal(harness.calls.filter(([name]) => name === "processStart").length, 2);
});

test("terminal_exec starts a fresh identical command after the promoted process has exited", async () => {
  let currentTime = 1_000;
  const harness = createHarness({ now: () => currentTime });
  harness.processManager.waitForExit = async (input) => {
    harness.calls.push(["processWait", input]);
    return { ...harness.processState, running: true };
  };
  const exec = harness.registrations.get("terminal_exec");
  const input = { command: "npm run gate:public", cwd: ".", wait_ms: 120_000, max_output_chars: 5000 };

  const first = parseText(await exec.handler(input));
  assert.equal(first.processId, "proc-exec-1");
  harness.processState.running = false;
  harness.processState.exitCode = 0;
  currentTime += 2_000;

  const second = parseText(await exec.handler(input));
  assert.equal(second.processId, "proc-exec-2");
  assert.equal(second.replayRecovered, undefined);
  assert.equal(harness.calls.filter(([name]) => name === "processStart").length, 2);
});

test("terminal read/write/resize/stop adapters preserve argument mapping and global mutation scopes", async () => {
  const harness = createHarness();

  const list = harness.registrations.get("terminal_list");
  assert.equal(list.options.projectAware, false);
  assert.deepEqual(parseText(await list.handler({})).sessions, [{ sessionId: "term-1" }]);

  const read = harness.registrations.get("terminal_read");
  assert.equal(read.options.projectAware, false);
  assert.deepEqual(parseText(await read.handler({
    session_id: "term-1",
    cursor: 4,
    max_chars: 500,
    strip_ansi: false,
    wait_ms: 25,
  })), { nextCursor: 12, output: "hello" });

  for (const name of ["terminal_write", "terminal_resize", "terminal_stop"]) {
    assert.deepEqual(harness.registrations.get(name).options, {
      projectAware: false,
      mutationScopes: ["global"],
    });
  }

  assert.equal(parseText(await harness.registrations.get("terminal_write").handler({
    session_id: "term-1",
    data: "pwd",
    key: "enter",
  })).ok, true);
  assert.equal(parseText(await harness.registrations.get("terminal_resize").handler({
    session_id: "term-1",
    cols: 100,
    rows: 25,
  })).session.cols, 100);
  assert.equal(parseText(await harness.registrations.get("terminal_stop").handler({
    session_id: "term-1",
    force: true,
    remove: false,
  })).session.running, false);

  assert.deepEqual(harness.calls.slice(-4), [
    ["read", { sessionId: "term-1", cursor: 4, maxChars: 500, stripAnsiCodes: false, waitMs: 25 }],
    ["write", { sessionId: "term-1", data: "pwd", key: "enter" }],
    ["resize", { sessionId: "term-1", cols: 100, rows: 25 }],
    ["stop", { sessionId: "term-1", force: true, remove: false }],
  ]);
});

test("terminal mutation adapters fail closed when terminal access is disabled", async () => {
  const harness = createHarness({ agentAccess: { terminal: false } });
  const exec = await harness.registrations.get("terminal_exec").handler({
    command: "echo nope",
    cwd: ".",
    wait_ms: 1000,
    max_output_chars: 5000,
  });
  const start = await harness.registrations.get("terminal_start").handler({
    cwd: ".",
    shell: "bash",
    cols: 120,
    rows: 30,
  });
  const write = await harness.registrations.get("terminal_write").handler({
    session_id: "term-1",
    data: "echo nope",
  });
  assert.equal(exec.isError, true);
  assert.equal(start.isError, true);
  assert.equal(write.isError, true);
  assert.match(start.content[0].text, /Terminal erişimi Control Center'da kapalı/u);
  assert.equal(harness.calls.length, 0);
});

test("Windows PowerShell 7 is explicit, dynamically discovered, and never auto-installed or silently downgraded", async () => {
  const env = { SystemRoot: "C:\\Windows", ProgramFiles: "C:\\Program Files", PATH: "C:\\Windows\\System32" };
  const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
  let installed = false;
  const harness = createHarness({
    platform: "win32",
    arch: "x64",
    runtimeEnv: env,
    powerShell7StatFile: (candidate) => {
      if (installed && candidate === pwsh) return { isFile: () => true };
      throw new Error("not found");
    },
  });
  const exec = harness.registrations.get("terminal_exec");
  const start = harness.registrations.get("terminal_start");
  const defaultParsed = exec.config.inputSchema.shell.safeParse(undefined);
  assert.equal(defaultParsed.success, true);
  assert.equal(defaultParsed.data, "powershell");
  assert.equal(start.config.inputSchema.shell.safeParse(undefined).data, "powershell");
  const missingExec = await exec.handler({
    shell: "pwsh", command: "Write-Output 7", cwd: ".", wait_ms: 50, max_output_chars: 1000,
  });
  assert.equal(missingExec.isError, true);
  assert.match(missingExec.content[0].text, /PowerShell 7.*not installed/u);
  const missingPty = await start.handler({ shell: "pwsh", cwd: ".", cols: 80, rows: 25 });
  assert.equal(missingPty.isError, true);
  assert.match(missingPty.content[0].text, /PowerShell 7.*not installed/u);
  assert.equal(harness.calls.some(([op]) => op === "processStart" || op === "start"), false);
  installed = true; // Installed after Local initialized; no restart or PATH search required.
  const result = parseText(await exec.handler({
    shell: "pwsh", command: "Write-Output 7", cwd: ".", wait_ms: 30, max_output_chars: 1000,
  }));
  assert.equal(result.ok, true);
  const finiteCall = harness.calls.find(([op]) => op === "processStart");
  assert.equal(finiteCall[1].command, pwsh);
  const pty = parseText(await start.handler({ shell: "pwsh", cwd: ".", cols: 80, rows: 25 }));
  assert.equal(pty.ok, true);
  const ptyCall = harness.calls.find(([op]) => op === "start");
  assert.equal(ptyCall[1].shell, pwsh);
  assert.deepEqual(ptyCall[1].shellArgs, ["-NoLogo", "-NoProfile"]);
});

test("terminal finite and PTY admission rejects inaccessible and nondirectory CWD before managed process creation",async()=>{
  for(const terminalTool of ["terminal_exec","terminal_start"]){
    for(const condition of ["denied","not-directory"]){
      let resolves=0,stats=0;
      const harness=createHarness({
        safeResolve:async()=>{resolves++;if(condition==="denied")throw Error("Agent Access selected root rejected");return "/safe/fixture-file"},
        fsImpl:{stat:async()=>{stats++;return {isDirectory:()=>false}}},
      });
      const args=terminalTool==="terminal_exec"
        ?{command:"echo synthetic",cwd:"../../outside",wait_ms:50,max_output_chars:1000}
        :{cwd:"../../outside",shell:"zsh",cols:80,rows:25};
      const response=await harness.registrations.get(terminalTool).handler(args);
      assert.equal(response.isError,true);
      assert.equal(resolves,1);
      assert.equal(stats,condition==="denied"?0:1);
      assert.equal(harness.calls.some(([op])=>op==="processStart"||op==="start"),false);
    }
  }
});

test("terminal promoted replay is exact-project/cwd/argv bound, never adopts a foreign managed process",async()=>{
  let currentTime=100;
  const harness=createHarness({now:()=>currentTime});
  harness.processManager.waitForExit=async input=>{
    harness.calls.push(["processWait",input]);
    return {...harness.processState,running:true};
  };
  const handler=harness.registrations.get("terminal_exec").handler;
  const input={command:"npm run fixture",cwd:".",wait_ms:10,max_output_chars:1000};
  assert.equal(parseText(await handler(input)).processId,"proc-exec-1");
  currentTime+=20;
  harness.processState.purpose="other-process";
  assert.equal(parseText(await handler(input)).processId,"proc-exec-2");
  assert.equal(harness.calls.filter(([op])=>op==="processStart").length,2);
  currentTime+=20;
  const changed=await handler({...input,command:"npm run different"});
  assert.equal(parseText(changed).processId,"proc-exec-3");
  assert.equal(harness.calls.filter(([op])=>op==="processStart").length,3);
  currentTime+=20;
  const changedCwd=await handler({...input,cwd:"subfolder"});
  assert.equal(parseText(changedCwd).processId,"proc-exec-4");
  assert.equal(harness.calls.filter(([op])=>op==="processStart").length,4);
});

test("terminal finite command remains bounded and does not publish command, cwd, or subprocess output as observability details",async()=>{
  const harness=createHarness({
    recordEvent:async event=>{
      for(const disallowed of ["command","args","cwd","stdout","stderr","combinedOutput","env"]){
        assert.equal(Object.hasOwn(event.details,disallowed),false,disallowed);
      }
      assert.equal(JSON.stringify(event).includes("synthetic-private-command"),false);
      throw Error("synthetic optional observability collector failure");
    },
  });
  const result=parseText(await harness.registrations.get("terminal_exec").handler({
    command:"echo synthetic-private-command",cwd:".",wait_ms:10,max_output_chars:1024,
  }));
  assert.equal(result.completed,true);
  assert.equal(result.ok,true);
  assert.equal(harness.calls.filter(([op])=>op==="processStart").length,1);
  assert.equal(harness.calls.filter(([op])=>op==="processStop").length,1);
});

test("terminal finite and PTY schemas keep permission boundaries and bounded input before handler invocation",()=>{
  const harness=createHarness();
  const exec=harness.registrations.get("terminal_exec");
  const start=harness.registrations.get("terminal_start");
  const read=harness.registrations.get("terminal_read");
  const write=harness.registrations.get("terminal_write");
  const errors=[
    [exec,"command","a".repeat(20_001)],
    [exec,"wait_ms",120_001],
    [exec,"max_output_chars",999],
    [start,"cols",401],
    [start,"rows",4],
    [write,"data","x".repeat(100_001)],
    [read,"wait_ms",5_001],
    [read,"max_chars",120_001],
  ];
  for(const [tool,key,value] of errors){
    assert.equal(tool.config.inputSchema[key].safeParse(value).success,false,key);
  }
  assert.equal(exec.config.inputSchema.shell.safeParse("sh").success,false);
  assert.equal(write.config.inputSchema.key.safeParse("not-a-terminal-key").success,false);
  assert.equal(exec.options.mutationScopes[0],"global");
  assert.equal(write.options.mutationScopes[0],"global");
  assert.equal(start.config.annotations.openWorldHint,true);
  assert.equal(read.config.annotations.readOnlyHint,true);
  assert.equal(harness.calls.length,0);
});

test("terminal mutation adapters do not bypass Agent Access when finite or interactive process launch is forbidden",async()=>{
  const harness=createHarness({agentAccess:{terminal:false}});
  const testCases=[
    ["terminal_exec",{command:"echo synthetic",cwd:".",wait_ms:0,max_output_chars:1000}],
    ["terminal_start",{cwd:".",shell:"zsh",cols:80,rows:25}],
    ["terminal_write",{session_id:"term-1",data:"secret",key:"enter"}],
  ];
  for(const [name,args] of testCases){
    const response=await harness.registrations.get(name).handler(args);
    assert.equal(response.isError,true,name);
  }
  assert.deepEqual(harness.calls,[]);
});
