import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function createRuntimeHistoryStore({
  rootDir,
  fileName,
  schemaVersion,
  maxRecords,
  randomId = randomUUID,
  fsImpl = fs,
  rootMode = 0o700,
  fileMode = 0o600,
} = {}) {
  const historyPath = path.join(rootDir, fileName);
  let initialized = false;
  let appendTail = Promise.resolve();

  const initialize = async () => {
    if (initialized) return;
    await fsImpl.mkdir(rootDir, { recursive: true, mode: rootMode });
    await fsImpl.chmod(rootDir, rootMode).catch(() => {});
    try {
      await fsImpl.access(historyPath);
    } catch {
      await fsImpl.writeFile(historyPath, "", { mode: fileMode });
    }
    await fsImpl.chmod(historyPath, fileMode).catch(() => {});
    initialized = true;
  };

  const read = async () => {
    let text = "";
    try {
      text = await fsImpl.readFile(historyPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }

    const records = [];
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed?.schemaVersion === schemaVersion) {
          records.push(parsed);
        }
      } catch {
        // Ignore malformed lines so retained history remains readable.
      }
    }
    return records;
  };

  const appendOnce = async (record) => {
    await initialize();
    const existing = await read();
    const next = [...existing, record].slice(-maxRecords);
    const temporaryPath = `${historyPath}.${process.pid}.${randomId()}.tmp`;
    const serialized = next.map((item) => JSON.stringify(item)).join("\n") + (next.length ? "\n" : "");
    await fsImpl.writeFile(temporaryPath, serialized, { mode: fileMode });
    try {
      await fsImpl.rename(temporaryPath, historyPath);
      await fsImpl.chmod(historyPath, fileMode).catch(() => {});
    } catch (error) {
      if (typeof fsImpl.rm === "function") await fsImpl.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  };

  const append = (record) => {
    const operation = appendTail.then(() => appendOnce(record));
    appendTail = operation.catch(() => {});
    return operation;
  };

  return Object.freeze({
    historyPath,
    initialize,
    read,
    append,
  });
}
