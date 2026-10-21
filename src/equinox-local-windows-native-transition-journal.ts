import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { protectWindowsPrivateStatePath, verifyWindowsPrivateStateAcl } from "./equinox-local-private-state.js";
import type {MainTransactionReceipt} from "./equinox-local-main-update-transaction.js";

export type WindowsPreviousNative =
  | Readonly<{kind:"main"; sourceSha:string; runtimeContractSha256:string}>
  | Readonly<{kind:"stable"; version:string}>;
export type WindowsJournalExpected = Readonly<{
  transactionId:string; target:string; currentSha:string; targetSha:string; receiptStartedAt:string;
}>;
export type WindowsJournalRecord = WindowsJournalExpected & Readonly<{
  schemaVersion:1; channel:"main"; previousNative:WindowsPreviousNative;
  targetRuntimeContractSha256:string; stage:string; sequence:number;
  createdAt:string; updatedAt:string;
}>;
type JournalFs = typeof fs;
type JournalHandle = Awaited<ReturnType<JournalFs["open"]>>;
type AclResult = boolean | Readonly<{safe:boolean}>;
type AclTarget = {target:string;type:"file"|"directory"};
type ProtectAcl = (options: AclTarget) => Promise<unknown>;
type VerifyAcl = (options: AclTarget) => Promise<AclResult>;
type JournalOptions = {
  transactionRoot?: string; fsImpl?: JournalFs; now?: () => string;
  inspectOwningReceipt?: (data:WindowsJournalRecord) => Promise<MainTransactionReceipt | null>;
  verifyMilestone?: (record:WindowsJournalRecord, to:string) => Promise<boolean>;
  platform?: string; protectWindowsAcl?: ProtectAcl; verifyWindowsAcl?: VerifyAcl;
};
type ACLFS = {fsImpl: JournalFs; platform:string; protectAcl:ProtectAcl; verifyAcl:VerifyAcl};
type AclDirectoryOptions = ACLFS & {create?:boolean};
type RecordWriteOptions = ACLFS & {createOnly:boolean};
type ExpectedIdentity = Partial<WindowsJournalExpected>;
type CreateInput = WindowsJournalExpected & Readonly<{
  previousNative:WindowsPreviousNative; targetRuntimeContractSha256:string;
}>;
type AdvanceInput = {from:string;to:string;sequence:number};
export type WindowsJournal = Readonly<{
  create:(input:CreateInput)=>Promise<WindowsJournalRecord>;
  read:(id:string,expected?:ExpectedIdentity)=>Promise<WindowsJournalRecord>;
  advance:(id:string,input:AdvanceInput)=>Promise<WindowsJournalRecord>;
  root:string;
}>;
function hasErrorCode(error:unknown,code:string):boolean {
  return error!==null && typeof error==="object" && "code" in error && error.code===code;
}


const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const TRANSACTION = /^main-[a-f0-9]{32}$/u;
const MAX_BYTES = 8 * 1024;
const WINDOWS_TARGETS = new Set(["win32-x64", "win32-arm64"]);
const STAGE_SEQUENCE_RANGES: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  prepared: [0, 0], native_staged: [1, 1], shell_stopped: [2, 2],
  switched: [3, 3], restarted: [4, 4], healthy: [5, 5], committed: [6, 6],
  rollback_started: [1, 6], rollback_native_restored: [2, 7],
  rollback_healthy: [3, 8], rolled_back: [4, 9],
});
const NEXT: Readonly<Record<string, readonly string[]>> = Object.freeze({
  prepared: ["native_staged", "rollback_started"],
  native_staged: ["shell_stopped", "rollback_started"],
  shell_stopped: ["switched", "rollback_started"],
  switched: ["restarted", "rollback_started"],
  restarted: ["healthy", "rollback_started"],
  healthy: ["committed", "rollback_started"],
  rollback_started: ["rollback_native_restored"],
  rollback_native_restored: ["rollback_healthy"],
  rollback_healthy: ["rolled_back"],
  committed: [],
  rolled_back: [],
});

function expectKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} identity is invalid.`);
  }
}
function iso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
function previousNativeIdentity(value: unknown): WindowsPreviousNative {
  if (value !== null && typeof value === "object" && "kind" in value && value.kind === "stable") {
    expectKeys(value, ["kind", "version"], "Windows transition previous Stable");
    const record = value as Record<string, unknown>;
    if (typeof record.version !== "string" ||
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(record.version)) {
      throw new Error("Previous Stable version is invalid.");
    }
    return Object.freeze({kind:"stable",version:record.version});
  }
  if (value !== null && typeof value === "object" && "kind" in value && value.kind === "main") {
    expectKeys(value, ["kind", "sourceSha", "runtimeContractSha256"], "Windows transition previous Main");
    const record = value as Record<string, unknown>;
    if (typeof record.sourceSha !== "string" || !SHA.test(record.sourceSha) ||
        typeof record.runtimeContractSha256 !== "string" || !DIGEST.test(record.runtimeContractSha256)) {
      throw new Error("Previous native Main identity is invalid.");
    }
    return Object.freeze({kind:"main",sourceSha:record.sourceSha,runtimeContractSha256:record.runtimeContractSha256});
  }
  throw new Error("Windows transition previous native identity is invalid.");
}
export function validateEquinoxLocalWindowsNativeTransitionJournal(value: unknown, expected: ExpectedIdentity = {}): WindowsJournalRecord {
  expectKeys(value, ["schemaVersion", "channel", "transactionId", "target", "currentSha", "targetSha", "receiptStartedAt", "previousNative", "targetRuntimeContractSha256", "stage", "sequence", "createdAt", "updatedAt"], "Windows native transition journal");
  const stage = typeof value.stage === "string" ? value.stage : "";
  const sequence = typeof value.sequence === "number" ? value.sequence : -1;
  if (value.schemaVersion !== 1 || value.channel !== "main" ||
      typeof value.transactionId !== "string" || !TRANSACTION.test(value.transactionId) ||
      typeof value.target !== "string" || !WINDOWS_TARGETS.has(value.target) ||
      typeof value.currentSha !== "string" || !SHA.test(value.currentSha) ||
      typeof value.targetSha !== "string" || !SHA.test(value.targetSha) || value.currentSha === value.targetSha ||
      typeof value.targetRuntimeContractSha256 !== "string" || !DIGEST.test(value.targetRuntimeContractSha256) ||
      !iso(value.receiptStartedAt) || !iso(value.createdAt) || !iso(value.updatedAt) ||
      Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
      !Object.hasOwn(NEXT, stage) || !Number.isSafeInteger(sequence) || sequence < 0 ||
      sequence < (STAGE_SEQUENCE_RANGES[stage]?.[0] ?? Infinity) ||
      sequence > (STAGE_SEQUENCE_RANGES[stage]?.[1] ?? -1)) {
    throw new Error("Windows native transition journal state or immutable identity is invalid.");
  }
  const previousNative = previousNativeIdentity(value.previousNative);
  if (previousNative.kind === "main" && previousNative.sourceSha !== value.currentSha) {
    throw new Error("Windows native transition previous Main source does not match transaction A.");
  }
  for (const field of ["transactionId", "target", "currentSha", "targetSha", "receiptStartedAt"] as const) {
    if (Object.hasOwn(expected, field) && value[field] !== expected[field]) {
      throw new Error(`Windows native transition journal ${field} does not match the owning transaction.`);
    }
  }
  return Object.freeze({ ...value, previousNative }) as WindowsJournalRecord;
}

async function directoryOwned(directory: string, { fsImpl, create = false, platform, protectAcl, verifyAcl }: AclDirectoryOptions): Promise<string> {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || path.normalize(directory) !== directory) {
    throw new Error("Windows transition journal directory must be canonical and absolute.");
  }
  if (create) await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const [stat, real] = await Promise.all([fsImpl.lstat(directory), fsImpl.realpath(directory)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.normalize(real).toLowerCase() !== directory.toLowerCase()) {
    throw new Error("Windows transition journal directory is not a normal owned directory.");
  }
  if (platform === "win32") {
    if (create) await protectAcl({ target: directory, type: "directory" });
    const checked = await verifyAcl({ target: directory, type: "directory" });
    if (checked !== true && (typeof checked !== "object" || checked.safe !== true)) {
      throw new Error("Windows transition journal directory ACL ownership cannot be verified.");
    }
  }
  return directory;
}
async function syncDirectory(dir: string, fsImpl: JournalFs): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fsImpl.open(dir, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readRecord(file: string, { fsImpl, platform, verifyAcl }: ACLFS): Promise<WindowsJournalRecord> {
  // Open first, then validate the already-open handle. Checking a pathname
  // before opening it introduces a TOCTOU race across native update restarts.
  const handle = await fsImpl.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  let raw: string;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size < 2 || opened.size > MAX_BYTES) {
      throw new Error("Windows transition journal is not a bounded normal file.");
    }
    const assertOpenIdentity = async () => {
      const linked = await fsImpl.lstat(file);
      if (!linked.isFile() || linked.isSymbolicLink() ||
          linked.ino !== opened.ino || linked.dev !== opened.dev) {
        throw new Error("Windows transition journal path no longer identifies the opened file.");
      }
    };
    await assertOpenIdentity();
    if (platform === "win32") {
      const checked = await verifyAcl({ target: file, type: "file" });
      if (checked !== true && (typeof checked !== "object" || checked.safe !== true)) throw new Error("Windows transition journal file ACL ownership cannot be verified.");
      await assertOpenIdentity();
    }
    raw = await handle.readFile("utf8");
  } finally { await handle.close(); }
  if (Buffer.byteLength(raw) > MAX_BYTES) throw new Error("Windows transition journal exceeds its bound.");
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("Windows transition journal JSON is invalid."); }
  return validateEquinoxLocalWindowsNativeTransitionJournal(value);
}

async function writeRecord(file: string, data: WindowsJournalRecord, { fsImpl, createOnly, platform, protectAcl, verifyAcl }: RecordWriteOptions): Promise<void> {
  const body = `${JSON.stringify(data, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("Windows transition journal exceeds its bound.");
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(8).toString("hex")}.tmp`);
  let handle: JournalHandle | null | undefined;
  try {
    handle = await fsImpl.open(temp, "wx", 0o600);
    await handle.writeFile(body, "utf8");
    await handle.sync(); await handle.close(); handle = null;
    if (createOnly) {
      // Link with exclusivity: never silently overwrite an existing journal.
      await fsImpl.link(temp, file);
      await fsImpl.unlink(temp);
    } else await fsImpl.rename(temp, file);
    if (platform === "win32") {
      await protectAcl({ target: file, type: "file" });
      const checked = await verifyAcl({ target: file, type: "file" });
      if (checked !== true && (typeof checked !== "object" || checked.safe !== true)) throw new Error("Windows transition journal file ACL protection cannot be verified.");
    }
    await syncDirectory(dir, fsImpl);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsImpl.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

// A write guard is never silently reclaimed after a crash: a future trusted
// supervisor must reconcile process ownership and the durable receipt first.
export function createEquinoxLocalWindowsNativeTransitionJournal({
  transactionRoot,
  fsImpl = fs,
  now = () => new Date().toISOString(),
  inspectOwningReceipt,
  verifyMilestone,
  platform = process.platform,
  protectWindowsAcl = protectWindowsPrivateStatePath,
  verifyWindowsAcl = verifyWindowsPrivateStateAcl,
}: JournalOptions = {}): WindowsJournal {
  if (typeof transactionRoot !== "string" || !path.isAbsolute(transactionRoot) || path.normalize(transactionRoot) !== transactionRoot ||
      typeof inspectOwningReceipt !== "function" || typeof verifyMilestone !== "function") {
    throw new Error("Windows transition journal requires a canonical root and an exact receipt validator.");
  }
  const root = path.join(transactionRoot, "guardian-journal");
  const aclOpts = { fsImpl, platform, protectAcl: protectWindowsAcl, verifyAcl: verifyWindowsAcl };
  const targetFile = (id: string): string => {
    if (!TRANSACTION.test(id ?? "")) throw new Error("Windows transition journal transaction id is invalid.");
    return path.join(root, `${id}.json`);
  };
  const verifiedReceipt = async (data: WindowsJournalRecord, nextStage = "prepared"): Promise<void> => {
    const receipt = await inspectOwningReceipt(data);
    if (!receipt || receipt.transactionId !== data.transactionId || receipt.currentSha !== data.currentSha ||
        receipt.targetSha !== data.targetSha || receipt.startedAt !== data.receiptStartedAt ||
        (nextStage === "committed" ? receipt.status !== "succeeded" :
          nextStage === "rolled_back" ? receipt.status !== "rolled_back" :
          !["promoting", "verifying"].includes(receipt.status))) {
      throw new Error("Windows transition journal refuses missing or mismatched active Main transaction ownership.");
    }
  };
  const withWriteGuard = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
    await directoryOwned(transactionRoot, aclOpts);
    await directoryOwned(root, { ...aclOpts, create: true });
    const guard = path.join(root, `.${id}.writer-lock`);
    const fd = await fsImpl.open(guard, "wx", 0o600);
    try {
      await fd.writeFile(`${process.pid}\n`);
      await fd.sync();
      return await action();
    } finally {
      await fd.close();
      await fsImpl.unlink(guard);
    }
  };
  const read = async (id: string, expected: ExpectedIdentity = {}): Promise<WindowsJournalRecord> => {
    targetFile(id);
    await directoryOwned(transactionRoot, aclOpts);
    await directoryOwned(root, aclOpts);
    const journal = await readRecord(targetFile(id), aclOpts);
    return validateEquinoxLocalWindowsNativeTransitionJournal(journal, { ...expected, transactionId: id });
  };
  const create = async ({ transactionId, target, currentSha, targetSha, receiptStartedAt, previousNative, targetRuntimeContractSha256 }: CreateInput): Promise<WindowsJournalRecord> => {
    targetFile(transactionId);
    return withWriteGuard(transactionId, async () => {
      const timestamp = now();
      const value = validateEquinoxLocalWindowsNativeTransitionJournal({
        schemaVersion: 1, channel: "main", transactionId, target, currentSha, targetSha,
        receiptStartedAt, previousNative, targetRuntimeContractSha256,
        stage: "prepared", sequence: 0, createdAt: timestamp, updatedAt: timestamp,
      });
      await verifiedReceipt(value);
      await writeRecord(targetFile(transactionId), value, { ...aclOpts, createOnly: true });
      return value;
    });
  };
  const advance = async (transactionId: string, { from, to, sequence }: AdvanceInput): Promise<WindowsJournalRecord> => {
    targetFile(transactionId);
    return withWriteGuard(transactionId, async () => {
      const journal = await read(transactionId);
      if (journal.stage !== from || journal.sequence !== sequence || !NEXT[from]?.includes(to)) {
        throw new Error("Windows transition journal refuses stale or unsafe stage transition.");
      }
      await verifiedReceipt(journal, to);
      if (await verifyMilestone(Object.freeze({ ...journal }), to) !== true) {
        throw new Error("Windows transition journal native milestone was not independently verified.");
      }
      const updatedAt = now();
      if (!iso(updatedAt) || Date.parse(updatedAt) < Date.parse(journal.updatedAt)) {
        throw new Error("Windows transition journal timestamp is invalid.");
      }
      const next = validateEquinoxLocalWindowsNativeTransitionJournal({ ...journal, stage: to, sequence: sequence + 1, updatedAt });
      await writeRecord(targetFile(transactionId), next, { ...aclOpts, createOnly: false });
      return next;
    });
  };
  return Object.freeze({ create, read, advance, root });
}
