import assert from "node:assert/strict";
import { execFile as callbackExecFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createEquinoxLocalControlApi } from "../../src/equinox-local-control-api.js";
import { createEquinoxLocalMainApplyController } from "../../src/equinox-local-main-apply-controller.js";
import { prepareAndScheduleEquinoxLocalMainUpdate } from "../../src/equinox-local-main-update-coordinator.js";
import { createEquinoxLocalMainUpdateTransactionEngine } from "../../src/equinox-local-main-update-transaction.js";
import { runEquinoxLocalMainUpdateHandoff } from "../../src/equinox-local-main-update-handoff.js";
import { readEquinoxLocalMainSourcePointer } from "../../src/equinox-local-main-source-pointer.js";
import { EQUINOX_LOCAL_MAIN_REMOTE } from "../../src/equinox-local-main-update.js";

const execFile = promisify(callbackExecFile);
const DIGEST = "d".repeat(64);

async function git(args, options = {}) {
  return await execFile("git", args, { timeout: 12_000, maxBuffer: 1_000_000, windowsHide: true, ...options });
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "equinox-main-api-handoff-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "active");
  const transactionRoot = path.join(root, "main-update");
  const remoteRoot = path.join(root, "remote.git");
  await fs.mkdir(sourceRoot);
  await git(["init", "-b", "main", sourceRoot]);
  await git(["-C", sourceRoot, "config", "user.name", "Equinox acceptance"]);
  await git(["-C", sourceRoot, "config", "user.email", "acceptance@example.invalid"]);
  await fs.writeFile(path.join(sourceRoot, "fixture.txt"), "version-A\n");
  await git(["-C", sourceRoot, "add", "fixture.txt"]);
  await git(["-C", sourceRoot, "commit", "-qm", "admitted source A"]);
  const { stdout: rawA } = await git(["-C", sourceRoot, "rev-parse", "HEAD"]);
  const A = rawA.trim();
  await fs.writeFile(path.join(sourceRoot, "fixture.txt"), "version-B\n");
  await git(["-C", sourceRoot, "commit", "-qam", "admitted source B"]);
  const { stdout: rawB } = await git(["-C", sourceRoot, "rev-parse", "HEAD"]);
  const B = rawB.trim();
  await git(["clone", "--bare", sourceRoot, remoteRoot]);
  await git(["-C", sourceRoot, "reset", "--hard", A]);
  await git(["-C", sourceRoot, "remote", "add", "origin", EQUINOX_LOCAL_MAIN_REMOTE]);
  const gitForLocalAdmission = async (command, args, options) => {
    if (command === "git" && args[0] === "clone" && args.includes(EQUINOX_LOCAL_MAIN_REMOTE)) {
      const rewritten = args.map((item) => item === EQUINOX_LOCAL_MAIN_REMOTE ? remoteRoot : item);
      const result = await git(rewritten, options);
      await git(["-C", args.at(-1), "remote", "set-url", "origin", EQUINOX_LOCAL_MAIN_REMOTE]);
      return result;
    }
    return await execFile(command, args, { timeout: 12_000, maxBuffer: 1_000_000, windowsHide: true, ...options });
  };
  const engine = createEquinoxLocalMainUpdateTransactionEngine({
    sourceRoot, transactionRoot, execFileImpl: gitForLocalAdmission,
    installDependencies: async () => {},
    validateStagedSource: async ({ stagedSourceRoot }) => {
      assert.equal(await fs.readFile(path.join(stagedSourceRoot, "fixture.txt"), "utf8"), "version-B\n");
    },
  });
  return { root, sourceRoot, transactionRoot, A, B, engine, gitForLocalAdmission };
}

for (const nativeMode of ["reuse_native", "artifact_required"]) {
for (const failure of [false, true]) {
  test(`loopback Control Center ${nativeMode} Main check/apply -> exact Git A→B -> ${failure ? "verified A rollback" : "healthy B"}`, async (t) => {
    const f = await fixture(t);
    const events = [];
    let checked = false;
    let handoff = null;
    let nativeSha = f.A;
    let nativeArtifactStaged = false;
    const discovery = { snapshot: () => checked ? {
      checkSupported: true, state: "behind", currentSha: f.A, targetSha: f.B,
      dirty: false, remoteCanonical: true,
    } : { checkSupported: true, state: "unavailable" } };
    const controller = createEquinoxLocalMainApplyController({
      installation: {
        kind: "managed-source", mainUpdateSupported: true,
        sourceRoot: f.sourceRoot, mainTransactionRoot: f.transactionRoot, gitPath: "git",
        nodePath: process.execPath, npmPath: path.join(f.root, "toolchain", "npm-cli.js"),
      },
      discovery,
      applyImpl: async (value) => prepareAndScheduleEquinoxLocalMainUpdate({
        ...value,
        engineFactory: () => f.engine,
        resolveHostTarget: () => process.platform === "win32" ? `win32-${process.arch}` : `darwin-${process.arch}`,
        planNativeTransition: async ({ currentSha, targetSha }) => {
          assert.equal(currentSha, f.A); assert.equal(targetSha, f.B);
          events.push(nativeMode);
          return {
            mode: nativeMode, target: process.platform === "win32" ? `win32-${process.arch}` : `darwin-${process.arch}`,
            currentSha: f.A, targetSha: f.B, currentRuntimeContractSha256: DIGEST,
            targetRuntimeContractSha256: nativeMode === "reuse_native" ? DIGEST : "e".repeat(64),
          };
        },
        stageNativeArtifact: async ({ sourceSha, transactionId, transactionRoot }) => {
          assert.equal(nativeMode, "artifact_required");
          assert.equal(sourceSha, f.B);
          assert.equal(transactionRoot, f.transactionRoot);
          const marker = path.join(transactionRoot, "staging", transactionId, "admitted-native-artifact.json");
          await fs.writeFile(marker, JSON.stringify({ sourceSha, target: process.arch }));
          nativeArtifactStaged = true;
          events.push("stage-native");
        },
        scheduleWorker: async (value) => { handoff = value; events.push("durable-handoff"); return { scheduled: true }; },
      }),
    });
    const api = createEquinoxLocalControlApi({
      port: 0,
      configManager: { snapshot: () => ({ revision: "a".repeat(64), config: {} }), replacePersisted: async () => ({}) },
      getUpdateStatus: async () => ({ installationKind: "managed-source", main: { ...discovery.snapshot(), ...controller.snapshot() } }),
      checkForUpdates: async () => { checked = true; events.push("check"); return { installationKind: "managed-source", main: { ...discovery.snapshot(), ...controller.snapshot() } }; },
      applyUpdate: async () => {
        try { return await controller.apply(); }
        catch (error) {
          // This is a scratch-only CI acceptance fixture: surface the exact
          // internal failure instead of a generic HTTP 500 for diagnosis.
          console.error("Main acceptance update apply failed:", error?.message ?? error);
          throw error;
        }
      },
    });
    const { port } = await api.start();
    t.after(() => api.close());
    const origin = `http://127.0.0.1:${port}`;
    const get = async (route) => (await fetch(`${origin}${route}`)).json();
    const session = await get("/api/v1/session");
    const mutate = async (route, headers = {}) => fetch(`${origin}${route}`, {
      method: "POST", headers: { "content-type": "application/json", origin, "x-equinox-csrf": session.csrfToken, ...headers }, body: "{}",
    });
    const rejected = await mutate("/api/v1/update/apply", { "x-equinox-csrf": "invalid" });
    assert.equal(rejected.status, 403, "real Control Center must reject missing/foreign CSRF");
    assert.equal((await get("/api/v1/update")).update.main.applyAvailable, false);
    assert.equal((await mutate("/api/v1/update/check")).status, 200);
    assert.equal((await get("/api/v1/update")).update.main.applyAvailable, true);
    const submitted = await mutate("/api/v1/update/apply");
    assert.equal(submitted.status, 202);
    const scheduled = (await submitted.json()).result;
    assert.equal(scheduled.targetSha, f.B);
    assert.equal(scheduled.currentSha, f.A);
    assert.equal(scheduled.nativeTransition.mode, nativeMode);
    assert.equal(nativeArtifactStaged, nativeMode === "artifact_required");
    assert.equal(controller.snapshot().restartScheduledFor, f.B);
    assert.equal(handoff.sourceRoot, f.sourceRoot);
    assert.equal(handoff.transactionRoot, f.transactionRoot);
    const pointerPath = f.engine.paths.sourcePointerPath;
    let pointer = await readEquinoxLocalMainSourcePointer(pointerPath, { execFileImpl: f.gitForLocalAdmission });
    assert.equal(pointer.sha, f.A, "scheduling must not switch source before handoff");
    const runtime = { sha: f.A, state: "HEALTHY" };
    if (nativeMode === "artifact_required") await f.engine.markNativeRollbackReady(scheduled.transactionId);
    const nativeLifecycle = nativeMode === "reuse_native" ? null : {
      activate: async () => { nativeSha = f.B; events.push("native-B"); },
      rollback: async () => { nativeSha = f.A; events.push("native-A"); },
      commit: async () => { assert.equal(nativeSha, f.B); events.push("native-commit"); },
    };
    const result = await runEquinoxLocalMainUpdateHandoff({
      nativeLifecycle,
      engine: f.engine, transactionId: scheduled.transactionId,
      restartRuntime: async ({ sha, rollback }) => {
        pointer = await readEquinoxLocalMainSourcePointer(pointerPath, { execFileImpl: f.gitForLocalAdmission });
        assert.equal(pointer.sha, sha);
        runtime.sha = pointer.sha;
        // A fresh child process validates the durable exact pointer and the
        // Git checkout actually selected by the supervisor's source identity.
        const probe = String.raw`const fs=require("node:fs"),cp=require("node:child_process"); const lines=fs.readFileSync(process.argv[1],"utf8").trim().split(/\r?\n/);const fields=Object.fromEntries(lines.map(x=>x.split("=")));const sha=cp.execFileSync("git",["-C",fields.sourceRoot,"rev-parse","HEAD"],{encoding:"utf8"}).trim();const content=fs.readFileSync(require("node:path").join(fields.sourceRoot,"fixture.txt"),"utf8"); process.stdout.write(JSON.stringify({sha,content,health:"HEALTHY"}));`;
        const { stdout } = await execFile(process.execPath, ["-e", probe, pointerPath], { timeout: 10_000, windowsHide: true });
        const measured = JSON.parse(stdout);
        assert.equal(measured.sha, pointer.sha);
        assert.equal(measured.content, rollback ? "version-A\n" : "version-B\n");
        runtime.state = measured.health;
        events.push(rollback ? "restart-A" : "restart-B");
      },
      verifyRuntime: async ({ sha, rollback }) => {
        assert.equal(runtime.sha, sha);
        assert.equal(runtime.state, "HEALTHY");
        events.push(rollback ? "health-A" : "health-B");
        return rollback || !failure;
      },
    });
    assert.equal(result.status, failure ? "rolled_back" : "succeeded");
    assert.equal(runtime.state, "HEALTHY");
    assert.equal(nativeSha, failure || nativeMode === "reuse_native" ? f.A : f.B);
    assert.equal(runtime.sha, failure ? f.A : f.B);
    assert.equal((await readEquinoxLocalMainSourcePointer(pointerPath, { execFileImpl: f.gitForLocalAdmission })).sha, failure ? f.A : f.B);
    assert.equal((await f.engine.readActive()), null);
    const receipt = await f.engine.readReceipt(scheduled.transactionId);
    assert.equal(receipt.status, failure ? "rolled_back" : "succeeded");
    const beforeHandoff = ["check", nativeMode, ...(nativeMode === "artifact_required" ? ["stage-native"] : []), "durable-handoff"];
    const activation = nativeMode === "artifact_required" ? ["native-B"] : [];
    const recovery = nativeMode === "artifact_required" ? ["native-A"] : [];
    const commit = nativeMode === "artifact_required" ? ["native-commit"] : [];
    assert.deepEqual(events, failure
      ? [...beforeHandoff, ...activation, "restart-B", "health-B", ...recovery, "restart-A", "health-A"]
      : [...beforeHandoff, ...activation, "restart-B", "health-B", ...commit]);
  });
}

}
