function asError(value, fallback) {
  return value instanceof Error ? value : new Error(String(value || fallback));
}

function nativeGuardianRecoveryRequired(cause) {
  const pending = new Error("Guardian-owned Main native recovery awaits OS-authorized physical A restore; B pointers and A backup are preserved.");
  pending.code = "EQUINOX_NATIVE_OS_RECOVERY_REQUIRED";
  if (cause) pending.cause = cause;
  return pending;
}

function assertNativeLifecycle(nativeLifecycle) {
  if (!nativeLifecycle || typeof nativeLifecycle.activate !== "function" || typeof nativeLifecycle.rollback !== "function" || typeof nativeLifecycle.commit !== "function") {
    throw new Error("Main update native lifecycle callbacks are incomplete.");
  }
  if (nativeLifecycle.journaledAB === true && !["selectRuntime", "recordRestarted", "recordHealthy", "recordRollbackHealthy", "finalizeCommitted", "finalizeRolledBack"].every((key) => typeof nativeLifecycle[key] === "function")) {
    throw new Error("Windows journaled native A/B lifecycle requires every verified milestone and terminal finalizer.");
  }
}

async function finishNativeRollback({ engine, transactionId, receipt, nativeLifecycle, restartRuntime, verifyRuntime }) {
  assertNativeLifecycle(nativeLifecycle);
  let rolledBack = receipt;
  try {
    // Restore is deliberately re-run even for rollback_native_restored: exact prior
    // state is an idempotent no-op while drift/partial mutation fails closed.
    await nativeLifecycle.rollback({ nativeActivated: true });
    if (nativeLifecycle.journaledAB === true) await nativeLifecycle.selectRuntime({ rollback: true });
    if (rolledBack.stage === "rollback_source_restored") {
      rolledBack = await engine.markNativeRollbackRestored(transactionId);
    }
    await restartRuntime({ transactionId, sha: rolledBack.rollbackSha, sourceRoot: rolledBack.rollbackSourceRoot, previousSourceRoot: rolledBack.targetSourceRoot, rollback: true });
    const rollbackHealth = await verifyRuntime({ transactionId, sha: rolledBack.rollbackSha, sourceRoot: rolledBack.rollbackSourceRoot, rollback: true });
    if (rollbackHealth !== true) throw new Error("Rollback Equinox Local runtime did not pass health verification.");
    if (nativeLifecycle.journaledAB === true) await nativeLifecycle.recordRollbackHealthy();
    rolledBack = await engine.markRollbackSucceeded(transactionId);
    // After a durable terminal receipt, failure to finalize is NOT a reason
    // to run the destructive rollback path a second time.
    if (nativeLifecycle.journaledAB === true) {
      try { await nativeLifecycle.finalizeRolledBack(); }
      catch (failure) { throw Object.assign(new Error(`Native rollback committed but cleanup remains pending: ${failure.message}`), { terminalReceipt: true, cause: failure }); }
    }
    await engine.releaseStagedLock(transactionId);
    return Object.freeze({ status: "rolled_back", receipt: rolledBack, targetError: rolledBack.lastError ? new Error(rolledBack.lastError) : null });
  } catch (rollbackFailure) {
    if (rollbackFailure?.terminalReceipt === true) throw rollbackFailure;
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
  // Validate before entering any promotion/rollback catch path. An incomplete
  // journaled adapter cannot be mistaken for a failed target to recover.
  if (nativeLifecycle) assertNativeLifecycle(nativeLifecycle);

  const initialStage = initialReceipt?.stage ?? "ready_to_switch";
  if (["rollback_source_restored", "rollback_native_restored"].includes(initialStage)) {
    if (nativeLifecycle?.journaledAB === true && nativeLifecycle?.nativeOwnsMilestones === true) {
      // An old/stale JS source-only rollback receipt cannot grant WPF A
      // restoration after a native Guardian was installed as sole writer.
      throw nativeGuardianRecoveryRequired();
    }
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
    // Only after the durable B source pointer has advanced may native B become
    // the WPF runtime selected on disk. Both must be exact before launch.
    if (nativeLifecycle?.journaledAB === true) await nativeLifecycle.selectRuntime({ rollback: false });
    await restartRuntime({ transactionId, sha: switched.targetSha, sourceRoot: switched.targetSourceRoot, previousSourceRoot: switched.rollbackSourceRoot, rollback: false });
    if (nativeLifecycle?.journaledAB === true) await nativeLifecycle.recordRestarted();
    const health = await verifyRuntime({ transactionId, sha: switched.targetSha, sourceRoot: switched.targetSourceRoot, rollback: false });
    if (health !== true) throw new Error("Updated Equinox Local runtime did not pass health verification.");
    if (nativeLifecycle?.journaledAB === true) await nativeLifecycle.recordHealthy();
    if (nativeLifecycle) await nativeLifecycle.commit();
    const succeeded = await engine.markPromotionSucceeded(transactionId);
    if (nativeLifecycle?.journaledAB === true) {
      try { await nativeLifecycle.finalizeCommitted(); }
      catch (failure) { throw Object.assign(new Error(`Native B receipt committed but A backup cleanup remains pending: ${failure.message}`), { terminalReceipt: true, cause: failure }); }
    }
    await engine.releaseStagedLock(transactionId);
    return Object.freeze({ status: "succeeded", receipt: succeeded });
  } catch (targetFailure) {
    // Successful terminal receipt is irreversible; keep A on disk for a
    // trusted follow-up reconciler instead of trying to rollback committed B.
    if (targetFailure?.terminalReceipt === true) throw targetFailure;
    const targetError = asError(targetFailure, "Target runtime failed.");
    if (nativeLifecycle?.journaledAB === true && nativeLifecycle?.nativeOwnsMilestones === true) {
      // An original Guardian may have B restarted/4 and retained physical A,
      // but independent OS-owned physical A restoration is NOT implemented.
      // engine.rollbackPromotion() mutates the managed source pointer to A;
      // doing so BEFORE the OS Guardian restores A's WPF/native/NM identity
      // creates a cross-version runtime. Preserve both exact B pointers,
      // retained A, native journal and the staged lock for manual, trusted
      // reconciliation. Do not claim terminal rollback_failed: no rollback
      // was ever independently authorized or attempted.
      throw nativeGuardianRecoveryRequired(targetError);
    }
    let rolledBack;
    try {
      rolledBack = await engine.rollbackPromotion(transactionId, targetError.message, { nativeRollbackPending: Boolean(nativeLifecycle) });
      if (nativeLifecycle) {
        await nativeLifecycle.rollback({ nativeActivated });
        if (nativeLifecycle.journaledAB === true) await nativeLifecycle.selectRuntime({ rollback: true });
        rolledBack = await engine.markNativeRollbackRestored(transactionId);
      }
      await restartRuntime({ transactionId, sha: rolledBack.rollbackSha, sourceRoot: rolledBack.rollbackSourceRoot, previousSourceRoot: rolledBack.targetSourceRoot, rollback: true });
      const rollbackHealth = await verifyRuntime({ transactionId, sha: rolledBack.rollbackSha, sourceRoot: rolledBack.rollbackSourceRoot, rollback: true });
      if (rollbackHealth !== true) throw new Error("Rollback Equinox Local runtime did not pass health verification.");
      if (nativeLifecycle?.journaledAB === true) await nativeLifecycle.recordRollbackHealthy();
      if (nativeLifecycle) rolledBack = await engine.markRollbackSucceeded(transactionId);
      if (nativeLifecycle?.journaledAB === true) {
        try { await nativeLifecycle.finalizeRolledBack(); }
        catch (failure) { throw Object.assign(new Error(`Native rollback committed but cleanup remains pending: ${failure.message}`), { terminalReceipt: true, cause: failure }); }
      }
      await engine.releaseStagedLock(transactionId);
      return Object.freeze({ status: "rolled_back", receipt: rolledBack, targetError });
    } catch (rollbackFailure) {
      if (rollbackFailure?.terminalReceipt === true) throw rollbackFailure;
      const rollbackError = asError(rollbackFailure, "Rollback failed.");
      await engine.markRollbackFailed(transactionId, rollbackError.message).catch(() => {});
      const error = new Error(`Main update target failed and rollback did not recover: ${targetError.message}; rollback: ${rollbackError.message}`);
      error.cause = rollbackError;
      throw error;
    }
  }
}
