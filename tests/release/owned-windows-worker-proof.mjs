// Fixed, disposable real installed-host IPC witness. It neither updates nor
// impersonates any process and never accepts arbitrary user commands.
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
const productProofModule = process.env.EQUINOX_LOCAL_TEST_PROOF_MODULE;
if (!productProofModule) throw new Error('Hosted IPC witness module path is missing.');
const { startEquinoxWindowsMainWorkerProof } = await import(pathToFileURL(productProofModule).href);
await startEquinoxWindowsMainWorkerProof({
  transactionId: process.env.EQUINOX_LOCAL_TEST_WORKER_TX,
  workerToken: process.env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN,
});

// Disposable real-OS evidence: ONLY a test-owned trigger permits the exact
// worker PID to answer the separate Guardian authority challenge. No journal
// state advancement or WPF mutation is performed by the witness.
const trigger = process.env.EQUINOX_LOCAL_TEST_JOURNAL_TRIGGER;
const abortTrigger = process.env.EQUINOX_LOCAL_TEST_JOURNAL_ABORT_TRIGGER;
const shellTrigger = process.env.EQUINOX_LOCAL_TEST_WPF_QUIESCE_TRIGGER;
const integratedTrigger = process.env.EQUINOX_LOCAL_TEST_INTEGRATED_AB_TRIGGER;
// Unlike earlier PowerShell-owned hosted fixtures, launch the actual native
// Guardian from the SAME OS-owned product Node worker. The fixed product
// launcher checks the trusted installed binary against the Stable release;
// Guardian STILL independently admits PID/birthtime/argv/SID/LUID/HMAC/lease.
// This is hosted-only; it is NOT a production Main supervisor capability.
const guardianSpawnTrigger = process.env.EQUINOX_LOCAL_TEST_GUARDIAN_SPAWN_TRIGGER;
if (guardianSpawnTrigger) {
  const pidReceipt = process.env.EQUINOX_LOCAL_TEST_GUARDIAN_PID_RECEIPT;
  const launcherModule = process.env.EQUINOX_LOCAL_TEST_GUARDIAN_LAUNCH_MODULE;
  if (!pidReceipt || !launcherModule || process.env.GITHUB_ACTIONS !== 'true') {
    throw new Error('Hosted native Guardian launch lacks its fixed isolated fixture inputs.');
  }
  const bootTimer = setInterval(() => {
    if (!fs.existsSync(guardianSpawnTrigger)) return;
    clearInterval(bootTimer);
    void (async () => {
      const path = await import('node:path');
      const txRoot = process.env.EQUINOX_LOCAL_TEST_JOURNAL_TX_ROOT;
      const installRoot = path.win32.join(process.env.LOCALAPPDATA, 'Equinox Local');
      const releaseDir = path.win32.join(installRoot, 'releases', process.env.EQUINOX_LOCAL_TEST_GUARDIAN_STABLE_VERSION);
      const { launchEquinoxLocalWindowsNativeMainGuardian } = await import(pathToFileURL(launcherModule).href);
      const launched = await launchEquinoxLocalWindowsNativeMainGuardian({
        transactionId: process.env.EQUINOX_LOCAL_TEST_WORKER_TX,
        transactionRoot: txRoot,
        currentSha: process.env.EQUINOX_LOCAL_TEST_AB_CURRENT_SHA,
        targetSha: process.env.EQUINOX_LOCAL_TEST_AB_TARGET_SHA,
        workerToken: process.env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN,
        installation: { managed: true, selfUpdateSupported: true, target: process.env.EQUINOX_LOCAL_TEST_GUARDIAN_TARGET,
          installRoot, releaseDir },
      });
      fs.writeFileSync(pidReceipt, `${launched.guardianPid}\n`, { flag: 'wx' });
    })().catch((error) => {
      const diagnostic = process.env.EQUINOX_LOCAL_TEST_AB_DIAGNOSTIC_FILE;
      const kind = String(error?.name ?? 'error').slice(0, 45);
      if (diagnostic) try { fs.appendFileSync(diagnostic, `guardian-launch:${kind}\n`); } catch { }
      console.error('Hosted fixed native Guardian launch refused:', kind);
      process.exitCode = 1;
    });
  }, 90);
  bootTimer.unref();
}
for (const source of [trigger, abortTrigger, shellTrigger, integratedTrigger].filter(Boolean)) {
  const clientModule = process.env.EQUINOX_LOCAL_TEST_JOURNAL_CLIENT_MODULE;
  if (!clientModule) throw new Error('Test worker journal client module is missing.');
  const { proveEquinoxWindowsNativeJournalAuthority } = await import(pathToFileURL(clientModule).href);
  const timer = setInterval(() => {
    if (!fs.existsSync(source)) return;
    clearInterval(timer);
    const root = process.env.EQUINOX_LOCAL_TEST_JOURNAL_TX_ROOT;
    const tx = process.env.EQUINOX_LOCAL_TEST_WORKER_TX;
    const token = process.env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN;
    // The Guardian might not yet have called CreateNamedPipe. A tightly
    // bounded retry is test orchestration only; never retry a journal write.
    void (async () => {
      let proved = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          await proveEquinoxWindowsNativeJournalAuthority({transactionId: tx, transactionRoot: root, workerToken: token});
          proved = true;
          if (source === integratedTrigger) {
            const modulePath = process.env.EQUINOX_LOCAL_TEST_AB_CLIENT_MODULE;
            if (!modulePath) throw new Error('Product native A/B slot client module is missing.');
            const { runEquinoxLocalWindowsGuardianOwnedSlot } = await import(pathToFileURL(modulePath).href);
            // The owner Guardian now independently advances the two durable
            // milestones, then grants the existing shared JS A/B swap. This
            // is explicitly a hosted disposable native installation only.
            for (let slotAttempt = 0; slotAttempt < 120; slotAttempt += 1) {
              try {
                await runEquinoxLocalWindowsGuardianOwnedSlot({transactionId: tx, transactionRoot: root, workerToken: token});
                const restartTrigger = process.env.EQUINOX_LOCAL_TEST_AB_RESTART_TRIGGER;
                const restartClientModule = process.env.EQUINOX_LOCAL_TEST_AB_RESTART_MODULE;
                if (!restartTrigger || !restartClientModule) throw new Error('Native B startup witness requires its bounded exact restart trigger and product client.');
                let signaled = false;
                for (let attempt = 0; attempt < 300; attempt += 1) {
                  if (fs.existsSync(restartTrigger)) { signaled = true; break; }
                  await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (!signaled) throw new Error('Hosted native B restart was never authorized after the real slot swap.');
                const { requestEquinoxLocalGuardianOwnedBWpfRestart } = await import(pathToFileURL(restartClientModule).href);
                await requestEquinoxLocalGuardianOwnedBWpfRestart({
                  transactionId: tx, transactionRoot: root, workerToken: token,
                  sourceSha: process.env.EQUINOX_LOCAL_TEST_AB_TARGET_SHA,
                });
                return;
              } catch (error) {
                // Retry only before the fixed grant; a failed/ambiguous
                // physical swap must NEVER be attempted automatically twice.
                const notStarted = error?.code === 'ENOENT' || error?.code === 'ECONNREFUSED' ||
                  /refuses a foreign journal stage or Stable A/u.test(error?.message ?? '');
                if (!notStarted || slotAttempt === 119) throw error;
                await new Promise(resolve => setTimeout(resolve, 250));
              }
            }
          }
          return;
        } catch (error) {
          // NEVER replay a potentially mutated A/B slot after the native
          // worker has already satisfied Guardian's journal admission.
          if (proved || attempt === 29) throw error;
          await new Promise(resolve => setTimeout(resolve, 130));
        }
      }
    })().catch(error => {
      const category = String(error?.code ?? error?.name ?? 'error').slice(0,40);
      const description = String(error?.message ?? 'unspecified').slice(0,240).replace(/[\r\n]/gu, ' ');
      const diagnostics = process.env.EQUINOX_LOCAL_TEST_AB_DIAGNOSTIC_FILE;
      if (diagnostics && source === integratedTrigger) {
        try { fs.appendFileSync(diagnostics, `${category}: ${description}\n`, { flag: 'a' }); } catch { }
      }
      console.error(category, description);
      process.exitCode = 1;
    });
  }, 120);
  timer.unref();
}

// One-shot hosted-only physical A: the exact original worker is the ONLY
// caller; production Main never imports or triggers this internal bridge.
const physicalTrigger = process.env.EQUINOX_LOCAL_TEST_AB_PHYSICAL_RESTORE_TRIGGER;
if (physicalTrigger) {
  const physicalReceipt = process.env.EQUINOX_LOCAL_TEST_AB_PHYSICAL_RESTORE_RECEIPT;
  const physicalModule = process.env.EQUINOX_LOCAL_TEST_AB_PHYSICAL_RESTORE_MODULE;
  if (process.env.GITHUB_ACTIONS !== 'true' || !physicalReceipt || !physicalModule ||
      !process.env.EQUINOX_LOCAL_TEST_AB_NEGATIVE_B_TRIGGER) {
    throw new Error('Hosted physical A request requires disposable CI and owned negative-B witness.');
  }
  const physicalTimer = setInterval(() => {
    if (!fs.existsSync(physicalTrigger)) return;
    clearInterval(physicalTimer);
    void (async () => {
      const path = await import('node:path');
      const tx = process.env.EQUINOX_LOCAL_TEST_WORKER_TX;
      const root = path.win32.join(process.env.LOCALAPPDATA, 'Equinox Local');
      const { runEquinoxLocalWindowsGuardianOwnedPhysicalARestore } = await import(pathToFileURL(physicalModule).href);
      // The product client independently re-runs the live original-Guardian
      // OS kernel lease/SID/LUID/nonce/HMAC audit before the one-shot grant.
      const request = Object.freeze({
        transactionId: tx,
        transactionRoot: process.env.EQUINOX_LOCAL_TEST_JOURNAL_TX_ROOT,
        workerToken: process.env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN,
        installation: Object.freeze({managed: true, selfUpdateSupported: true,
          target: process.env.EQUINOX_LOCAL_TEST_GUARDIAN_TARGET,
          installRoot: root,
          releaseDir: path.win32.join(root, 'releases', process.env.EQUINOX_LOCAL_TEST_GUARDIAN_STABLE_VERSION)}),
      });
      // The auditor may return just before the SAME Guardian finishes
      // disposing its read-only pipe and creates the fixed physical action
      // listener. Retry ONLY OS-level pre-connect refusal/absence. Never
      // retry a nonce/HMAC grant or an ambiguous physical rename.
      let result;
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          result = await runEquinoxLocalWindowsGuardianOwnedPhysicalARestore(request);
          break;
        } catch (error) {
          if (!['ENOENT', 'ECONNREFUSED'].includes(error?.code) || attempt === 19) throw error;
          await new Promise(resolve => setTimeout(resolve, 125));
        }
      }
      if (result.stage !== 'physical_a_restored_pending_native_and_source_commit')
        throw new Error('Hosted exact physical A proof is not yet durably completed.');
      const commit = JSON.parse(fs.readFileSync(path.win32.join(process.env.EQUINOX_LOCAL_TEST_JOURNAL_TX_ROOT,
        'guardian-journal', `${tx}.rollback_started.commit.json`), 'utf8'));
      fs.writeFileSync(physicalReceipt, JSON.stringify({
        transactionId: tx, stage: result.stage, guardianPid: commit.guardianPid,
      }), {flag: 'wx'});
    })().catch(error => {
      const kind = String(error?.code ?? error?.name ?? 'error').slice(0, 40);
      const diagnostic = process.env.EQUINOX_LOCAL_TEST_AB_DIAGNOSTIC_FILE;
      if (diagnostic) try { fs.appendFileSync(diagnostic, `physical-A:${kind}\n`); } catch { }
      process.exitCode = 1;
    });
  }, 110);
  physicalTimer.unref();
}

// Hosted-only negative-B acceptance. The SAME original product worker asks
// the SAME live Guardian to persist rollback_started/5 after CI deliberately
// terminates ONLY its independently identified disposable B WPF tree.
// The pinned product auditor then proves the original OS-held Guardian lease
// and nonce/HMAC. No A filesystem restore or production fallback is enabled.
const negativeBTrigger = process.env.EQUINOX_LOCAL_TEST_AB_NEGATIVE_B_TRIGGER;
if (negativeBTrigger) {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Negative-B witness must run only on disposable hosted CI.');
  const proofReceipt = process.env.EQUINOX_LOCAL_TEST_AB_NEGATIVE_B_RECEIPT;
  const clientModule = process.env.EQUINOX_LOCAL_TEST_AB_ROLLBACK_MODULE;
  const journalModule = process.env.EQUINOX_LOCAL_TEST_AB_EVIDENCE_MODULE;
  const verifierModule = process.env.EQUINOX_LOCAL_TEST_AB_OWNER_VERIFIER_MODULE;
  if (!proofReceipt || !clientModule || !journalModule || !verifierModule) {
    throw new Error('Negative-B witness requires exact product rollback client, observer and verifier.');
  }
  const negativeTimer = setInterval(() => {
    if (!fs.existsSync(negativeBTrigger)) return;
    clearInterval(negativeTimer);
    void (async () => {
      const path = await import('node:path');
      const transactionId = process.env.EQUINOX_LOCAL_TEST_WORKER_TX;
      const transactionRoot = process.env.EQUINOX_LOCAL_TEST_JOURNAL_TX_ROOT;
      const workerToken = process.env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN;
      const sourceSha = process.env.EQUINOX_LOCAL_TEST_AB_TARGET_SHA;
      const root = path.win32.join(process.env.LOCALAPPDATA, 'Equinox Local');
      const stableVersion = process.env.EQUINOX_LOCAL_TEST_GUARDIAN_STABLE_VERSION;
      const installation = Object.freeze({
        managed: true, selfUpdateSupported: true,
        target: process.env.EQUINOX_LOCAL_TEST_GUARDIAN_TARGET,
        installRoot: root, releaseDir: path.win32.join(root, 'releases', stableVersion),
      });
      const { requestEquinoxLocalGuardianOwnedARollbackStart } = await import(pathToFileURL(clientModule).href);
      // Retry only a connection that has never reached the Guardian pipe.
      // Never replay an ambiguous HMAC or a possibly-committed journal write.
      let started = false;
      for (let attempt = 0; attempt < 45; attempt += 1) {
        try {
          await requestEquinoxLocalGuardianOwnedARollbackStart({
            transactionId, transactionRoot, workerToken, sourceSha,
          });
          started = true;
          break;
        } catch (error) {
          if (!['ENOENT', 'ECONNREFUSED'].includes(error?.code) || attempt === 44) throw error;
          await new Promise(resolve => setTimeout(resolve, 130));
        }
      }
      if (!started) throw new Error('Original Guardian never admitted exact rejected B.');
      const { readEquinoxWindowsNativeGuardianMilestone } = await import(pathToFileURL(journalModule).href);
      const { createEquinoxWindowsNativeRollbackOwnerVerifier } = await import(pathToFileURL(verifierModule).href);
      const expected = Object.freeze({ transactionId, target: installation.target,
        currentSha: process.env.EQUINOX_LOCAL_TEST_AB_CURRENT_SHA,
        targetSha: sourceSha, receiptStartedAt: process.env.EQUINOX_LOCAL_TEST_AB_STARTED_AT });
      const result = await readEquinoxWindowsNativeGuardianMilestone({
        transactionRoot, transactionId, expected, stage: 'rollback_started',
        verifyGuardianOsOwner: createEquinoxWindowsNativeRollbackOwnerVerifier({ transactionId, installation }),
      });
      if (result.stage !== 'rollback_started' || result.sequence !== 5 || result.sourceSha !== sourceSha) {
        throw new Error('Independent live Guardian OS auditor did not prove durable rollback_started/5.');
      }
      fs.writeFileSync(proofReceipt, JSON.stringify({
        transactionId, sourceSha, stage: result.stage, sequence: result.sequence,
        guardianPid: result.guardianPid, osLeaseAttested: true, physicalARestored: false,
      }), { flag: 'wx' });
    })().catch((error) => {
      const diagnostic = process.env.EQUINOX_LOCAL_TEST_AB_DIAGNOSTIC_FILE;
      const kind = String(error?.code ?? error?.name ?? 'error').slice(0, 40);
      if (diagnostic) try { fs.appendFileSync(diagnostic, `negative-b:${kind}\n`); } catch { }
      process.exitCode = 1;
    });
  }, 110);
  negativeTimer.unref();
}
