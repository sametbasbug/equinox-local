import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDefaultPrivateComposition,
  loadPrivateComposition,
} from "../../src/equinox-local-private-composition.js";

const HOOKS = [
  "registerPrivateVisualTools",
  "createPrivateReleaseGateRuntime",
  "privateWorkflowStepExecutor",
  "registerPrivateReleaseGateTools",
  "registerPrivateSecureServiceTools",
  "privateReleaseGateSnapshot",
  "privateGitHubStatus",
];

async function rootFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-private-composition-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeModule(root, name, body) {
  const filePath = path.join(root, name);
  await fs.writeFile(filePath, body, { mode: 0o600 });
  return filePath;
}

function validModuleSource(marker = "external") {
  return `${HOOKS.map((name) => `export function ${name}(){ return ${JSON.stringify(marker + ':' + name)}; }`).join("\n")}\n`;
}

test("default private composition stays safe and generic", async () => {
  const composition = createDefaultPrivateComposition();
  assert.equal(composition.registerPrivateVisualTools(), null);
  assert.equal(composition.createPrivateReleaseGateRuntime(), null);
  assert.deepEqual(await composition.privateReleaseGateSnapshot(), {});
  const status = await composition.privateGitHubStatus({
    context: { id: "public" },
    projectContextStorage: { run: async (_context, callback) => callback() },
    runGhWithCode: async () => ({ code: 0, stdout: "public-user\n" }),
  });
  assert.deepEqual(status, { ready: true, account: "public-user" });
});

test("valid external private composition loads only from its configured root", async (t) => {
  const root = await rootFixture(t);
  const modulePath = await writeModule(root, "composition.mjs", validModuleSource());
  const composition = await loadPrivateComposition({ modulePath, rootPath: root });
  assert.equal(composition.registerPrivateVisualTools(), "external:registerPrivateVisualTools");
  for (const hook of HOOKS) assert.equal(typeof composition[hook], "function");
});

test("missing, malformed and contract-invalid private modules fall back safely", async (t) => {
  const root = await rootFixture(t);
  const missing = await loadPrivateComposition({ modulePath: path.join(root, "missing.mjs"), rootPath: root });
  assert.equal(missing.registerPrivateVisualTools(), null);

  const malformedPath = await writeModule(root, "malformed.mjs", "export function registerPrivateVisualTools( {\n");
  const malformed = await loadPrivateComposition({ modulePath: malformedPath, rootPath: root });
  assert.equal(malformed.registerPrivateVisualTools(), null);

  const invalidPath = await writeModule(root, "invalid.mjs", "export const registerPrivateVisualTools = 1;\n");
  const invalid = await loadPrivateComposition({ modulePath: invalidPath, rootPath: root });
  assert.equal(invalid.registerPrivateVisualTools(), null);
});

test("relative and out-of-root module paths are rejected without disclosure", async (t) => {
  const root = await rootFixture(t);
  const outside = await rootFixture(t);
  const outsideModule = await writeModule(outside, "outside.mjs", validModuleSource("outside"));
  const relative = await loadPrivateComposition({ modulePath: "./composition.mjs", rootPath: root });
  assert.equal(relative.registerPrivateVisualTools(), null);
  const escaped = await loadPrivateComposition({ modulePath: outsideModule, rootPath: root });
  assert.equal(escaped.registerPrivateVisualTools(), null);
  assert.equal(JSON.stringify(escaped).includes(outside), false);
});

test("symlinked private module targets fail closed", async (t) => {
  const root = await rootFixture(t);
  const realPath = await writeModule(root, "real.mjs", validModuleSource("real"));
  const linkPath = path.join(root, "link.mjs");
  await fs.symlink(realPath, linkPath);
  const composition = await loadPrivateComposition({ modulePath: linkPath, rootPath: root });
  assert.equal(composition.registerPrivateVisualTools(), null);
});
