// Fixed, disposable real installed-host IPC witness. It neither updates nor
// impersonates any process and never accepts arbitrary user commands.
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
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

// Positive native OS integration: the REAL product-owned signed Node worker
// launches the already-installed original Guardian and completes the same
// per-journal HMAC as production admission. PowerShell only inspects/ends the
// resulting real OS process and fixture evidence; it does NOT spawn Guardian.
const originalLaunchTrigger=process.env.EQUINOX_LOCAL_TEST_SIGNED_GUARDIAN_START_TRIGGER;
const originalLaunchResult=process.env.EQUINOX_LOCAL_TEST_SIGNED_GUARDIAN_START_RESULT;
if (originalLaunchTrigger && originalLaunchResult) {
  const timer=setInterval(()=>{
    if (!fs.existsSync(originalLaunchTrigger)) return;
    clearInterval(timer);
    void (async()=>{
      const modulePath=process.env.EQUINOX_LOCAL_TEST_SIGNED_GUARDIAN_ADMISSION_MODULE;
      const root=process.env.EQUINOX_LOCAL_TEST_JOURNAL_TX_ROOT;
      const transactionId=process.env.EQUINOX_LOCAL_TEST_WORKER_TX;
      if (!modulePath || !root || !transactionId) throw Error('Original signed Guardian module/root is absent.');
      const ownership=JSON.parse(fs.readFileSync(path.win32.join(root,'handoff',transactionId+'.windows-worker.json'),'utf8'));
      const {authenticateOriginalWindowsGuardianOwner}=await import(pathToFileURL(modulePath).href);
      const admitted=await authenticateOriginalWindowsGuardianOwner({
        transactionId,transactionRoot:root,
        releaseDir:process.env.EQUINOX_LOCAL_TEST_SIGNED_GUARDIAN_RELEASE,
        workerToken:process.env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN,
        workerPid:process.pid,workerStartTimeUtcTicks:ownership.startTimeUtcTicks,
        fsImpl:fsPromises,sleepImpl:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
      });
      fs.writeFileSync(originalLaunchResult,JSON.stringify({
        originalSignedOwner:admitted.originalSignedOwner,guardianPid:admitted.guardianPid,
        workerPid:admitted.workerPid,workerStartTimeUtcTicks:admitted.workerStartTimeUtcTicks,
      }));
    })().catch(error=>{
      // The installed test only accepts a bounded error category; never
      // leak potentially private paths/tokens into hosted job logs.
      const reason = String(error?.message ?? '');
      const SAFE_REASON = [
        'Signed Windows Guardian requires its original live product worker.',
        'Guardian session root is not the actual signed product installation.',
        'Original signed Guardian session already exists; explicit recovery required.',
        'Original signed Guardian requires the first prepared journal generation.',
        'Original signed Guardian exited before ownership proof.',
        'Original signed Guardian refused live prepared worker HMAC.',
        'Original signed Guardian exited without durable ownership.',
        'Original signed Guardian durable kernel worker/journal/handoff attestation failed.',
        'Original signed Guardian did not retain its exclusive native OS session lease.',
        'Installed original signed Guardian differs from the current immutable A release.',
      ];
      const category = SAFE_REASON.indexOf(reason);
      fs.writeFileSync(originalLaunchResult,JSON.stringify({failed:true,
        // A finite allowlist index, never native stderr, paths or HMAC tokens.
        category: category >= 0 ? 'admission-'+category : 'unclassified-'+String(error?.code ?? 'none').replace(/[^A-Z0-9_]/g,'').slice(0,18)}));
    });
  },120);
  timer.unref();
}
