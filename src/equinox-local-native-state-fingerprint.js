import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_ENTRIES = 20_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DOMAIN = "equinox-local-native-state-v1\0";

async function hashFile(filePath, fsImpl) {
  const digest = createHash("sha256");
  const handle = await fsImpl.open(filePath, "r");
  try {
    for await (const chunk of handle.createReadStream()) digest.update(chunk);
  } finally {
    await handle.close().catch(() => {});
  }
  return digest.digest("hex");
}

export async function fingerprintEquinoxLocalNativeState(root, { fsImpl = fs } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("Native state fingerprint root must be absolute.");
  const rootStat = await fsImpl.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Native state fingerprint root must be a normal directory.");
  const rows = [];
  const stack = [{ absolute: root, relative: "" }];
  let entries = 0;
  let bytes = 0;
  while (stack.length) {
    const current = stack.pop();
    const children = await fsImpl.readdir(current.absolute, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, "en"));
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      entries += 1;
      if (entries > MAX_ENTRIES) throw new Error("Native state fingerprint contains too many entries.");
      const absolute = path.join(current.absolute, child.name);
      const relative = current.relative ? `${current.relative}/${child.name}` : child.name;
      const stat = await fsImpl.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error("Native state fingerprint may not contain symbolic links or junctions.");
      if (stat.isDirectory()) {
        rows.push(Object.freeze({ type: "dir", relative, mode: stat.mode & 0o777 }));
        stack.push({ absolute, relative });
        continue;
      }
      if (!stat.isFile()) throw new Error("Native state fingerprint contains an unsupported filesystem entry.");
      bytes += stat.size;
      if (bytes > MAX_BYTES) throw new Error("Native state fingerprint exceeds the size limit.");
      rows.push(Object.freeze({ type: "file", relative, mode: stat.mode & 0o777, bytes: stat.size, sha256: await hashFile(absolute, fsImpl) }));
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
