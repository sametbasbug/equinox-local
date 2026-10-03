import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { checkProject, collectFiles, discoverTests, parseTestProfile, runNodeTests } from "../../scripts/lib/factory-tooling.mjs";
import { checkPublicProject } from "../../scripts/check.mjs";
import { discoverPublicTestFiles, runPublicTests } from "../../scripts/run-tests.mjs";

async function withTempRoot(run) {
  const scratchDirectory = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  assert.ok(scratchDirectory, "a configured scratch directory is required");
  const root = await fs.mkdtemp(path.join(scratchDirectory, "equinox-factory-tooling-"));
  try {
    return await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeFile(root, relative, content = "// fixture\n") {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

function relative(root, files) {
  return files.map((file) => path.relative(root, file).split(path.sep).join("/"));
}

test("profile parsing preserves default, first matching flag, and literal profile values", async () => {
  assert.equal(parseTestProfile([]), "full");
  assert.equal(parseTestProfile(["--profile=fast", "--profile=full"]), "fast");
  assert.equal(parseTestProfile(["--profile="]), "");
});

test("filesystem discovery recurses selected roots and keeps factory roots top-level-only", async () => {
  await withTempRoot(async (root) => {
    await Promise.all([
      writeFile(root, "tests/unit/core.test.js"),
      writeFile(root, "tests/unit/nested/deep.test.js"),
      writeFile(root, "tests/release/full.test.js"),
      writeFile(root, "tests/ignored/skip.test.js"),
      writeFile(root, "factory/local/top.test.js"),
      writeFile(root, "factory/local/nested/not-top.test.js"),
    ]);

    const files = await collectFiles(root, {
      recursiveDirectories: ["tests"],
      topLevelDirectories: ["factory/local"],
      skipDirectoryNames: ["ignored"],
      includeFile: (_absolute, name) => name.endsWith(".test.js"),
    });
    assert.deepEqual(relative(root, files).sort(), [
      "factory/local/top.test.js",
      "tests/release/full.test.js",
      "tests/unit/core.test.js",
      "tests/unit/nested/deep.test.js",
    ]);
  });
});

test("profile discovery applies private and public recursive-root policies", async () => {
  await withTempRoot(async (root) => {
    await Promise.all([
      writeFile(root, "tests/unit/core.test.js"),
      writeFile(root, "tests/browser/web.test.js"),
      writeFile(root, "tests/release/release.test.js"),
      writeFile(root, "factory/local/top.test.js"),
      writeFile(root, "factory/local/nested/not-top.test.js"),
      writeFile(root, "factory/browser/top.test.js"),
      writeFile(root, "factory/browser/nested/not-top.test.js"),
    ]);

    const privatePolicy = {
      profileDirectories: { full: ["tests"], fast: ["tests/unit", "tests/browser"] },
      topLevelDirectories: ["factory/local", "factory/browser"],
    };
    assert.deepEqual(relative(root, await discoverTests({ rootDir: root, profile: "full", ...privatePolicy })), [
      "factory/browser/top.test.js",
      "factory/local/top.test.js",
      "tests/browser/web.test.js",
      "tests/release/release.test.js",
      "tests/unit/core.test.js",
    ]);
    assert.deepEqual(relative(root, await discoverTests({ rootDir: root, profile: "fast", ...privatePolicy })), [
      "factory/browser/top.test.js",
      "factory/local/top.test.js",
      "tests/browser/web.test.js",
      "tests/unit/core.test.js",
    ]);

    const publicPolicy = {
      profileDirectories: { full: ["tests"], fast: ["tests/unit", "tests/browser"] },
    };
    assert.deepEqual(relative(root, await discoverTests({ rootDir: root, profile: "fast", ...publicPolicy })), [
      "tests/browser/web.test.js",
      "tests/unit/core.test.js",
    ]);
    await assert.rejects(
      discoverTests({ rootDir: root, profile: "banana", ...publicPolicy }),
      /Unknown test profile: banana/u,
    );
    assert.deepEqual(await discoverTests({ rootDir: root, profile: "fast", profileDirectories: { fast: [] } }), []);
  });
});

test("public test wrapper preserves categorized recursive roots and empty-suite errors", async () => {
  await withTempRoot(async (root) => {
    await Promise.all([
      writeFile(root, "tests/unit/nested/unit.test.js"),
      writeFile(root, "tests/browser/browser.test.js"),
      writeFile(root, "tests/release/release.test.js"),
      writeFile(root, "factory/local/factory.test.js"),
    ]);

    assert.deepEqual(relative(root, await discoverPublicTestFiles({ rootDir: root, profile: "full" })), [
      "tests/browser/browser.test.js",
      "tests/release/release.test.js",
      "tests/unit/nested/unit.test.js",
    ]);
    assert.deepEqual(relative(root, await discoverPublicTestFiles({ rootDir: root, profile: "fast" })), [
      "tests/browser/browser.test.js",
      "tests/unit/nested/unit.test.js",
    ]);
    await assert.rejects(
      discoverPublicTestFiles({ rootDir: root, profile: "banana" }),
      /Unknown test profile: banana/u,
    );
  });

  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, "tests"), { recursive: true });
    await assert.rejects(
      runPublicTests({ rootDir: root, profile: "full" }),
      /No public tests were discovered for profile full\./u,
    );
  });
});

test("test execution keeps argv, cwd, inherited environment, profile, and exit status", async () => {
  const child = new EventEmitter();
  let invocation;
  const result = runNodeTests({
    files: ["one.test.js", "two.test.js"],
    cwd: "/project",
    profile: "fast",
    stdio: "ignore",
    spawnImpl: (...args) => {
      invocation = args;
      queueMicrotask(() => child.emit("exit", 7, null));
      return child;
    },
  });

  assert.equal(await result, 7);
  assert.equal(invocation[0], process.execPath);
  assert.deepEqual(invocation[1], ["--test", "one.test.js", "two.test.js"]);
  assert.equal(invocation[2].cwd, "/project");
  assert.equal(invocation[2].stdio, "ignore");
  assert.equal(invocation[2].env.EQUINOX_TEST_PROFILE, "fast");
  assert.equal(invocation[2].env.PATH, process.env.PATH);
});

test("test execution maps a null exit code to failure and propagates child errors", async () => {
  const child = new EventEmitter();
  const nullExit = runNodeTests({
    files: [],
    cwd: "/project",
    profile: "full",
    spawnImpl: () => {
      queueMicrotask(() => child.emit("exit", null, null));
      return child;
    },
  });
  assert.equal(await nullExit, 1);

  const errorChild = new EventEmitter();
  const expected = new Error("spawn failed");
  const failure = runNodeTests({ files: [], cwd: "/project", profile: "full", spawnImpl: () => {
    queueMicrotask(() => errorChild.emit("error", expected));
    return errorChild;
  } });
  await assert.rejects(failure, (error) => error === expected);
});

test("test execution forwards child signals without converting them to exit codes", async () => {
  const child = new EventEmitter();
  let signalObserved;
  const signalReceived = new Promise((resolve) => { signalObserved = resolve; });
  runNodeTests({
    files: [],
    cwd: "/project",
    profile: "full",
    spawnImpl: () => {
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return child;
    },
    propagateSignal: signalObserved,
  });
  assert.equal(await signalReceived, "SIGTERM");
});

test("static checking preserves ordered source roots, root-file policy, exclusions, and JSON checks", async () => {
  await withTempRoot(async (root) => {
    const fixtureFiles = [
      "src/z.js",
      "src/a.mjs",
      "tests/unit/c.test.js",
      "scripts/b.mjs",
      "factory/browser/d.sh",
      "factory/local/e.js",
      "factory/local/public-template/hidden.mjs",
      "extension/f.js",
      "root.js",
      "root.mjs",
      "root.sh",
    ];
    await Promise.all(fixtureFiles.map((file) => writeFile(root, file)));
    await writeFile(root, "package.json", "{}\n");
    await writeFile(root, "extension/manifest.json", "{}\n");
    await writeFile(root, "examples/equinox-local-config.example.json", "{}\n");

    const calls = [];
    const spawnSyncImpl = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    };
    const sourceFilter = (_absolute, name) => /\.(?:js|mjs|sh)$/u.test(name);
    const rootFilter = (_absolute, name) => name.endsWith(".mjs") || name.endsWith(".sh");
    const jsonFiles = ["package.json", "extension/manifest.json", "examples/equinox-local-config.example.json"];

    const privateReport = await checkProject({
      rootDir: root,
      recursiveDirectories: ["src", "tests", "scripts", "factory/browser", "extension", "factory/local"],
      skipDirectoryNames: ["public-template"],
      includeRootFiles: true,
      includeFile: sourceFilter,
      includeRootFile: rootFilter,
      deduplicate: true,
      jsonFiles,
      spawnSyncImpl,
    });
    const privateJavascript = calls.filter((call) => call.args[0] === "--check").map((call) => call.args[1]);
    const privateShell = calls.filter((call) => call.args[0] === "-n").map((call) => call.args[1]);
    assert.deepEqual(privateJavascript, [
      "extension/f.js",
      "factory/local/e.js",
      "root.mjs",
      "scripts/b.mjs",
      "src/a.mjs",
      "src/z.js",
      "tests/unit/c.test.js",
    ]);
    assert.deepEqual(privateShell, ["factory/browser/d.sh", "root.sh"]);
    assert.equal(privateJavascript.includes("factory/local/public-template/hidden.mjs"), false);
    assert.equal(privateJavascript.includes("root.js"), false);
    assert.deepEqual(privateReport.jsonFiles, jsonFiles);

    calls.length = 0;
    const publicReport = await checkPublicProject({
      rootDir: root,
      spawnSyncImpl,
    });
    const publicJavascript = calls.filter((call) => call.args[0] === "--check").map((call) => call.args[1]);
    const publicShell = calls.filter((call) => call.args[0] === "-n").map((call) => call.args[1]);
    assert.deepEqual(publicJavascript, ["extension/f.js", "scripts/b.mjs", "src/a.mjs", "src/z.js"]);
    assert.deepEqual(publicShell, []);
    assert.equal(publicJavascript.some((file) => file.startsWith("tests/")), false);
    assert.equal(publicJavascript.some((file) => file.startsWith("factory/")), false);
    assert.equal(publicJavascript.includes("root.mjs"), false);
    assert.deepEqual(publicReport.jsonFiles, jsonFiles);
  });
});
