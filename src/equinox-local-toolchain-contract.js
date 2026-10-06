import path from "node:path";

import { equinoxLocalReleaseTargetContract } from "./equinox-local-platform.js";
import {
  DUGITE_DISTRIBUTIONS,
  EQUINOX_LOCAL_DUGITE_VERSION,
  EQUINOX_LOCAL_NODE_VERSION,
  NODE_DISTRIBUTIONS,
} from "./equinox-local-runtime-versions.js";

const DUGITE_RELEASE_BASE = `https://github.com/desktop/dugite-native/releases/download/v${EQUINOX_LOCAL_DUGITE_VERSION}`;
const NODE_RELEASE_BASE = `https://nodejs.org/dist/v${EQUINOX_LOCAL_NODE_VERSION}`;

function safeRuntimeRoot(runtimeRoot, pathApi) {
  if (typeof runtimeRoot !== "string" || runtimeRoot.length === 0 || runtimeRoot.includes("\0") || !pathApi.isAbsolute(runtimeRoot)) {
    throw new Error("Equinox Local toolchain runtime root must be an absolute path.");
  }
  const normalized = pathApi.normalize(runtimeRoot);
  if (normalized === pathApi.parse(normalized).root) {
    throw new Error("Equinox Local toolchain runtime root cannot be a filesystem root.");
  }
  return normalized;
}

function pinnedDistribution(distribution, baseUrl) {
  if (!distribution) throw new Error("Equinox Local toolchain distribution is unavailable.");
  return Object.freeze({
    filename: distribution.filename,
    bytes: distribution.bytes,
    sha256: distribution.sha256,
    url: `${baseUrl}/${distribution.filename}`,
  });
}

function nodeArchiveRoot(filename) {
  if (filename.endsWith(".tar.gz")) return filename.slice(0, -".tar.gz".length);
  if (filename.endsWith(".zip")) return filename.slice(0, -".zip".length);
  throw new Error("Pinned Node distribution has an unsupported archive type.");
}

export function equinoxLocalToolchainContract({ runtimeRoot, target }) {
  const targetContract = equinoxLocalReleaseTargetContract(target);
  const windows = targetContract.platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  const normalizedRuntimeRoot = safeRuntimeRoot(runtimeRoot, pathApi);
  const dugiteDistribution = pinnedDistribution(DUGITE_DISTRIBUTIONS[target], DUGITE_RELEASE_BASE);
  const nodeDistribution = pinnedDistribution(NODE_DISTRIBUTIONS[target], NODE_RELEASE_BASE);

  const toolchainRoot = pathApi.join(normalizedRuntimeRoot, "toolchain");
  const gitRoot = pathApi.join(toolchainRoot, "git", EQUINOX_LOCAL_DUGITE_VERSION, target);
  const nodeRoot = pathApi.join(toolchainRoot, "node", EQUINOX_LOCAL_NODE_VERSION, target);

  const gitPath = windows
    ? pathApi.join(gitRoot, "cmd", "git.exe")
    : pathApi.join(gitRoot, "bin", "git");
  const nodePath = windows
    ? pathApi.join(nodeRoot, "node.exe")
    : pathApi.join(nodeRoot, "bin", "node");
  const npmPath = windows
    ? pathApi.join(nodeRoot, "node_modules", "npm", "bin", "npm-cli.js")
    : pathApi.join(nodeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const npxPath = windows
    ? pathApi.join(nodeRoot, "node_modules", "npm", "bin", "npx-cli.js")
    : pathApi.join(nodeRoot, "lib", "node_modules", "npm", "bin", "npx-cli.js");

  const npmLauncherPath = windows
    ? pathApi.join(nodeRoot, "npm.cmd")
    : pathApi.join(nodeRoot, "bin", "npm");
  const npxLauncherPath = windows
    ? pathApi.join(nodeRoot, "npx.cmd")
    : pathApi.join(nodeRoot, "bin", "npx");

  return Object.freeze({
    schemaVersion: 1,
    target,
    platform: targetContract.platform,
    runtimeRoot: normalizedRuntimeRoot,
    toolchainRoot,
    ambientPathDiscovery: false,
    gitPath,
    nodePath,
    npmPath,
    npxPath,
    gitInvocation: Object.freeze({ command: gitPath, argsPrefix: Object.freeze([]) }),
    npmInvocation: Object.freeze({ command: nodePath, argsPrefix: Object.freeze([npmPath]) }),
    npxInvocation: Object.freeze({ command: nodePath, argsPrefix: Object.freeze([npxPath]) }),
    git: Object.freeze({
      component: "git",
      version: EQUINOX_LOCAL_DUGITE_VERSION,
      target,
      root: gitRoot,
      archiveRoot: ".",
      distribution: dugiteDistribution,
    }),
    node: Object.freeze({
      component: "node",
      version: EQUINOX_LOCAL_NODE_VERSION,
      target,
      root: nodeRoot,
      archiveRoot: nodeArchiveRoot(nodeDistribution.filename),
      distribution: nodeDistribution,
      launcherPaths: Object.freeze({ npm: npmLauncherPath, npx: npxLauncherPath }),
    }),
  });
}
