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
