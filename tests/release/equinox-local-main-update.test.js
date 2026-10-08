import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  createEquinoxLocalMainUpdateDiscovery,
  EQUINOX_LOCAL_MAIN_REMOTE,
  EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG,
  isCanonicalMainRemote,
  validateManagedSourceInstallStamp,
} from "../../src/equinox-local-main-update.js";

const ROOT = path.join(path.parse(process.cwd()).root, "equinox-main-update-fixture");
const CURRENT = "1".repeat(40);
const TARGET = "2".repeat(40);

function fsMock() {
  return {
    async lstat() { return { isDirectory: () => true, isSymbolicLink: () => false }; },
    async realpath(value) { return value; },
  };
}

function gitMock({ branch = "main", remote = EQUINOX_LOCAL_MAIN_REMOTE, dirty = "", detached = false, sha = CURRENT } = {}) {
  const calls = [];
  const execFileImpl = async (command, args) => {
    calls.push({ command, args: [...args] });
    const gitArgs = args.slice(2);
    const key = gitArgs.join(" ");
    if (key === "rev-parse --show-toplevel") return { stdout: `${ROOT}\n`, stderr: "" };
    if (key === "rev-parse HEAD") return { stdout: `${sha}\n`, stderr: "" };
    if (key === "symbolic-ref --quiet --short HEAD") {
      if (detached) { const error = new Error("detached"); error.code = 1; throw error; }
      return { stdout: `${branch}\n`, stderr: "" };
    }
    if (key === "remote get-url origin") return { stdout: `${remote}\n`, stderr: "" };
    if (key === "status --porcelain=v1 --untracked-files=normal") return { stdout: dirty, stderr: "" };
    throw new Error(`Unexpected git command: ${key}`);
  };
  return { calls, execFileImpl };
}

function comparePayload({ status = "ahead", aheadBy = 2, behindBy = 0 } = {}) {
  return {
    url: "https://api.github.com/example",
    html_url: "https://github.com/example",
    permalink_url: "https://github.com/example",
    diff_url: "https://github.com/example.diff",
    patch_url: "https://github.com/example.patch",
    base_commit: { sha: CURRENT },
    merge_base_commit: { sha: CURRENT },
    status,
    ahead_by: aheadBy,
    behind_by: behindBy,
    total_commits: aheadBy,
    commits: [
      { sha: TARGET, commit: { message: "Improve updater\nbody", author: { date: "2026-10-04T08:00:00Z" } } },
    ],
    files: [],
  };
}

function fetchSequence(responses, calls = []) {
  let index = 0;
  return async (url, options) => {
    calls.push({ url, options });
    const response = responses[index++];
    if (response instanceof Error) throw response;
    return response;
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function discovery({ git = gitMock(), fetchImpl, now = () => new Date("2026-10-04T09:00:00Z"), cacheTtlMs = 60_000 } = {}) {
  return {
    git,
    value: createEquinoxLocalMainUpdateDiscovery({
      installation: { kind: "source" },
      sourceRoot: ROOT,
      fsImpl: fsMock(),
      execFileImpl: git.execFileImpl,
      fetchImpl,
      now,
      cacheTtlMs,
    }),
  };
}

test("managed-source install stamp pins canonical main identity", () => {
  assert.deepEqual(validateManagedSourceInstallStamp({
    schemaVersion: 1,
    channel: "main",
    repository: "sametbasbug/equinox-local",
    branch: "main",
    bootstrapSha: CURRENT,
  }), {
    schemaVersion: 1,
    channel: "main",
    repository: "sametbasbug/equinox-local",
    branch: "main",
    bootstrapSha: CURRENT,
  });
  assert.throws(() => validateManagedSourceInstallStamp({
    schemaVersion: 1, channel: "main", repository: "someone/fork", branch: "main", bootstrapSha: CURRENT,
  }), /not canonical/u);
  assert.equal(isCanonicalMainRemote("https://github.com/sametbasbug/equinox-local"), true);
  assert.equal(isCanonicalMainRemote("git@github.com:sametbasbug/equinox-local.git"), true);
  assert.equal(isCanonicalMainRemote("https://github.com/someone/fork.git"), false);
});

test("managed-source installations use the same admitted Main discovery contract", async () => {
  const git = gitMock();
  const value = createEquinoxLocalMainUpdateDiscovery({
    installation: { kind: "managed-source" },
    sourceRoot: ROOT,
    fsImpl: fsMock(),
    execFileImpl: git.execFileImpl,
    fetchImpl: fetchSequence([
      jsonResponse({ ref: "refs/tags/" + EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG, object: { type: "commit", sha: CURRENT } }),
    ]),
  });
  const status = await value.check({ force: true });
  assert.equal(status.checkSupported, true);
  assert.equal(status.state, "up_to_date");
  assert.equal(status.targetSha, CURRENT);
});

test("passive main check reports up to date without mutating Git refs", async () => {
  const network = [];
  const { git, value } = discovery({
    fetchImpl: fetchSequence([jsonResponse({ ref: `refs/tags/${EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG}`, object: { type: "commit", sha: CURRENT } })], network),
  });
  const status = await value.check();
  assert.equal(status.state, "up_to_date");
  assert.equal(status.currentSha, CURRENT);
  assert.equal(status.targetSha, CURRENT);
  assert.equal(status.behindBy, 0);
  assert.equal(network.length, 1);
  assert.match(network[0].url, /\/git\/ref\/tags\/main-snapshot$/u);
  assert.equal(network[0].url.includes("/branches/main"), false);
  assert.equal(git.calls.some(({ args }) => args.includes("fetch") || args.includes("pull") || args.includes("reset")), false);
  assert.equal(git.calls.every(({ args }) => args[0] === "-C" && args[1] === ROOT), true);
});

test("passive main check reports behind distance and bounded summaries", async () => {
  const { value } = discovery({
    fetchImpl: fetchSequence([
      jsonResponse({ ref: `refs/tags/${EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG}`, object: { type: "commit", sha: TARGET } }),
      jsonResponse(comparePayload({ status: "ahead", aheadBy: 2, behindBy: 0 })),
    ]),
  });
  const status = await value.check();
  assert.equal(status.state, "behind");
  assert.equal(status.behindBy, 2);
  assert.equal(status.aheadBy, 0);
  assert.equal(status.summaries[0].shortSha, TARGET.slice(0, 7));
  assert.equal(status.summaries[0].message, "Improve updater");
});

test("dirty, detached, non-main and fork checkouts fail closed before network", async () => {
  for (const [expected, git] of [
    ["dirty", gitMock({ dirty: " M src/server.js\n" })],
    ["detached", gitMock({ detached: true })],
    ["unsupported", gitMock({ branch: "feature" })],
    ["unsupported", gitMock({ remote: "https://github.com/someone/fork.git" })],
  ]) {
    let fetched = false;
    const { value } = discovery({ git, fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); } });
    const status = await value.check({ force: true });
    assert.equal(status.state, expected);
    assert.equal(fetched, false);
  }
});

test("Main discovery accepts only the exact lightweight main-snapshot commit ref", async () => {
  for (const payload of [
    { ref: "refs/tags/main-snapshot", object: { type: "tag", sha: TARGET } },
    { ref: "refs/tags/other", object: { type: "commit", sha: TARGET } },
    { ref: "refs/tags/main-snapshot", object: { type: "commit", sha: "BAD" } },
  ]) {
    const { value } = discovery({ fetchImpl: fetchSequence([jsonResponse(payload)]) });
    const status = await value.check({ force: true });
    assert.equal(status.state, "unavailable");
    assert.equal(status.targetSha, null);
    assert.match(status.reason, /not an up-to-date result/u);
  }
});

test("network and deleted-main failures are unavailable, never up to date", async () => {
  for (const response of [
    new Error("offline"),
    jsonResponse({ message: "Not Found" }, 404),
  ]) {
    const { value } = discovery({ fetchImpl: fetchSequence([response]) });
    const status = await value.check({ force: true });
    assert.equal(status.state, "unavailable");
    assert.equal(status.targetSha, null);
    assert.match(status.reason, /not an up-to-date result/u);
    assert.ok(status.lastError);
  }
});

test("divergent and locally-ahead histories remain distinct states", async () => {
  for (const [remoteStatus, expected, aheadBy, behindBy] of [
    ["diverged", "diverged", 3, 2],
    ["behind", "ahead", 0, 4],
  ]) {
    const { value } = discovery({
      fetchImpl: fetchSequence([
        jsonResponse({ ref: `refs/tags/${EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG}`, object: { type: "commit", sha: TARGET } }),
        jsonResponse(comparePayload({ status: remoteStatus, aheadBy, behindBy })),
      ]),
    });
    const status = await value.check({ force: true });
    assert.equal(status.state, expected);
    assert.equal(status.behindBy, aheadBy);
    assert.equal(status.aheadBy, behindBy);
  }
});

test("passive checks use a bounded cache", async () => {
  const calls = [];
  let clock = Date.parse("2026-10-04T09:00:00Z");
  const { value } = discovery({
    fetchImpl: fetchSequence([
      jsonResponse({ ref: `refs/tags/${EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG}`, object: { type: "commit", sha: CURRENT } }),
      jsonResponse({ ref: `refs/tags/${EQUINOX_LOCAL_MAIN_SNAPSHOT_TAG}`, object: { type: "commit", sha: CURRENT } }),
    ], calls),
    now: () => new Date(clock),
    cacheTtlMs: 60_000,
  });
  await value.check();
  clock += 30_000;
  await value.check();
  assert.equal(calls.length, 1);
  clock += 31_000;
  await value.check();
  assert.equal(calls.length, 2);
});


test("Control Center keeps developer source check-only and enables managed-source Main apply", async () => {
  const [html, ui, macApp] = await Promise.all([
    fs.readFile(new URL("../../src/equinox-control-center.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../../src/equinox-control-center.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../../app/EquinoxLocalApp.swift", import.meta.url), "utf8"),
  ]);
  for (const id of ["update-main-meta", "update-main-current", "update-main-target", "update-main-distance", "update-main-summaries"]) {
    assert.equal(html.includes(`id="${id}"`), true);
  }
  assert.match(ui, /main\.state === "behind"/u);
  assert.match(ui, /main\.state === "up_to_date"/u);
  assert.match(ui, /main\.state === "diverged"/u);
  assert.match(ui, /main\.state === "unavailable"/u);
  assert.match(ui, /\["source", "managed-source"\]\.includes\(update\.installationKind\)/u);
  assert.match(ui, /managedMain && main\.applyAvailable/u);
  assert.match(ui, /This developer source checkout remains check-only/u);
  assert.match(ui, /scheduled\.targetSha/u);
  assert.match(ui, /Check main/u);
  assert.match(ui, /Update & restart/u);
  assert.match(macApp, /installationKind == "managed-source"/u);
  assert.match(macApp, /main\["applyAvailable"\] as\? Bool == true/u);
  assert.match(macApp, /main\["targetSha"\] as\? String/u);
  assert.match(macApp, /"Main " \+ String\(targetSha\.prefix\(7\)\)/u);
});
