import { createHash, createHmac } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const TX = /^main-[a-f0-9]{32}$/u;
const TOKEN = /^[a-f0-9]{64}$/u;
const DOMAIN = Buffer.from("equinox-local-guardian-journal-authority-v1:", "ascii");

// Witness only: this handshake does NOT authorize stage promotion, WPF
// shutdown, native slot switching or replacement of the JS journal writer.
// The server independently admits the worker PID via the Windows kernel.
export async function proveEquinoxWindowsNativeJournalAuthority({
  transactionId, transactionRoot, workerToken, platform = process.platform,
  fixturePipePath = null,
} = {}) {
  if (!TX.test(transactionId ?? "") || !TOKEN.test(workerToken ?? "") ||
      typeof transactionRoot !== "string" || !path.isAbsolute(transactionRoot) ||
      path.normalize(transactionRoot) !== transactionRoot ||
      (platform !== "win32" && !(platform === "test" && typeof fixturePipePath === "string")) ||
      (platform === "win32" && fixturePipePath !== null)) {
    throw new Error("Native Windows journal authority witness has invalid exact identity.");
  }
  const journalPath = path.join(transactionRoot, "guardian-journal", `${transactionId}.json`);
  const content = await fs.readFile(journalPath);
  if (content.length < 2 || content.length > 8192) throw new Error("Journal witness source exceeds size limit.");
  const journal = JSON.parse(content.toString("utf8"));
  if (journal.transactionId !== transactionId || journal.stage !== "prepared" || journal.sequence !== 0) {
    throw new Error("Native journal authority witness refuses any non-prepared generation.");
  }
  const digest = createHash("sha256").update(content).digest();
  const key = Buffer.from(workerToken, "hex");
  const pipe = platform === "win32"
    ? `\\\\.\\pipe\\EquinoxLocalMainJournal-${transactionId}` : fixturePipePath;
  try {
    await new Promise((resolve, reject) => {
      let received = Buffer.alloc(0);
      const socket = net.createConnection(pipe);
      socket.setTimeout(5000, () => socket.destroy(new Error("Native journal authority proof timed out.")));
      socket.once("connect", () => {});
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (received.length > 32) { socket.destroy(new Error("Native journal authority challenge exceeded bound.")); return; }
        if (received.length === 32) {
          const mac = createHmac("sha256", key).update(DOMAIN).update(received).update(digest).digest();
          socket.end(mac);
        }
      });
      socket.once("end", resolve);
      socket.once("error", reject);
    });
  } finally { key.fill(0); }
}
