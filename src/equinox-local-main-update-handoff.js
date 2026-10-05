function asError(value, fallback) {
  return value instanceof Error ? value : new Error(String(value || fallback));
}

function assertNativeLifecycle(nativeLifecycle) {
  if (!nativeLifecycle || typeof nativeLifecycle.activate !== "function" || typeof nativeLifecycle.rollback !== "function" || typeof nativeLifecycle.commit !== "function") {
    throw new Error("Main update native lifecycle callbacks are incomplete.");
  }
}

async function finishNativeRollback({ engine, transactionId, receipt, nativeLifecycle, restartRuntime, verifyRuntime }) {
  assertNativeLifecycle(nativeLifecycle);
  let rolledBack = receipt;
  try {
    // Restore is deliberately re-run even for rollback_native_restored: exact prior
    // state is an idempotent no-op while drift/partial mutation fails closed.
    await nativeLifecycle.rollback({ nativeActivated: true });
    if (rolledBack.stage === "rollback_source_restored") {
      rolledBack = await engine.markNativeRollbackRestored(transactionId);
    }
    await restartRuntime({ transactionId, sha: rolledBack.rollbackSha, sourceRoot: rolledBack.rollbackSourceRoot, previousSourceRoot: rolledBack.targetSourceRoot, rollback: true });
    const rollbackHealth = await verifyRuntime({ transactionId, sha: rolledBack.rollbackSha, sourceRoot: rolledBack.rollbackSourceRoot, rollback: true });
    if (rollbackHealth !== true) throw new Error("Rollback Equinox Local runtime did not pass health verification.");
    rolledBack = await engine.markRollbackSucceeded(transactionId);
    await engine.releaseStagedLock(transactionId);
    return Object.freeze({ status: "rolled_back", receipt: rolledBack, targetError: rolledBack.lastError ? new Error(rolledBack.lastError) : null });
  } catch (rollbackFailure) {
    const rollbackError = asError(rollbackFailure, "Rollback failed.");
    await engine.markRollbackFailed(transactionId, rollbackError.message).catch(() => {});
    const error = new Error(`Main update interrupted rollback did not recover: ${rollbackError.message}`);
    error.cause = rollbackError;
    throw error;
  }
}

export async function runEquinoxLocalMainUpdateHandoff({
  engine,
  transactionId,
  restartRuntime,
  verifyRuntime,
  nativeLifecycle = null,
  initialReceipt = null,
} = {}) {
  if (!engine || typeof engine.activatePromotion !== "function" || typeof engine.rollbackPromotion !== "function") throw new Error("Main update transaction engine is required.");
  if (typeof restartRuntime !== "function") throw new Error("Main update restart callback is required.");
  if (typeof verifyRuntime !== "function") throw new Error("Main update health callback is required.");

  const initialStage = initialReceipt?.stage ?? "ready_to_switch";
  if (["rollback_source_restored", "rollback_native_restored"].includes(initialStage)) {
    return await finishNativeRollback({ engine, transactionId, receipt: initialReceipt, nativeLifecycle, restartRuntime, verifyRuntime });
  }
  if (!["ready_to_switch", "native_rollback_ready", "native_switched", "source_switched"].includes(initialStage)) {
    throw new Error(`Main update handoff cannot resume from stage ${initialStage}.`);
  }

  let nativeActivated = false;
  let switched;
  try {
    if (nativeLifecycle) {
      assertNativeLifecycle(nativeLifecycle);
      // Re-run exact native activation for interrupted stages. The platform primitives
      // are identity-bound and idempotent: target exact => no-op, expected previous =>
      // complete the switch, any third state => fail closed and rollback.
      nativeActivated = true;
      await nativeLifecycle.activate();
      if (["ready_to_switch", "native_rollback_ready"].includes(initialStage)) {
        await engine.markNativeSwitched(transactionId);
      }
    } else if (["native_rollback_ready", "native_switched"].includes(initialStage)) {
      throw new Error("Main update native receipt stage requires a recoverable native lifecycle.");
    }

    if (initialStage === "source_switched") {
      switched = initialReceipt;
    } else {
      switched = await engine.activatePromotion(transactionId);
    }
    await restartRuntime({ transactionId, sha: switched.targetSha, sourceRoot: switched.targetSourceRoot, previousSourceRoot: switched.rollbackSourceRoot, rollback: false });
    const health = await verifyRuntime({ transactionId, sha: switched.targetSha, sourceRoot: switched.targetSourceRoot, rollback: false });
    if (health !== true) throw new Error("Updated Equinox Local runtime did not pass health verification.");
    if (nativeLifecycle) await nativeLifecycle.commit();
    const succeeded = await engine.markPromotionSucceeded(transactionId);
    await engine.releaseStagedLock(transactionId);
    return Object.freeze({ status: "succeeded", receipt: succeeded });
  } catch (targetFailure) {
    const targetError = asError(targetFailure, "Target runtime failed.");
    let rolledBack;
    try {
      rolledBack = await engine.rollbackPromotion(transactionId, targetError.message, { nativeRollbackPending: Boolean(nativeLifecycle) });
      if (nativeLifecycle) {
        await nativeLifecycle.rollback({ nativeActivated });
        rolledBack = await engine.markNativeRollbackRestored(transactionId);
      }
      await restartRuntime({ transactionId, sha: rolledBack.rollbackSha, sourceRoot: rolledBack.rollbackSourceRoot, previousSourceRoot: rolledBack.targetSourceRoot, rollback: true });
      const rollbackHealth = await verifyRuntime({ transactionId, sha: rolledBack.rollbackSha, sourceRoot: rolledBack.rollbackSourceRoot, rollback: true });
      if (rollbackHealth !== true) throw new Error("Rollback Equinox Local runtime did not pass health verification.");
      if (nativeLifecycle) rolledBack = await engine.markRollbackSucceeded(transactionId);
      await engine.releaseStagedLock(transactionId);
      return Object.freeze({ status: "rolled_back", receipt: rolledBack, targetError });
    } catch (rollbackFailure) {
      const rollbackError = asError(rollbackFailure, "Rollback failed.");
      await engine.markRollbackFailed(transactionId, rollbackError.message).catch(() => {});
      const error = new Error(`Main update target failed and rollback did not recover: ${targetError.message}; rollback: ${rollbackError.message}`);
      error.cause = rollbackError;
      throw error;
    }
  }
}
