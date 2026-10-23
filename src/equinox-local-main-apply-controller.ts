import path from "node:path";

import { prepareAndScheduleEquinoxLocalMainUpdate } from "./equinox-local-main-update-coordinator.js";

type ScheduleInput=Parameters<typeof prepareAndScheduleEquinoxLocalMainUpdate>[0];
type ScheduleResult=Readonly<{status?:string;targetSha?:string;[key:string]:unknown}>;
type MainApply= (input:ScheduleInput)=>Promise<ScheduleResult>;
type Install=Readonly<{
  kind?:string;mainUpdateSupported?:boolean;mainUpdateReason?:string;
  sourceRoot?:string;mainTransactionRoot?:string;gitPath?:string;
  nodePath?:string;npmPath?:string|null;shellPath?:string|null;
  mainSchedulerOptions?:NonNullable<ScheduleInput['schedulerOptions']>;
}>;
type DiscoverySnapshot=Readonly<{
  checkSupported?:boolean;state?:string;currentSha?:string|null;
  targetSha?:string|null;dirty?:boolean|null;remoteCanonical?:boolean|null;
}>;
type Discovery=Readonly<{snapshot:()=>DiscoverySnapshot}>;
type Options={installation?:Install;discovery?:Discovery;applyImpl?:MainApply};

const SHA_PATTERN = /^[a-f0-9]{40}$/u;

function validAbsolute(value:unknown):value is string {
  return typeof value === "string" && path.isAbsolute(value) && !/[\r\n\0]/u.test(value);
}

function unavailableReason(installation:Install|undefined):string|null {
  if (installation?.kind !== "managed-source") {
    return "Main apply is available only for managed-source installations.";
  }
  if (installation?.mainUpdateSupported !== true) {
    return installation?.mainUpdateReason || "This managed-source installation has not enabled Main update handoff.";
  }
  if (!validAbsolute(installation?.sourceRoot) || !validAbsolute(installation?.mainTransactionRoot)) {
    return "Managed-source update paths are unavailable.";
  }
  return null;
}

export function createEquinoxLocalMainApplyController({
  installation,
  discovery,
  applyImpl = prepareAndScheduleEquinoxLocalMainUpdate,
}:Options = {}) {
  if (!discovery || typeof discovery.snapshot !== "function") {
    throw new Error("Main update discovery is required by the apply controller.");
  }
  if (typeof applyImpl !== "function") {
    throw new Error("Main update apply implementation is required.");
  }

  let applying = false;
  let restartScheduledFor:string|null = null;
  let lastError:string|null = null;

  const snapshot = () => {
    const main = discovery.snapshot();
    const reason = unavailableReason(installation);
    const applySupported = reason === null && main?.checkSupported === true;
    const applyAvailable = Boolean(
      applySupported
      && main?.state === "behind"
      && SHA_PATTERN.test(main?.currentSha ?? "")
      && SHA_PATTERN.test(main?.targetSha ?? "")
      && main?.currentSha !== main?.targetSha
      && main?.dirty === false
      && main?.remoteCanonical === true
      && !lastError,
    );
    return Object.freeze({
      applySupported,
      applyAvailable,
      applying,
      restartScheduledFor,
      applyReason: reason,
      applyError: lastError,
    });
  };

  const resetError = () => {
    lastError = null;
    return snapshot();
  };

  const apply = async () => {
    if (applying) throw new Error("A Main update is already being prepared.");
    const status = snapshot();
    if (!status.applySupported) {
      throw new Error(status.applyReason || "Main update apply is unavailable.");
    }

    const main = discovery.snapshot();
    if (!status.applyAvailable) {
      throw new Error("Check the admitted Main snapshot and require a newer eligible target before applying.");
    }

    const currentSha = main.currentSha!;
    const targetSha = main.targetSha!;
    applying = true;
    lastError = null;
    try {
      const result = await applyImpl({
        sourceRoot: path.resolve(installation!.sourceRoot!),
        transactionRoot: path.resolve(installation!.mainTransactionRoot!),
        currentSha,
        targetSha,
        engineOptions: {
          gitPath: installation!.gitPath ?? "git",
          nodePath: installation!.nodePath ?? process.execPath,
          npmPath: installation!.npmPath ?? null,
          shellPath: installation!.shellPath ?? null,
        },
        schedulerOptions: {
          ...(installation!.mainSchedulerOptions ?? {}),
          ...(installation!.nodePath ? { nodePath: installation!.nodePath } : {}),
        },
      });
      if (result?.targetSha !== targetSha || result?.status !== "scheduled") {
        throw new Error("Main update handoff did not preserve the admitted target identity.");
      }
      restartScheduledFor = targetSha;
      return Object.freeze({
        ...result,
        currentSha,
        targetSha,
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      applying = false;
    }
  };

  return Object.freeze({ snapshot, apply, resetError });
}
