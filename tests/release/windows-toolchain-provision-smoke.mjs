import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { provisionEquinoxLocalToolchain } from "../../src/equinox-local-toolchain-provisioner.js";

if (process.platform !== "win32" || process.arch !== "arm64") {
  throw new Error(`Windows ARM64 toolchain smoke requires native win32-arm64 Node, got ${process.platform}-${process.arch}.`);
}

const base = process.env.RUNNER_TEMP || os.tmpdir();
const root = path.join(base, `equinox-fresh-toolchain-${process.pid}`);
const runtimeRoot = path.join(root, "runtime");
const helperPath = path.resolve("src/equinox-local-windows-release-zip.ps1");

await fs.mkdir(runtimeRoot, { recursive: true });
try {
  const first = await provisionEquinoxLocalToolchain({
    runtimeRoot,
    target: "win32-arm64",
    platform: "win32",
    windowsZipHelperPath: helperPath,
  });
  if (first.components.some((component) => component.status !== "installed")) {
    throw new Error(`Fresh ARM64 toolchain did not install both components: ${JSON.stringify(first.components)}`);
  }
  const second = await provisionEquinoxLocalToolchain({
    runtimeRoot,
    target: "win32-arm64",
    platform: "win32",
    windowsZipHelperPath: helperPath,
  });
  if (second.components.some((component) => component.status !== "reused")) {
    throw new Error(`ARM64 toolchain did not reuse the admitted components: ${JSON.stringify(second.components)}`);
  }
  process.stdout.write("Windows ARM64 fresh product-owned toolchain provisioning acceptance passed.\n");
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
