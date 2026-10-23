import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { equinoxLocalGitExecutionEnvironment, equinoxLocalToolchainContract } from "../../src/equinox-local-toolchain-contract.js";

const DARWIN_RUNTIME = "/Users/example/Library/Application Support/Equinox Local/runtime";
const WINDOWS_RUNTIME = "C:\\Users\\Example\\AppData\\Local\\Equinox Local\\runtime";

test("M8 toolchain contract derives exact product-owned identities for all targets", () => {
  for (const target of ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]) {
    const windows = target.startsWith("win32-");
    const runtimeRoot = windows ? WINDOWS_RUNTIME : DARWIN_RUNTIME;
    const p = windows ? path.win32 : path.posix;
    const contract = equinoxLocalToolchainContract({ runtimeRoot, target });
    assert.equal(contract.ambientPathDiscovery, false);
    assert.equal(contract.gitPath, windows
      ? p.join(runtimeRoot, "toolchain", "git", "2.56.0-1", target, "cmd", "git.exe")
      : p.join(runtimeRoot, "toolchain", "git", "2.56.0-1", target, "bin", "git"));
    assert.equal(contract.nodePath, windows
      ? p.join(runtimeRoot, "toolchain", "node", "26.12.1", target, "node.exe")
      : p.join(runtimeRoot, "toolchain", "node", "26.12.1", target, "bin", "node"));
    assert.equal(contract.shellPath, windows
      ? p.join(runtimeRoot, "toolchain", "git", "2.56.0-1", target, "usr", "bin", "sh.exe")
      : null);
    const npmRoot = windows ? ["node_modules", "npm", "bin"] : ["lib", "node_modules", "npm", "bin"];
    assert.equal(contract.npmPath, p.join(runtimeRoot, "toolchain", "node", "26.12.1", target, ...npmRoot, "npm-cli.js"));
    assert.equal(contract.npxPath, p.join(runtimeRoot, "toolchain", "node", "26.12.1", target, ...npmRoot, "npx-cli.js"));
    assert.deepEqual(contract.gitInvocation, { command: contract.gitPath, argsPrefix: [] });
    assert.deepEqual(contract.npmInvocation, { command: contract.nodePath, argsPrefix: [contract.npmPath] });
    assert.equal(contract.git.archiveRoot, ".");
  }
});

test("M8 toolchain contract pins exact Dugite and Node archives", () => {
  const expected = {
    "darwin-arm64": [["dugite-native-v2.56.0-7ce66f8-macOS-arm64.tar.gz", 63_488_157, "ab756ab9a15241f14b6c0a0386c704a998bb710a837ab35dc55d4747a90f2ca0"], ["node-v26.12.1-darwin-arm64.tar.gz", 58_334_853, "1901d539912c02afa10d1cc126943a8855a7eedebe830119463470db5e6c59e8"]],
    "darwin-x64": [["dugite-native-v2.56.0-7ce66f8-macOS-x64.tar.gz", 67_470_255, "f294895790a98405b2900d55160945d4d0ce92492891aac4b95f2c7085220fa3"], ["node-v26.12.1-darwin-x64.tar.gz", 59_800_211, "b85c2ea4420ad0bc4abf2dc6cf1f55130ed681f1cabf60cf3f526e4c9e2712ff"]],
    "win32-arm64": [["dugite-native-v2.56.0-7ce66f8-windows-arm64.tar.gz", 44_348_850, "bd8ecc89890421684d9b49951af162725389a43b9f128350daff673116af5726"], ["node-v26.12.1-win-arm64.zip", 37_275_911, "34567581ee63967b37afb6b7a0cc63a2d550a43d5d838adb75982d7e356f2e2c"]],
    "win32-x64": [["dugite-native-v2.56.0-7ce66f8-windows-x64.tar.gz", 46_985_154, "2157566523b767a8f812a6733686fdf13046aa9c1d9987f96030401b759bffee"], ["node-v26.12.1-win-x64.zip", 41_901_456, "b3efd5c70cba3308ed46e7e699a9b8aac075bbc6b027fcb39c84c31acc25e2b4"]],
  };
  for (const [target, [gitPin, nodePin]] of Object.entries(expected)) {
    const runtimeRoot = target.startsWith("win32-") ? WINDOWS_RUNTIME : DARWIN_RUNTIME;
    const contract = equinoxLocalToolchainContract({ runtimeRoot, target });
    assert.deepEqual([contract.git.distribution.filename, contract.git.distribution.bytes, contract.git.distribution.sha256], gitPin);
    assert.deepEqual([contract.node.distribution.filename, contract.node.distribution.bytes, contract.node.distribution.sha256], nodePin);
    assert.match(contract.git.distribution.url, /^https:\/\/github\.com\/desktop\/dugite-native\/releases\/download\/v2\.56\.0-1\//u);
    assert.match(contract.node.distribution.url, /^https:\/\/nodejs\.org\/dist\/v26\.12\.1\//u);
  }
});

test("M8 toolchain contract rejects unsupported targets and unsafe roots", () => {
  assert.throws(() => equinoxLocalToolchainContract({ runtimeRoot: DARWIN_RUNTIME, target: "linux-x64" }), /Unsupported Equinox Local release target/u);
  assert.throws(() => equinoxLocalToolchainContract({ runtimeRoot: "relative/runtime", target: "darwin-arm64" }), /absolute path/u);
  assert.throws(() => equinoxLocalToolchainContract({ runtimeRoot: "/", target: "darwin-arm64" }), /filesystem root/u);
  assert.throws(() => equinoxLocalToolchainContract({ runtimeRoot: "C:\\", target: "win32-x64" }), /filesystem root/u);
});


test("managed-source Dugite Git finds HTTPS helpers in its pinned macOS distribution, never the host root", () => {
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    const contract = equinoxLocalToolchainContract({ runtimeRoot: DARWIN_RUNTIME, target });
    const hostileBase = { HOME: "/isolated/home", GIT_EXEC_PATH: "/untrusted/helper", GIT_TEMPLATE_DIR: "/untrusted/templates", PATH: "/usr/bin:/bin" };
    const env = equinoxLocalGitExecutionEnvironment(contract.gitPath, hostileBase, { platform: "darwin" });
    assert.equal(env.GIT_EXEC_PATH, path.posix.join(contract.git.root, "libexec", "git-core"));
    assert.equal(env.GIT_TEMPLATE_DIR, path.posix.join(contract.git.root, "share", "git-core", "templates"));
    assert.equal(env.HOME, "/isolated/home");
    assert.equal(env.PATH, "/usr/bin:/bin");
    assert.equal(hostileBase.GIT_EXEC_PATH, "/untrusted/helper");
  }
  const ambient = { HOME: "/isolated", PATH: "/usr/bin" };
  assert.deepEqual(equinoxLocalGitExecutionEnvironment("git", ambient, { platform: "darwin" }), ambient);
  const windows = equinoxLocalToolchainContract({ runtimeRoot: WINDOWS_RUNTIME, target: "win32-x64" });
  assert.deepEqual(equinoxLocalGitExecutionEnvironment(windows.gitPath, ambient, { platform: "win32" }), ambient);
});
