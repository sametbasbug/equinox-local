import { createHash, createPublicKey } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readPrivateUpdateSigningKeyFromFd } from "./sign-update-manifest.mjs";
import { createSignedMainNativeBAuthorization, validateSignedMainNativeBAuthorization,
  type MainNativeBAuthorizationPayload } from "../../src/equinox-local-main-native-b-authorization.js";
import { EQUINOX_LOCAL_UPDATE_KEYS } from "../../src/equinox-local-update-keys.js";

async function hashExactArtifact(filename: string) {
  if (!path.isAbsolute(filename)) throw new Error("Main B release archive path must be absolute.");
  const named = await fs.lstat(filename);
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size < 1 || named.size > 1024 * 1024 * 1024) {
    throw new Error("Main B release archive must be a bounded normal single-link file.");
  }
  // Hash the same actual OS descriptor whose identity and exact byte size
  // were checked; never size-check one pathname and stream another one.
  const handle = await fs.open(filename, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== named.size ||
        (process.platform === "win32" && (opened.ino === 0 || named.ino === 0)) ||
        opened.dev !== named.dev || opened.ino !== named.ino) {
      throw new Error("Main B release archive changed during descriptor admission.");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (bytes < named.size) {
      const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, named.size - bytes), bytes);
      if (bytesRead === 0) throw new Error("Main B release archive ended early while hashing.");
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    const extra = await handle.read(buffer, 0, 1, bytes);
    const finalStat = await handle.stat();
    if (extra.bytesRead !== 0 || finalStat.size !== named.size ||
        finalStat.mtimeMs !== opened.mtimeMs || finalStat.ino !== opened.ino || finalStat.dev !== opened.dev) {
      throw new Error("Main B release archive changed while hashing.");
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally { await handle.close(); }
}

async function main(argv: string[]) {
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]; const value = argv[i + 1];
    if (!flag?.startsWith("--") || !value) throw new Error("Main B signer expects --flag value pairs.");
    const key = flag.slice(2);
    if (!["payload", "artifact", "key-id", "output"].includes(key) || Object.hasOwn(values, key)) {
      throw new Error("Main B signer has an unsupported or duplicated argument.");
    }
    values[key] = value;
  }
  for (const key of ["payload", "artifact", "key-id", "output"]) {
    if (!values[key] || !path.isAbsolute(values[key]) && key !== "key-id") {
      throw new Error("Main B signer requires absolute existing input and output paths.");
    }
  }
  const payloadPath = values.payload!;
  const payloadStat = await fs.lstat(payloadPath);
  if (!payloadStat.isFile() || payloadStat.isSymbolicLink() || payloadStat.nlink !== 1 || payloadStat.size > 8192) {
    throw new Error("Main B authorization payload must be a bounded normal file.");
  }
  const unsigned = JSON.parse(await fs.readFile(payloadPath, "utf8")) as MainNativeBAuthorizationPayload;
  // Product release uses ONLY inherited FD3 with 0600 + current UID. No PEM
  // pathname CLI, printed key, generated key or fallback signer is permitted.
  const privateKey = readPrivateUpdateSigningKeyFromFd(3);
  const keyId = values["key-id"]!;
  const trusted = (EQUINOX_LOCAL_UPDATE_KEYS as Record<string, string>)[keyId];
  if (!trusted || createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString() !== trusted) {
    throw new Error("Main B signing key does not match shipped immutable production trust root.");
  }
  const archive = await hashExactArtifact(values.artifact!);
  if (unsigned.artifact.sha256 !== archive.sha256 || unsigned.artifact.bytes !== archive.bytes) {
    throw new Error("Main B signed authorization does not match the actual native archive bytes.");
  }
  const result = createSignedMainNativeBAuthorization(unsigned, { privateKey, keyId });
  validateSignedMainNativeBAuthorization(result, { expected: unsigned });
  const output = values.output!;
  const handle = await fs.open(output, "wx", 0o644);
  try { await handle.writeFile(`${JSON.stringify(result, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  process.stdout.write("Main B authorization signed and verified under shipped production Ed25519 key.\n");
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked && invoked === import.meta.url) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
