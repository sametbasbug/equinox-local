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
const stageTrigger = process.env.EQUINOX_LOCAL_TEST_JOURNAL_STAGE_TRIGGER;
for (const source of [trigger, abortTrigger, shellTrigger, stageTrigger].filter(Boolean)) {
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
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          await proveEquinoxWindowsNativeJournalAuthority({transactionId: tx, transactionRoot: root, workerToken: token});
          return;
        } catch (error) {
          if (attempt === 29) throw error;
          await new Promise(resolve => setTimeout(resolve, 130));
        }
      }
    })().catch(error => { console.error(error.message); process.exitCode = 1; });
  }, 120);
  timer.unref();
}

// Negative staged-B admission using the SAME real installed worker PID.
// A forged native_staged journal without immutable B bytes MUST NOT stop A.
// Never retry after a stage HMAC could have been sent.
const nativeStageTrigger = process.env.EQUINOX_LOCAL_TEST_NATIVE_STAGE_DENY_TRIGGER;
const nativeStageResult = process.env.EQUINOX_LOCAL_TEST_NATIVE_STAGE_DENY_RESULT;
if (nativeStageTrigger && nativeStageResult) {
  const timer = setInterval(() => {
    if (!fs.existsSync(nativeStageTrigger)) return;
    clearInterval(timer);
    void (async () => {
      const modulePath = process.env.EQUINOX_LOCAL_TEST_JOURNAL_CLIENT_MODULE;
      if (!modulePath) throw new Error('Stage denial needs exact product client module.');
      const {requestEquinoxWindowsOwnedNativeShellShutdown} = await import(pathToFileURL(modulePath).href);
      try {
        await requestEquinoxWindowsOwnedNativeShellShutdown({
          transactionId: process.env.EQUINOX_LOCAL_TEST_WORKER_TX,
          transactionRoot: process.env.EQUINOX_LOCAL_TEST_JOURNAL_TX_ROOT,
          workerToken: process.env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN, release:'A',
        });
        fs.writeFileSync(nativeStageResult,'UNSAFE-ACCEPTED');
      } catch {
        fs.writeFileSync(nativeStageResult,'denied-before-WPF-exit');
      }
    })().catch(() => fs.writeFileSync(nativeStageResult,'test-client-failure'));
  },120);
  timer.unref();
}
