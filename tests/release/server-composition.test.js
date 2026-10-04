import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { equinoxBrowserSocketDirectory, equinoxBrowserSocketPath } from "../../src/equinox-browser-socket.js";

const SERVER_PATH = new URL("../../src/server.js", import.meta.url);
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const execFileAsync = promisify(execFile);

function createFixtureSocketNamespace() {
  return `fixture-${randomBytes(12).toString("hex")}`;
}

async function acquireOwnedSocketDirectory(directory) {
  await fs.mkdir(directory, { mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Socket fixture did not acquire a normal directory.");
  }
  return Object.freeze({ directory, dev: stat.dev, ino: stat.ino, uid: stat.uid ?? null });
}

function isOwnedDirectory(stat, ownership) {
  return Boolean(
    stat && stat.isDirectory() && !stat.isSymbolicLink() &&
    stat.dev === ownership.dev && stat.ino === ownership.ino &&
    (ownership.uid == null || stat.uid === ownership.uid),
  );
}

async function cleanupOwnedSocketDirectory(ownership) {
  const current = await fs.lstat(ownership.directory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!current) return;
  if (!isOwnedDirectory(current, ownership)) {
    throw new Error("Socket fixture directory ownership changed; leaving it in place.");
  }

  const contents = await fs.readdir(ownership.directory);
  if (contents.length > 0) {
    throw new Error("Socket fixture directory has unexpected contents; leaving it in place.");
  }

  const verified = await fs.lstat(ownership.directory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!verified) return;
  if (!isOwnedDirectory(verified, ownership)) {
    throw new Error("Socket fixture directory ownership changed; leaving it in place.");
  }

  await fs.rmdir(ownership.directory);
}

const CHILD_ENV_ALLOWLIST = process.platform === "win32"
  ? ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "USER", "LOGNAME", "LANG", "LC_ALL"]
  : ["PATH", "USER", "LOGNAME", "LANG", "LC_ALL"];

function createFixtureChildEnvironment({
  configPath,
  homePath,
  privateModulePath,
  privateModuleSource,
  root,
  socketDirectoryOwnership,
  socketNamespace,
  tempPath,
}, hostEnvironment = process.env) {
  const childEnvironment = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (typeof hostEnvironment[key] === "string") childEnvironment[key] = hostEnvironment[key];
  }

  Object.assign(childEnvironment, {
    HOME: homePath,
    USERPROFILE: homePath,
    APPDATA: path.join(homePath, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(homePath, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(homePath, ".config"),
    XDG_DATA_HOME: path.join(homePath, ".local", "share"),
    XDG_STATE_HOME: path.join(homePath, ".local", "state"),
    TMPDIR: tempPath,
    TMP: tempPath,
    TEMP: tempPath,
    EQUINOX_COMPOSITION_FIXTURE_HOME: homePath,
    EQUINOX_LOCAL_CONFIG_PATH: configPath,
    EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE: socketNamespace,
    EQUINOX_LOCAL_PRIVATE_COMPOSITION_MODULE: privateModuleSource ? privateModulePath : "",
    EQUINOX_LOCAL_PRIVATE_COMPOSITION_ROOT: privateModuleSource ? root : "",
    EQUINOX_COMPOSITION_FIXTURE_SOCKET_DIRECTORY: socketDirectoryOwnership?.directory ?? "",
    EQUINOX_COMPOSITION_FIXTURE_SOCKET_DIRECTORY_DEV: socketDirectoryOwnership ? String(socketDirectoryOwnership.dev) : "",
    EQUINOX_COMPOSITION_FIXTURE_SOCKET_DIRECTORY_INO: socketDirectoryOwnership ? String(socketDirectoryOwnership.ino) : "",
    EQUINOX_COMPOSITION_FIXTURE_SOCKET_DIRECTORY_UID: socketDirectoryOwnership?.uid == null
      ? ""
      : String(socketDirectoryOwnership.uid),
  });
  return childEnvironment;
}

async function readServer() {
  return await fs.readFile(SERVER_PATH, "utf8");
}

test("server composition keeps extracted helper wiring valid", async () => {
  const source = await readServer();

  assert.equal(
    source.includes("terminalJsonResult"),
    false,
    "terminal JSON formatting is local to the terminal tool module and must not leak into the composition root",
  );

  const helperDeclaration = source.indexOf("const processJsonResult =");
  const firstHelperInjection = source.indexOf("processJsonResult,", helperDeclaration + 1);
  assert.notEqual(helperDeclaration, -1, "processJsonResult must be defined in the composition root");
  assert.notEqual(firstHelperInjection, -1, "processJsonResult must still be injected into extracted modules");
  assert.ok(
    helperDeclaration < firstHelperInjection,
    "processJsonResult must be initialized before its first injection",
  );
});

test("server composition initializes Browser dependencies before private visual tools", async () => {
  const source = await readServer();

  const bridgeCreation = source.indexOf("const equinoxBrowserBridge = createEquinoxBrowserBridge(");
  const agentCreation = source.indexOf("equinoxAgentBrowser = createEquinoxAgentBrowser(");
  const visualRegistration = source.indexOf("registerPrivateVisualTools({");

  assert.notEqual(bridgeCreation, -1);
  assert.notEqual(agentCreation, -1);
  assert.notEqual(visualRegistration, -1);
  assert.ok(bridgeCreation < visualRegistration, "Browser bridge must exist before private visual tools register");
  assert.ok(agentCreation < visualRegistration, "Agent Browser manager must exist before private visual tools register");
});

test("server Telegram task state follows the injected runtime platform paths", async () => {
  const source = await readServer();

  assert.match(source, /statePath:\s*defaultTelegramTaskStatePath\(runtimeHomeDir, \{ platform, arch, env: runtimeEnv \}\)/u);
});

test("server restart quiesces continuity before scheduling and restores it on failure", async () => {
  const source = await readServer();

  assert.match(source, /async function quiesceContinuityForRestart\(\)[\s\S]*freshChatResumeController\.shutdown\(\)[\s\S]*autoContinueController\.shutdown\(\)/u);
  assert.match(source, /async function restartLocalRuntime\(\)[\s\S]*await quiesceContinuityForRestart\(\)/u);
  assert.ok(source.includes("restartRuntime: restartLocalRuntime"));
  assert.ok(source.includes("requestRestart: requestTelegramRuntimeRestart"));
  assert.ok(source.includes("beforeRestart: quiesceContinuityForRestart"));
  assert.ok(source.includes("restartFailed: resumeContinuityAfterFailedRestart"));
});

test("server composition imports workflow TCP probing dependency", async () => {
  const source = await readServer();

  assert.match(
    source,
    /import\s*\{[\s\S]*?createProcessManager,[\s\S]*?probeTcpPort,[\s\S]*?\}\s*from\s*"\.\/process-manager\.js";/u,
  );
  assert.ok(source.includes("probeTcpPort,"), "workflow/release registrations must receive probeTcpPort");
});

test("composition fixture refuses predictable namespaces and recursive shared socket cleanup", async () => {
  const source = await fs.readFile(new URL(import.meta.url), "utf8");
  assert.doesNotMatch(source, /const socketNamespace\s*=\s*`server-\$\{process\.pid\}`/u);
  assert.doesNotMatch(source, /fs\.rm\(socketDirectory,\s*\{\s*recursive:\s*true/u);
  const ownershipAcquisition = source.search(/socketDirectoryOwnership\s*=\s*await acquireOwnedSocketDirectory\(socketDirectory\)/u);
  const childStartup = source.search(/await execFileAsync\(process\.execPath,\s*\["--input-type=module", "--eval", script\]/u);
  assert.notEqual(ownershipAcquisition, -1, "Unix socket ownership must be acquired by the fixture");
  assert.ok(ownershipAcquisition < childStartup, "socket ownership must be acquired before child startup");
  assert.match(
    source,
    /"const lifecycle = await runtime\.start\(\{ transport \}\);",\s*"try \{",[\s\S]*\.\.\.assertions\.map\(\(assertion\) => `  \$\{assertion\}`\),\s*"\} finally \{",\s*"  await lifecycle\.shutdown\(\);"/u,
    "child assertion failures must still shut down the runtime lifecycle",
  );
});

test("composition fixture binds child startup to the acquired socket directory identity", async () => {
  const source = await fs.readFile(new URL(import.meta.url), "utf8");
  assert.doesNotMatch(source, /env:\s*\{\s*\.\.\.process\.env/u);
  assert.match(source, /EQUINOX_COMPOSITION_FIXTURE_SOCKET_DIRECTORY_DEV/u);
  assert.match(source, /EQUINOX_COMPOSITION_FIXTURE_SOCKET_DIRECTORY_INO/u);
  assert.match(source, /assertFixtureSocketDirectoryIdentity\(\)/u);
});

test("composition child environment keeps fixture paths and excludes ambient credentials and overrides", () => {
  const environment = createFixtureChildEnvironment({
    configPath: "/fixture/config.json",
    homePath: "/fixture/home",
    privateModulePath: "/fixture/private.mjs",
    privateModuleSource: "",
    root: "/fixture",
    socketDirectoryOwnership: { directory: "/tmp/equinox-fixture", dev: 3, ino: 7, uid: 501 },
    socketNamespace: "fixture-test",
    tempPath: "/fixture/tmp",
  }, {
    PATH: "/trusted/bin",
    USER: "fixture-user",
    LOGNAME: "fixture-user",
    LANG: "C",
    LC_ALL: "C",
    HOME: "/ambient/home",
    NODE_OPTIONS: "--require /untrusted/hook.js",
    AWS_SECRET_ACCESS_KEY: "do-not-inherit",
    EQUINOX_LOCAL_CONFIG_PATH: "/ambient/config.json",
    SSH_AUTH_SOCK: "/ambient/agent.sock",
  });

  assert.equal(environment.PATH, "/trusted/bin");
  assert.equal(environment.HOME, "/fixture/home");
  assert.equal(environment.EQUINOX_LOCAL_CONFIG_PATH, "/fixture/config.json");
  assert.equal(environment.EQUINOX_COMPOSITION_FIXTURE_SOCKET_DIRECTORY_INO, "7");
  assert.equal(Object.hasOwn(environment, "NODE_OPTIONS"), false);
  assert.equal(Object.hasOwn(environment, "AWS_SECRET_ACCESS_KEY"), false);
  assert.equal(Object.hasOwn(environment, "SSH_AUTH_SOCK"), false);
});

test("socket fixture namespace is unique and meets the product length and character bounds", () => {
  const first = createFixtureSocketNamespace();
  const second = createFixtureSocketNamespace();
  assert.match(first, /^[a-z0-9][a-z0-9-]{0,31}$/u);
  assert.ok(first.length <= 32);
  assert.notEqual(first, second);
});

test("socket fixture ownership rejects an existing directory without removing it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-socket-ownership-"));
  const directory = path.join(root, "occupied");
  const marker = path.join(directory, "keep.txt");
  try {
    await fs.mkdir(directory);
    await fs.writeFile(marker, "preserve");
    await assert.rejects(acquireOwnedSocketDirectory(directory), { code: "EEXIST" });
    assert.equal(await fs.readFile(marker, "utf8"), "preserve");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("socket fixture cleanup refuses a replaced directory and preserves it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-socket-ownership-"));
  const directory = path.join(root, "socket");
  const originalDirectory = path.join(root, "original");
  const marker = path.join(directory, "keep.txt");
  try {
    const ownership = await acquireOwnedSocketDirectory(directory);
    await fs.rename(directory, originalDirectory);
    await fs.mkdir(directory);
    await fs.writeFile(marker, "preserve replacement");
    await assert.rejects(cleanupOwnedSocketDirectory(ownership), /ownership|replaced|changed/iu);
    assert.equal(await fs.readFile(marker, "utf8"), "preserve replacement");
    assert.equal((await fs.lstat(originalDirectory)).isDirectory(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("socket fixture cleanup refuses unexpected contents and preserves them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-socket-ownership-"));
  const directory = path.join(root, "socket");
  const marker = path.join(directory, "unexpected.txt");
  try {
    const ownership = await acquireOwnedSocketDirectory(directory);
    await fs.writeFile(marker, "preserve unexpected entry");
    await assert.rejects(cleanupOwnedSocketDirectory(ownership), /contents|not empty/iu);
    assert.equal(await fs.readFile(marker, "utf8"), "preserve unexpected entry");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("socket fixture cleanup removes only the same owned empty directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-socket-ownership-"));
  const directory = path.join(root, "socket");
  try {
    const ownership = await acquireOwnedSocketDirectory(directory);
    await cleanupOwnedSocketDirectory(ownership);
    await assert.rejects(fs.lstat(directory), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function exerciseRuntime({
  privateModuleSource = "",
  assertions = [],
  replaceSocketDirectoryBeforeChild = false,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-server-composition-"));
  const configPath = path.join(root, "config.json");
  const privateModulePath = path.join(root, "private-composition.mjs");
  const downloadsPath = path.join(root, "downloads");
  const workspacePath = path.join(root, "workspace");
  const homePath = path.join(root, "home");
  const tempPath = path.join(root, "tmp");
  const socketNamespace = createFixtureSocketNamespace();
  const socketDirectory = process.platform === "darwin"
    ? equinoxBrowserSocketDirectory({ namespace: socketNamespace })
    : null;
  let socketDirectoryOwnership = null;
  let displacedSocketDirectory = null;
  let replacementSocketDirectoryCreated = false;
  let replacementSocketServer = null;
  let replacementSocketPath = null;
  let replacementMarkerPath = null;
  let replacementSocketProbeCount = 0;
  const config = {
    version: 1,
    defaultProject: "fixture",
    runtime: {
      workspaceProject: "fixture",
      downloadsRoot: "downloads",
    },
    projects: {
      fixture: {
        name: "Fixture",
        root: workspacePath,
        worktrees: false,
      },
    },
    fileRoots: {
      downloads: {
        name: "Downloads",
        root: downloadsPath,
        access: "read-only",
      },
    },
    agentAccess: {
      files: "full",
      terminal: false,
      desktop: false,
      browser: false,
    },
    controlCenter: {
      enabled: false,
      port: 24891,
    },
  };

  try {
    await fs.mkdir(downloadsPath, { recursive: true });
    await fs.mkdir(homePath, { recursive: true });
    await fs.mkdir(tempPath, { recursive: true });
    await fs.mkdir(workspacePath, { recursive: true });
    await execFileAsync("git", ["init", "--quiet", workspacePath], { timeout: 5_000 });
    await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, { flag: "wx", mode: 0o600 });
    if (privateModuleSource) await fs.writeFile(privateModulePath, privateModuleSource);
    if (socketDirectory) {
      socketDirectoryOwnership = await acquireOwnedSocketDirectory(socketDirectory);
    }
    if (replaceSocketDirectoryBeforeChild) {
      assert.ok(socketDirectoryOwnership, "replacement regression requires the isolated Unix socket fixture");
      displacedSocketDirectory = path.join(root, "displaced-browser-socket-directory");
      await fs.rename(socketDirectory, displacedSocketDirectory);
      await fs.mkdir(socketDirectory, { mode: 0o700 });
      replacementSocketDirectoryCreated = true;
      replacementSocketPath = equinoxBrowserSocketPath({ namespace: socketNamespace });
      replacementMarkerPath = path.join(socketDirectory, "protected-marker.txt");
      await fs.writeFile(replacementMarkerPath, "preserve replaced namespace\n", { flag: "wx", mode: 0o600 });
      replacementSocketServer = net.createServer(() => {
        replacementSocketProbeCount += 1;
      });
      await new Promise((resolve, reject) => {
        replacementSocketServer.once("error", reject);
        replacementSocketServer.listen(replacementSocketPath, resolve);
      });
    }
    const script = [
      "const { lstat } = await import('node:fs/promises');",
      "const fixtureSocketDirectory = process.env.EQUINOX_COMPOSITION_FIXTURE_SOCKET_DIRECTORY;",
      "async function assertFixtureSocketDirectoryIdentity() {",
      "  if (!fixtureSocketDirectory) return;",
      "  const expectedDev = Number(process.env.EQUINOX_COMPOSITION_FIXTURE_SOCKET_DIRECTORY_DEV);",
      "  const expectedIno = Number(process.env.EQUINOX_COMPOSITION_FIXTURE_SOCKET_DIRECTORY_INO);",
      "  const expectedUid = process.env.EQUINOX_COMPOSITION_FIXTURE_SOCKET_DIRECTORY_UID === '' ? null : Number(process.env.EQUINOX_COMPOSITION_FIXTURE_SOCKET_DIRECTORY_UID);",
      "  let directoryStat;",
      "  try { directoryStat = await lstat(fixtureSocketDirectory); } catch (error) {",
      "    if (error?.code === 'ENOENT') throw new Error('Fixture Browser socket directory identity changed before startup.');",
      "    throw error;",
      "  }",
      "  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryStat.dev !== expectedDev || directoryStat.ino !== expectedIno || (expectedUid !== null && directoryStat.uid !== expectedUid)) {",
      "    throw new Error('Fixture Browser socket directory identity changed before startup.');",
      "  }",
      "}",
      "await assertFixtureSocketDirectoryIdentity();",
      "const { createEquinoxLocalRuntime } = await import('./src/server.js');",
      "const transport = {",
      "  started: false,",
      "  onclose: undefined,",
      "  onerror: undefined,",
      "  onmessage: undefined,",
      "  async start() { this.started = true; },",
      "  async send() {},",
      "  async close() { this.onclose?.(); },",
      "};",
      "const runtime = await createEquinoxLocalRuntime({ platform: process.platform, arch: process.arch, env: process.env, homeDir: process.env.EQUINOX_COMPOSITION_FIXTURE_HOME });",
      "await assertFixtureSocketDirectoryIdentity();",
      "if (runtime.snapshot().started !== false) throw new Error('runtime started during composition');",
      "await assertFixtureSocketDirectoryIdentity();",
      "const lifecycle = await runtime.start({ transport });",
      "try {",
      "  if (runtime.snapshot().started !== true) throw new Error('runtime did not enter started state');",
      "  if (transport.started !== true) throw new Error('MCP transport did not start');",
      ...assertions.map((assertion) => `  ${assertion}`),
      "} finally {",
      "  await lifecycle.shutdown();",
      "}",
    ].join("\n");
    const childEnvironment = createFixtureChildEnvironment({
      configPath,
      homePath,
      privateModulePath,
      privateModuleSource,
      root,
      socketDirectoryOwnership,
      socketNamespace,
      tempPath,
    });
    let childError = null;
    try {
      await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: REPO_ROOT,
        env: childEnvironment,
        timeout: 15_000,
      });
    } catch (error) {
      childError = error;
    }

    if (replaceSocketDirectoryBeforeChild) {
      assert.ok(childError, "the child must refuse the replaced Browser socket directory");
      assert.match(
        `${childError.stderr ?? ""}\n${childError.message ?? ""}`,
        /Fixture Browser socket directory identity changed before startup/u,
      );
      assert.equal(replacementSocketProbeCount, 0, "rejection must happen before any Browser socket liveness probe");
      assert.equal(await fs.readFile(replacementMarkerPath, "utf8"), "preserve replaced namespace\n");
      assert.equal((await fs.lstat(replacementSocketPath)).isSocket(), true, "the protected fake Browser socket must remain in place");
    } else if (childError) {
      throw childError;
    }
  } finally {
    try {
      if (replacementSocketServer?.listening) {
        await new Promise((resolve) => replacementSocketServer.close(() => resolve()));
      }
      if (replacementSocketDirectoryCreated) {
        const socketEntry = await fs.lstat(replacementSocketPath).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        if (socketEntry) {
          if (!socketEntry.isSocket() || socketEntry.isSymbolicLink()) {
            throw new Error("Fixture replacement socket changed; leaving it in place.");
          }
          await fs.unlink(replacementSocketPath);
        }
        const markerEntry = await fs.lstat(replacementMarkerPath).catch((error) => {
          if (error?.code === "ENOENT") return null;
          throw error;
        });
        if (markerEntry) {
          if (!markerEntry.isFile() || markerEntry.isSymbolicLink()) {
            throw new Error("Fixture replacement marker changed; leaving it in place.");
          }
          await fs.unlink(replacementMarkerPath);
        }
        await fs.rmdir(socketDirectory);
      }
      if (displacedSocketDirectory) {
        await fs.rename(displacedSocketDirectory, socketDirectory);
      }
      if (socketDirectoryOwnership) {
        await cleanupOwnedSocketDirectory(socketDirectoryOwnership);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

test("server fixture refuses a replaced Browser namespace before child startup or socket probing", { skip: process.platform !== "darwin" }, async () => {
  await exerciseRuntime({ replaceSocketDirectoryBeforeChild: true });
});

test("server runtime starts and shuts down in an isolated process", exerciseRuntime);

test("server injects its canonical workflow planner into the admitted private release hook", async () => {
  await exerciseRuntime({
    privateModuleSource: PRIVATE_FIXTURE_NOOPS + `
export function registerPrivateVisualTools() { return null; }
export async function registerPrivateReleaseGateTools({ buildWorkflowPlan }) {
  const plan = buildWorkflowPlan({
    recipeId: "qa-and-preview",
    scripts: { check: "fixture check", build: "fixture build", preview: "fixture preview" },
    options: {},
  });
  globalThis.privateHookStepKinds = plan.steps.map((step) => step.kind);
}
`,
    assertions: [
      'if (JSON.stringify(globalThis.privateHookStepKinds) !== JSON.stringify(["git-clean", "npm-script", "npm-script", "preview-smoke", "git-clean"])) throw new Error("private release hook did not receive the canonical workflow plan");',
    ],
  });
});

const PRIVATE_FIXTURE_NOOPS = `
export function createPrivateReleaseGateRuntime() { return null; }
export function privateWorkflowStepExecutor() { return null; }
export function registerPrivateSecureServiceTools() { return null; }
export async function privateReleaseGateSnapshot() { return {}; }
export async function privateGitHubStatus() { return { ready: false, account: null }; }
`;

test("server injects its schema instance into the admitted private visual hook", async () => {
  await exerciseRuntime({
    privateModuleSource: PRIVATE_FIXTURE_NOOPS + `
export function registerPrivateVisualTools({ z }) {
  globalThis.visualHookSchemaValue = z.string().parse("shared-schema");
}
export async function registerPrivateReleaseGateTools() { return null; }
`,
    assertions: [
      'if (globalThis.visualHookSchemaValue !== "shared-schema") throw new Error("private visual hook was not admitted or invoked");',
    ],
  });
});
