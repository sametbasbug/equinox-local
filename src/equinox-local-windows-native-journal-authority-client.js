import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import net from "node:net";
import path from "node:path";
function recordOrNull(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value : null;
}
const TX = /^main-[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const DOMAIN = Buffer.from("equinox-local-guardian-journal-authority-v1:", "ascii");
const ROLLBACK_DOMAIN = Buffer.from("equinox-local-guardian-b-rollback-authority-v1:", "ascii");
// This is a distinct rollback-stage witness, never a prepared-stage privilege
// upgrade. It responds only to a fresh kernel-bound Guardian nonce for the
// exact rollback_started journal bytes; it grants no native shell authority.
export async function proveEquinoxWindowsNativeBRollbackAuthority(options = {}) {
    return proveJournalAuthorityWitness(options, "rollback_started");
}
// Witness only: this handshake does NOT authorize stage promotion, WPF
// shutdown, native slot switching or replacement of the JS journal writer.
// The server independently admits the worker PID via the Windows kernel.
export async function proveEquinoxWindowsNativeJournalAuthority(options = {}) {
    return proveJournalAuthorityWitness(options, "prepared");
}
// Retry only before a pipe has connected; NEVER retry a mutating request
// after its HMAC was sent, where WPF might already have exited.
async function connectOriginalGuardianStagePipe(pipe) {
    for (let attempt = 0; attempt < 40; attempt++) {
        try {
            return await new Promise((resolve, reject) => {
                const socket = net.createConnection(pipe);
                const fail = (error) => { socket.destroy(); reject(error); };
                socket.once('error', fail);
                socket.once('connect', () => {
                    socket.off('error', fail);
                    resolve(socket);
                });
            });
        }
        catch (error) {
            const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
            if (!['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(String(code)) || attempt === 39)
                throw error;
            await new Promise(resolve => setTimeout(resolve, 120));
        }
    }
    throw new Error('Original signed Guardian stage socket is unavailable.');
}
// This is the SAME independently signed Guardian kernel owner session,
// not a new executable or bearer-only native shell permission.
const SESSION_DOMAIN = Buffer.from('equinox-local-guardian-native-stage-v1:', 'ascii');
export async function requestEquinoxWindowsOwnedNativeShellHealth(options) {
    return requestEquinoxWindowsOwnedNativeShellShutdown({ ...options, sustainedHealth: true });
}
export async function requestEquinoxWindowsOwnedNativeShellShutdown({ transactionId, transactionRoot, workerToken, platform = process.platform, fixturePipePath = null, release, sustainedHealth = false, }) {
    if (!TX.test(transactionId ?? '') || !TOKEN.test(workerToken ?? '') ||
        typeof transactionRoot !== 'string' || !path.isAbsolute(transactionRoot) ||
        path.normalize(transactionRoot) !== transactionRoot ||
        (platform !== 'win32' && !(platform === 'test' && typeof fixturePipePath === 'string')) ||
        (platform === 'win32' && fixturePipePath !== null) || !['A', 'B'].includes(release)) {
        throw new Error('Native Guardian session command has invalid exact worker identity.');
    }
    const opcode = sustainedHealth ? (release === 'A' ? 4 : 3) : (release === 'A' ? 1 : 2);
    const handle = await fs.open(path.join(transactionRoot, 'guardian-journal', transactionId + '.json'), fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let raw;
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 2 || stat.size > 8192)
            throw new Error('Native stage journal exceeds its bound.');
        raw = await handle.readFile();
        if (raw.length < 2 || raw.length > 8192)
            throw new Error('Native stage journal exceeds its bound.');
    }
    finally {
        await handle.close();
    }
    const j = recordOrNull(JSON.parse(raw.toString('utf8')));
    const valid = opcode === 1
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
    const secret = Buffer.from(workerToken, 'hex');
    const pipe = platform === 'win32'
        ? `\\\\.\\pipe\\EquinoxLocalMainSession-${transactionId}` : fixturePipePath;
    try {
        const socket = await connectOriginalGuardianStagePipe(pipe);
        await new Promise((resolve, reject) => {
            let nonce = Buffer.alloc(0);
            let challengeAnswered = false;
            let settled = false;
            const fail = (error) => { if (settled)
                return; settled = true; socket.destroy(); reject(error); };
            socket.setTimeout(60000, () => fail(new Error('Original native Guardian stage proof timed out.')));
            socket.on('data', (chunk) => {
                if (!Buffer.isBuffer(chunk))
                    return fail(new Error('Invalid native stage proof bytes.'));
                if (!challengeAnswered) {
                    nonce = Buffer.concat([nonce, chunk]);
                    if (nonce.length > 32)
                        return fail(new Error('Original Guardian stage nonce exceeded bound.'));
                    if (nonce.length === 32) {
                        challengeAnswered = true;
                        const mac = createHmac('sha256', secret).update(SESSION_DOMAIN)
                            .update(Buffer.from([opcode])).update(nonce).update(digest).digest();
                        socket.write(Buffer.concat([Buffer.from([opcode]), mac]));
                    }
                }
                else {
                    if (chunk.length !== 1 || chunk[0] !== 1)
                        return fail(new Error('Original Guardian did not confirm exact WPF OS shutdown or sustained health.'));
                    settled = true;
                    socket.end();
                    resolve();
                }
            });
            socket.once('error', (e) => fail(e));
            socket.once('end', () => { if (!settled)
                fail(new Error('Original Guardian exited without OS shell shutdown receipt.')); });
        });
    }
    finally {
        secret.fill(0);
    }
}
async function proveJournalAuthorityWitness({ transactionId, transactionRoot, workerToken, platform = process.platform, fixturePipePath = null, }, stage) {
    if (!TX.test(transactionId ?? "") || !TOKEN.test(workerToken ?? "") ||
        typeof transactionRoot !== "string" || !path.isAbsolute(transactionRoot) ||
        path.normalize(transactionRoot) !== transactionRoot ||
        (platform !== "win32" && !(platform === "test" && typeof fixturePipePath === "string")) ||
        (platform === "win32" && fixturePipePath !== null)) {
        throw new Error("Native Windows journal authority witness has invalid exact identity.");
    }
    const journalPath = path.join(transactionRoot, "guardian-journal", `${transactionId}.json`);
    // Bind validation and hashing to the same file descriptor, never a symlink.
    const handle = await fs.open(journalPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let content;
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size < 2 || metadata.size > 8192) {
            throw new Error("Journal witness source exceeds size limit.");
        }
        content = await handle.readFile();
        if (content.length < 2 || content.length > 8192) {
            throw new Error("Journal witness source exceeds size limit.");
        }
    }
    finally {
        await handle.close();
    }
    const journal = recordOrNull(JSON.parse(content.toString("utf8")));
    if (journal?.transactionId !== transactionId || journal?.stage !== stage ||
        (stage === "prepared" ? journal?.sequence !== 0 :
            !Number.isInteger(journal?.sequence) || Number(journal.sequence) < 1 || Number(journal.sequence) > 6)) {
        throw new Error(stage === "prepared"
            ? "Native journal authority witness refuses any non-prepared generation."
            : "Native B rollback authority witness refuses invalid rollback_started generation.");
    }
    const digest = createHash("sha256").update(content).digest();
    const key = Buffer.from(workerToken, "hex");
    const pipe = platform === "win32"
        ? `\\\\.\\pipe\\${stage === "prepared" ? "EquinoxLocalMainJournal" : "EquinoxLocalMainRollbackJournal"}-${transactionId}` : fixturePipePath;
    try {
        await new Promise((resolve, reject) => {
            let received = Buffer.alloc(0);
            const socket = net.createConnection(pipe);
            socket.setTimeout(5000, () => socket.destroy(new Error("Native journal authority proof timed out.")));
            socket.once("connect", () => { });
            socket.on("data", (chunk) => {
                if (!Buffer.isBuffer(chunk)) {
                    socket.destroy(new Error("Native journal authority challenge exceeded bound."));
                    return;
                }
                received = Buffer.concat([received, chunk]);
                if (received.length > 32) {
                    socket.destroy(new Error("Native journal authority challenge exceeded bound."));
                    return;
                }
                if (received.length === 32) {
                    const domain = stage === "prepared" ? DOMAIN : ROLLBACK_DOMAIN;
                    const mac = createHmac("sha256", key).update(domain).update(received).update(digest).digest();
                    socket.end(mac);
                }
            });
            socket.once("end", resolve);
            socket.once("error", reject);
        });
    }
    finally {
        key.fill(0);
    }
}
