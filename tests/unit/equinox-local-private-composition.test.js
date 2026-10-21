import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDefaultPrivateComposition,
  loadPrivateComposition,
} from "../../src/equinox-local-private-composition.js";

const HOOKS = [
  "registerPrivateVisualTools",
  "createPrivateReleaseGateRuntime",
  "privateWorkflowStepExecutor",
  "registerPrivateReleaseGateTools",
  "registerPrivateSecureServiceTools",
  "privateReleaseGateSnapshot",
  "privateGitHubStatus",
];

async function rootFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-private-composition-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeModule(root, name, body) {
  const filePath = path.join(root, name);
  await fs.writeFile(filePath, body, { mode: 0o600 });
  return filePath;
}

function validModuleSource(marker = "external") {
  return `${HOOKS.map((name) => `export function ${name}(){ return ${JSON.stringify(marker + ':' + name)}; }`).join("\n")}\n`;
}

test("default private composition stays safe and generic", async () => {
  const composition = createDefaultPrivateComposition();
  assert.equal(composition.registerPrivateVisualTools(), null);
  assert.equal(composition.createPrivateReleaseGateRuntime(), null);
  assert.deepEqual(await composition.privateReleaseGateSnapshot(), {});
  const status = await composition.privateGitHubStatus({
    context: { id: "public" },
    projectContextStorage: { run: async (_context, callback) => callback() },
    runGhWithCode: async () => ({ code: 0, stdout: "public-user\n" }),
  });
  assert.deepEqual(status, { ready: true, account: "public-user" });
});

test("valid external private composition loads only from its configured root", async (t) => {
  const root = await rootFixture(t);
  const modulePath = await writeModule(root, "composition.mjs", validModuleSource());
  const composition = await loadPrivateComposition({ modulePath, rootPath: root });
  assert.equal(composition.registerPrivateVisualTools(), "external:registerPrivateVisualTools");
  for (const hook of HOOKS) assert.equal(typeof composition[hook], "function");
});

test("missing, malformed and contract-invalid private modules fall back safely", async (t) => {
  const root = await rootFixture(t);
  const missing = await loadPrivateComposition({ modulePath: path.join(root, "missing.mjs"), rootPath: root });
  assert.equal(missing.registerPrivateVisualTools(), null);

  const malformedPath = await writeModule(root, "malformed.mjs", "export function registerPrivateVisualTools( {\n");
  const malformed = await loadPrivateComposition({ modulePath: malformedPath, rootPath: root });
  assert.equal(malformed.registerPrivateVisualTools(), null);

  const invalidPath = await writeModule(root, "invalid.mjs", "export const registerPrivateVisualTools = 1;\n");
  const invalid = await loadPrivateComposition({ modulePath: invalidPath, rootPath: root });
  assert.equal(invalid.registerPrivateVisualTools(), null);
});

test("relative and out-of-root module paths are rejected without disclosure", async (t) => {
  const root = await rootFixture(t);
  const outside = await rootFixture(t);
  const outsideModule = await writeModule(outside, "outside.mjs", validModuleSource("outside"));
  const relative = await loadPrivateComposition({ modulePath: "./composition.mjs", rootPath: root });
  assert.equal(relative.registerPrivateVisualTools(), null);
  const escaped = await loadPrivateComposition({ modulePath: outsideModule, rootPath: root });
  assert.equal(escaped.registerPrivateVisualTools(), null);
  assert.equal(JSON.stringify(escaped).includes(outside), false);
});

test("symlinked private module targets fail closed", async (t) => {
  const root = await rootFixture(t);
  const realPath = await writeModule(root, "real.mjs", validModuleSource("real"));
  const linkPath = path.join(root, "link.mjs");
  await fs.symlink(realPath, linkPath);
  const composition = await loadPrivateComposition({ modulePath: linkPath, rootPath: root });
  assert.equal(composition.registerPrivateVisualTools(), null);
});

test("private composition requires explicit absolute root and module, without filesystem or import probes when invalid", async () => {
  const calls = [];
  const fakeFs = {
    lstat: async (name) => { calls.push(["lstat", name]); throw Error("should not read private paths"); },
    realpath: async (name) => { calls.push(["realpath", name]); throw Error("should not resolve private paths"); },
  };
  const importModule = async (url) => { calls.push(["import", url]); throw Error("should not import"); };
  const rejected = [
    {modulePath:"",rootPath:""},
    {modulePath:"/private/ops.mjs",rootPath:""},
    {modulePath:"",rootPath:"/private"},
    {modulePath:"relative/ops.mjs",rootPath:"/private"},
    {modulePath:"/private/ops.mjs",rootPath:"relative"},
    {modulePath:123,rootPath:"/private"},
    {modulePath:"/private/ops.mjs",rootPath:null},
  ];
  for (const options of rejected) {
    const loaded = await loadPrivateComposition({...options,fsImpl:fakeFs,importModule});
    assert.equal(Object.isFrozen(loaded),true);
    assert.equal(loaded.registerPrivateVisualTools(),null);
    assert.deepEqual(await loaded.privateReleaseGateSnapshot(),{});
  }
  assert.deepEqual(calls,[]);
});

test("private composition refuses symlink root, non-directory root, symlink module and non-file module before realpath/import", async () => {
  const root="/fixtures/approved-root",modulePath="/fixtures/approved-root/composition.mjs";
  for (const invalid of ["root-link","root-file","module-link","module-directory"]) {
    const calls=[];
    const stat=(kind)=>({
      isDirectory:()=>kind==="directory",
      isFile:()=>kind==="file",
      isSymbolicLink:()=>kind==="symlink",
    });
    const fsImpl={
      lstat:async location=>{
        calls.push(["lstat",location]);
        const kind=location===root
          ? invalid==="root-link"?"symlink":invalid==="root-file"?"file":"directory"
          : invalid==="module-link"?"symlink":invalid==="module-directory"?"directory":"file";
        return stat(kind);
      },
      realpath:async location=>{calls.push(["realpath",location]);throw Error("realpath not allowed");},
    };
    const loaded=await loadPrivateComposition({
      modulePath,rootPath:root,fsImpl,
      importModule:async()=>{throw Error("untrusted module must not import");},
    });
    assert.equal(loaded.registerPrivateVisualTools(),null,invalid);
    assert.deepEqual(calls,[["lstat",root],["lstat",modulePath]]);
  }
});

test("private composition compares resolved canonical roots, never imports outside/root-target or after realpath failure", async () => {
  const root="/fixtures/approved",modulePath="/fixtures/approved/component.mjs";
  const cases=[
    {rootReal:"/approved",moduleReal:"/approved",reason:"root itself"},
    {rootReal:"/approved",moduleReal:"/elsewhere/outside.mjs",reason:"outside"},
    {rootReal:"/approved",moduleReal:"/approved-but-not-inside/component.mjs",reason:"prefix collision"},
    {rootReal:"/approved",moduleReal:"/approved/../sibling/component.mjs",reason:"relative escape"},
    {rootReal:"/approved",moduleReal:"/approved/component.mjs",failRealpath:true,reason:"failed canonicalization"},
  ];
  for (const scenario of cases) {
    const calls=[];
    const fsImpl={
      lstat:async location=>{
        calls.push(["lstat",location]);
        return {
          isDirectory:()=>location===root,
          isFile:()=>location===modulePath,
          isSymbolicLink:()=>false,
        };
      },
      realpath:async location=>{
        calls.push(["realpath",location]);
        if(scenario.failRealpath&&location===modulePath)throw Error("denied canonicalization");
        return location===root?scenario.rootReal:scenario.moduleReal;
      },
    };
    const result=await loadPrivateComposition({
      modulePath,rootPath:root,fsImpl,
      importModule:async url=>{calls.push(["import",url]);throw Error("must not import disallowed module");},
    });
    assert.equal(result.registerPrivateVisualTools(),null,scenario.reason);
    assert.equal(calls.some(([op])=>op==="import"),false,scenario.reason);
    assert.deepEqual(calls.map(([op])=>op),["lstat","lstat","realpath","realpath"]);
  }
});

test("private composition validates all seven named callable hooks atomically and binds only allowlisted exports", async () => {
  const root="/fixtures/approved",modulePath="/fixtures/approved/composition.mjs";
  const names=HOOKS;
  const trace=[];
  const hooks=Object.fromEntries(names.map(name=>[name,(...args)=>{
    trace.push(["hook",name,args]);
    return name;
  }]));
  const loadedModule={...hooks,unauthorizedHook:()=>{throw Error("unauthorized")},__privateToken:"fixture-only-do-not-export"};
  const fsImpl={
    lstat:async location=>({
      isDirectory:()=>location===root,
      isFile:()=>location===modulePath,
      isSymbolicLink:()=>false,
    }),
    realpath:async location=>location,
  };
  const imported=[];
  const importModule=async url=>{imported.push(url);return loadedModule;};
  const composition=await loadPrivateComposition({rootPath:root,modulePath,fsImpl,importModule});
  assert.deepEqual(imported,["file:///fixtures/approved/composition.mjs"]);
  assert.equal(Object.isFrozen(composition),true);
  assert.deepEqual(Object.keys(composition),names);
  assert.equal(Object.hasOwn(composition,"unauthorizedHook"),false);
  assert.equal(JSON.stringify(composition).includes("__privateToken"),false);
  for(const name of names) {
    const args=[{fixture:true},"fixture"];
    assert.equal(await composition[name](...args),name);
  }
  assert.deepEqual(trace,names.map(name=>["hook",name,[{fixture:true},"fixture"]]));
  for(const missingName of names) {
    const invalid={...hooks,[missingName]:"not a function"};
    let attempts=0;
    const fallback=await loadPrivateComposition({
      rootPath:root,modulePath,fsImpl,importModule:async()=>{attempts++;return invalid;},
    });
    assert.equal(attempts,1);
    assert.equal(fallback.registerPrivateVisualTools(),null);
    assert.deepEqual(await fallback.privateReleaseGateSnapshot(),{});
    assert.equal(Object.keys(fallback).length,names.length);
  }
});

test("private composition load errors remain isolated, and default GitHub status is strictly bounded", async () => {
  const root="/fixtures/approved",modulePath="/fixtures/approved/composition.mjs";
  const fsImpl={
    lstat:async location=>({isDirectory:()=>location===root,isFile:()=>location===modulePath,isSymbolicLink:()=>false}),
    realpath:async location=>location,
  };
  for(const result of [null,{},Promise.reject(Error("controlled private module failure"))]) {
    const fallback=await loadPrivateComposition({
      modulePath,rootPath:root,fsImpl,
      importModule:async()=>await result,
    });
    assert.equal(fallback.registerPrivateVisualTools(),null);
    assert.equal(Object.isFrozen(fallback),true);
  }
  const defaults=createDefaultPrivateComposition();
  const identities=["valid-user","hyphen-name","a".repeat(39),"a".repeat(40),"bad_value","bad name","", "VALID"];
  for(const name of identities) {
    const calls=[];
    const response=await defaults.privateGitHubStatus({
      context:{scope:"only-this-fixture"},
      projectContextStorage:{
        run:async(context,callback)=>{calls.push(["scope",context]);return callback();},
      },
      runGhWithCode:async(args,input,limit)=>{
        calls.push(["gh",args,input,limit]);
        return {code:0,stdout:name+"\n"};
      },
    });
    assert.deepEqual(response,{
      ready:/^[A-Za-z0-9-]{1,39}$/u.test(name),
      account:/^[A-Za-z0-9-]{1,39}$/u.test(name)?name:null,
    });
    assert.deepEqual(calls,[
      ["scope",{scope:"only-this-fixture"}],
      ["gh",["api","user","--jq",".login"],"",15_000],
    ]);
  }
  const refused=await defaults.privateGitHubStatus({
    context:{scope:"mock"},
    projectContextStorage:{run:async()=>{throw Error("GitHub account unavailable");}},
    runGhWithCode:async()=>{throw Error("should not run");},
  });
  assert.deepEqual(refused,{ready:false,account:null});
});
