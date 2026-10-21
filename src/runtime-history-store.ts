import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type HistoryFs = Pick<typeof fs, "mkdir" | "chmod" | "access" | "writeFile" | "readFile" | "rename" | "rm">;
type HistoryRecord = Record<string, unknown>;
type HistoryStoreOptions = {
  rootDir?: string;
  fileName?: string;
  schemaVersion?: number;
  maxRecords?: number;
  randomId?: () => string;
  fsImpl?: HistoryFs;
  rootMode?: number;
  fileMode?: number;
};

function hasErrorCode(error: unknown, code: string): boolean {
  return error !== null && (typeof error === "object" || typeof error === "function") &&
    "code" in error && error.code === code;
}

export function createRuntimeHistoryStore({
  rootDir,
  fileName,
  schemaVersion,
  maxRecords,
  randomId = randomUUID,
  fsImpl = fs,
  rootMode = 0o700,
  fileMode = 0o600,
}: HistoryStoreOptions = {}) {
  const historyPath = path.join(rootDir!, fileName!);
  let initialized = false;
  let appendTail: Promise<void> = Promise.resolve();

  const initialize = async (): Promise<void> => {
    if (initialized) return;
    await fsImpl.mkdir(rootDir!, { recursive: true, mode: rootMode });
    await fsImpl.chmod(rootDir!, rootMode).catch(() => {});
    try {
      await fsImpl.access(historyPath);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
      await fsImpl.writeFile(historyPath, "", { mode: fileMode, flag: "wx" });
    }
    await fsImpl.chmod(historyPath, fileMode).catch(() => {});
    initialized = true;
  };

  const read = async (): Promise<HistoryRecord[]> => {
    let text = "";
    try {
      text = await fsImpl.readFile(historyPath, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return [];
      throw error;
    }

    const records: HistoryRecord[] = [];
    for (const line of text.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      try {
        const parsed: HistoryRecord | null = JSON.parse(line);
        if (parsed?.schemaVersion === schemaVersion) {
          records.push(parsed!);
        }
      } catch {
        // Ignore malformed lines so retained history remains readable.
      }
    }
    return records;
  };

  const appendOnce = async (record: unknown): Promise<void> => {
    await initialize();
    const existing = await read();
    const next = [...existing, record].slice(-maxRecords!);
    const temporaryPath = `${historyPath}.${process.pid}.${randomId()}.tmp`;
    const serialized = next.map((item) => JSON.stringify(item)).join("\n") + (next.length ? "\n" : "");
    await fsImpl.writeFile(temporaryPath, serialized, { mode: fileMode, flag: "wx" });
    try {
      await fsImpl.rename(temporaryPath, historyPath);
      await fsImpl.chmod(historyPath, fileMode).catch(() => {});
    } catch (error) {
      if (typeof fsImpl.rm === "function") await fsImpl.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  };

  const append = (record: unknown): Promise<void> => {
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
