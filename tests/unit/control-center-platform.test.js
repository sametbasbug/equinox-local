import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chooseLocalFolder, openLocalUrl, revealLocalPath, __test } from "../../src/control-center-platform.js";

test("folder picker is a fixed macOS osascript flow and returns a resolved directory", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-picker-"));
  const selected = path.join(tempRoot, "project");
  await fs.mkdir(selected);
  try {
    let invocation = null;
    const result = await chooseLocalFolder({
      platform: "darwin",
      execFileAsync: async (command, args, options) => {
        invocation = { command, args, options };
        return { stdout: `${selected}\n`, stderr: "" };
      },
    });
    assert.equal(result, await fs.realpath(selected));
    assert.equal(invocation.command, "/usr/bin/osascript");
    assert.deepEqual(invocation.args, ["-e", __test.PICK_FOLDER_SCRIPT]);
    assert.equal(invocation.options.timeout, 120_000);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("folder picker cancellation returns null without inventing a path", async () => {
  const result = await chooseLocalFolder({
    platform: "darwin",
    execFileAsync: async () => ({ stdout: "\n", stderr: "" }),
  });
  assert.equal(result, null);
});

test("folder picker fails closed off macOS", async () => {
  await assert.rejects(
    chooseLocalFolder({ platform: "linux", execFileAsync: async () => ({ stdout: "/tmp/x\n" }) }),
    (error) => error?.statusCode === 501 && /macOS/u.test(error.message),
  );
});


test("host URL open uses argument-safe platform executables", async () => {
  const calls = [];
  const execFileAsync = async (command, args, options) => { calls.push({ command, args, options }); return { stdout: "", stderr: "" }; };
  await openLocalUrl({ url: "http://127.0.0.1:24891/", platform: "darwin", execFileAsync });
  await openLocalUrl({ url: "http://127.0.0.1:24891/", platform: "win32", execFileAsync });
  assert.deepEqual(calls[0].args, ["http://127.0.0.1:24891/"]);
  assert.equal(calls[0].command, "/usr/bin/open");
  assert.deepEqual(calls[1].args, ["http://127.0.0.1:24891/"]);
  assert.equal(calls[1].command, "explorer.exe");
  await assert.rejects(() => openLocalUrl({ url: "file:///etc/passwd", platform: "darwin", execFileAsync }), /HTTP/u);
});

test("host reveal keeps paths as arguments instead of shell strings", async () => {
  const calls = [];
  const execFileAsync = async (command, args, options) => { calls.push({ command, args, options }); return { stdout: "", stderr: "" }; };
  await revealLocalPath({ targetPath: "/Users/example/My File.txt", kind: "file", platform: "darwin", execFileAsync });
  await revealLocalPath({ targetPath: "C:\\Users\\Example User\\My File.txt", kind: "file", platform: "win32", execFileAsync });
  assert.deepEqual(calls[0].args, ["-R", "/Users/example/My File.txt"]);
  assert.deepEqual(calls[1].args, ["/select,", "C:\\Users\\Example User\\My File.txt"]);
});

test("host URL opening refuses schemes, credentials, invalid input and oversized URLs before spawning a command", async () => {
  let spawned = 0;
  const execFileAsync = async () => { spawned++; return { stdout: "", stderr: "" }; };
  for (const url of [
    "file:///etc/passwd", "javascript:alert(1)", "data:text/html,private",
    "ftp://example.com/archive", "https://user:password@example.com/",
    "http://user@example.com/", "https://example.com".padEnd(2049, "a"),
    "this-is-not-a-url", "", undefined, null, 5,
  ]) {
    await assert.rejects(openLocalUrl({ url, platform: "darwin", execFileAsync }));
    await assert.rejects(openLocalUrl({ url, platform: "win32", execFileAsync }));
  }
  assert.equal(spawned, 0);
});

test("host URL and reveal actions reject unsupported platforms without executing programs", async () => {
  let spawned = 0;
  const execFileAsync = async () => { spawned++; throw Error("exec must not be called"); };
  await assert.rejects(
    openLocalUrl({ url: "https://example.org/", platform: "linux", execFileAsync }),
    (error) => error.statusCode === 501 && /unsupported/u.test(error.message),
  );
  await assert.rejects(
    revealLocalPath({ targetPath: "/home/example", platform: "linux", execFileAsync }),
    (error) => error.statusCode === 501 && /unsupported/u.test(error.message),
  );
  for (const targetPath of ["../secrets", "relative", "", undefined, null, 100]) {
    await assert.rejects(revealLocalPath({ targetPath, platform: "darwin", execFileAsync }), /absolute/u);
    await assert.rejects(revealLocalPath({ targetPath, platform: "win32", execFileAsync }), /absolute/u);
  }
  await assert.rejects(
    revealLocalPath({ targetPath: "/home/example", kind: "executable", platform: "darwin", execFileAsync }),
    /file or directory/u,
  );
  assert.equal(spawned, 0);
});

test("folder picker refuses relative, filesystem-root and non-directory selections without guessing another folder", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-picker-admission-"));
  const filePath = path.join(root, "not-a-directory.txt");
  await fs.writeFile(filePath, "fixture");
  let launches = 0;
  const result = async (stdout) => chooseLocalFolder({
    platform: "darwin",
    execFileAsync: async (command, args, options) => {
      launches++;
      assert.equal(command, "/usr/bin/osascript");
      assert.deepEqual(args, ["-e", __test.PICK_FOLDER_SCRIPT]);
      assert.equal(options.timeout, 120_000);
      assert.equal(options.env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
      assert.equal(options.env.NODE_OPTIONS, undefined);
      return { stdout, stderr: "" };
    },
  });
  try {
    await assert.rejects(result("relative/folder\n"), /non-absolute/u);
    await assert.rejects(result("/\n"), /filesystem root/u);
    await assert.rejects(result(filePath + "\n"), /not a safe local directory/u);
    assert.equal(await result("\n"), null);
    assert.equal(launches, 4);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("platform adapters pass paths only as direct argv, including shell metacharacters, never as shell command strings", async () => {
  const calls = [];
  const execFileAsync = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { stdout: "", stderr: "" };
  };
  const windowsPath = "C:\\Users\\Test\\a&b;$(echo)-private.txt";
  const darwinPath = "/Users/example/a&b;$(echo)-private.txt";
  assert.equal(await revealLocalPath({ targetPath: windowsPath, kind: "file", platform: "win32", execFileAsync }), windowsPath);
  assert.equal(await revealLocalPath({ targetPath: darwinPath, kind: "directory", platform: "darwin", execFileAsync }), darwinPath);
  assert.equal(await openLocalUrl({ url: "https://example.org/?q=%24%28echo%29", platform: "darwin", execFileAsync }),
    "https://example.org/?q=%24%28echo%29");
  assert.deepEqual(calls[0].args, ["/select,", windowsPath]);
  assert.deepEqual(calls[1].args, [darwinPath]);
  assert.deepEqual(calls[2].args, ["https://example.org/?q=%24%28echo%29"]);
  assert.ok(calls.every(({ options }) => options.shell !== true));
  assert.equal(calls[0].options.windowsHide, true);
});
