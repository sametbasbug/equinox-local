import { createHmac } from 'node:crypto';
import net from 'node:net';

const TX = /^main-[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const CHALLENGE = /^[a-f0-9]{64}$/u;
const DOMAIN = Buffer.from('equinox-local-native-main-proof-v1:', 'ascii');

export function equinoxWindowsMainWorkerProofPipe(transactionId) {
  if (!TX.test(transactionId ?? '')) throw new Error('Windows native worker proof transaction is invalid.');
  return `\\\\.\\pipe\\EquinoxLocalMainOwner-${transactionId}`;
}

/**
 * A live worker responds to one nonce with a domain-separated HMAC. Guardian
 * must ALSO prove the Windows named-pipe server PID through the kernel. Neither
 * this handshake nor the user-owned handoff JSON authorizes native mutation.
 */
export async function startEquinoxWindowsMainWorkerProof({
  transactionId, workerToken, platform = process.platform,
  // Only used by socket fixture tests; Windows always uses the product pipe.
  fixtureSocketPath = null,
} = {}) {
  if (!TX.test(transactionId ?? '') || !TOKEN.test(workerToken ?? '') ||
      (platform !== 'win32' && !(platform === 'test' && typeof fixtureSocketPath === 'string')) ||
      (platform === 'win32' && fixtureSocketPath !== null)) {
    throw new Error('Windows native worker proof identity is invalid.');
  }
  const pipe = platform === 'win32' ? equinoxWindowsMainWorkerProofPipe(transactionId) : fixtureSocketPath;
  const key = Buffer.from(workerToken, 'hex');
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(2500, () => socket.destroy());
    let request = '';
    socket.on('data', (chunk) => {
      request += chunk.toString('ascii');
      if (request.length > 65) { socket.destroy(); return; }
      if (!request.endsWith('\n')) return;
      const challenge = request.slice(0, -1);
      if (!CHALLENGE.test(challenge)) { socket.destroy(); return; }
      const proof = createHmac('sha256', key).update(DOMAIN).update(Buffer.from(challenge, 'hex')).digest('hex');
      socket.end(`${proof}\n`);
    });
    socket.on('error', () => socket.destroy());
  });
  server.maxConnections = 4;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(pipe, () => { server.removeListener('error', reject); resolve(); });
    });
  } catch (error) {
    server.close();
    key.fill(0);
    throw error;
  }
  return Object.freeze({
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      key.fill(0);
    },
  });
}
