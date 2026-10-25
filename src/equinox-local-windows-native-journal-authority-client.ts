import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import net from "node:net";
import path from "node:path";

type AuthorityProofOptions = {
  transactionId?:string;
  transactionRoot?:string;
  workerToken?:string;
  platform?:string;
  fixturePipePath?:string|null;
};
function recordOrNull(value:unknown):Record<string,unknown>|null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string,unknown> : null;
}

const TX = /^main-[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const DOMAIN = Buffer.from("equinox-local-guardian-journal-authority-v1:", "ascii");
const ROLLBACK_DOMAIN = Buffer.from("equinox-local-guardian-b-rollback-authority-v1:", "ascii");

// This is a distinct rollback-stage witness, never a prepared-stage privilege
// upgrade. It responds only to a fresh kernel-bound Guardian nonce for the
// exact rollback_started journal bytes; it grants no native shell authority.
export async function proveEquinoxWindowsNativeBRollbackAuthority(options:AuthorityProofOptions = {}):Promise<void> {
  return proveJournalAuthorityWitness(options, "rollback_started");
}

// Witness only: this handshake does NOT authorize stage promotion, WPF
// shutdown, native slot switching or replacement of the JS journal writer.
// The server independently admits the worker PID via the Windows kernel.
export async function proveEquinoxWindowsNativeJournalAuthority(options:AuthorityProofOptions = {}):Promise<void> {
  return proveJournalAuthorityWitness(options, "prepared");
}

// Retry only before a pipe has connected; NEVER retry a mutating request
// after its HMAC was sent, where WPF might already have exited.
async function connectOriginalGuardianStagePipe(pipe:string):Promise<net.Socket> {
  for (let attempt=0; attempt<40; attempt++) {
    try {
      return await new Promise<net.Socket>((resolve,reject)=>{
        const socket=net.createConnection(pipe);
        const fail=(error:Error)=>{socket.destroy();reject(error);};
        socket.once('error',fail);
        socket.once('connect',()=>{
          socket.off('error',fail);
          resolve(socket);
        });
      });
    } catch(error) {
      const code=error!==null && typeof error==='object' && 'code' in error ? error.code : null;
      if (!['ENOENT','ECONNREFUSED','EPIPE'].includes(String(code)) || attempt===39) throw error;
      await new Promise<void>(resolve=>setTimeout(resolve,120));
    }
  }
  throw new Error('Original signed Guardian stage socket is unavailable.');
}

// This is the SAME independently signed Guardian kernel owner session,
// not a new executable or bearer-only native shell permission.
const SESSION_DOMAIN = Buffer.from('equinox-local-guardian-native-stage-v1:', 'ascii');
// The kernel-attested original Guardian remains alive AND owns this exact
// journal generation. It grants no A/B WPF action or milestone assertion.
export async function attestEquinoxWindowsOriginalGuardianSession(
  options:AuthorityProofOptions,
):Promise<void> {
  return requestEquinoxWindowsOwnedNativeShellShutdown({...options, release:'A', signedOwnerOnly:true});
}

const PHYSICAL_MILESTONES = Object.freeze({
  native_staged: 5, shell_stopped: 6, switched: 7, restarted: 8,
  healthy: 9, committed: 10, rollback_started: 11,
  rollback_native_restored: 12, rollback_healthy: 13, rolled_back: 14,
} as const);

export async function attestEquinoxWindowsNativePhysicalMilestone(
  options:AuthorityProofOptions & {to:keyof typeof PHYSICAL_MILESTONES},
):Promise<void> {
  return requestEquinoxWindowsOwnedNativeShellShutdown({
    ...options, release:'B', signedMilestone:options.to,
  });
}

export async function requestEquinoxWindowsOwnedNativeShellHealth(options:AuthorityProofOptions & {release:'A'|'B'}):Promise<void> {
  return requestEquinoxWindowsOwnedNativeShellShutdown({...options, sustainedHealth:true});
}

export async function requestEquinoxWindowsOwnedNativeShellShutdown({
  transactionId, transactionRoot, workerToken, platform = process.platform,
  fixturePipePath = null, release, sustainedHealth = false, signedOwnerOnly = false,
  signedMilestone,
}:AuthorityProofOptions & {release:'A'|'B'; sustainedHealth?:boolean; signedOwnerOnly?:boolean;
  signedMilestone?:keyof typeof PHYSICAL_MILESTONES}):Promise<void> {
  if (!TX.test(transactionId ?? '') || !TOKEN.test(workerToken ?? '') ||
      typeof transactionRoot !== 'string' || !path.isAbsolute(transactionRoot) ||
      path.normalize(transactionRoot) !== transactionRoot ||
      (platform !== 'win32' && !(platform === 'test' && typeof fixturePipePath === 'string')) ||
      (platform === 'win32' && fixturePipePath !== null) || !['A','B'].includes(release)) {
    throw new Error('Native Guardian session command has invalid exact worker identity.');
  }
  const opcode = signedMilestone === undefined
    ? signedOwnerOnly ? 0 : sustainedHealth ? (release === 'A' ? 4 : 3) : (release === 'A' ? 1 : 2)
    : PHYSICAL_MILESTONES[signedMilestone];
  const handle = await fs.open(path.join(transactionRoot!, 'guardian-journal', transactionId! + '.json'),
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let raw:Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 8192)
      throw new Error('Native stage journal exceeds its bound.');
    raw = await handle.readFile();
    if (raw.length < 2 || raw.length > 8192) throw new Error('Native stage journal exceeds its bound.');
  } finally { await handle.close(); }
  const j = recordOrNull(JSON.parse(raw.toString('utf8')));
  const seq = typeof j?.sequence === 'number' && Number.isSafeInteger(j.sequence) ? j.sequence : -1;
  const valid = opcode >= 5 && opcode <= 14
    ? (opcode === 5 && j?.stage === 'prepared' && seq === 0) ||
      (opcode === 6 && j?.stage === 'native_staged' && seq === 1) ||
      (opcode === 7 && j?.stage === 'shell_stopped' && seq === 2) ||
      (opcode === 8 && j?.stage === 'switched' && seq === 3) ||
      (opcode === 9 && j?.stage === 'restarted' && seq === 4) ||
      (opcode === 10 && j?.stage === 'healthy' && seq === 5) ||
      (opcode === 11 && (j?.stage === 'prepared' && seq === 0 ||
        j?.stage === 'native_staged' && seq === 1 ||
        j?.stage === 'shell_stopped' && seq === 2 ||
        j?.stage === 'switched' && seq === 3 ||
        j?.stage === 'restarted' && seq === 4 ||
        j?.stage === 'healthy' && seq === 5)) ||
      (opcode === 12 && j?.stage === 'rollback_started' && seq >= 1 && seq <= 6) ||
      (opcode === 13 && j?.stage === 'rollback_native_restored' && seq >= 2 && seq <= 7) ||
      (opcode === 14 && j?.stage === 'rollback_healthy' && seq >= 3 && seq <= 8)
    : opcode === 0
    ? (j?.stage === 'prepared' && seq === 0) ||
      (j?.stage === 'native_staged' && seq === 1) ||
      (j?.stage === 'shell_stopped' && seq === 2) ||
      (j?.stage === 'switched' && seq === 3) ||
      (j?.stage === 'restarted' && seq === 4) ||
      (j?.stage === 'healthy' && seq === 5) ||
      (j?.stage === 'committed' && seq === 6) ||
      (j?.stage === 'rollback_started' && Number.isInteger(seq) && seq >= 1 && seq <= 6) ||
      (j?.stage === 'rollback_native_restored' && Number.isInteger(seq) && seq >= 2 && seq <= 7) ||
      (j?.stage === 'rollback_healthy' && Number.isInteger(seq) && seq >= 3 && seq <= 8) ||
      (j?.stage === 'rolled_back' && Number.isInteger(seq) && seq >= 4 && seq <= 9)
    : opcode === 1
    ? j?.stage === 'native_staged' && j.sequence === 1
    : opcode === 2
      ? j?.stage === 'rollback_started' && Number.isInteger(j.sequence) &&
        Number(j.sequence) >= 1 && Number(j.sequence) <= 6
      : opcode === 3
        ? (j?.stage === 'restarted' && j.sequence === 4) ||
          (j?.stage === 'healthy' && j.sequence === 5) ||
          (j?.stage === 'committed' && j.sequence === 6)
        : (j?.stage === 'rollback_native_restored' && Number.isInteger(j.sequence) &&
            Number(j.sequence) >= 2 && Number(j.sequence) <= 7) ||
          (j?.stage === 'rollback_healthy' && Number.isInteger(j.sequence) &&
            Number(j.sequence) >= 3 && Number(j.sequence) <= 8) ||
          (j?.stage === 'rolled_back' && Number.isInteger(j.sequence) &&
            Number(j.sequence) >= 4 && Number(j.sequence) <= 9);
  if (j?.transactionId !== transactionId || !valid) {
    throw new Error('Original signed Guardian refuses unrelated native A/B journal generation.');
  }
  const digest = createHash('sha256').update(raw).digest();
  const secret = Buffer.from(workerToken!, 'hex');
  const pipe = platform === 'win32'
    ? `\\\\.\\pipe\\EquinoxLocalMainSession-${transactionId}` : fixturePipePath!;
  try {
    const socket = await connectOriginalGuardianStagePipe(pipe);
    await new Promise<void>((resolve,reject)=>{
      let nonce = Buffer.alloc(0);
      let challengeAnswered = false;
      let settled = false;
      const fail = (error:Error) => { if (settled) return; settled=true; socket.destroy(); reject(error); };
      socket.setTimeout(60000,()=>fail(new Error('Original native Guardian stage proof timed out.')));
      socket.on('data', (chunk)=>{
        if (!Buffer.isBuffer(chunk)) return fail(new Error('Invalid native stage proof bytes.'));
        if (!challengeAnswered) {
          nonce = Buffer.concat([nonce,chunk]);
          if (nonce.length > 32) return fail(new Error('Original Guardian stage nonce exceeded bound.'));
          if (nonce.length === 32) {
            challengeAnswered=true;
            const mac=createHmac('sha256',secret).update(SESSION_DOMAIN)
              .update(Buffer.from([opcode])).update(nonce).update(digest).digest();
            socket.write(Buffer.concat([Buffer.from([opcode]),mac]));
          }
        } else {
          if (chunk.length !== 1 || chunk[0] !== 1)
            return fail(new Error('Original Guardian did not confirm exact WPF OS shutdown or sustained health.'));
          settled=true;
          socket.end();
          resolve();
        }
      });
      socket.once('error',(e)=>fail(e));
      socket.once('end',()=>{if (!settled) fail(new Error('Original Guardian exited without OS shell shutdown receipt.'));});
    });
  } finally { secret.fill(0); }
}

async function proveJournalAuthorityWitness({
  transactionId, transactionRoot, workerToken, platform = process.platform,
  fixturePipePath = null,
}:AuthorityProofOptions, stage:"prepared"|"rollback_started"):Promise<void> {
  if (!TX.test(transactionId ?? "") || !TOKEN.test(workerToken ?? "") ||
      typeof transactionRoot !== "string" || !path.isAbsolute(transactionRoot) ||
      path.normalize(transactionRoot) !== transactionRoot ||
      (platform !== "win32" && !(platform === "test" && typeof fixturePipePath === "string")) ||
      (platform === "win32" && fixturePipePath !== null)) {
    throw new Error("Native Windows journal authority witness has invalid exact identity.");
  }
  const journalPath = path.join(transactionRoot!, "guardian-journal", `${transactionId}.json`);
  // Bind validation and hashing to the same file descriptor, never a symlink.
  const handle = await fs.open(journalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let content:Buffer;
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 8192) {
      throw new Error("Journal witness source exceeds size limit.");
    }
    content = await handle.readFile();
    if (content.length < 2 || content.length > 8192) {
      throw new Error("Journal witness source exceeds size limit.");
    }
  } finally { await handle.close(); }
  const journal = recordOrNull(JSON.parse(content.toString("utf8")));
  if (journal?.transactionId !== transactionId || journal?.stage !== stage ||
      (stage === "prepared" ? journal?.sequence !== 0 :
        !Number.isInteger(journal?.sequence) || Number(journal.sequence) < 1 || Number(journal.sequence) > 6)) {
    throw new Error(stage === "prepared"
      ? "Native journal authority witness refuses any non-prepared generation."
      : "Native B rollback authority witness refuses invalid rollback_started generation.");
  }
  const digest = createHash("sha256").update(content).digest();
  const key = Buffer.from(workerToken!, "hex");
  const pipe = platform === "win32"
    ? `\\\\.\\pipe\\${stage === "prepared" ? "EquinoxLocalMainJournal" : "EquinoxLocalMainRollbackJournal"}-${transactionId}` : fixturePipePath!;
  try {
    await new Promise<void>((resolve, reject) => {
      let received = Buffer.alloc(0);
      const socket = net.createConnection(pipe);
      socket.setTimeout(5000, () => socket.destroy(new Error("Native journal authority proof timed out.")));
      socket.once("connect", () => {});
      socket.on("data", (chunk) => {
        if (!Buffer.isBuffer(chunk)) { socket.destroy(new Error("Native journal authority challenge exceeded bound.")); return; }
        received = Buffer.concat([received, chunk]);
        if (received.length > 32) { socket.destroy(new Error("Native journal authority challenge exceeded bound.")); return; }
        if (received.length === 32) {
          const domain = stage === "prepared" ? DOMAIN : ROLLBACK_DOMAIN;
          const mac = createHmac("sha256", key).update(domain).update(received).update(digest).digest();
          socket.end(mac);
        }
      });
      socket.once("end", resolve);
      socket.once("error", reject);
    });
  } finally { key.fill(0); }
}
