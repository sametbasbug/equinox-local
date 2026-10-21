import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

type FilePredicate = (absolute: string, name: string) => boolean;
type CollectOptions = {
  recursiveDirectories?: readonly string[] | undefined;
  topLevelDirectories?: string[];
  includeRootFiles?: boolean;
  skipDirectoryNames?: string[];
  includeFile?: FilePredicate;
  includeRootFile?: FilePredicate;
};
type SpawnAsync = (command: string, args: string[], options: {cwd: string; stdio: StdioOptions; env: NodeJS.ProcessEnv}) => ChildProcess;
type SpawnSyncCheck = (command: string, args: string[], options: {cwd: string; stdio: StdioOptions}) => {status: number | null};
type CheckOptions = CollectOptions & {rootDir: string; deduplicate?: boolean; jsonFiles?: readonly string[]; spawnSyncImpl?: SpawnSyncCheck | undefined; javascriptCommand?: string; shellCommand?: string | undefined};
type RunOptions = {files: string[]; cwd: string; profile: string; stdio?: StdioOptions; spawnImpl?: SpawnAsync; propagateSignal?: (signal: NodeJS.Signals) => void};
type DiscoveryOptions = {
  rootDir: string;
  profile: string;
  profileDirectories: Record<string, readonly string[]>;
  topLevelDirectories?: string[];
  testSuffix?: string;
};

export function parseTestProfile(argv: string[]) {
  const argument = argv.find((value) => value.startsWith("--profile="));
  return argument ? argument.slice("--profile=".length) : "full";
}

export async function collectFiles(rootDir: string, {
  recursiveDirectories = [],
  topLevelDirectories = [],
  includeRootFiles = false,
  skipDirectoryNames = [],
  includeFile = () => true,
  includeRootFile = includeFile,
}: CollectOptions = {}): Promise<string[]> {
  const files: string[] = [];
  const skippedDirectories = new Set(skipDirectoryNames);

  async function walk(directory: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) await walk(absolute);
      } else if (entry.isFile() && includeFile(absolute, entry.name)) {
        files.push(absolute);
      }
    }
  }

  for (const relative of recursiveDirectories) await walk(path.join(rootDir, relative));
  for (const relative of topLevelDirectories) {
    const directory = path.join(rootDir, relative);
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isFile()) {
        const absolute = path.join(directory, entry.name);
        if (includeFile(absolute, entry.name)) files.push(absolute);
      }
    }
  }
  if (includeRootFiles) {
    for (const entry of await fs.readdir(rootDir, { withFileTypes: true })) {
      if (entry.isFile()) {
        const absolute = path.join(rootDir, entry.name);
        if (includeRootFile(absolute, entry.name)) files.push(absolute);
      }
    }
  }
  return files;
}

export async function discoverTests({
  rootDir,
  profile,
  profileDirectories,
  topLevelDirectories = [],
  testSuffix = ".test.js",
}: DiscoveryOptions): Promise<string[]> {
  if (!Object.hasOwn(profileDirectories ?? {}, profile)) {
    throw new Error(`Unknown test profile: ${profile}`);
  }
  const files = await collectFiles(rootDir, {
    recursiveDirectories: profileDirectories[profile],
    topLevelDirectories,
    includeFile: (_absolute, name) => name.endsWith(testSuffix),
  });
  return files.sort();
}

export function runNodeTests({
  files,
  cwd,
  profile,
  stdio = "inherit",
  spawnImpl = spawn,
  propagateSignal = (signal) => process.kill(process.pid, signal),
}: RunOptions = {} as RunOptions): Promise<number> {
  const child = spawnImpl(process.execPath, ["--test", ...files], {
    cwd,
    stdio,
    env: {
      ...process.env,
      EQUINOX_TEST_PROFILE: profile,
    },
  });

  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        propagateSignal(signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export async function checkProject({
  rootDir,
  recursiveDirectories = [],
  skipDirectoryNames = [],
  includeRootFiles = false,
  includeFile = (_absolute, name) => /\.(?:js|mjs)$/u.test(name) || name.endsWith(".sh"),
  includeRootFile = includeFile,
  deduplicate = false,
  jsonFiles = [],
  spawnSyncImpl = spawnSync,
  javascriptCommand = process.execPath,
  shellCommand = "/bin/bash",
}: CheckOptions = {} as CheckOptions) {
  const discovered = await collectFiles(rootDir, {
    recursiveDirectories,
    includeRootFiles,
    skipDirectoryNames,
    includeFile,
    includeRootFile,
  });
  const relativeFiles = discovered.map((file) => path.relative(rootDir, file));
  const javascriptFiles = relativeFiles.filter((file) => /\.(?:js|mjs)$/u.test(file));
  const shellFiles = relativeFiles.filter((file) => file.endsWith(".sh"));
  const javascript = deduplicate ? [...new Set(javascriptFiles)] : javascriptFiles;
  const shell = deduplicate ? [...new Set(shellFiles)] : shellFiles;
  javascript.sort();
  shell.sort();

  for (const file of javascript) {
    const result = spawnSyncImpl(javascriptCommand, ["--check", file], { cwd: rootDir, stdio: "inherit" });
    if (result.status !== 0) {
      return Object.freeze({
        exitCode: result.status ?? 1,
        javascriptFiles: javascript,
        shellFiles: shell,
        jsonFiles: [],
      });
    }
  }
  for (const file of shell) {
    const result = spawnSyncImpl(shellCommand, ["-n", file], { cwd: rootDir, stdio: "inherit" });
    if (result.status !== 0) {
      return Object.freeze({
        exitCode: result.status ?? 1,
        javascriptFiles: javascript,
        shellFiles: shell,
        jsonFiles: [],
      });
    }
  }
  for (const file of jsonFiles) JSON.parse(await fs.readFile(path.join(rootDir, file), "utf8"));

  return Object.freeze({
    exitCode: 0,
    javascriptFiles: javascript,
    shellFiles: shell,
    jsonFiles: [...jsonFiles],
  });
}
