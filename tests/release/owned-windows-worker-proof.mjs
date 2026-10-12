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
