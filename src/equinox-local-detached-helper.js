export async function launchDetachedHelper({
  spawnImpl,
  command,
  args = [],
  options = {},
  label = "Detached helper",
  spawnTimeoutMs = 1000,
} = {}) {
  if (typeof spawnImpl !== "function") throw new Error(`${label} spawn function is unavailable.`);
  if (typeof command !== "string" || !command) throw new Error(`${label} command is required.`);
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    throw new Error(`${label} arguments must be text.`);
  }
  if (!Number.isInteger(spawnTimeoutMs) || spawnTimeoutMs < 1 || spawnTimeoutMs > 10_000) {
    throw new Error(`${label} spawn timeout is invalid.`);
  }

  let child;
  try {
    child = spawnImpl(command, args, options);
  } catch (error) {
    throw new Error(`${label} failed to start: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (
    !child ||
    typeof child.on !== "function" ||
    typeof child.once !== "function" ||
    typeof child.unref !== "function"
  ) {
    throw new Error(`${label} failed to start.`);
  }

  await new Promise((resolve, reject) => {
    let spawnConfirmed = false;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`${label} spawn acknowledgement timed out.`));
    }, spawnTimeoutMs);

    child.on("error", (error) => {
      if (spawnConfirmed) return;
      finish(
        reject,
        new Error(`${label} failed to start: ${error instanceof Error ? error.message : String(error)}`),
      );
    });
    child.once("spawn", () => {
      spawnConfirmed = true;
      finish(resolve);
    });
  });

  child.unref();
  return child;
}
