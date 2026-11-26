import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type NativeTreeFs = Pick<typeof fs, "open" | "lstat" | "readdir">;
export type NativeStateFingerprint = Readonly<{
  schemaVersion: 1;
  sha256: string;
  entries: number;
  bytes: number;
}>;
type FingerprintRow = Readonly<
  { type: "dir"; relative: string; mode: number } |
  { type: "file"; relative: string; mode: number; bytes: number; sha256: string }
>;


const MAX_ENTRIES = 20_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DOMAIN = "equinox-local-native-state-v1\0";

// At most four files are open concurrently; read each through a bounded
// buffer without allocating a per-file ReadStream and async iterator.
const FILE_BATCH = 4;
const HASH_BUFFER_BYTES = 256 * 1024;
async function hashFile(filePath: string, expectedBytes: number, fsImpl: NativeTreeFs): Promise<string> {
  const digest = createHash("sha256");
  const handle = await fsImpl.open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expectedBytes) throw new Error("Native state file changed before hashing.");
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(expectedBytes, HASH_BUFFER_BYTES)));
    let offset = 0;
    while (offset < expectedBytes) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expectedBytes - offset), offset);
      if (bytesRead === 0) throw new Error("Native state file ended during hashing.");
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== expectedBytes || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error("Native state file changed during hashing.");
  } finally {
    await handle.close();
  }
  return digest.digest("hex");
}

export async function fingerprintEquinoxLocalNativeState(root: unknown, { fsImpl = fs }: { fsImpl?: NativeTreeFs } = {}): Promise<NativeStateFingerprint> {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Native state fingerprint root must be absolute.");
  const rootStat = await fsImpl.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Native state fingerprint root must be a normal directory.");
  const rows: FingerprintRow[] = [];
  const stack: { absolute: string; relative: string }[] = [{ absolute: root, relative: "" }];
  let entries = 0;
  let bytes = 0;
  while (stack.length) {
    const current = stack.pop();
    if (!current) break;
    const children = await fsImpl.readdir(current.absolute, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, "en"));
    // Preserve the original deterministic traversal/order while overlapping
    // bounded filesystem operations. Never descend before lstat admission.
    children.reverse();
    for (let index = 0; index < children.length; index += FILE_BATCH) {
      const batch = children.slice(index, index + FILE_BATCH);
      entries += batch.length;
      if (entries > MAX_ENTRIES) throw new Error("Native state fingerprint contains too many entries.");
      const inspected = await Promise.all(batch.map(async child => {
        const absolute = path.join(current.absolute, child.name);
        const relative = current.relative ? `${current.relative}/${child.name}` : child.name;
        return { absolute, relative, stat: await fsImpl.lstat(absolute) };
      }));
      for (const { stat } of inspected) {
        if (stat.isSymbolicLink()) throw new Error("Native state fingerprint may not contain symbolic links or junctions.");
        if (!stat.isDirectory() && !stat.isFile()) throw new Error("Native state fingerprint contains an unsupported filesystem entry.");
        if (stat.isFile()) {
          bytes += stat.size;
          if (bytes > MAX_BYTES) throw new Error("Native state fingerprint exceeds the size limit.");
        }
      }
      const batchRows = await Promise.allSettled(inspected.map(async ({ absolute, relative, stat }): Promise<FingerprintRow> => {
        if (stat.isDirectory()) return Object.freeze({ type: "dir", relative, mode: stat.mode & 0o777 });
        return Object.freeze({ type: "file", relative, mode: stat.mode & 0o777, bytes: stat.size,
          sha256: await hashFile(absolute, stat.size, fsImpl) });
      }));
      // Settle all admitted reads before reporting a failure to the caller.
      for (let i = 0; i < batchRows.length; i += 1) {
        const result = batchRows[i]!;
        if (result.status === "rejected") throw result.reason;
        rows.push(result.value);
        const item = inspected[i]!;
        if (result.value.type === "dir") stack.push({ absolute: item.absolute, relative: item.relative });
      }
    }
  }
  rows.sort((a, b) => a.relative.localeCompare(b.relative, "en"));
  const digest = createHash("sha256");
  digest.update(DOMAIN);
  for (const row of rows) {
    digest.update(`${row.type}\0${row.relative}\0${row.mode}\0`);
    if (row.type === "file") digest.update(`${row.bytes}\0${row.sha256}\0`);
  }
  return Object.freeze({ schemaVersion: 1, sha256: digest.digest("hex"), entries, bytes });
}
