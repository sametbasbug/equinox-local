import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BUCKET = "equinox-local-main";
const ENDPOINT = "https://c1ff8ccffcbffe46094cd3a2729a1c1f.r2.cloudflarestorage.com";
const PUBLIC_REPO = "https://github.com/sametbasbug/equinox-local.git";
const SHA = /^[0-9a-f]{40}$/u;
const ROOT_KEY = /^snapshots\/([0-9a-f]{40})\/(.+)$/u;
const TARGETS = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];
const KEEP_LATEST = 8;
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_OBJECTS = 20_000;

function expectedKeys(sha) {
  return new Set(TARGETS.flatMap((target) => {
    const stem = "snapshots/" + sha + "/equinox-local-main-" + sha + "-" + target;
    return [stem + ".json", stem + (target.startsWith("win32") ? ".zip" : ".tar.gz")];
  }));
}

export function planEquinoxMainR2Retention(objects, { mainSha, snapshotSha, now = new Date() }) {
  assert.ok(Array.isArray(objects) && objects.length >= 8 && objects.length <= MAX_OBJECTS, "Complete bounded R2 inventory is required.");
  assert.match(mainSha, SHA);
  assert.match(snapshotSha, SHA);
  assert.ok(now instanceof Date && !Number.isNaN(now.getTime()), "Current time is required.");
  const seen = new Set(), groups = new Map();
  for (const item of objects) {
    const key = item?.Key, size = item?.Size, modified = item?.LastModified;
    assert.ok(typeof key === "string" && key.startsWith("snapshots/") && !seen.has(key), "Unexpected or duplicate R2 object key.");
    assert.ok(Number.isSafeInteger(size) && size >= 0, "R2 object size is invalid.");
    assert.ok(typeof modified === "string" && !Number.isNaN(Date.parse(modified)), "R2 object date is invalid.");
    const timestamp = new Date(modified).getTime();
    assert.ok(timestamp <= now.getTime() + 5 * 60_000, "R2 object timestamp is unexpectedly in the future.");
    seen.add(key);
    const parts = ROOT_KEY.exec(key);
    if (!parts) throw new Error("Unexpected R2 object shape; delete operation refused.");
    const sha = parts[1];
    const group = groups.get(sha) ?? { sha, keys: [], bytes: 0, newest: 0 };
    group.keys.push(key);
    group.bytes += size;
    group.newest = Math.max(group.newest, timestamp);
    groups.set(sha, group);
  }
  const ordered = [...groups.values()].sort((left, right) => right.newest - left.newest || left.sha.localeCompare(right.sha));
  const complete = (group) => group.keys.length === 8 &&
    group.keys.every((key) => expectedKeys(group.sha).has(key));
  const keep = new Set([mainSha, snapshotSha,
    ...ordered.filter(complete).slice(0, KEEP_LATEST).map((item) => item.sha)]);
  const protectedGroups = [];
  const deletingGroups = [];
  let retainedBytes = 0, removedBytes = 0;
  for (const group of ordered) {
    const isComplete = complete(group);
    const recent = now.getTime() - group.newest < MIN_AGE_MS;
    if (!isComplete || recent || keep.has(group.sha)) {
      protectedGroups.push(group);
      retainedBytes += group.bytes;
    } else {
      deletingGroups.push(group);
      removedBytes += group.bytes;
    }
  }
  const deleteKeys = deletingGroups.flatMap((group) => group.keys);
  assert.ok(deleteKeys.length < objects.length, "Cannot delete every object.");
  assert.ok(ordered.filter(complete).slice(0, KEEP_LATEST).every((item) => !deletingGroups.includes(item)), "Latest complete archives cannot be deleted.");
  return Object.freeze({
    keepCount: protectedGroups.length,
    deleteCount: deletingGroups.length,
    objectCount: objects.length,
    snapshotCount: ordered.length,
    keptBytes: retainedBytes,
    deleteBytes: removedBytes,
    deleteKeys: Object.freeze(deleteKeys),
    protectedShas: Object.freeze(protectedGroups.map((g) => g.sha)),
  });
}

function cmd(args, { maxBuffer = 12 * 1024 * 1024 } = {}) {
  return execFileSync(args[0], args.slice(1), { encoding: "utf8", timeout: 120_000, maxBuffer });
}

function remoteSha(ref) {
  const text = cmd(["git", "ls-remote", PUBLIC_REPO, ref]).trim();
  const match = /^([a-f0-9]{40})\trefs\/(heads\/main|tags\/main-snapshot)$/u.exec(text);
  if (!match) throw new Error("Canonical Main reference unavailable: " + ref);
  return match[1];
}

function inventory() {
  const contents = [];
  let cursor;
  for (let page = 0; page < 25; page++) {
    const args = ["aws", "s3api", "list-objects-v2", "--no-paginate", "--bucket", BUCKET,
      "--prefix", "snapshots/", "--max-keys", "1000", "--endpoint-url", ENDPOINT, "--output", "json"];
    if (cursor) args.push("--continuation-token", cursor);
    const response = JSON.parse(cmd(args));
    if (!Array.isArray(response.Contents)) throw new Error("R2 returned no object inventory.");
    contents.push(...response.Contents);
    if (contents.length > MAX_OBJECTS) throw new Error("R2 inventory exceeds safe bound.");
    if (response.IsTruncated === false) return contents;
    if (!response.IsTruncated || !response.NextContinuationToken ||
      response.NextContinuationToken === cursor) throw new Error("R2 inventory pagination is invalid.");
    cursor = response.NextContinuationToken;
  }
  throw new Error("R2 inventory page limit reached; no objects removed.");
}

function validateCurrentRefs(mainSha, snapshotSha) {
  if (remoteSha("refs/heads/main") !== mainSha || remoteSha("refs/tags/main-snapshot") !== snapshotSha)
    throw new Error("Canonical Main/snapshot refs changed; refusing R2 deletion.");
}

function execute() {
  if (process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === "--apply")) {
    throw new Error("Usage: node scripts/release/prune-main-r2.mjs [--apply] (dry-run by default)");
  }
  const apply = process.argv[2] === "--apply";
  const mainSha = remoteSha("refs/heads/main");
  const snapshotSha = remoteSha("refs/tags/main-snapshot");
  const objects = inventory();
  const plan = planEquinoxMainR2Retention(objects, { mainSha, snapshotSha });
  process.stdout.write(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    mainSha, snapshotSha, inventory: plan.objectCount, commits: plan.snapshotCount,
    keptCommits: plan.keepCount, removableCommits: plan.deleteCount,
    removableObjects: plan.deleteKeys.length, retainedGB: +(plan.keptBytes / 1e9).toFixed(3),
    reclaimableGB: +(plan.deleteBytes / 1e9).toFixed(3),
  }) + "\n");
  if (!apply || plan.deleteKeys.length === 0) return;
  assert.ok(plan.deleteKeys.length > 0 && plan.keepCount >= KEEP_LATEST, "Unsafe retention plan.");
  validateCurrentRefs(mainSha, snapshotSha);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "equinox-r2-prune-"));
  try {
    for (let start = 0; start < plan.deleteKeys.length; start += 1000) {
      validateCurrentRefs(mainSha, snapshotSha);
      const keys = plan.deleteKeys.slice(start, start + 1000);
      const file = path.join(tempRoot, "delete-" + start + ".json");
      fs.writeFileSync(file, JSON.stringify({ Objects: keys.map((Key) => ({ Key })), Quiet: true }), { flag: "wx", mode: 0o600 });
      // R2 accepts quiet bulk deletion with an empty success response.
      // The authoritative proof is the fresh complete inventory check below.
      const receipt = cmd(["aws", "s3api", "delete-objects", "--bucket", BUCKET,
        "--delete", "file://" + file, "--endpoint-url", ENDPOINT, "--output", "json"]);
      const result = receipt.trim() ? JSON.parse(receipt) : {};
      if (!result || typeof result !== "object" || Array.isArray(result) ||
        (Array.isArray(result.Errors) && result.Errors.length)) {
        throw new Error("R2 delete API did not confirm a safe batch response.");
      }
      process.stdout.write("Deleted checked R2 key batch: " + keys.length + "\n");
    }
    const remaining = new Set(inventory().map((object) => object.Key));
    if (plan.deleteKeys.some((key) => remaining.has(key))) {
      throw new Error("Some pruned R2 objects remain after API deletion; manual review required.");
    }
    process.stdout.write("R2 post-deletion inventory verified.\n");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { execute(); } catch (error) { console.error(error instanceof Error ? error.message : "R2 cleanup failed."); process.exitCode = 1; }
}
