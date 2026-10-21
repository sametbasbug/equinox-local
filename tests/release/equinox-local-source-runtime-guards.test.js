import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  inspectSourcePeekabooRuntime,
  inspectSourceTunnelRuntime,
  parseSourceRuntimeConfig,
  readSourceRuntimeConfig,
  updateSourceRuntimePeekabooPath,
  updateSourceRuntimeTunnelClient,
} from "../../src/equinox-local-source-runtime.js";

const ROOT="/fixture/source-runtime";
const FILE=path.join(ROOT,"dev-runtime.conf");
const ORIGINAL=`launchAgentLabel=fixture
tunnelClient=/fixture/source-runtime/old-tunnel
sourceLauncher=/fixture/source-runtime/start.sh
`;

function mockPrivateFs({
  config=ORIGINAL,mode=0o600,uid=501,parentMode=0o700,
  parentSymlink=false,renameError=null,chmodError=null,openError=null,
}={}){
  const trace=[],content=Buffer.from(config,"utf8"),writes=[];
  const fsImpl={
    async open(file,flags,fileMode){
      trace.push(["open",file,flags,fileMode??null]);
      if(typeof flags==="string"){
        if(openError)throw openError;
        assert.equal(flags,"wx");
        assert.equal(fileMode,0o600);
        return {
          async writeFile(text,encoding){trace.push(["writeFile",text,encoding]);writes.push(text)},
          async sync(){trace.push(["sync"])},
          async chmod(value){trace.push(["chmod",value]);if(chmodError)throw chmodError},
          async close(){trace.push(["close","writer"])},
        };
      }
      assert.equal(file,FILE);
      return {
        async stat(){trace.push(["stat"]);return {
          isFile:()=>true,mode,uid,dev:11,ino:21,size:content.length,
        }},
        async read(buffer,offset,length,position){
          trace.push(["read",position,length]);
          const bytesRead=Math.min(length,Math.max(0,content.length-position));
          content.copy(buffer,offset,position,position+bytesRead);
          return {bytesRead};
        },
        async close(){trace.push(["close","reader"])},
      };
    },
    async lstat(file){
      trace.push(["lstat",file]);
      if(file===ROOT)return {
        isDirectory:()=>true,isSymbolicLink:()=>parentSymlink,uid,mode:parentMode,
      };
      return {isFile:()=>true,isSymbolicLink:()=>false,uid,mode:0o755};
    },
    async rename(from,to){
      trace.push(["rename",from,to]);
      assert.equal(to,FILE);
      if(renameError)throw renameError;
    },
    async rm(file,options){trace.push(["rm",file,options])},
  };
  return {fsImpl,trace,writes};
}

test("Developer config parser rejects duplicate/unknown fields and unpaired private composition without exposing a secret",()=>{
  const base="tunnelClient=/fixture/bin/tunnel\nsourceLauncher=/fixture/start.sh\n";
  const invalid=[
    base+"credential=secret\n",
    base+"tunnelClient=/fixture/bin/other\n",
    base+"privateCompositionModule=/fixture/private.mjs\n",
    base+"privateCompositionRoot=/fixture/private\n",
    base+"privateCompositionModule=relative\nprivateCompositionRoot=/fixture/private\n",
    base+"sourceLauncherOwnsLifecycle=true\n",
    "tunnelClient=relative\nsourceLauncher=/fixture/start.sh\n",
    "tunnelClient=/fixture/bin/tunnel\nsourceLauncher=relative\n",
    base+"no-equals\n",
  ];
  for(const input of invalid)assert.throws(()=>parseSourceRuntimeConfig(input),Error);
  const output=parseSourceRuntimeConfig(base);
  assert.equal(Object.isFrozen(output),true);
  assert.equal(output.privateCompositionModule,"");
  assert.equal(output.privateCompositionRoot,"");
});

test("Developer config reader rejects incorrect ownership and public file modes without mutation",async()=>{
  for(const overrides of [
    {mode:0o644},{mode:0o777},{mode:0o200},{uid:502},
  ]){
    const mock=mockPrivateFs(overrides);
    await assert.rejects(readSourceRuntimeConfig({
      configPath:FILE,fsImpl:mock.fsImpl,uid:501,
    }),/ownership|permissions/u);
    assert.equal(mock.trace.some(([event])=>["writeFile","rename","rm"].includes(event)),false);
  }
  const readOnly=mockPrivateFs({mode:0o400});
  const result=await readSourceRuntimeConfig({configPath:FILE,fsImpl:readOnly.fsImpl,uid:501});
  assert.equal(result.configured,true);
  assert.equal(result.config.sourceLauncher,"/fixture/source-runtime/start.sh");
  assert.equal(Object.isFrozen(result),true);
});

test("Developer runtime atomic writes preserve exact 0600 temporary mode, fsync, close and rename order",async()=>{
  for(const action of ["tunnel","peekaboo"]){
    const mock=mockPrivateFs();
    if(action==="tunnel"){
      await updateSourceRuntimeTunnelClient(FILE,"/fixture/new-tunnel",{fsImpl:mock.fsImpl,uid:501});
    }else{
      await updateSourceRuntimePeekabooPath(FILE,"/fixture/peekaboo",{fsImpl:mock.fsImpl,uid:501});
    }
    const events=mock.trace.map(([op])=>op);
    const openWriter=mock.trace.findIndex(([op,_,flags])=>op==="open"&&flags==="wx");
    const write=mock.trace.findIndex(([op])=>op==="writeFile");
    const sync=mock.trace.findIndex(([op])=>op==="sync");
    const chmod=mock.trace.findIndex(([op])=>op==="chmod");
    const close=mock.trace.findIndex(([op,label])=>op==="close"&&label==="writer");
    const rename=mock.trace.findIndex(([op])=>op==="rename");
    assert.ok(openWriter>0&&openWriter<write&&write<sync&&sync<chmod&&chmod<close&&close<rename,events.join(","));
    assert.equal(mock.trace[openWriter][3],0o600);
    assert.equal(mock.trace[chmod][1],0o600);
    assert.equal(mock.trace[rename][2],FILE);
    assert.equal(mock.trace.some(([op])=>op==="rm"),false);
    assert.equal(mock.writes.length,1);
    assert.ok(mock.writes[0].includes(action==="tunnel"?
      "tunnelClient=/fixture/new-tunnel":"peekabooPath=/fixture/peekaboo"));
    assert.ok(mock.writes[0].includes("sourceLauncher=/fixture/source-runtime/start.sh"));
  }
});

test("Developer runtime update rejects unsafe parent, malformed config and wrong owners before temporary creation",async()=>{
  for(const options of [
    {parentSymlink:true},{parentMode:0o722},{uid:502},{mode:0o644},
    {config:"tunnelClient=/fixture/old\nsourceLauncher=/fixture/start.sh\ntunnelClient=/fixture/duplicate\n"},
  ]){
    const mock=mockPrivateFs(options);
    await assert.rejects(updateSourceRuntimeTunnelClient(FILE,"/fixture/new",{
      fsImpl:mock.fsImpl,uid:501,
    }),Error);
    assert.equal(mock.trace.some(([op,_,flags])=>op==="open"&&flags==="wx"),false);
    assert.equal(mock.trace.some(([op])=>["rename","rm"].includes(op)),false);
  }
  const malformed=mockPrivateFs({config:"tunnelClient=/fixture/old\n"});
  await assert.rejects(updateSourceRuntimePeekabooPath(FILE,"/fixture/peekaboo",{
    fsImpl:malformed.fsImpl,uid:501,
  }),/must contain sourceLauncher/u);
  assert.equal(malformed.trace.some(([op,_,flags])=>op==="open"&&flags==="wx"),false);
});

test("Developer atomic update closes temporary handle and cleans up a failed rename, not the user config",async()=>{
  const failedRename=mockPrivateFs({renameError:Error("simulated rename failure")});
  await assert.rejects(updateSourceRuntimeTunnelClient(FILE,"/fixture/new",{
    fsImpl:failedRename.fsImpl,uid:501,
  }),/simulated rename failure/u);
  const rename=failedRename.trace.findIndex(([op])=>op==="rename");
  const removal=failedRename.trace.findIndex(([op])=>op==="rm");
  assert.ok(rename>=0&&removal>rename);
  assert.deepEqual(failedRename.trace[removal].slice(0,1),["rm"]);
  assert.match(failedRename.trace[removal][1],/\.equinox-local-dev-runtime-[a-f0-9]{16}\.tmp$/u);
  assert.deepEqual(failedRename.trace[removal][2],{force:true});
  assert.equal(failedRename.trace[rename][2],FILE);
  const failedChmod=mockPrivateFs({chmodError:Error("simulated chmod failure")});
  await assert.rejects(updateSourceRuntimePeekabooPath(FILE,"/fixture/peekaboo",{
    fsImpl:failedChmod.fsImpl,uid:501,
  }),/simulated chmod failure/u);
  assert.ok(failedChmod.trace.some(([op,label])=>op==="close"&&label==="writer"));
  assert.equal(failedChmod.trace.some(([op])=>op==="rename"),false);
});

test("Developer Tunnel and Peekaboo diagnostics never exec unowned or symlinked binaries or echo their local paths",async()=>{
  for(const inspect of [inspectSourceTunnelRuntime,inspectSourcePeekabooRuntime]){
    let execCalls=0;
    const mock=mockPrivateFs({
      config:ORIGINAL.replace("sourceLauncher=", "peekabooPath=/fixture/source-runtime/peekaboo\nsourceLauncher="),
    });
    const originalLstat=mock.fsImpl.lstat;
    mock.fsImpl.lstat=async file=>{
      if(file!==ROOT)return {isFile:()=>true,isSymbolicLink:()=>true,uid:501,mode:0o755};
      return originalLstat(file);
    };
    const result=await inspect({
      configPath:FILE,fsImpl:mock.fsImpl,uid:501,
      execFileImpl:async()=>{execCalls++;throw Error("should never execute");},
    });
    assert.equal(result.configured,true);
    assert.equal(result.needsAttention,true);
    assert.equal(result.actualVersion,null);
    assert.equal(execCalls,0);
    assert.doesNotMatch(JSON.stringify(result),/fixture\/source-runtime/u);
  }
});
