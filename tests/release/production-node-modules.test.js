import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createProductionNodeModulesFilter, productionNodeModulesFilter } from "../../scripts/release/production-node-modules.mjs";
import { copyProductionNodeModules } from "../../scripts/release/package-managed-release.mjs";
import { hardlinkNormalTree } from "../../scripts/release/package-managed-release-windows.mjs";
import { seedPrebuiltDependenciesFromStableRelease } from "../../src/equinox-local-managed-source-enrollment.js";

const FIXTURE_LOCK = {
  lockfileVersion: 3,
  packages: {
    "": { dependencies: { "node-pty": "1.0.0", "@test/runtime": "1.0.0" }, devDependencies: { typescript: "7.0.2" } },
    "node_modules/node-pty": { version: "1.0.0" },
    "node_modules/@test/runtime": { version: "1.0.0" },
    "node_modules/node-pty/node_modules/nested-prod": { version: "1.0.0" },
    "node_modules/typescript": { version: "7.0.2", dev: true },
    "node_modules/@typescript/typescript-darwin-arm64": { version: "7.0.2", dev: true, optional: true },
    "node_modules/@types/node": { version: "26.6.5", dev: true },
    "node_modules/node-pty/node_modules/nested-dev": { dev: true },
  },
};

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-production-modules-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const release = path.join(root, "release");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(release, { recursive: true });
  const manifest = JSON.stringify({ name: "fixture", dependencies: { "node-pty": "1.0.0", "@test/runtime": "1.0.0" }, devDependencies: { typescript: "7.0.2" } });
  const lock = JSON.stringify(FIXTURE_LOCK);
  for (const folder of [source, release]) {
    await fs.writeFile(path.join(folder, "package.json"), manifest);
    await fs.writeFile(path.join(folder, "package-lock.json"), lock);
  }
  const files = {
    "node-pty/scripts/prebuild.js": "prebuilt helper",
    "node-pty/prebuilds/win32-arm64/conpty.node": "platform native file",
    "node-pty/node_modules/nested-prod/index.js": "transitive dependency",
    "node-pty/node_modules/nested-dev/index.js": "development only nested dependency",
    "@test/runtime/index.js": "scoped production module",
    "typescript/bin/tsc": "compiler",
    "@typescript/typescript-darwin-arm64/lib/tsgo": "native compiler",
    "@types/node/index.d.ts": "development typings",
    ".bin/tsc": "dev bin entry",
    "foreign-secret/index.js": "unlisted module",
  };
  for (const [relative, content] of Object.entries(files)) {
    const dest = path.join(source, "node_modules", relative);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content);
  }
  return { root, source, release };
}

test("lockfile production inventory includes native/transitive/optional production packages but excludes TS and unknown paths", () => {
  const include = createProductionNodeModulesFilter(FIXTURE_LOCK);
  for (const relative of ["", "node-pty", "node-pty/prebuilds/win32-arm64/conpty.node",
    "node-pty/node_modules/nested-prod/index.js", "@test", "@test/runtime/index.js"]) assert.equal(include(relative), true, relative);
  for (const relative of ["typescript", "typescript/bin/tsc", "@typescript/typescript-darwin-arm64",
    "@types/node", "node-pty/node_modules/nested-dev/index.js", "foreign-secret",
    ".bin", ".bin/tsc", "../node-pty", "node-pty/../../foreign-secret"]) assert.equal(include(relative), false, relative);
  assert.throws(() => createProductionNodeModulesFilter({ lockfileVersion: 2 }), /lockfile v3/);
  assert.throws(() => createProductionNodeModulesFilter({ lockfileVersion: 3, packages: { "": { dependencies: { missing: "1" } } } }), /missing from the admitted lockfile/);
  assert.throws(() => createProductionNodeModulesFilter({ lockfileVersion: 3, packages: { "": { dependencies: {} }, "node_modules/../evil": {} } }), /unsafe package path/);
});

test("real product lockfile marks the TS toolchain as development-only while retaining runtime packages", async () => {
  const root = new URL("../../", import.meta.url);
  const include = await productionNodeModulesFilter(fileURLToPath(root));
  assert.equal(include("typescript"), false);
  assert.equal(include("@typescript/typescript-win32-arm64"), false);
  assert.equal(include("@types/node"), false);
  assert.equal(include("node-pty/prebuilds/win32-arm64/conpty.node"), true);
  assert.equal(include("@modelcontextprotocol/sdk/dist/esm/index.js"), true);
});

test("macOS Stable stages only admitted production deps without changing lock identity or native prebuild", async (t) => {
  const { source, release } = await fixture(t);
  await copyProductionNodeModules(source, release);
  await assertProductionTree(release);
  const sourceLock = await fs.readFile(path.join(source, "package-lock.json"));
  assert.deepEqual(await fs.readFile(path.join(release, "package-lock.json")), sourceLock);
  const seeded = path.join(path.dirname(release), "seeded");
  await fs.mkdir(seeded);
  await fs.copyFile(path.join(release, "package.json"), path.join(seeded, "package.json"));
  await fs.copyFile(path.join(release, "package-lock.json"), path.join(seeded, "package-lock.json"));
  await seedPrebuiltDependenciesFromStableRelease(seeded, release);
  assert.equal(await fs.readFile(path.join(seeded, "node_modules/node-pty/scripts/prebuild.js"), "utf8"), "prebuilt helper");
  await assert.rejects(fs.stat(path.join(seeded, "node_modules/typescript")), { code: "ENOENT" });
});

test("Windows Stable hardlink staging keeps native prebuild and excludes development and unknown dependencies", async (t) => {
  const { source, release } = await fixture(t);
  const included = await productionNodeModulesFilter(source);
  await hardlinkNormalTree(path.join(source, "node_modules"), path.join(release, "node_modules"), { includeProduction: included });
  await assertProductionTree(release);
  const from = await fs.stat(path.join(source, "node_modules/node-pty/scripts/prebuild.js"));
  const to = await fs.stat(path.join(release, "node_modules/node-pty/scripts/prebuild.js"));
  assert.equal(to.ino, from.ino, "hardlinked same-filesystem Windows package file should retain inode");
});

async function assertProductionTree(release) {
  const read = (rel) => fs.readFile(path.join(release, "node_modules", rel), "utf8");
  assert.equal(await read("node-pty/scripts/prebuild.js"), "prebuilt helper");
  assert.equal(await read("node-pty/prebuilds/win32-arm64/conpty.node"), "platform native file");
  assert.equal(await read("node-pty/node_modules/nested-prod/index.js"), "transitive dependency");
  assert.equal(await read("@test/runtime/index.js"), "scoped production module");
  for (const rel of ["typescript", "@typescript", "@types", "foreign-secret", ".bin", "node-pty/node_modules/nested-dev"]) {
    await assert.rejects(fs.stat(path.join(release, "node_modules", rel)), { code: "ENOENT" }, rel);
  }
}
