import assert from "node:assert/strict";
import test from "node:test";
import { createEquinoxLocalMainNativePointerTransition } from "../../src/equinox-local-main-native-pointer-transition.js";

const A = { sourceSha: "a".repeat(40), target: "win32-x64", runtimeContractSha256: "1".repeat(64) };
const B = { sourceSha: "b".repeat(40), target: "win32-x64", runtimeContractSha256: "2".repeat(64) };
const path = "/virtual/current-native.json";
function fixture(previous) {
  let onDisk = previous;
  const events = [];
  const options = {
    pointerPath: path,
    transactionRoot: "/virtual",
    target: B,
    previous,
    readPointer: async () => onDisk ?? Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
    writePointer: async (_path, identity) => {
      events.push(["write", identity.sourceSha]);
      onDisk = identity;
      return identity;
    },
    fsImpl: {
      unlink: async () => { events.push(["unlink"]); onDisk = null; },
    },
  };
  return { events, get current() { return onDisk; }, transition: createEquinoxLocalMainNativePointerTransition(options) };
}

test("Windows B native pointer is selected before WPF restart and idempotently committed", async () => {
  const f = fixture(A);
  await f.transition.selectTarget();
  assert.equal(f.current.sourceSha, B.sourceSha);
  await f.transition.selectTarget();
  await f.transition.requireTarget();
  assert.deepEqual(f.events, [["write", B.sourceSha]]);
  await f.transition.restorePrevious();
  assert.equal(f.current.sourceSha, A.sourceSha);
  await f.transition.restorePrevious();
  assert.deepEqual(f.events, [["write", B.sourceSha], ["write", A.sourceSha]]);
});

test("first Main native upgrade restores absent A pointer instead of leaving B selected", async () => {
  const f = fixture(null);
  await f.transition.selectTarget();
  assert.equal(f.current.sourceSha, B.sourceSha);
  await f.transition.restorePrevious();
  assert.equal(f.current, null);
  assert.deepEqual(f.events, [["write", B.sourceSha], ["unlink"]]);
});

test("unexpected third-party pointer identity prevents B selection, commit and rollback", async () => {
  const outsider = { sourceSha: "c".repeat(40), target: "win32-x64", runtimeContractSha256: "3".repeat(64) };
  const f = fixture(A);
  const fOutsider = createEquinoxLocalMainNativePointerTransition({
    pointerPath: path, transactionRoot: "/virtual", target: B, previous: A,
    readPointer: async () => outsider,
    writePointer: async () => assert.fail("Foreign native pointer must never be replaced"),
  });
  await assert.rejects(fOutsider.selectTarget(), /switched away/u);
  await assert.rejects(fOutsider.restorePrevious(), /no longer belongs/u);
  await assert.rejects(fOutsider.requireTarget(), /not durably selected/u);
  assert.deepEqual(f.events, []);
});
