import assert from "node:assert/strict";
import test from "node:test";
import { createEquinoxLocalMainChannelNotice } from "../../src/equinox-local-update-awareness.js";
const SHA = "a".repeat(40);
const makeResponse = (value) => new Response(JSON.stringify(value), { status: 200 });

test("Stable Main information accepts only the public admitted commit-tag target and caches checks", async () => {
  let calls = 0;
  let clock = Date.parse("2026-10-08T12:00:00.000Z");
  const notice = createEquinoxLocalMainChannelNotice({
    now: () => new Date(clock),
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, "https://api.github.com/repos/sametbasbug/equinox-local/git/ref/tags/main-snapshot");
      assert.equal(options.credentials, "omit");
      return makeResponse({ ref: "refs/tags/main-snapshot", object: { type: "commit", sha: SHA } });
    },
  });
  assert.equal(notice.snapshot().targetSha, null);
  assert.equal((await notice.check()).targetSha, SHA);
  await notice.check();
  assert.equal(calls, 1);
  clock += 6 * 60 * 60_000 + 1;
  await notice.check();
  assert.equal(calls, 2);
});

test("Main informational check fails closed on invalid tags and network errors", async () => {
  let count = 0;
  const notice = createEquinoxLocalMainChannelNotice({
    fetchImpl: async () => ++count === 1
      ? makeResponse({ ref: "refs/tags/main-snapshot", object: { type: "tag", sha: SHA } })
      : Promise.reject(new Error("offline")),
  });
  assert.equal((await notice.check()).targetSha, null);
  assert.match(notice.snapshot().lastError, /unavailable/u);
  assert.equal((await notice.check({ force: true })).targetSha, null);
  assert.equal(count, 2);
});

test("Parallel Main notice checks share one in-flight request", async () => {
  let calls = 0;
  const notice = createEquinoxLocalMainChannelNotice({ fetchImpl: async () => { calls++; return makeResponse({ ref: "refs/tags/main-snapshot", object: { type: "commit", sha: SHA } }); } });
  const [a, b] = await Promise.all([notice.check(), notice.check()]);
  assert.equal(calls, 1);
  assert.equal(a.targetSha, b.targetSha);
});
