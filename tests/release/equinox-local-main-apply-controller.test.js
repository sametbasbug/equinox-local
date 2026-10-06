import assert from "node:assert/strict";
import test from "node:test";

import { createEquinoxLocalMainApplyController } from "../../src/equinox-local-main-apply-controller.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

function discovery(value) {
  return { snapshot: () => value };
}

function installation(extra = {}) {
  return {
    kind: "managed-source",
    mainUpdateSupported: true,
    sourceRoot: "/owned/main-update/sources/current",
    mainTransactionRoot: "/owned/main-update",
    ...extra,
  };
}

test("managed-source apply controller binds apply to the exact admitted discovery target", async () => {
  const calls = [];
  const value = discovery({
    checkSupported: true,
    state: "behind",
    currentSha: A,
    targetSha: B,
    dirty: false,
    remoteCanonical: true,
  });
  const controller = createEquinoxLocalMainApplyController({
    installation: installation(),
    discovery: value,
    applyImpl: async (input) => {
      calls.push(input);
      return { status: "scheduled", transactionId: "main-fixture", targetSha: B };
    },
  });

  assert.deepEqual(controller.snapshot(), {
    applySupported: true,
    applyAvailable: true,
    applying: false,
    restartScheduledFor: null,
    applyReason: null,
    applyError: null,
  });

  const result = await controller.apply();
  assert.equal(result.targetSha, B);
  assert.equal(controller.snapshot().restartScheduledFor, B);
  assert.deepEqual(calls, [{
    sourceRoot: "/owned/main-update/sources/current",
    transactionRoot: "/owned/main-update",
    currentSha: A,
    targetSha: B,
    schedulerOptions: {},
  }]);
});

test("Main apply remains unavailable for developer source and non-behind discovery states", async () => {
  const source = createEquinoxLocalMainApplyController({
    installation: { kind: "source" },
    discovery: discovery({ checkSupported: true, state: "behind", currentSha: A, targetSha: B, dirty: false, remoteCanonical: true }),
  });
  assert.equal(source.snapshot().applySupported, false);
  await assert.rejects(source.apply(), /managed-source/u);

  for (const state of ["up_to_date", "ahead", "diverged", "dirty", "unavailable"]) {
    const controller = createEquinoxLocalMainApplyController({
      installation: installation(),
      discovery: discovery({ checkSupported: true, state, currentSha: A, targetSha: B, dirty: state === "dirty", remoteCanonical: true }),
    });
    assert.equal(controller.snapshot().applyAvailable, false);
    await assert.rejects(controller.apply(), /newer eligible target/u);
  }
});

test("Main apply rejects unsafe identity and handoff drift", async () => {
  for (const invalid of [
    installation({ mainUpdateSupported: false, mainUpdateReason: "handoff unavailable" }),
    installation({ sourceRoot: "relative/source" }),
    installation({ mainTransactionRoot: "relative/state" }),
  ]) {
    const controller = createEquinoxLocalMainApplyController({
      installation: invalid,
      discovery: discovery({ checkSupported: true, state: "behind", currentSha: A, targetSha: B, dirty: false, remoteCanonical: true }),
    });
    assert.equal(controller.snapshot().applySupported, false);
  }

  const controller = createEquinoxLocalMainApplyController({
    installation: installation(),
    discovery: discovery({ checkSupported: true, state: "behind", currentSha: A, targetSha: B, dirty: false, remoteCanonical: true }),
    applyImpl: async () => ({ status: "scheduled", transactionId: "main-fixture", targetSha: "c".repeat(40) }),
  });
  await assert.rejects(controller.apply(), /target identity/u);
  assert.match(controller.snapshot().applyError, /target identity/u);
});

test("a successful Main re-check can clear a previous apply failure for retry", async () => {
  let fail = true;
  const controller = createEquinoxLocalMainApplyController({
    installation: installation(),
    discovery: discovery({ checkSupported: true, state: "behind", currentSha: A, targetSha: B, dirty: false, remoteCanonical: true }),
    applyImpl: async () => {
      if (fail) throw new Error("temporary handoff failure");
      return { status: "scheduled", transactionId: "main-retry", targetSha: B };
    },
  });
  await assert.rejects(controller.apply(), /temporary handoff failure/u);
  assert.equal(controller.snapshot().applyAvailable, false);
  controller.resetError();
  assert.equal(controller.snapshot().applyAvailable, true);
  fail = false;
  const retried = await controller.apply();
  assert.equal(retried.targetSha, B);
});
