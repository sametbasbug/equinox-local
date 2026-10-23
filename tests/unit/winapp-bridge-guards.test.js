import assert from "node:assert/strict";
import test from "node:test";

import {
  WINAPP_ALLOWED_TOOLS,
  WINAPP_TOOL_DEFINITIONS,
  __test,
  buildSafeWinappEnvironment,
  createWinappBridge,
  resolveWinappBinary,
} from "../../src/winapp-bridge.js";

const WIN_ENV = {
  SystemRoot:"C:\\Windows",LOCALAPPDATA:"C:\\Users\\Fixture\\AppData\\Local",
  USERPROFILE:"C:\\Users\\Fixture",OPENAI_API_KEY:"fixture-credential",
  GITHUB_TOKEN:"fixture-token",NODE_OPTIONS:"--require \\unsafe",PATH:"C:\\untrusted",
};
const EXECUTABLE = "C:\\Fixture\\native\\runtime\\winapp\\winapp.exe";

function fakeBridge({
  fsImpl={},
  execFileImpl=async()=>({stdout:"{}",stderr:""}),
  resolveBinaryImpl=async()=>EXECUTABLE,
  platform="win32",
}={}){
  const invocations=[];
  const bridge=createWinappBridge({
    baseEnvironment:WIN_ENV,platform,
    fsImpl:{
      lstat:async()=>({isFile:()=>true,isSymbolicLink:()=>false}),
      mkdir:async()=>{},writeFile:async()=>{},unlink:async()=>{},
      open:async()=>{throw Error("no unexpected screenshots")},
      ...fsImpl,
    },
    resolveBinaryImpl,
    execFileImpl:async(file,args,options)=>{
      invocations.push({file,args,options});
      return execFileImpl(file,args,options);
    },
  });
  return {bridge,invocations};
}

test("winapp denies unsupported tools, inherited/prototype arguments and ambiguous targets before execution",async()=>{
  const {bridge,invocations}=fakeBridge();
  for(const [tool,input] of [
    ["arbitrary",{command:"powershell"}],
    ["click",{selector:"Save",app:"Demo",window:"0x2"}],
    ["send_keys",{keys:"a",imaginary:"x"}],
    ["click",{selector:"Save",app:"Demo",pid:23}],
    ["scroll",{selector:"Pane",wheel:1001}],
    ["wait_for",{selector:"Button",timeout_ms:60001}],
    ["send_keys",{keys:"k".repeat(20001)}],
    ["drag",{from:"A",to:"B",hold_ms:60001}],
    ["screenshot",{output:"x".repeat(4097)}],
  ])await assert.rejects(bridge.callTool(tool,input),Error,tool);
  const untrusted=Object.create({selector:"inherited"});
  untrusted.app="Demo";
  await assert.rejects(bridge.callTool("click",untrusted),/plain object/u);
  assert.equal(invocations.length,0);
  assert.equal(WINAPP_ALLOWED_TOOLS.length,22);
  assert.equal(Object.keys(WINAPP_TOOL_DEFINITIONS).length,22);
  assert.equal(Object.hasOwn(Object.prototype,"inherited"),false);
});

test("winapp refuses to resolve or execute Windows desktop code on non-Windows hosts",async()=>{
  let resolutions=0,executions=0;
  const {bridge}=fakeBridge({
    platform:"darwin",
    resolveBinaryImpl:async()=>{resolutions++;return EXECUTABLE},
    execFileImpl:async()=>{executions++;return {stdout:"{}"}},
  });
  await assert.rejects(bridge.status(),/only on Windows/u);
  await assert.rejects(bridge.listTools(),/only on Windows/u);
  await assert.rejects(bridge.callTool("click",{selector:"Button"}),/only on Windows/u);
  assert.equal(resolutions,0);
  assert.equal(executions,0);
});

test("Windows winapp subprocess inherits only allowlisted system paths, safe PATH and bounded output",async()=>{
  const safe=buildSafeWinappEnvironment(WIN_ENV,"fixture-workflow");
  assert.equal(safe.PATH,"C:\\Windows\\System32;C:\\Windows");
  assert.equal(safe.WINAPP_UI_WORKFLOW_ID,"fixture-workflow");
  for(const key of ["OPENAI_API_KEY","GITHUB_TOKEN","NODE_OPTIONS","PATH_FROM_PARENT","PYTHONPATH","LD_PRELOAD"]){
    assert.equal(key==="PATH_FROM_PARENT"?safe[key]:safe[key],undefined,key);
  }
  const {bridge,invocations}=fakeBridge({
    execFileImpl:async()=>({stdout:"{}".padEnd(2*1024*1024+1,"x"),stderr:""}),
  });
  await assert.rejects(bridge.callTool("click",{selector:"Button",workflow_id:"fixture-workflow"}),/bounded result limit/u);
  assert.equal(invocations.length,1);
  assert.equal(invocations[0].options.windowsHide,true);
  assert.equal(invocations[0].options.maxBuffer,2*1024*1024);
  assert.equal(invocations[0].options.env.OPENAI_API_KEY,undefined);
  assert.equal(invocations[0].options.env.WINAPP_UI_WORKFLOW_ID,"fixture-workflow");
  assert.equal(invocations[0].options.shell,undefined);
});

test("Windows clipboard helper failure deletes only the private temporary input with no fallback executable",async()=>{
  const events=[];
  const {bridge,invocations}=fakeBridge({
    fsImpl:{
      lstat:async file=>{events.push(["lstat",file]);return {isFile:()=>true,isSymbolicLink:()=>false}},
      mkdir:async(directory,opts)=>{events.push(["mkdir",directory,opts])},
      writeFile:async(file,data,opts)=>{events.push(["write",file,Buffer.from(data).toString("utf8"),opts])},
      unlink:async file=>{events.push(["unlink",file])},
    },
    execFileImpl:async()=>{throw Object.assign(Error("synthetic helper failed"),{stderr:"fixture clipboard denied"})},
  });
  await assert.rejects(bridge.callTool("clipboard",{action:"set",text:"private-fixture-value"}),/Windows clipboard helper failed/u);
  const write=events.find(([name])=>name==="write");
  const deletion=events.find(([name])=>name==="unlink");
  assert.equal(write[2],"private-fixture-value");
  assert.deepEqual(write[3],{flag:"wx",mode:0o600});
  assert.equal(deletion[1],write[1]);
  assert.match(write[1],/^C:\\Users\\Fixture\\AppData\\Local\\Equinox Local\\cache\\desktop\\clipboard-/u);
  assert.equal(invocations.length,1);
  assert.match(invocations[0].file,/WindowsPowerShell\\v1\.0\\powershell\.exe$/u);
  assert.equal(invocations[0].options.windowsHide,true);
  assert.equal(invocations[0].options.env.OPENAI_API_KEY,undefined);
});

test("Windows screenshot refuses path swap and changing buffer while closing same file handle and deleting auto capture",async()=>{
  const events=[],fileContent=Buffer.from("synthetic content only");
  let stats=0,reportedPath;
  const {bridge,invocations}=fakeBridge({
    fsImpl:{
      mkdir:async()=>{},
      lstat:async filename=>{reportedPath=filename;events.push(["lstat",filename]);return {isFile:()=>true,isSymbolicLink:()=>false}},
      open:async(filename,flags)=>{
        events.push(["open",filename,flags]);
        return {
          stat:async()=>{stats++;events.push(["stat",stats]);return {isFile:()=>true,size:stats===1?fileContent.length:fileContent.length+1}},
          readFile:async()=>{events.push(["readFile"]);return fileContent},
          close:async()=>{events.push(["close"])},
        };
      },
      unlink:async filename=>events.push(["unlink",filename]),
    },
  });
  await assert.rejects(bridge.callTool("screenshot",{app:"Notepad"}),/changed while it was being read/u);
  assert.equal(invocations.length,1);
  assert.equal(events.find(([op])=>op==="open")[1],reportedPath);
  assert.deepEqual(events.slice(-5).map(([op])=>op),["stat","readFile","stat","close","unlink"]);
  assert.equal(events.at(-1)[1],reportedPath);
});

test("pinned native winapp refuses symlinked or missing candidates and never probes untrusted PATH",async()=>{
  const looked=[];
  await assert.rejects(resolveWinappBinary({
    EQUINOX_WINAPP_PATH:"winapp.exe",
    EQUINOX_LOCAL_RELEASE_DIR:"C:\\Fixture\\trusted-release",
    PATH:"C:\\untrusted",
  },{
    fsImpl:{lstat:async file=>{
      looked.push(file);
      return {isFile:()=>true,isSymbolicLink:()=>true};
    }},
  }),/pinned Microsoft winapp runtime is unavailable/u);
  assert.ok(looked.length>=2);
  assert.ok(looked.every(file=>file!=="winapp.exe"));
  assert.ok(looked.every(file=>!file.startsWith("C:\\untrusted")));
  assert.equal(__test.MAX_CLIPBOARD_BYTES,256*1024);
});
