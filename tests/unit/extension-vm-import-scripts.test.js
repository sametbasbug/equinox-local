import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createExtensionVmContext } from "../helpers/extension-vm-import-scripts.mjs";

const TEMP_ROOT = process.env.TMPDIR || os.tmpdir();

test("allowlisted importScripts executes classic scripts synchronously in the worker realm", async () => {
  const root = await fs.mkdtemp(path.join(TEMP_ROOT, "equinox-vm-importscripts-"));
  try {
    await fs.writeFile(path.join(root, "capability.js"), "globalThis.loadedCapabilities = (globalThis.loadedCapabilities || []).concat('capability');\n");
    const context = createExtensionVmContext({
      sandbox: { loadedCapabilities: ["worker"] },
      extensionRoot: root,
      allowedScripts: ["capability.js"],
    });

    const returned = context.importScripts("capability.js");
    assert.equal(returned, undefined);
    assert.deepEqual(Array.from(context.loadedCapabilities), ["worker", "capability"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("importScripts rejects paths and scripts outside its explicit package allowlist", async () => {
  const root = await fs.mkdtemp(path.join(TEMP_ROOT, "equinox-vm-importscripts-"));
  try {
    await fs.writeFile(path.join(root, "capability.js"), "globalThis.allowedScriptLoaded = true;\n");
    const context = createExtensionVmContext({ sandbox: {}, extensionRoot: root, allowedScripts: ["capability.js"] });
    assert.throws(() => context.importScripts("../secret.js"), /not allowlisted/u);
    assert.throws(() => context.importScripts("secret.js"), /not allowlisted/u);
    assert.throws(() => context.importScripts("capability.js", "secret.js"), /not allowlisted/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
