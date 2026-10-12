// Fixed, disposable real installed-host IPC witness. It neither updates nor
// impersonates any process and never accepts arbitrary user commands.
import { pathToFileURL } from 'node:url';
const productProofModule = process.env.EQUINOX_LOCAL_TEST_PROOF_MODULE;
if (!productProofModule) throw new Error('Hosted IPC witness module path is missing.');
const { startEquinoxWindowsMainWorkerProof } = await import(pathToFileURL(productProofModule).href);
await startEquinoxWindowsMainWorkerProof({
  transactionId: process.env.EQUINOX_LOCAL_TEST_WORKER_TX,
  workerToken: process.env.EQUINOX_LOCAL_MAIN_WORKER_TOKEN,
});
