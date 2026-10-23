import assert from "node:assert/strict";
import test from "node:test";

import { registerProjectDiscoveryTools } from "../../src/equinox-local-project-tools.js";

function createHarness() {
  const registrations = new Map();
  const projectDefinitions = {
    app: { name: "App", root: "/tmp/app" },
    broken: { name: "Broken", root: "/tmp/broken" },
  };
  const fileRootDefinitions = {
    ...projectDefinitions,
    downloads: { name: "Downloads", root: "/tmp/downloads" },
  };

  registerProjectDiscoveryTools({
    registerTextTool(name, config, handler, options = {}) {
      registrations.set(name, { config, handler, options });
    },
    projectIds: ["app", "broken"],
    projectDefinitions,
    fileRootIds: ["app", "broken", "downloads"],
    fileRootDefinitions,
    fullFileAccess: true,
    defaultProject: "app",
    async resolveProjectContext(projectId) {
      if (projectId === "broken") throw new Error("fixture unavailable");
      return {
        id: projectId,
        name: projectDefinitions[projectId].name,
        rootRealPath: projectDefinitions[projectId].root,
      };
    },
    async resolveFileRootContext(rootId) {
      return {
        id: rootId,
        name: fileRootDefinitions[rootId].name,
        rootRealPath: fileRootDefinitions[rootId].root,
      };
    },
    gitPath: "/pinned/managed/git",
    async execFileImpl(binary, args) {
      assert.equal(binary, "/pinned/managed/git");
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return { stdout: "/tmp/app\n" };
      if (command === "symbolic-ref --quiet --short HEAD") return { stdout: "main\n" };
      if (command === "status --porcelain=v1 --untracked-files=all") {
        return { stdout: " M changed.txt\n?? new.txt\n" };
      }
      if (command === "remote get-url origin") {
        return { stdout: "https://secret-token@github.com/example/repo.git\n" };
      }
      throw new Error(`Unexpected git fixture command: ${command}`);
    },
    fsImpl: {
      async realpath(value) {
        return value;
      },
    },
    gitEnv: { PATH: "/usr/bin" },
    textResult: (text) => ({ text }),
  });

  return registrations;
}

test("project discovery tools preserve bounded project/root status output", async () => {
  const registrations = createHarness();
  const listProjects = registrations.get("list_projects");

  assert.ok(listProjects);
  assert.equal(listProjects.options.projectAware, false);
  assert.equal(listProjects.config.annotations.readOnlyHint, true);

  const result = await listProjects.handler({});
  assert.match(result.text, /Dosya erişim modu: FULL/u);
  assert.match(result.text, /Varsayılan proje: app/u);
  assert.match(result.text, /app — App/u);
  assert.match(result.text, /Branch: main/u);
  assert.match(result.text, /Çalışma ağacı: 2 değişiklik/u);
  assert.match(result.text, /Origin: https:\/\/\[REDACTED\]@github\.com\/example\/repo\.git/u);
  assert.match(result.text, /broken — Broken[\s\S]*Durum: Kullanılamıyor[\s\S]*fixture unavailable/u);
  assert.match(result.text, /downloads — Downloads[\s\S]*Tür: Yapılandırılmış dosya kökü/u);
  assert.equal(result.text.includes("secret-token"), false);
});

function projectDiscoveryHarness({
  projectIds = ["allowed"],
  projectDefinitions = {allowed: {name: "Allowed", root: "/fixture/allowed"}},
  fileRootIds = [],
  fileRootDefinitions = {},
  fullFileAccess = false,
  resolveProjectContext = async () => ({rootRealPath: "/fixture/allowed"}),
  resolveFileRootContext = async () => ({rootRealPath: "/fixture/files"}),
  execFileImpl = async (_binary, args) => {
    const cmd = args.join(" ");
    if (cmd === "rev-parse --show-toplevel") return {stdout:"/fixture/allowed\n"};
    if (cmd === "symbolic-ref --quiet --short HEAD") return {stdout:"topic\n"};
    if (cmd === "status --porcelain=v1 --untracked-files=all") return {stdout:""};
    if (cmd === "remote get-url origin") return {stdout:"https://github.com/acme/example.git\n"};
    throw Error("unexpected mocked git command");
  },
  fsImpl = {realpath: async path => path},
  gitEnv = {PATH:"/mock/system/bin",GIT_TERMINAL_PROMPT:"1",CUSTOM:"fixture-value"},
} = {}) {
  const tools = new Map();
  registerProjectDiscoveryTools({
    registerTextTool: (name,definition,handler,options)=>tools.set(name,{definition,handler,options}),
    projectIds,projectDefinitions,fileRootIds,fileRootDefinitions,
    fullFileAccess,defaultProject:"allowed",
    resolveProjectContext,resolveFileRootContext,
    execFileImpl,fsImpl,gitEnv,gitPath:"/managed/git",
    textResult:text=>({text}),
  });
  return tools;
}

test("project discovery rejects mismatched canonical git root without running status or leaking an origin URL", async () => {
  const calls = [];
  const tools = projectDiscoveryHarness({
    execFileImpl: async (binary,args,options)=>{
      calls.push([binary,args,options]);
      if(args[0]==="rev-parse")return {stdout:"/fixture/foreign-repo\n"};
      throw Error("status and origin must not execute on foreign Git root");
    },
    fsImpl: {realpath: async path=>{
      calls.push(["realpath",path]);
      return path;
    }},
  });
  const tool=tools.get("list_projects");
  assert.deepEqual(tool.options,{projectAware:false});
  assert.equal(Object.hasOwn(tool.options,"mutationScopes"),false);
  assert.deepEqual(tool.definition.inputSchema,{});
  assert.deepEqual(tool.definition.annotations,{
    title:"Proje ve erişim köklerini listele",
    readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false,
  });
  const {text}=await tool.handler();
  assert.match(text,/Durum: Kullanılamıyor/u);
  assert.match(text,/İzinli yol bağımsız Git repo kökü değil/u);
  assert.equal(calls.length,2);
  assert.deepEqual(calls[0][1],["rev-parse","--show-toplevel"]);
  assert.deepEqual(calls[1],["realpath","/fixture/foreign-repo"]);
  assert.equal(calls[0][0],"/managed/git");
  assert.equal(calls[0][2].cwd,"/fixture/allowed");
  assert.deepEqual(Object.fromEntries(["GIT_OPTIONAL_LOCKS","GIT_TERMINAL_PROMPT","LC_ALL"].map(key=>[key,calls[0][2].env[key]])),{
    GIT_OPTIONAL_LOCKS:"0",GIT_TERMINAL_PROMPT:"0",LC_ALL:"C",
  });
  assert.equal(calls[0][2].timeout,15000);
  assert.equal(calls[0][2].maxBuffer,1024*1024);
});

test("project discovery uses read-only Git argv and sanitizes HTTPS origin credentials, preserving fallback branch and missing origin", async () => {
  const calls=[];
  const tools=projectDiscoveryHarness({
    execFileImpl: async (binary,args,options)=>{
      calls.push([binary,args,options]);
      const command=args.join(" ");
      if(command==="rev-parse --show-toplevel")return {stdout:"/fixture/allowed\n"};
      if(command==="symbolic-ref --quiet --short HEAD")throw Error("detached");
      if(command==="status --porcelain=v1 --untracked-files=all")return {stdout:" M change.txt\n?? new.txt\n"};
      if(command==="remote get-url origin")return {stdout:"https://username:secret-token@github.com/acme/repo.git\n"};
      throw Error("unexpected Git argument");
    },
  });
  const {text}=await tools.get("list_projects").handler();
  assert.match(text,/Branch: DETACHED/u);
  assert.match(text,/Çalışma ağacı: 2 değişiklik/u);
  assert.match(text,/Origin: https:\/\/\[REDACTED\]@github\.com\/acme\/repo\.git/u);
  assert.equal(text.includes("secret-token"),false);
  assert.equal(text.includes("username"),false);
  assert.deepEqual(calls.map(([,args])=>args),[
    ["rev-parse","--show-toplevel"],
    ["symbolic-ref","--quiet","--short","HEAD"],
    ["status","--porcelain=v1","--untracked-files=all"],
    ["remote","get-url","origin"],
  ]);
  assert.ok(calls.every(([binary,,options])=>binary==="/managed/git"
    &&options.cwd==="/fixture/allowed"&&options.env.GIT_OPTIONAL_LOCKS==="0"
    &&options.env.GIT_TERMINAL_PROMPT==="0"&&options.env.LC_ALL==="C"));
  assert.equal(calls[2][2].maxBuffer,2*1024*1024);
  assert.ok(calls.filter(([,args])=>args[0]==="status").every(([,args])=>args.includes("--porcelain=v1")));
});

test("project discovery never executes Git after resolver access denial and reports inaccessible configured file roots separately", async () => {
  const calls=[];
  const tools=projectDiscoveryHarness({
    projectIds:["denied"],
    projectDefinitions:{denied:{name:"Denied",root:"/fixture/denied"}},
    fileRootIds:["denied","external"],
    fileRootDefinitions:{
      denied:{name:"Denied",root:"/fixture/denied"},
      external:{name:"External",root:"/fixture/external"},
    },
    resolveProjectContext:async id=>{
      calls.push(["resolveProject",id]);
      throw Error("Agent Access refused");
    },
    resolveFileRootContext:async id=>{
      calls.push(["resolveFileRoot",id]);
      throw Error("file root unavailable");
    },
    execFileImpl:async()=>{throw Error("must not invoke Git")},
    fsImpl:{realpath:async()=>{throw Error("must not touch filesystem")}},
  });
  const tool=tools.get("list_projects");
  const {text}=await tool.handler();
  assert.match(text,/Dosya erişim modu: SELECTED/u);
  assert.match(text,/denied — Denied[\s\S]*Agent Access refused/u);
  assert.match(text,/external — External[\s\S]*file root unavailable/u);
  assert.deepEqual(calls,[["resolveProject","denied"],["resolveFileRoot","external"]]);
});

test("project discovery remains a single read-only capability in FULL mode even when one project Git check fails", async () => {
  const effects=[];
  const tools=projectDiscoveryHarness({
    projectIds:["bad","good"],
    projectDefinitions:{
      bad:{name:"Bad",root:"/fixture/bad"},
      good:{name:"Good",root:"/fixture/allowed"},
    },
    fullFileAccess:true,
    resolveProjectContext:async id=>{
      effects.push(["resolve",id]);
      if(id==="bad")throw Error("restricted project");
      return {rootRealPath:"/fixture/allowed"};
    },
  });
  assert.deepEqual([...tools.keys()],["list_projects"]);
  const {text}=await tools.get("list_projects").handler();
  assert.match(text,/Dosya erişim modu: FULL/u);
  assert.match(text,/bad — Bad[\s\S]*restricted project/u);
  assert.match(text,/good — Good[\s\S]*Branch: topic/u);
  assert.deepEqual(effects,[["resolve","bad"],["resolve","good"]]);
});
