import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyTypeScriptRuntimeOutput } from "../../scripts/verify-typescript-runtime.mjs";

test("TypeScript runtime source emits the exact committed JS that Main and Stable launch", async () => {
  const result = await verifyTypeScriptRuntimeOutput();
  assert.ok(result.checked >= 2, "the verifier must cover actual migrated runtime modules");
  assert.ok(result.files.includes("equinox-local-version.js"));
  assert.ok(result.files.includes("equinox-local-darwin-helper-environment.js"));
});

test("TypeScript runtime verification detects stale, absent and empty JS output", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-ts-parity-test-"));
  const simulatedEmit = (_node, args) => {
    const staging = args[args.indexOf("--outDir") + 1];
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(staging, "example.js"), 'export const value = "updated";\n');
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    await fs.mkdir(path.join(rootDir, "src"));
    await fs.writeFile(path.join(rootDir, "src", "example.js"), 'export const value = "outdated";\n');
    await assert.rejects(
      verifyTypeScriptRuntimeOutput({ rootDir, spawnImpl: simulatedEmit }),
      /Committed runtime JS is stale or missing/,
    );
    await fs.rm(path.join(rootDir, "src", "example.js"));
    await assert.rejects(
      verifyTypeScriptRuntimeOutput({ rootDir, spawnImpl: simulatedEmit }),
      /Committed runtime JS is stale or missing/,
    );
    await assert.rejects(
      verifyTypeScriptRuntimeOutput({ rootDir, spawnImpl: () => ({ status: 0 }) }),
      /found no emitted JavaScript/,
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});


test("TypeScript tooling source emits byte-identical packaged SHA-256 I/O code", async () => {
  const result = await verifyTypeScriptRuntimeOutput({
    projectFile: "tsconfig.tooling.json", sourceDirectory: "scripts", emittedPrefix: "scripts",
  });
  assert.ok(result.files.includes("lib/package-io.mjs"));
});

test("TypeScript tooling verifier refuses stale, missing, and empty MJS files", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-ts-tooling-parity-"));
  const emitted = (_node, args) => {
    const staging = args[args.indexOf("--outDir") + 1];
    mkdirSync(path.join(staging, "scripts", "lib"), { recursive: true });
    writeFileSync(path.join(staging, "scripts", "lib", "package-io.mjs"), 'export const digest = "updated";\n');
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    await fs.mkdir(path.join(rootDir, "scripts", "lib"), { recursive: true });
    const output = path.join(rootDir, "scripts", "lib", "package-io.mjs");
    await fs.writeFile(output, 'export const digest = "stale";\n');
    await assert.rejects(verifyTypeScriptRuntimeOutput({
      rootDir, projectFile: "tsconfig.tooling.json", sourceDirectory: "scripts", emittedPrefix: "scripts", spawnImpl: emitted,
    }), /Committed runtime JS is stale or missing/u);
    await fs.rm(output);
    await assert.rejects(verifyTypeScriptRuntimeOutput({
      rootDir, projectFile: "tsconfig.tooling.json", sourceDirectory: "scripts", emittedPrefix: "scripts", spawnImpl: emitted,
    }), /Committed runtime JS is stale or missing/u);
    await assert.rejects(verifyTypeScriptRuntimeOutput({
      rootDir, projectFile: "tsconfig.tooling.json", sourceDirectory: "scripts", emittedPrefix: "scripts", spawnImpl: () => ({ status: 0 }),
    }), /found no emitted JavaScript/u);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("cross-root tooling build updates only owned scripts and never emitted runtime JS", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-ts-tooling-isolation-"));
  const emitBothRoots = (_node, args) => {
    const staging = args[args.indexOf("--outDir") + 1];
    mkdirSync(path.join(staging, "scripts", "lib"), { recursive: true });
    mkdirSync(path.join(staging, "src"), { recursive: true });
    writeFileSync(path.join(staging, "scripts", "lib", "package-io.mjs"), 'export const changed = true;\n');
    writeFileSync(path.join(staging, "src", "server.js"), 'export const shouldNeverShip = true;\n');
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    await fs.mkdir(path.join(rootDir, "scripts", "lib"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
    const scriptFile = path.join(rootDir, "scripts", "lib", "package-io.mjs");
    const runtimeFile = path.join(rootDir, "src", "server.js");
    await fs.writeFile(scriptFile, 'export const old = true;\n');
    await fs.writeFile(runtimeFile, 'export const actualRuntime = true;\n');
    const result = await verifyTypeScriptRuntimeOutput({
      rootDir, projectFile: "tsconfig.tooling.json", sourceDirectory: "scripts",
      emittedPrefix: "scripts", writeOutput: true, spawnImpl: emitBothRoots,
    });
    assert.deepEqual(result.files, ["lib/package-io.mjs"]);
    assert.equal(await fs.readFile(scriptFile, "utf8"), 'export const changed = true;\n');
    assert.equal(await fs.readFile(runtimeFile, "utf8"), 'export const actualRuntime = true;\n');
    await assert.rejects(verifyTypeScriptRuntimeOutput({
      rootDir, sourceDirectory: "src", writeOutput: true, spawnImpl: emitBothRoots,
    }), /Only owned tooling output may be rebuilt/u);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("tooling writer refuses a symlinked ancestor even when the output file is regular", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-tooling-parent-link-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-tooling-external-"));
  const outsideFile = path.join(outside, "package-io.mjs");
  const previous = 'export const outsideMustStay = true;\n';
  const emit = (_node, args) => {
    const staging = args[args.indexOf("--outDir") + 1];
    mkdirSync(path.join(staging, "scripts", "lib"), { recursive: true });
    writeFileSync(path.join(staging, "scripts", "lib", "package-io.mjs"), 'export const poisoned = true;\n');
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    await fs.mkdir(path.join(rootDir, "scripts"));
    await fs.symlink(outside, path.join(rootDir, "scripts", "lib"));
    await fs.writeFile(outsideFile, previous);
    await assert.rejects(verifyTypeScriptRuntimeOutput({
      rootDir, projectFile: "tsconfig.tooling.json", sourceDirectory: "scripts",
      emittedPrefix: "scripts", writeOutput: true, spawnImpl: emit,
    }), /unsafe|symlink|symbolic|directory|contained/u);
    assert.equal(await fs.readFile(outsideFile, "utf8"), previous);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("tooling writer rejects hard-linked outputs without changing the foreign inode or earlier files", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-tooling-hardlink-root-"));
  const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-tooling-hardlink-foreign-"));
  const emitted = (_node, args) => {
    const staging = args[args.indexOf("--outDir") + 1];
    mkdirSync(path.join(staging, "scripts", "lib"), { recursive: true });
    writeFileSync(path.join(staging, "scripts", "lib", "a.mjs"), 'export const changed = true;\n');
    writeFileSync(path.join(staging, "scripts", "lib", "z.mjs"), 'export const poisoned = true;\n');
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    const ownedDir = path.join(rootDir, "scripts", "lib");
    await fs.mkdir(ownedDir, { recursive: true });
    const safe = path.join(ownedDir, "a.mjs");
    const outside = path.join(externalRoot, "foreign.mjs");
    const previousSafe = 'export const safe = true;\n';
    const previousOutside = 'export const externalMustStay = true;\n';
    await fs.writeFile(safe, previousSafe);
    await fs.writeFile(outside, previousOutside);
    try {
      await fs.link(outside, path.join(ownedDir, "z.mjs"));
    } catch (error) {
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) {
        t.skip("This filesystem does not support ordinary file hard links.");
        return;
      }
      throw error;
    }
    assert.ok((await fs.stat(outside)).nlink > 1, "Fixture must share an actual inode");
    await assert.rejects(verifyTypeScriptRuntimeOutput({
      rootDir, projectFile: "tsconfig.tooling.json", sourceDirectory: "scripts",
      emittedPrefix: "scripts", writeOutput: true, spawnImpl: emitted,
    }), /not an owned regular file|hard.link/u);
    assert.equal(await fs.readFile(safe, "utf8"), previousSafe, "Preflight must not partially modify earlier output");
    assert.equal(await fs.readFile(outside, "utf8"), previousOutside, "Hard-linked external bytes must never change");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(externalRoot, { recursive: true, force: true });
  }
});

test("tooling writer preflights every emitted destination before modifying earlier outputs", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-tooling-preflight-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-tooling-preflight-external-"));
  const original = 'export const untouched = true;\n';
  const outsideBytes = 'export const external = true;\n';
  const injectTwoEmits = (_node, args) => {
    const staging = args[args.indexOf("--outDir") + 1];
    mkdirSync(path.join(staging, "scripts", "lib"), { recursive: true });
    writeFileSync(path.join(staging, "scripts", "lib", "a.mjs"), 'export const changed = true;\n');
    writeFileSync(path.join(staging, "scripts", "lib", "z.mjs"), 'export const altered = true;\n');
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    await fs.mkdir(path.join(rootDir, "scripts", "lib"), { recursive: true });
    const first = path.join(rootDir, "scripts", "lib", "a.mjs");
    const unsafe = path.join(rootDir, "scripts", "lib", "z.mjs");
    const external = path.join(outside, "real.mjs");
    await fs.writeFile(first, original);
    await fs.writeFile(external, outsideBytes);
    await fs.symlink(external, unsafe);
    await assert.rejects(verifyTypeScriptRuntimeOutput({
      rootDir, projectFile: "tsconfig.tooling.json", sourceDirectory: "scripts",
      emittedPrefix: "scripts", writeOutput: true, spawnImpl: injectTwoEmits,
    }), /not an owned regular file|unsafe/u);
    assert.equal(await fs.readFile(first, "utf8"), original,
      "An unsafe later output must not leave an earlier checked-in file modified");
    assert.equal(await fs.readFile(external, "utf8"), outsideBytes);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
