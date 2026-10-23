import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { equinoxLocalGitExecutionEnvironment } from "./equinox-local-toolchain-contract.js";

const execFile = promisify(execFileCallback);
export type MainGitExec = (command:string,args:string[],options:{
  timeout:number;maxBuffer:number;env:NodeJS.ProcessEnv;
})=>Promise<{stdout:string|Buffer;stderr?:string|Buffer}>;
type MainFs = Pick<typeof fs,"lstat"|"realpath">;
type CheckoutOptions = {fsImpl?:MainFs;execFileImpl?:MainGitExec|undefined;gitPath?:string};
type GitOptions = {execFileImpl?:MainGitExec|undefined;gitPath?:string};
type FetchOptions = {fetchImpl?:typeof fetch};
type CheckoutResult = Readonly<{
 eligible:boolean;state:string;reason:string|null;sourceRoot?:string;
 currentSha?:string;branch?:string|null;remoteCanonical?:boolean;dirty?:boolean;
}>;
type Installation = Readonly<{kind?:string;gitPath?:string}>;
type DiscoveryOptions = CheckoutOptions & FetchOptions & {
 installation?:Installation;sourceRoot?:string;now?:()=>Date;cacheTtlMs?:number;
};
type Summary = Readonly<{sha:string;shortSha:string;message:string;authoredAt:string|null}>;
type DiscoveryState = Readonly<{
 channel:string;repository:string;branch:string;checkSupported:boolean;
 checkedAt:string|null;cacheExpiresAt:string|null;state:string;
 currentSha:string|null;targetSha:string|null;behindBy:number|null;aheadBy:number|null;
 dirty:boolean|null;remoteCanonical:boolean|null;
 summaries:ReadonlyArray<Summary>;lastError:string|null;reason:string|null;
}>;
function recordOrNull(value:unknown):Record<string,unknown>|null {
 return value !== null && typeof value === "object" && !Array.isArray(value)
   ? value as Record<string,unknown> : null;
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_ROOT = path.basename(MODULE_DIR) === "src" ? path.dirname(MODULE_DIR) : MODULE_DIR;

export const EQUINOX_LOCAL_MAIN_UPDATE_SCHEMA_VERSION = 1;
export const EQUINOX_LOCAL_MAIN_REPOSITORY = "sametbasbug/equinox-local";
export const EQUINOX_LOCAL_MAIN_BRANCH = "main";
export const EQUINOX_LOCAL_MAIN_REMOTE = `https://github.com/${EQUINOX_LOCAL_MAIN_REPOSITORY}.git`;
export const EQUINOX_LOCAL_MAIN_UPDATE_CHANNEL = "main";
export const EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG = "main-snapshot";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
// Real older-v6 -> current Main comparisons can exceed 256 KiB because
// GitHub includes changed file metadata even with per_page=5. Keep a fixed
// maximum, but allow full legitimate version-spanning comparisons.
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SUMMARIES = 5;

function boundedMessage(value:unknown,maximum:number = 300):string {
  return String(value ?? "")
    .replace(/[\r\n\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
}

function assertExactObject(value:unknown,keys:ReadonlyArray<string>,label:string):asserts value is Record<string,unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
}

export function validateManagedSourceInstallStamp(value:unknown) {
  assertExactObject(value, ["schemaVersion", "channel", "repository", "branch", "bootstrapSha"], "Managed-source install stamp");
  if (value.schemaVersion !== EQUINOX_LOCAL_MAIN_UPDATE_SCHEMA_VERSION) throw new Error("Unsupported managed-source install stamp schema.");
  if (value.channel !== EQUINOX_LOCAL_MAIN_UPDATE_CHANNEL) throw new Error("Managed-source install stamp channel must be main.");
  if (value.repository !== EQUINOX_LOCAL_MAIN_REPOSITORY) throw new Error("Managed-source install stamp repository is not canonical.");
  if (value.branch !== EQUINOX_LOCAL_MAIN_BRANCH) throw new Error("Managed-source install stamp branch must be main.");
  if (!SHA_PATTERN.test(typeof value.bootstrapSha === "string" ? value.bootstrapSha : "")) throw new Error("Managed-source install stamp bootstrap SHA is invalid.");
  return Object.freeze({
    schemaVersion: value.schemaVersion,
    channel: value.channel,
    repository: value.repository,
    branch: value.branch,
    bootstrapSha: value.bootstrapSha,
  });
}

export function isCanonicalMainRemote(value:unknown):boolean {
  const remote = String(value ?? "").trim();
  return remote === EQUINOX_LOCAL_MAIN_REMOTE
    || remote === EQUINOX_LOCAL_MAIN_REMOTE.replace(/\.git$/u, "")
    || remote === `git@github.com:${EQUINOX_LOCAL_MAIN_REPOSITORY}.git`
    || remote === `ssh://git@github.com/${EQUINOX_LOCAL_MAIN_REPOSITORY}.git`;
}

async function runGit(sourceRoot:string,args:string[],{execFileImpl=execFile,gitPath="git"}:GitOptions = {}):Promise<string> {
  const result = await execFileImpl(gitPath, ["-C", sourceRoot, ...args], {
    timeout: CHECK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: equinoxLocalGitExecutionEnvironment(gitPath, { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" }) as NodeJS.ProcessEnv,
  });
  return String(result?.stdout ?? "").trim();
}

async function readBoundedJsonResponse(response:Response):Promise<unknown> {
  if (!response?.ok) {
    const error = new Error(`GitHub returned HTTP ${response?.status ?? "unknown"}.`);
    Object.assign(error,{status:response?.status ?? null});
    throw error;
  }
  const lengthHeader = response.headers?.get?.("content-length");
  if (lengthHeader) {
    const bytes = Number(lengthHeader);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_RESPONSE_BYTES) throw new Error("GitHub response exceeds the size limit.");
  }
  if (!response.body) throw new Error("GitHub response body is unavailable.");
  const chunks:Buffer[] = [];
  let total = 0;
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > MAX_RESPONSE_BYTES) throw new Error("GitHub response exceeds the size limit.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new Error("GitHub returned invalid JSON.");
  }
}

async function fetchGithubJson(url:string,{fetchImpl=globalThis.fetch}:FetchOptions = {}):Promise<unknown> {
  if (typeof fetchImpl !== "function") throw new Error("Main update network client is unavailable.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "Equinox-Local",
      },
      signal: controller.signal,
    });
    return await readBoundedJsonResponse(response);
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectCanonicalMainCheckout(sourceRoot:string,{fsImpl=fs,execFileImpl=execFile,gitPath="git"}:CheckoutOptions = {}):Promise<CheckoutResult> {
  const resolvedRoot = path.resolve(sourceRoot);
  const [stat, realRoot] = await Promise.all([fsImpl.lstat(resolvedRoot), fsImpl.realpath(resolvedRoot)]);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realRoot !== resolvedRoot) {
    return { eligible: false, state: "unsupported", reason: "The source checkout root is not a canonical normal directory." };
  }

  let topLevel;
  try {
    topLevel = await runGit(resolvedRoot, ["rev-parse", "--show-toplevel"], { execFileImpl, gitPath });
  } catch {
    return { eligible: false, state: "unsupported", reason: "The active source directory is not a Git checkout." };
  }
  if (path.resolve(topLevel) !== resolvedRoot) {
    return { eligible: false, state: "unsupported", reason: "The active source directory is not the checkout root." };
  }

  const currentSha = await runGit(resolvedRoot, ["rev-parse", "HEAD"], { execFileImpl, gitPath });
  if (!SHA_PATTERN.test(currentSha)) return { eligible: false, state: "unsupported", reason: "The current source SHA is invalid." };

  let branch = null;
  try {
    branch = await runGit(resolvedRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], { execFileImpl, gitPath });
  } catch {
    return { eligible: false, state: "detached", currentSha, branch: null, reason: "The source checkout is detached from main." };
  }
  if (branch !== EQUINOX_LOCAL_MAIN_BRANCH) {
    return { eligible: false, state: "unsupported", currentSha, branch, reason: "The source checkout must be on the canonical main branch." };
  }

  let remote;
  try {
    remote = await runGit(resolvedRoot, ["remote", "get-url", "origin"], { execFileImpl, gitPath });
  } catch {
    return { eligible: false, state: "unsupported", currentSha, branch, reason: "The source checkout has no canonical origin remote." };
  }
  if (!isCanonicalMainRemote(remote)) {
    return { eligible: false, state: "unsupported", currentSha, branch, remoteCanonical: false, reason: "The origin remote is not the canonical Equinox Local repository." };
  }

  const dirtyOutput = await runGit(resolvedRoot, ["status", "--porcelain=v1", "--untracked-files=normal"], { execFileImpl, gitPath });
  if (dirtyOutput) {
    return { eligible: false, state: "dirty", currentSha, branch, remoteCanonical: true, dirty: true, reason: "The source checkout has uncommitted changes." };
  }

  return { eligible: true, state: "ready", sourceRoot: resolvedRoot, currentSha, branch, remoteCanonical: true, dirty: false, reason: null };
}

function summarizeCompareCommit(commit:unknown):Summary|null {
  const item=recordOrNull(commit);
  const details=recordOrNull(item?.commit);
  const author=recordOrNull(details?.author);
  const sha = typeof item?.sha === "string" && SHA_PATTERN.test(item.sha) ? item.sha : null;
  const message = boundedMessage((typeof details?.message === "string" ? details.message.split("\n")[0] : "") ?? "", 120);
  const authoredAt = typeof author?.date === "string" && !Number.isNaN(Date.parse(author.date))
    ? new Date(author.date).toISOString()
    : null;
  if (!sha || !message) return null;
  return Object.freeze({ sha, shortSha: sha.slice(0, 7), message, authoredAt });
}

function classifyComparison(raw:unknown,currentSha:string,targetSha:string) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("GitHub comparison is invalid.");
  const info = raw as Record<string,unknown>;
  const aheadBy = typeof info.ahead_by === "number" && Number.isSafeInteger(info.ahead_by) && info.ahead_by >= 0 ? info.ahead_by : null;
  const behindBy = typeof info.behind_by === "number" && Number.isSafeInteger(info.behind_by) && info.behind_by >= 0 ? info.behind_by : null;
  if (aheadBy === null || behindBy === null) throw new Error("GitHub comparison distances are invalid.");
  const state = info.status === "ahead" ? "behind"
    : info.status === "behind" ? "ahead"
      : info.status === "diverged" ? "diverged"
        : info.status === "identical" ? "up_to_date"
          : null;
  if (!state) throw new Error("GitHub comparison status is unsupported.");
  const summaries = Array.isArray(info.commits)
    ? info.commits.map(summarizeCompareCommit).filter((value):value is Summary=>value!==null).slice(0,MAX_SUMMARIES)
    : [];
  return Object.freeze({
    state,
    currentSha,
    targetSha,
    behindBy: aheadBy,
    aheadBy: behindBy,
    summaries: Object.freeze(summaries),
  });
}

export function createEquinoxLocalMainUpdateDiscovery({
  installation,
  sourceRoot = DEFAULT_SOURCE_ROOT,
  fsImpl = fs,
  execFileImpl = execFile,
  gitPath = installation?.gitPath ?? "git",
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
}:DiscoveryOptions = {}) {
  if (!Number.isSafeInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 60 * 60 * 1000) throw new Error("Main update cache TTL is invalid.");
  const checkSupported = installation?.kind === "source" || installation?.kind === "managed-source";
  let state:DiscoveryState = Object.freeze({
    channel: EQUINOX_LOCAL_MAIN_UPDATE_CHANNEL,
    repository: EQUINOX_LOCAL_MAIN_REPOSITORY,
    branch: EQUINOX_LOCAL_MAIN_BRANCH,
    checkSupported,
    checkedAt: null,
    cacheExpiresAt: null,
    state: checkSupported ? "not_checked" : "unsupported",
    currentSha: null,
    targetSha: null,
    behindBy: null,
    aheadBy: null,
    dirty: null,
    remoteCanonical: null,
    summaries: Object.freeze([]),
    lastError: null,
    reason: checkSupported ? null : "Main update discovery is available only for source-managed checkouts.",
  });

  const snapshot = () => state;

  const check = async ({ force = false } = {}) => {
    const currentTime = now();
    if (!force && state.checkedAt && state.cacheExpiresAt && currentTime.getTime() < Date.parse(state.cacheExpiresAt)) return state;
    if (!checkSupported) return state;

    let local;
    try {
      local = await inspectCanonicalMainCheckout(sourceRoot, { fsImpl, execFileImpl, gitPath });
    } catch (error) {
      state = Object.freeze({ ...state, checkedAt: currentTime.toISOString(), cacheExpiresAt: null, state: "unsupported", lastError: null, reason: boundedMessage(error instanceof Error ? error.message : error) });
      return state;
    }

    const checkedAt = currentTime.toISOString();
    const cacheExpiresAt = new Date(currentTime.getTime() + cacheTtlMs).toISOString();
    if (!local.eligible) {
      state = Object.freeze({
        ...state,
        checkedAt,
        cacheExpiresAt,
        state: local.state,
        currentSha: local.currentSha ?? null,
        targetSha: null,
        behindBy: null,
        aheadBy: null,
        dirty: local.dirty ?? null,
        remoteCanonical: local.remoteCanonical ?? null,
        summaries: Object.freeze([]),
        lastError: null,
        reason: local.reason,
      });
      return state;
    }

    try {
      const snapshotUrl = `https://api.github.com/repos/${EQUINOX_LOCAL_MAIN_REPOSITORY}/git/ref/tags/${EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG}`;
      const snapshotPayload=recordOrNull(await fetchGithubJson(snapshotUrl,{fetchImpl}));
      const tagObject=recordOrNull(snapshotPayload?.object);
      const targetSha = tagObject?.sha;
      if (snapshotPayload?.ref !== `refs/tags/${EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG}` || tagObject?.type !== "commit" || !SHA_PATTERN.test(typeof targetSha === 'string' ? targetSha : '')) {
        throw new Error("GitHub Main Snapshot tag returned an invalid target SHA.");
      }

      let comparison:ReturnType<typeof classifyComparison>;
      if (targetSha === local.currentSha) {
        comparison = Object.freeze({ state: "up_to_date", currentSha: local.currentSha!, targetSha: targetSha as string, behindBy: 0, aheadBy: 0, summaries: Object.freeze([]) });
      } else {
        const compareUrl = `https://api.github.com/repos/${EQUINOX_LOCAL_MAIN_REPOSITORY}/compare/${local.currentSha}...${targetSha}?per_page=5&page=1`;
        comparison = classifyComparison(await fetchGithubJson(compareUrl, { fetchImpl }), local.currentSha!, targetSha as string);
      }
      state = Object.freeze({
        ...state,
        checkedAt,
        cacheExpiresAt,
        state: comparison.state,
        currentSha: comparison.currentSha,
        targetSha: comparison.targetSha,
        behindBy: comparison.behindBy,
        aheadBy: comparison.aheadBy,
        dirty: false,
        remoteCanonical: true,
        summaries: comparison.summaries,
        lastError: null,
        reason: null,
      });
      return state;
    } catch (error) {
      const message = boundedMessage(error instanceof Error ? error.message : error);
      state = Object.freeze({
        ...state,
        checkedAt,
        cacheExpiresAt,
        state: "unavailable",
        currentSha: local.currentSha ?? null,
        targetSha: null,
        behindBy: null,
        aheadBy: null,
        dirty: false,
        remoteCanonical: true,
        summaries: Object.freeze([]),
        lastError: message,
        reason: "The admitted Main Snapshot could not be checked. This is not an up-to-date result.",
      });
      return state;
    }
  };

  return Object.freeze({ snapshot, check });
}
