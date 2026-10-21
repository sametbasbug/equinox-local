import type { EventEmitter } from "node:events";

type LifecycleEmitter = Pick<EventEmitter,"once"|"off"> & {
  resume?:()=>unknown;
  pause?:()=>unknown;
};
type RuntimeLifecycleOptions = {
  connect?:()=>Promise<unknown>|unknown;
  shutdown?:(input:{reason:string})=>Promise<unknown>|unknown;
  stdin?:LifecycleEmitter;
  consumeOwnedStdin?:boolean;
  processLike?:LifecycleEmitter;
  exit?:(code:number)=>unknown;
  signals?:readonly string[];
};
type LifecycleControl = Readonly<{
  detach:()=>void;
  shutdown:()=>Promise<void>;
}>;

const DEFAULT_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);

function assertEmitter(value:unknown,label:string):LifecycleEmitter {
  if (!value || typeof (value as LifecycleEmitter).once !== "function" || typeof (value as LifecycleEmitter).off !== "function") {
    throw new Error(`${label} must expose once/off event methods.`);
  }
  return value as LifecycleEmitter;
}

export async function startRuntimeLifecycle({
  connect,
  shutdown,
  stdin = process.stdin,
  consumeOwnedStdin = false,
  processLike = process,
  exit = (code) => process.exit(code),
  signals = DEFAULT_SIGNALS,
}:RuntimeLifecycleOptions = {}):Promise<LifecycleControl> {
  if (typeof connect !== "function") {
    throw new Error("Runtime lifecycle connect callback is required.");
  }
  if (typeof shutdown !== "function") {
    throw new Error("Runtime lifecycle shutdown callback is required.");
  }
  if (typeof exit !== "function") {
    throw new Error("Runtime lifecycle exit callback is required.");
  }
  assertEmitter(stdin, "Runtime lifecycle stdin");
  assertEmitter(processLike, "Runtime lifecycle process");
  if (!Array.isArray(signals) || signals.length === 0 || signals.some((signal) => typeof signal !== "string" || !signal)) {
    throw new Error("Runtime lifecycle signals must be a non-empty string array.");
  }

  let detached = false;
  let shutdownPromise:Promise<unknown>|null = null;
  let ownedStdinResumed = false;
  let signalExitScheduled = false;

  const beginShutdown = (reason:string = "api"):Promise<unknown> => {
    if (!shutdownPromise) {
      shutdownPromise = Promise.resolve().then(() => shutdown({ reason }));
    }
    return shutdownPromise;
  };

  const detach = () => {
    if (detached) return;
    detached = true;
    stdin.off("end", onStdinEnd);
    if (ownedStdinResumed && typeof stdin.pause === "function") stdin.pause();
    for (const signal of signals) {
      processLike.off(signal, signalHandlers.get(signal)!);
    }
  };

  const onStdinEnd = () => {
    if (consumeOwnedStdin && process.platform === "win32") {
      process.stderr.write("[Equinox Windows supervisor] state=local-only-stdin-eof.\n");
    }
    void beginShutdown("stdin_end").finally(detach);
  };

  const onSignal = (signal:string) => {
    if (signalExitScheduled) return;
    signalExitScheduled = true;
    void beginShutdown(signal).finally(() => {
      detach();
      exit(0);
    });
  };

  const signalHandlers = new Map(signals.map((signal) => [signal, () => onSignal(signal)]));
  stdin.once("end", onStdinEnd);
  // Only a supervised Windows local-only child expects a deliberate EOF to
  // hand off its port to a recovered tunnel. Other runtimes must not acquire
  // a new stdin reader or keep the process alive after explicit shutdown.
  if (consumeOwnedStdin && typeof stdin.resume === "function") {
    stdin.resume();
    ownedStdinResumed = true;
  }
  for (const signal of signals) {
    processLike.once(signal, signalHandlers.get(signal)!);
  }

  try {
    await connect();
  } catch (error) {
    detach();
    throw error;
  }

  return Object.freeze({
    detach,
    shutdown: async () => {
      try {
        await beginShutdown();
      } finally {
        detach();
      }
    },
  });
}

export const __test = Object.freeze({
  DEFAULT_SIGNALS,
});
