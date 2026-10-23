import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import test from "node:test";

import {
  createEquinoxBrowserNativeHostRuntime,
  MAX_NATIVE_MESSAGE_BYTES,
  MAX_BRIDGE_LINE_BYTES,
} from "../../src/equinox-browser-native-host-runtime.js";

class FixtureSocket extends EventEmitter {
  constructor({backpressure = 0}={}) {
    super();
    this.destroyed=false;
    this.backpressure=backpressure;
    this.writes=[];
  }
  write(value){
    this.writes.push(Buffer.from(value));
    if(this.backpressure>0){this.backpressure--;return false;}
    return true;
  }
  destroy(){
    if(this.destroyed)return;
    this.destroyed=true;
    this.emit("close");
  }
}
class FixtureOutput extends EventEmitter{
  constructor({backpressure = 0}={}){
    super();this.backpressure=backpressure;this.frames=[];
  }
  write(value){
    this.frames.push(Buffer.from(value));
    if(this.backpressure>0){this.backpressure--;return false;}
    return true;
  }
}
function frame(message){
  const payload=Buffer.from(JSON.stringify(message));
  const size=Buffer.alloc(4);
  size.writeUInt32LE(payload.length);
  return Buffer.concat([size,payload]);
}
function fixture(options={}){
  const input=new PassThrough();
  const output=new FixtureOutput(options);
  const errors=new FixtureOutput();
  const socket=new FixtureSocket(options);
  const fatals=[],connections=[];
  const runtime=createEquinoxBrowserNativeHostRuntime({
    bridgeEndpoint:{kind:"named-pipe",endpoint:"fixture-pipe",implemented:true},
    input,output,errorOutput:errors,
    createConnection:target=>{connections.push(target);return socket},
    onFatal:reason=>fatals.push(reason),
    reconnectDelayMs:60_000,
    ...options,
  });
  return {input,output,errors,socket,fatals,connections,runtime,
    close(){runtime.close();input.end()}};
}

test("Native Host rejects unimplemented, unknown or empty IPC endpoint before opening a connection",()=>{
  for(const bridgeEndpoint of [
    null,
    {kind:"unix",endpoint:"",implemented:true},
    {kind:"tcp",endpoint:"localhost:123",implemented:true},
    {kind:"named-pipe",endpoint:"fixture",implemented:false},
    {kind:"unix",endpoint:null,implemented:true},
  ]){
    let connects=0;
    assert.throws(()=>createEquinoxBrowserNativeHostRuntime({
      bridgeEndpoint,createConnection:()=>{connects++;throw Error("must not connect")}
    }),/required|unsupported|not implemented/u);
    assert.equal(connects,0);
  }
});

test("Native Messaging oversized header fails closed once before allocating a payload or forwarding a message",()=>{
  const f=fixture();
  try{
    f.runtime.start();
    const header=Buffer.alloc(4);
    header.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES+1);
    f.input.write(header.subarray(0,2));
    assert.equal(f.runtime.snapshot().closing,false);
    f.input.write(header.subarray(2));
    assert.equal(f.runtime.snapshot().closing,true);
    assert.equal(f.fatals.length,1);
    assert.equal(f.fatals[0].reason,"message-too-large");
    assert.equal(f.fatals[0].length,MAX_NATIVE_MESSAGE_BYTES+1);
    assert.equal(f.socket.destroyed,true);
    f.input.write(frame({type:"fixture.after-fatal"}));
    assert.equal(f.fatals.length,1);
    assert.equal(f.socket.writes.length,0);
    assert.equal(f.runtime.snapshot().queuedMessages,0);
  }finally{f.close()}
});

test("Native Host offline queue drops oldest non-hello messages under both count and byte caps, then drains in order",()=>{
  const f=fixture({maxOutboundQueueMessages:2,maxOutboundQueueBytes:256});
  try{
    f.runtime.start();
    for(const id of [1,2,3,4]){
      f.input.write(frame({type:"fixture.event",id}));
    }
    assert.equal(f.runtime.snapshot().closing,false);
    assert.equal(f.runtime.snapshot().queuedMessages,2);
    assert.ok(f.runtime.snapshot().queuedBytes<=256);
    f.socket.emit("connect");
    const lines=f.socket.writes.map(x=>x.toString("utf8").trim()).map(JSON.parse);
    assert.equal(lines[0].type,"host.hello");
    assert.deepEqual(lines.slice(1).map(x=>x.message.id),[3,4]);
    assert.equal(f.runtime.snapshot().queuedMessages,0);
    assert.equal(f.fatals.length,0);
  }finally{f.close()}
});

test("Native stdout output overflow triggers one fail-closed shutdown while preserving bounded pending queue",()=>{
  const f=fixture({backpressure:1,maxNativeOutputQueueBytes:180});
  try{
    f.runtime.start();
    assert.equal(f.output.frames.length,1);
    assert.equal(f.runtime.snapshot().closing,false);
    f.socket.emit("connect");
    assert.equal(f.runtime.snapshot().nativeOutputQueuedBytes>0,true);
    f.socket.emit("data",Buffer.from(JSON.stringify({type:"host.send",message:{type:"fixture",data:"x".repeat(140)}})+"\n"));
    assert.equal(f.fatals.length,1);
    assert.equal(f.fatals[0].reason,"native-output-overflow");
    assert.equal(f.runtime.snapshot().closing,true);
    assert.equal(f.socket.destroyed,true);
    f.output.emit("drain");
    assert.equal(f.fatals.length,1);
  }finally{f.close()}
});

test("Native Host drops invalid bridge and extension JSON without inventing a route or exposing fixture messages",()=>{
  const f=fixture();
  try{
    f.runtime.start();
    f.socket.emit("connect");
    f.socket.emit("data",Buffer.from("{\"type\":\n"));
    f.input.write(Buffer.from([1,0,0,0,0x7b]));
    assert.equal(f.fatals.length,0);
    assert.equal(f.runtime.snapshot().closing,false);
    assert.equal(f.socket.writes.length,1,"no extra bridge messages after invalid extension JSON");
    assert.equal(f.output.frames.length,2,"initial host status and connect status only");
    assert.ok(f.errors.frames.length>=2);
    assert.equal(f.runtime.snapshot().cachedExtensionHello,false);
  }finally{f.close()}
});
