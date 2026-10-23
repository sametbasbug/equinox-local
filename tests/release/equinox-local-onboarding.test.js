import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  configureManagedTunnel,
  getManagedOnboardingStatus,
  initializeManagedOnboardingState,
  recordManagedAgentCommand,
  validateTunnelOnboardingInput,
} from "../../src/equinox-local-onboarding.js";
import { managedSupervisorPaths } from "../../src/equinox-local-supervisor.js";

const TUNNEL_ID = "tunnel_0123456789abcdef0123456789abcdef";
const RUNTIME_KEY = "runtime-secret-value-0123456789";

async function makeManagedFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-onboarding-"));
  const homeDir = path.join(root, "Home With Space");
  const paths = managedSupervisorPaths(homeDir);
  const releaseDir = path.join(paths.releasesRoot, "4.2.0");
  await fs.mkdir(releaseDir, { recursive: true });
  return {
    root,
    homeDir,
    paths,
    installation: {
      managed: true,
      selfUpdateSupported: true,
      installRoot: paths.installRoot,
      releaseDir,
    },
  };
}

test("tunnel onboarding accepts only the documented tunnel id shape and opaque bounded key", () => {
  const input = validateTunnelOnboardingInput({ tunnelId: TUNNEL_ID, runtimeKey: RUNTIME_KEY });
  assert.equal(input.tunnelId, TUNNEL_ID);
  assert.equal(input.runtimeKey, RUNTIME_KEY);
  assert.throws(
    () => validateTunnelOnboardingInput({ tunnelId: "tunnel_zz23456789abcdef0123456789abcdef", runtimeKey: RUNTIME_KEY }),
    /lowercase hexadecimal/u,
  );
  assert.throws(
    () => validateTunnelOnboardingInput({ tunnelId: TUNNEL_ID, runtimeKey: ` ${RUNTIME_KEY}` }),
    /whitespace/u,
  );
  assert.throws(
    () => validateTunnelOnboardingInput({ tunnelId: TUNNEL_ID, runtimeKey: RUNTIME_KEY, extra: true }),
    /only tunnelId and runtimeKey/u,
  );
});

test("managed tunnel configuration stores the secret privately and status never returns it", async (t) => {
  const fixture = await makeManagedFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));

  const result = await configureManagedTunnel({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    tunnelId: TUNNEL_ID,
    runtimeKey: RUNTIME_KEY,
  });
  assert.deepEqual(result, { configured: true, tunnelId: TUNNEL_ID, restartRequired: true });
  assert.equal(await fs.readFile(fixture.paths.runtimeKeyPath, "utf8"), RUNTIME_KEY);
  assert.equal((await fs.lstat(fixture.paths.runtimeKeyPath)).mode & 0o077, 0);
  assert.equal((await fs.lstat(fixture.paths.transportConfigPath)).mode & 0o077, 0);

  const localOnly = await getManagedOnboardingStatus({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    supervisorMode: "local-only",
  });
  assert.equal(localOnly.transportConfigured, true);
  assert.equal(localOnly.tunnelId, TUNNEL_ID);
  assert.equal(localOnly.connectedThroughTunnel, false);
  assert.equal(localOnly.needsAttention, true);
  assert.equal(JSON.stringify(localOnly).includes(RUNTIME_KEY), false);

  const tunnel = await getManagedOnboardingStatus({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    supervisorMode: "tunnel",
  });
  assert.equal(tunnel.connectedThroughTunnel, true);
  assert.equal(tunnel.needsAttention, false);
  assert.equal(JSON.stringify(tunnel).includes(RUNTIME_KEY), false);
});

test("source checkout onboarding reports unavailable without touching disk", async () => {
  const status = await getManagedOnboardingStatus({
    installation: { managed: false, selfUpdateSupported: false },
    homeDir: "/Users/example",
  });
  assert.equal(status.available, false);
  assert.equal(status.supervisorMode, "source");
});


test("first agent command milestone records only for a configured managed tunnel", async (t) => {
  const fixture = await makeManagedFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await initializeManagedOnboardingState({ installation: fixture.installation, homeDir: fixture.homeDir });

  const localOnly = await recordManagedAgentCommand({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    supervisorMode: "local-only",
    now: () => Date.parse("2026-09-20T12:00:00.000Z"),
  });
  assert.equal(localOnly.recorded, false);

  await configureManagedTunnel({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    tunnelId: TUNNEL_ID,
    runtimeKey: RUNTIME_KEY,
  });
  const recorded = await recordManagedAgentCommand({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    supervisorMode: "tunnel",
    now: () => Date.parse("2026-09-20T12:01:02.000Z"),
  });
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.firstAgentCommandAt, "2026-09-20T12:01:02.000Z");
  assert.equal((await fs.lstat(fixture.paths.onboardingStatePath)).mode & 0o077, 0);

  const repeated = await recordManagedAgentCommand({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    supervisorMode: "tunnel",
    now: () => Date.parse("2026-09-20T12:05:00.000Z"),
  });
  assert.equal(repeated.recorded, false);
  assert.equal(repeated.reason, "already-recorded");
  assert.equal(repeated.firstAgentCommandAt, "2026-09-20T12:01:02.000Z");
});

test("setup completes durably only after tunnel, required Browser state and first agent command", async (t) => {
  const fixture = await makeManagedFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await initializeManagedOnboardingState({ installation: fixture.installation, homeDir: fixture.homeDir });
  await configureManagedTunnel({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    tunnelId: TUNNEL_ID,
    runtimeKey: RUNTIME_KEY,
  });

  let status = await getManagedOnboardingStatus({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    supervisorMode: "tunnel",
    browserUser: { ready: true, consentAccepted: true, controlEnabled: true },
    reconcileCompletion: true,
    now: () => Date.parse("2026-09-20T12:00:00.000Z"),
  });
  assert.equal(status.setupComplete, false);
  assert.equal(status.agentCommandReceived, false);

  await recordManagedAgentCommand({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    supervisorMode: "tunnel",
    now: () => Date.parse("2026-09-20T12:01:00.000Z"),
  });

  status = await getManagedOnboardingStatus({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    supervisorMode: "tunnel",
    browserUser: { ready: true, consentAccepted: true, controlEnabled: false },
    reconcileCompletion: true,
    now: () => Date.parse("2026-09-20T12:02:00.000Z"),
  });
  assert.equal(status.setupComplete, false);
  assert.equal(status.browserControlEnabled, false);
  assert.equal(status.firstAgentCommandAt, "2026-09-20T12:01:00.000Z");

  status = await getManagedOnboardingStatus({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    supervisorMode: "tunnel",
    browserUser: { ready: true, consentAccepted: true, controlEnabled: true },
    reconcileCompletion: true,
    now: () => Date.parse("2026-09-20T12:03:00.000Z"),
  });
  assert.equal(status.setupComplete, true);
  assert.equal(status.completedAt, "2026-09-20T12:03:00.000Z");

  const laterFailure = await getManagedOnboardingStatus({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    supervisorMode: "local-only",
    browserUser: { ready: false, consentAccepted: false, controlEnabled: false },
    reconcileCompletion: true,
    now: () => Date.parse("2026-09-20T12:10:00.000Z"),
  });
  assert.equal(laterFailure.setupComplete, true);
  assert.equal(laterFailure.completedAt, "2026-09-20T12:03:00.000Z");
  assert.equal(laterFailure.connectedThroughTunnel, false);
});


test("managed installs upgraded from before setup-state persistence are treated as legacy complete", async (t) => {
  const fixture = await makeManagedFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const status = await getManagedOnboardingStatus({
    installation: fixture.installation,
    homeDir: fixture.homeDir,
    supervisorMode: "local-only",
    browserUser: { ready: false, consentAccepted: false, controlEnabled: false },
    reconcileCompletion: true,
  });
  assert.equal(status.setupComplete, true);
  assert.equal(status.legacyCompleted, true);
  assert.equal(await fs.stat(fixture.paths.onboardingStatePath).then(() => true).catch((error) => error?.code === "ENOENT" ? false : Promise.reject(error)), false);
});

test("managed onboarding rejects malformed keys and tunnel IDs before creating private state", async(t)=>{
  const fixture=await makeManagedFixture();
  t.after(()=>fs.rm(fixture.root,{recursive:true,force:true}));
  const bodies=[
    null,[],{},"text",
    {tunnelId:TUNNEL_ID,runtimeKey:RUNTIME_KEY,extra:"secret"},
    {tunnelId:TUNNEL_ID.toUpperCase(),runtimeKey:RUNTIME_KEY},
    {tunnelId:TUNNEL_ID,runtimeKey:"short"},
    {tunnelId:TUNNEL_ID,runtimeKey:" "+RUNTIME_KEY},
    {tunnelId:TUNNEL_ID,runtimeKey:RUNTIME_KEY+"\n"},
    {tunnelId:TUNNEL_ID,runtimeKey:"x".repeat(4097)},
    {tunnelId:TUNNEL_ID,runtimeKey:42},
  ];
  for(const body of bodies)assert.throws(()=>validateTunnelOnboardingInput(body),Error);
  for(const runtimeKey of ["short"," "+RUNTIME_KEY,RUNTIME_KEY+"\n","x".repeat(4097)]){
    await assert.rejects(configureManagedTunnel({
      installation:fixture.installation,homeDir:fixture.homeDir,
      tunnelId:TUNNEL_ID,runtimeKey,
    }),Error);
  }
  for(const target of [fixture.paths.runtimeKeyPath,fixture.paths.transportConfigPath]){
    await assert.rejects(fs.lstat(target),{code:"ENOENT"});
  }
  assert.equal(Object.hasOwn(Object.prototype,"runtimeKey"),false);
});

test("managed onboarding rejects non-managed or foreign install roots without creating configuration",async(t)=>{
  const fixture=await makeManagedFixture();
  t.after(()=>fs.rm(fixture.root,{recursive:true,force:true}));
  for(const installation of [
    {...fixture.installation,managed:false},
    {...fixture.installation,selfUpdateSupported:false},
    {...fixture.installation,installRoot:path.join(fixture.root,"unowned")},
  ]){
    await assert.rejects(configureManagedTunnel({
      installation,homeDir:fixture.homeDir,tunnelId:TUNNEL_ID,runtimeKey:RUNTIME_KEY,
    }),Error);
    await assert.rejects(initializeManagedOnboardingState({
      installation,homeDir:fixture.homeDir,
    }),Error);
  }
  await assert.rejects(fs.lstat(fixture.paths.runtimeKeyPath),{code:"ENOENT"});
  await assert.rejects(fs.lstat(fixture.paths.transportConfigPath),{code:"ENOENT"});
  await assert.rejects(fs.lstat(fixture.paths.onboardingStatePath),{code:"ENOENT"});
});

test("managed onboarding never treats corrupt or symlinked state as legacy complete",async(t)=>{
  const fixture=await makeManagedFixture();
  t.after(()=>fs.rm(fixture.root,{recursive:true,force:true}));
  await fs.mkdir(path.dirname(fixture.paths.onboardingStatePath),{recursive:true});
  const outsider=path.join(fixture.root,"synthetic-outside.txt");
  await fs.writeFile(outsider,"synthetic-not-a-secret",{mode:0o600});
  for(const payload of [
    "{",
    JSON.stringify({version:99,firstAgentCommandAt:null,completedAt:null}),
    JSON.stringify({version:1,firstAgentCommandAt:"bad-date",completedAt:null}),
    JSON.stringify({version:1,firstAgentCommandAt:null,completedAt:null,unexpected:"fixture"}),
  ]){
    await fs.writeFile(fixture.paths.onboardingStatePath,payload,{mode:0o600});
    await assert.rejects(getManagedOnboardingStatus({
      installation:fixture.installation,homeDir:fixture.homeDir,
    }),/Existing onboarding .* is invalid/u);
    await assert.rejects(initializeManagedOnboardingState({
      installation:fixture.installation,homeDir:fixture.homeDir,
    }),/Existing onboarding .* is invalid/u);
    assert.equal(await fs.readFile(fixture.paths.onboardingStatePath,"utf8"),payload);
  }
  await fs.rm(fixture.paths.onboardingStatePath);
  await fs.symlink(outsider,fixture.paths.onboardingStatePath);
  await assert.rejects(getManagedOnboardingStatus({
    installation:fixture.installation,homeDir:fixture.homeDir,
  }),/Existing onboarding file is unsafe/u);
  await assert.rejects(initializeManagedOnboardingState({
    installation:fixture.installation,homeDir:fixture.homeDir,
  }),/Existing onboarding file is unsafe/u);
  assert.equal(await fs.readFile(outsider,"utf8"),"synthetic-not-a-secret");
});

test("managed onboarding requires all Browser consent milestones and never returns runtime key",async(t)=>{
  const fixture=await makeManagedFixture();
  t.after(()=>fs.rm(fixture.root,{recursive:true,force:true}));
  await initializeManagedOnboardingState({installation:fixture.installation,homeDir:fixture.homeDir});
  await configureManagedTunnel({
    installation:fixture.installation,homeDir:fixture.homeDir,
    tunnelId:TUNNEL_ID,runtimeKey:RUNTIME_KEY,
  });
  await recordManagedAgentCommand({
    installation:fixture.installation,homeDir:fixture.homeDir,
    supervisorMode:"tunnel",now:()=>Date.parse("2026-10-20T00:00:00.000Z"),
  });
  const conditions=[
    {ready:false,consentAccepted:true,controlEnabled:true},
    {ready:true,consentAccepted:false,controlEnabled:true},
    {ready:true,consentAccepted:true,controlEnabled:false},
  ];
  for(const browserUser of conditions){
    const status=await getManagedOnboardingStatus({
      installation:fixture.installation,homeDir:fixture.homeDir,
      supervisorMode:"tunnel",browserUser,reconcileCompletion:true,
      now:()=>Date.parse("2026-10-20T00:01:00.000Z"),
    });
    assert.equal(status.setupComplete,false);
    assert.equal(status.completedAt,null);
    assert.equal(JSON.stringify(status).includes(RUNTIME_KEY),false);
  }
  const status=await getManagedOnboardingStatus({
    installation:fixture.installation,homeDir:fixture.homeDir,
    supervisorMode:"tunnel",
    browserUser:{ready:true,consentAccepted:true,controlEnabled:true},
    reconcileCompletion:true,
    now:()=>Date.parse("2026-10-20T00:03:00.000Z"),
  });
  assert.equal(status.setupComplete,true);
  assert.equal(status.completedAt,"2026-10-20T00:03:00.000Z");
  assert.equal(JSON.stringify(status).includes(RUNTIME_KEY),false);
  assert.deepEqual(JSON.parse(await fs.readFile(fixture.paths.onboardingStatePath,"utf8")),{
    version:1,firstAgentCommandAt:"2026-10-20T00:00:00.000Z",
    completedAt:"2026-10-20T00:03:00.000Z",
  });
  assert.equal((await fs.stat(fixture.paths.onboardingStatePath)).mode&0o077,0);
});
