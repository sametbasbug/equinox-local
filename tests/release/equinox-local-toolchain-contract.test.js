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
      ? p.join(runtimeRoot, "toolchain", "git", "2.53.0-4", target, "cmd", "git.exe")
      : p.join(runtimeRoot, "toolchain", "git", "2.53.0-4", target, "bin", "git"));
    assert.equal(contract.nodePath, windows
      ? p.join(runtimeRoot, "toolchain", "node", "26.10.0", target, "node.exe")
      : p.join(runtimeRoot, "toolchain", "node", "26.10.0", target, "bin", "node"));
    assert.equal(contract.shellPath, windows
      ? p.join(runtimeRoot, "toolchain", "git", "2.53.0-4", target, "usr", "bin", "sh.exe")
      : null);
    const npmRoot = windows ? ["node_modules", "npm", "bin"] : ["lib", "node_modules", "npm", "bin"];
    assert.equal(contract.npmPath, p.join(runtimeRoot, "toolchain", "node", "26.10.0", target, ...npmRoot, "npm-cli.js"));
    assert.equal(contract.npxPath, p.join(runtimeRoot, "toolchain", "node", "26.10.0", target, ...npmRoot, "npx-cli.js"));
    assert.deepEqual(contract.gitInvocation, { command: contract.gitPath, argsPrefix: [] });
    assert.deepEqual(contract.npmInvocation, { command: contract.nodePath, argsPrefix: [contract.npmPath] });
    assert.equal(contract.git.archiveRoot, ".");
  }
});

test("M8 toolchain contract pins exact Dugite and Node archives", () => {
  const expected = {
    "darwin-arm64": [["dugite-native-v2.53.0-4098283-macOS-arm64.tar.gz", 62_348_987, "f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe"], ["node-v26.10.0-darwin-arm64.tar.gz", 58_175_384, "751fdf7439f115d87ee2a8f3f18c065b6151852068e3e666ac60ac2996f75ac9"]],
    "darwin-x64": [["dugite-native-v2.53.0-4098283-macOS-x64.tar.gz", 66_136_060, "ae6686718aa34f4140424db16b92a47dcffd6d1f312eb8b5f3b267f7404e2680"], ["node-v26.10.0-darwin-x64.tar.gz", 59_578_150, "ebbe9ab9b58ad6bb54390d6e2c862c1afa7d4475fb7e8ae8146acde211bf70df"]],
    "win32-arm64": [["dugite-native-v2.53.0-4098283-windows-arm64.tar.gz", 45_084_825, "1abbeb3a2ce06e9b80e75bb888dce959b6c73bdb11ccc670a01a71d64f4422a5"], ["node-v26.10.0-win-arm64.zip", 37_149_989, "b778640d7271566bcaa9679912cdf0684c13e824c114e41a8b696fb14af7a7aa"]],
    "win32-x64": [["dugite-native-v2.53.0-4098283-windows-x64.tar.gz", 47_119_821, "7b76bc5c32c0d7c5984efdc2a8a32697cf1e8a43bc55176fbf9869c0ee995130"], ["node-v26.10.0-win-x64.zip", 41_688_989, "9fef7eca6743a6b910989cd8e78712376b394fcb9b6e1e9c44a0799a287f90c5"]],
  };
  for (const [target, [gitPin, nodePin]] of Object.entries(expected)) {
    const runtimeRoot = target.startsWith("win32-") ? WINDOWS_RUNTIME : DARWIN_RUNTIME;
    const contract = equinoxLocalToolchainContract({ runtimeRoot, target });
    assert.deepEqual([contract.git.distribution.filename, contract.git.distribution.bytes, contract.git.distribution.sha256], gitPin);
    assert.deepEqual([contract.node.distribution.filename, contract.node.distribution.bytes, contract.node.distribution.sha256], nodePin);
    assert.match(contract.git.distribution.url, /^https:\/\/github\.com\/desktop\/dugite-native\/releases\/download\/v2\.53\.0-4\//u);
    assert.match(contract.node.distribution.url, /^https:\/\/nodejs\.org\/dist\/v26\.10\.0\//u);
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
