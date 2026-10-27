import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  managedSupervisorPaths,
  readSupervisorTransport,
  resolveSupervisorRelease,
  runManagedSupervisor,
  shellQuote,
  supervisorChildEnvironment,
  tunnelInitArguments,
} from "../../src/equinox-local-supervisor.js";
import { equinoxLocalUpdateTarget } from "../../src/equinox-local-updater.js";

async function makeFixture({ transport = false, malformedTransport = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-supervisor-"));
  const homeDir = path.join(root, "User Home");
  const paths = managedSupervisorPaths(homeDir);
  const releaseDir = path.join(paths.releasesRoot, "4.2.0");
  const nodeBinary = path.join(releaseDir, "runtime", "node", "bin", "node");
  const tunnelDir = path.join(releaseDir, "runtime", "tunnel");
  await fs.mkdir(path.dirname(nodeBinary), { recursive: true });
  await fs.mkdir(tunnelDir, { recursive: true });
  await fs.writeFile(path.join(releaseDir, "release.json"), JSON.stringify({
    schemaVersion: 1,
    version: "4.2.0",
    target: equinoxLocalUpdateTarget(),
    nodeVersion: "24.19.0",
    tunnelClientVersion: "0.0.12",
    serverEntry: "server.js",
  }));
  await fs.writeFile(path.join(releaseDir, "server.js"), "// fixture\n");
  await fs.writeFile(nodeBinary, "fixture node\n");
  await fs.chmod(nodeBinary, 0o755);
  for (const name of ["tunnel-client", "cloudflared"]) {
    const binary = path.join(tunnelDir, name);
    await fs.writeFile(binary, `${name}\n`);
    await fs.chmod(binary, 0o755);
  }
  await fs.mkdir(paths.installRoot, { recursive: true });
  await fs.symlink("releases/4.2.0", paths.currentLink, "dir");

  if (transport || malformedTransport) {
    await fs.mkdir(path.dirname(paths.runtimeKeyPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(paths.runtimeKeyPath, "sk-runtime-fixture\n", { mode: 0o600 });
    await fs.writeFile(paths.transportConfigPath, malformedTransport
      ? "not json\n"
      : `${JSON.stringify({ version: 1, mode: "openai-tunnel", tunnelId: "tunnel_0123456789abcdef0123456789abcdef" }, null, 2)}\n`,
    { mode: 0o600 });
  }
  return { root, homeDir, paths, releaseDir, nodeBinary, tunnelDir };
}

test("managed supervisor paths use the Windows per-user layout without POSIX path drift", () => {
  const homeDir = "C:\\Users\\Türk User";
  const localAppData = "C:\\Users\\Türk User\\AppData\\Local";
  const paths = managedSupervisorPaths(homeDir, {
    platform: "win32",
    arch: "x64",
    env: { LOCALAPPDATA: localAppData },
  });
  const installRoot = path.win32.join(localAppData, "Equinox Local");
  assert.equal(paths.homeDir, path.win32.normalize(homeDir));
  assert.equal(paths.installRoot, installRoot);
  assert.equal(paths.releasesRoot, path.win32.join(installRoot, "releases"));
  assert.equal(paths.currentLink, null);
  assert.equal(paths.currentPointer, path.win32.join(installRoot, "current-version.json"));
  assert.equal(paths.programRoot, path.win32.join(localAppData, "Programs", "Equinox Local"));
  assert.equal(paths.transportConfigPath, path.win32.join(installRoot, "transport.json"));
  assert.equal(paths.runtimeKeyPath, path.win32.join(installRoot, "secrets", "openai-runtime-key"));
});

test("supervisor lifecycle fails closed for Windows before touching managed files", async () => {
  await assert.rejects(() => runManagedSupervisor({
    platform: "win32", arch: "x64", homeDir: "C:\\Users\\Example", sourceEnv: {},
  }), /not implemented for win32-x64/u);
});

test("managed supervisor resolves only the current target-specific release", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const release = await resolveSupervisorRelease(fixture.paths);
  assert.equal(release.version, "4.2.0");
  assert.equal(release.releaseDir, await fs.realpath(fixture.releaseDir));
  assert.equal(release.metadata.target, equinoxLocalUpdateTarget());
});

test("transport config is optional and requires a private fixed runtime key", async (t) => {
  const absent = await makeFixture();
  t.after(() => fs.rm(absent.root, { recursive: true, force: true }));
  assert.equal(await readSupervisorTransport(absent.paths), null);

  const configured = await makeFixture({ transport: true });
  t.after(() => fs.rm(configured.root, { recursive: true, force: true }));
  const transport = await readSupervisorTransport(configured.paths);
  assert.equal(transport.mode, "openai-tunnel");
  assert.equal(transport.tunnelId, "tunnel_0123456789abcdef0123456789abcdef");
  await fs.chmod(configured.paths.runtimeKeyPath, 0o644);
  await assert.rejects(readSupervisorTransport(configured.paths), /permissions/u);
});

test("Windows supervisor validates current-user runtime-key ACL, not POSIX mode bits", async (t) => {
  const fixture = await makeFixture({ transport: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const checked = [];
  const transport = await readSupervisorTransport(fixture.paths, {
    platform: "win32",
    verifyWindowsAcl: async ({ target, type }) => {
      checked.push({ target, type });
      return { safe: true };
    },
  });
  assert.equal(transport.tunnelId, "tunnel_0123456789abcdef0123456789abcdef");
  assert.deepEqual(checked, [{ target: fixture.paths.runtimeKeyPath, type: "file" }]);
  await assert.rejects(readSupervisorTransport(fixture.paths, {
    platform: "win32", verifyWindowsAcl: async () => ({ safe: false, reason: "foreign-user" }),
  }), /current-user protected/u);
});

test("supervisor child environment keeps managed paths but drops provider credentials", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const env = supervisorChildEnvironment({
    paths: fixture.paths,
    releaseDir: fixture.releaseDir,
    sourceEnv: {
      USER: "example",
      TMPDIR: "/tmp/example",
      EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE: "smoke-123",
      OPENAI_API_KEY: "must-not-leak",
      GITHUB_TOKEN: "must-not-leak",
    },
  });
  assert.equal(env.HOME, fixture.homeDir);
  assert.equal(env.EQUINOX_LOCAL_RELEASE_DIR, fixture.releaseDir);
  assert.equal(env.EQUINOX_PEEKABOO_PATH, path.join(fixture.releaseDir, "runtime", "peekaboo", "peekaboo"));
  assert.equal(env.USER, "example");
  assert.equal(env.EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE, "smoke-123");
  assert.equal("OPENAI_API_KEY" in env, false);
  assert.equal("GITHUB_TOKEN" in env, false);
});

test("tunnel profile init uses the fixed secret file and safely quoted managed command", async (t) => {
  const fixture = await makeFixture({ transport: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const transport = await readSupervisorTransport(fixture.paths);
  const args = tunnelInitArguments({ paths: fixture.paths, releaseDir: fixture.releaseDir, transport });
  assert.equal(args[0], "init");
  assert.equal(args.includes("--force"), true);
  assert.equal(args.includes(`file:${fixture.paths.runtimeKeyPath}`), true);
  const command = args[args.indexOf("--mcp-command") + 1];
  assert.match(command, /^'.*node' '.*server\.js'$/u);
  assert.equal(shellQuote("a'b"), `'a'\"'\"'b'`);
});

test("local-only mode keeps Control Center available before tunnel onboarding", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const children = [];
  const result = await runManagedSupervisor({
    homeDir: fixture.homeDir,
    sourceEnv: { EQUINOX_LOCAL_INSTALL_ROOT: fixture.paths.installRoot, USER: "example" },
    execFileImpl: async () => { throw new Error("must not initialize tunnel"); },
    runChildImpl: async (...args) => {
      children.push(args);
      return { code: 0, signal: null, terminatingSignal: "SIGTERM" };
    },
  });
  assert.equal(result.mode, "local-only");
  assert.equal(children.length, 1);
  const realReleaseDir = await fs.realpath(fixture.releaseDir);
  assert.equal(children[0][0], path.join(realReleaseDir, "runtime", "node", "bin", "node"));
  assert.deepEqual(children[0][1], [path.join(realReleaseDir, "server.js")]);
  assert.equal(children[0][2].stdio[0], "pipe");
  assert.equal(children[0][2].env.EQUINOX_LOCAL_RELEASE_DIR, fixture.releaseDir);
  assert.equal(children[0][2].env.EQUINOX_LOCAL_SUPERVISOR_MODE, "local-only");
});

test("managed supervisor runs canonical managed-source server bytes on Stable runtime Node", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const sourceRoot = path.join(fixture.paths.installRoot, "main-update", "sources", "a".repeat(40));
  const sourceServer = path.join(sourceRoot, "src", "server.js");
  await fs.mkdir(path.dirname(sourceServer), { recursive: true, mode: 0o700 });
  await fs.writeFile(sourceServer, "// managed source fixture\n");
  const children = [];
  const result = await runManagedSupervisor({
    homeDir: fixture.homeDir,
    sourceEnv: { EQUINOX_LOCAL_INSTALL_ROOT: fixture.paths.installRoot, USER: "example" },
    execFileImpl: async () => { throw new Error("must not initialize tunnel"); },
    resolveManagedSourceImpl: async ({ baseInstallation }) => Object.freeze({
      ...baseInstallation,
      kind: "managed-source",
      sourceRoot,
      sourceSha: "a".repeat(40),
    }),
    runChildImpl: async (...args) => {
      children.push(args);
      return { code: 0, signal: null, terminatingSignal: "SIGTERM" };
    },
  });
  assert.equal(result.mode, "local-only");
  assert.equal(children.length, 1);
  const realReleaseDir = await fs.realpath(fixture.releaseDir);
  assert.equal(children[0][0], path.join(realReleaseDir, "runtime", "node", "bin", "node"));
  assert.deepEqual(children[0][1], [sourceServer]);
  assert.equal(children[0][2].cwd, sourceRoot);
  assert.equal(children[0][2].env.EQUINOX_LOCAL_RELEASE_DIR, fixture.releaseDir);
});

test("configured tunnel mode materializes a profile and supervises the bundled tunnel runtime", async (t) => {
  const fixture = await makeFixture({ transport: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const initCalls = [];
  const children = [];
  const result = await runManagedSupervisor({
    homeDir: fixture.homeDir,
    sourceEnv: { EQUINOX_LOCAL_INSTALL_ROOT: fixture.paths.installRoot, USER: "example" },
    execFileImpl: async (...args) => initCalls.push(args),
    runChildImpl: async (...args) => {
      children.push(args);
      return { code: null, signal: "SIGTERM", terminatingSignal: "SIGTERM" };
    },
  });
  assert.equal(result.mode, "tunnel");
  assert.equal(initCalls.length, 1);
  const realReleaseDir = await fs.realpath(fixture.releaseDir);
  const tunnelBinary = path.join(realReleaseDir, "runtime", "tunnel", "tunnel-client");
  assert.equal(initCalls[0][0], tunnelBinary);
  assert.equal(children.length, 1);
  assert.equal(children[0][0], tunnelBinary);
  assert.deepEqual(children[0][1], ["run", "--profile", "equinox-local", "--profile-dir", fixture.paths.profileDir]);
  assert.equal(children[0][2].cwd, realReleaseDir);
  assert.equal(initCalls[0][2].cwd, realReleaseDir);
  assert.equal(children[0][2].env.EQUINOX_LOCAL_RELEASE_DIR, fixture.releaseDir);
  assert.equal(children[0][2].env.EQUINOX_LOCAL_SUPERVISOR_MODE, "tunnel");
});

test("malformed tunnel configuration fails closed to local-only mode", async (t) => {
  const fixture = await makeFixture({ malformedTransport: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  let tunnelInitCalls = 0;
  const result = await runManagedSupervisor({
    homeDir: fixture.homeDir,
    sourceEnv: { EQUINOX_LOCAL_INSTALL_ROOT: fixture.paths.installRoot },
    execFileImpl: async () => { tunnelInitCalls += 1; },
    runChildImpl: async () => ({ code: 0, signal: null, terminatingSignal: "SIGTERM" }),
  });
  assert.equal(result.mode, "local-only");
  assert.equal(tunnelInitCalls, 0);
});

test("supervisor child environment is a strict allowlist even with injected provider secrets and shell configuration", () => {
  const paths = managedSupervisorPaths("/fixture/safe-home");
  const sourceEnv = {
    USER:"fixture",LOGNAME:"fixture",LANG:"tr_TR.UTF-8",LC_ALL:"C",
    TMPDIR:"/fixture/tmp",SSH_AUTH_SOCK:"/fixture/ssh.socket",
    EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE:"fixture-agent-lane",
    OPENAI_API_KEY:"secret-fixture-key",GITHUB_TOKEN:"secret-fixture-token",
    AWS_SECRET_ACCESS_KEY:"secret-fixture-aws",NODE_OPTIONS:"--require /fixture/unsafe.js",
    NODE_PATH:"/fixture/unsafe-module",LD_PRELOAD:"/fixture/unsafe.so",
    DYLD_INSERT_LIBRARIES:"/fixture/unsafe.dylib",EQUINOX_LOCAL_SUPERVISOR_MODE:"tunnel",
    PATH:"/fixture/untrusted",
  };
  const env=supervisorChildEnvironment({paths,releaseDir:"/fixture/release",sourceEnv});
  assert.deepEqual(Object.keys(env).sort(),[
    "EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE","EQUINOX_LOCAL_INSTALL_ROOT",
    "EQUINOX_LOCAL_RELEASE_DIR","EQUINOX_PEEKABOO_PATH","HOME","LANG",
    "LC_ALL","LOGNAME","PATH","SSH_AUTH_SOCK","TMPDIR","USER",
  ].sort());
  assert.equal(env.PATH,"/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin");
  assert.equal(env.EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE,"fixture-agent-lane");
  assert.equal(Object.isFrozen(env),true);
  assert.doesNotMatch(JSON.stringify(env),/secret-fixture|unsafe/u);
});

test("supervisor transport refuses untrusted schema keys and invalid tunnel identifiers before using the runtime key", async (t) => {
  const fixture=await makeFixture({transport:true});
  t.after(()=>fs.rm(fixture.root,{recursive:true,force:true}));
  const invalid=[
    {version:1,mode:"openai-tunnel",tunnelId:"tunnel_"+'A'.repeat(32)},
    {version:2,mode:"openai-tunnel",tunnelId:"tunnel_"+'a'.repeat(32)},
    {version:1,mode:"other",tunnelId:"tunnel_"+'a'.repeat(32)},
    {version:1,mode:"openai-tunnel",tunnelId:"../../foreign"},
    {version:1,mode:"openai-tunnel",tunnelId:"tunnel_"+'a'.repeat(32),runtimeKey:"fixture-secret"},
    [],
    null,
  ];
  for(const data of invalid){
    await fs.writeFile(fixture.paths.transportConfigPath,JSON.stringify(data),{mode:0o600});
    let aclChecks=0;
    await assert.rejects(readSupervisorTransport(fixture.paths,{
      platform:"win32",verifyWindowsAcl:async()=>{aclChecks++;return {safe:true}},
    }),/configuration/u);
    assert.equal(aclChecks,0,"malformed transport must never inspect or grant key authority");
  }
  await fs.writeFile(fixture.paths.transportConfigPath,"x".repeat(16*1024+1),{mode:0o600});
  await assert.rejects(readSupervisorTransport(fixture.paths),/bounded normal file/u);
});

test("supervisor release pointer fails closed on foreign release directory, malformed metadata and unsafe binaries",async(t)=>{
  const fixture=await makeFixture();
  t.after(()=>fs.rm(fixture.root,{recursive:true,force:true}));
  const foreign=path.join(fixture.root,"unowned");
  await fs.mkdir(foreign);
  await fs.rm(fixture.paths.currentLink);
  await fs.symlink(foreign,fixture.paths.currentLink);
  await assert.rejects(resolveSupervisorRelease(fixture.paths),/escaped the releases root/u);
  await fs.rm(fixture.paths.currentLink);
  await fs.symlink("releases/4.2.0",fixture.paths.currentLink);
  const manifest=path.join(fixture.releaseDir,"release.json");
  for(const mutation of [
    {schemaVersion:1,version:"4.2.0",target:"darwin-unknown",serverEntry:"server.js"},
    {schemaVersion:1,version:"4.2.1",target:equinoxLocalUpdateTarget(),serverEntry:"server.js"},
    {schemaVersion:1,version:"4.2.0",target:equinoxLocalUpdateTarget(),serverEntry:"unauthorized.js"},
  ]){
    await fs.writeFile(manifest,JSON.stringify(mutation));
    await assert.rejects(resolveSupervisorRelease(fixture.paths),/metadata is invalid/u);
  }
  await fs.writeFile(manifest,JSON.stringify({
    schemaVersion:1,version:"4.2.0",target:equinoxLocalUpdateTarget(),serverEntry:"server.js",
  }));
  await fs.chmod(fixture.nodeBinary,0o600);
  await assert.rejects(resolveSupervisorRelease(fixture.paths),/must be executable/u);
  await fs.rm(fixture.nodeBinary);
  await fs.symlink("/bin/sh",fixture.nodeBinary);
  await assert.rejects(resolveSupervisorRelease(fixture.paths),/normal file/u);
});

test("supervisor rejects mismatched configured root and falls back to local-only after tunnel init error without retry",async(t)=>{
  const fixture=await makeFixture({transport:true});
  t.after(()=>fs.rm(fixture.root,{recursive:true,force:true}));
  let tunnelInit=0,localOnly=0,mutations=0;
  const opts={
    homeDir:fixture.homeDir,
    sourceEnv:{EQUINOX_LOCAL_INSTALL_ROOT:fixture.paths.installRoot,OPENAI_API_KEY:"fixture-credential"},
    resolveManagedSourceImpl:async({baseInstallation})=>baseInstallation,
    execFileImpl:async()=>{tunnelInit++;throw Error("controlled tunnel initialization failure")},
    runChildImpl:async(command,args,options)=>{
      mutations++;
      localOnly++;
      const realReleaseDir=await fs.realpath(fixture.releaseDir);
      assert.equal(command,path.join(realReleaseDir,"runtime","node","bin","node"));
      assert.deepEqual(args,[path.join(realReleaseDir,"server.js")]);
      assert.equal(options.env.EQUINOX_LOCAL_SUPERVISOR_MODE,"local-only");
      assert.equal(options.env.OPENAI_API_KEY,undefined);
      return {code:0,signal:null,terminatingSignal:null};
    },
  };
  await assert.rejects(runManagedSupervisor({...opts,sourceEnv:{
    EQUINOX_LOCAL_INSTALL_ROOT:path.join(fixture.root,"foreign"),
  }}),/does not match/u);
  assert.equal(mutations,0);
  const result=await runManagedSupervisor(opts);
  assert.equal(result.mode,"local-only");
  assert.equal(localOnly,1);
  assert.equal(tunnelInit,1,"failed tunnel initialization must not be replayed");
});

test("native Main supervisor selects exact active SHA B bytes with the existing signed admission instead of numbered Stable",async t=>{
 const f=await makeFixture({transport:true});
 t.after(()=>fs.rm(f.root,{recursive:true,force:true}));
 const sha="b".repeat(40);
 const target="darwin-"+process.arch;
 const native=path.join(f.paths.stateRoot,"main-update","native-store",target,sha,"release");
 await fs.mkdir(path.dirname(native),{recursive:true});
 await fs.cp(f.releaseDir,native,{recursive:true});
 await fs.writeFile(path.join(native,"release.json"),JSON.stringify({
  schemaVersion:1,version:"4.2.0",sourceSha:sha,target,
  serverEntry:"server.js",
 }));
 await fs.unlink(f.paths.currentLink);
 await fs.symlink(path.relative(f.paths.installRoot,native),f.paths.currentLink,"dir");
 const calls=[], children=[];
 const verify=async({baseInstallation})=>{
  calls.push(baseInstallation.releaseDir);
  assert.equal(baseInstallation.releaseDir,await fs.realpath(native));
  assert.equal(baseInstallation.target,target);
  return {...baseInstallation,kind:"managed-main",sourceSha:sha,mainNativeSha:sha,
   version:"4.2.0",releaseDir:baseInstallation.releaseDir};
 };
 const inspected=await resolveSupervisorRelease(f.paths,{resolveManagedSourceImpl:verify});
 assert.equal(inspected.releaseDir,await fs.realpath(native));
 assert.equal(inspected.nativeInstallation.sourceSha,sha);
 const result=await runManagedSupervisor({
  homeDir:f.homeDir,
  sourceEnv:{EQUINOX_LOCAL_INSTALL_ROOT:f.paths.installRoot,USER:"example"},
  resolveManagedSourceImpl:verify,
  execFileImpl:async(...args)=>calls.push(args),
  runChildImpl:async(...args)=>{children.push(args);return {code:0,signal:null,terminatingSignal:"SIGTERM"}},
 });
 assert.equal(result.mode,"tunnel");
 assert.equal(calls.length,3,"production auth before transport, once per supervisor startup");
 const nativeReal=await fs.realpath(native);
 assert.equal(children[0][0],path.join(nativeReal,"runtime","tunnel","tunnel-client"));
 assert.equal(children[0][2].env.EQUINOX_LOCAL_RELEASE_DIR,nativeReal);
 assert.equal(children[0][2].cwd,nativeReal);
 assert.equal(calls[2][0],path.join(nativeReal,"runtime","tunnel","tunnel-client"));
 const tunnelArgs=calls[2][1];
 const mcp=tunnelArgs[tunnelArgs.indexOf("--mcp-command")+1];
 assert.ok(mcp.includes(path.join(nativeReal,"runtime","node","bin","node")));
 assert.ok(mcp.includes(path.join(nativeReal,"server.js")));
 assert.equal(mcp.includes(path.join(f.releaseDir,"server.js")),false,"must not silently boot Stable A");
});

test("native Main supervisor refuses unsigned SHA alias and wrong source/version/architecture before launching",async t=>{
 const f=await makeFixture();
 t.after(()=>fs.rm(f.root,{recursive:true,force:true}));
 const sha="c".repeat(40);
 const native=path.join(f.paths.stateRoot,"main-update","native-store","darwin-"+process.arch,sha,"release");
 await fs.mkdir(path.dirname(native),{recursive:true});
 await fs.cp(f.releaseDir,native,{recursive:true});
 await fs.writeFile(path.join(native,"release.json"),JSON.stringify({
  schemaVersion:1,version:"4.2.0",target:"darwin-"+process.arch,sourceSha:sha,serverEntry:"server.js",
 }));
 await fs.unlink(f.paths.currentLink);
 await fs.symlink(path.relative(f.paths.installRoot,native),f.paths.currentLink);
 const unsigned=async()=>({kind:"managed",releaseDir:native});
 await assert.rejects(resolveSupervisorRelease(f.paths,{resolveManagedSourceImpl:unsigned}),/not admitted/u);
 // The actual production verifier must not admit the synthetic unsigned B.
 await assert.rejects(resolveSupervisorRelease(f.paths),/no verified Main install stamp|signed native selector|native Main runtime|state directory is not private/u);
 let attempts=0;
 const admitted=async({baseInstallation})=>{
  attempts++;
  return {...baseInstallation,kind:"managed-main",sourceSha:sha,mainNativeSha:sha,version:"4.2.0"};
 };
 assert.equal((await resolveSupervisorRelease(f.paths,{resolveManagedSourceImpl:admitted})).releaseDir,await fs.realpath(native));
 for(const change of [
  {sourceSha:"d".repeat(40)},
  {mainNativeSha:"d".repeat(40)},
  {version:"4.2.1"},
  {releaseDir:path.join(f.paths.releasesRoot,"4.2.0")},
 ]){
  await assert.rejects(resolveSupervisorRelease(f.paths,{
   resolveManagedSourceImpl:async({baseInstallation})=>({...baseInstallation,kind:"managed-main",
    sourceSha:sha,mainNativeSha:sha,version:"4.2.0",...change}),
  }),/not admitted|metadata is invalid/u);
 }
 await fs.writeFile(path.join(native,"release.json"),JSON.stringify({
  schemaVersion:1,version:"4.2.0",sourceSha:"d".repeat(40),target:"darwin-"+process.arch,serverEntry:"server.js",
 }));
 await assert.rejects(resolveSupervisorRelease(f.paths,{resolveManagedSourceImpl:admitted}),/metadata is invalid/u);
 await fs.unlink(f.paths.currentLink);
 const foreign=path.join(f.root,"foreign");
 await fs.mkdir(foreign);
 await fs.symlink(foreign,f.paths.currentLink);
 await assert.rejects(resolveSupervisorRelease(f.paths,{resolveManagedSourceImpl:async()=>assert.fail("foreign path must not resolve")}),/escaped the releases root/u);
});
