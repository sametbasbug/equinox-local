function asError(value, fallback) {
  return value instanceof Error ? value : new Error(String(value || fallback));
}

export async function runEquinoxLocalMainUpdateHandoff({
  engine,
  transactionId,
  restartRuntime,
  verifyRuntime,
} = {}) {
  if (!engine || typeof engine.activatePromotion !== "function" || typeof engine.rollbackPromotion !== "function") throw new Error("Main update transaction engine is required.");
  if (typeof restartRuntime !== "function") throw new Error("Main update restart callback is required.");
  if (typeof verifyRuntime !== "function") throw new Error("Main update health callback is required.");

  const switched = await engine.activatePromotion(transactionId);
  try {
    await restartRuntime({ transactionId, sha: switched.targetSha, sourceRoot: switched.targetSourceRoot, rollback: false });
    const health = await verifyRuntime({ transactionId, sha: switched.targetSha, sourceRoot: switched.targetSourceRoot, rollback: false });
    if (health !== true) throw new Error("Updated Equinox Local runtime did not pass health verification.");
    const succeeded = await engine.markPromotionSucceeded(transactionId);
    await engine.releaseStagedLock(transactionId);
    return Object.freeze({ status: "succeeded", receipt: succeeded });
  } catch (targetFailure) {
    const targetError = asError(targetFailure, "Target runtime failed.");
    let rolledBack;
    try {
      rolledBack = await engine.rollbackPromotion(transactionId, targetError.message);
      await restartRuntime({ transactionId, sha: rolledBack.rollbackSha, sourceRoot: rolledBack.rollbackSourceRoot, rollback: true });
      const rollbackHealth = await verifyRuntime({ transactionId, sha: rolledBack.rollbackSha, sourceRoot: rolledBack.rollbackSourceRoot, rollback: true });
      if (rollbackHealth !== true) throw new Error("Rollback Equinox Local runtime did not pass health verification.");
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
