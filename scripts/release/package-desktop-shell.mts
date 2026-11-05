import { packager } from "@electron/packager";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EQUINOX_LOCAL_VERSION } from "../../src/equinox-local-version.js";
import { createIcns, nativePermissionIdentityInfoPlist, nativePermissionDesignatedRequirementSource } from "../../src/equinox-local-native-app-host.js";
import { buildEquinoxLocalProcessSessionHelper } from "../../src/equinox-local-native-app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const execFile = promisify(execFileCallback);
const TARGETS = new Set(["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]);
const SHELL_FILES = Object.freeze([
  "desktop/main.js", "desktop/control-client.js", "desktop/preload.cjs",
  "desktop/runtime-owner.js", "desktop/runtime-installation.js", "desktop/lifecycle-control.js",
  "desktop/uninstall-handoff.js", "desktop/shell-preferences.js", "desktop/companion.js",
  "desktop/companion-preload.cjs", "desktop/companion-renderer.js", "desktop/companion.html", "desktop/companion.css",
  "app/EquinoxLocal.png", "app/EquinoxLocalMenuBar.png", "app/EquinoxCompanionNyx.webp",
]);

type DesktopBuildOptions = { rootDir?: string; outputDir?: string; target?: string };
type ManagedDesktopIdentity = { sourceSha: string; shellVersion: number };

/** Default CLI stays attach-only; installed artifacts require the explicit managed entrypoint. */
export async function packageDevelopmentDesktopShell({
  rootDir = root,
  outputDir = path.join(root, "artifacts", "desktop"),
  target = `${process.platform}-${process.arch}`,
}: DesktopBuildOptions = {}) {
  return await packageDesktopShell({ rootDir, outputDir, target });
}

/** Build-only: no installation, signing-key access, publication or Factory conversion. */
export async function packageManagedDesktopShell({
  rootDir = root, outputDir = path.join(root, "artifacts", "desktop"), target = `${process.platform}-${process.arch}`,
  sourceSha, shellVersion,
}: DesktopBuildOptions & ManagedDesktopIdentity) {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha) || !Number.isSafeInteger(shellVersion) || shellVersion < 1) {
    throw new Error("Managed desktop build requires exact source and shell identities.");
  }
  const options = { timeout: 10_000, maxBuffer: 1024 * 1024 };
  const head = await execFile("git", ["-C", rootDir, "rev-parse", "HEAD"], options);
  const status = await execFile("git", ["-C", rootDir, "status", "--porcelain=v1", "--untracked-files=all"], options);
  if (String(head.stdout).trim() !== sourceSha || String(status.stdout).trim()) throw new Error("Managed desktop source must match the exact clean checkout.");
  return await packageDesktopShell({ rootDir, outputDir, target }, { sourceSha, shellVersion });
}

async function packageDesktopShell({ rootDir, outputDir, target }: Required<DesktopBuildOptions>, identity?: ManagedDesktopIdentity) {
  if (!TARGETS.has(target)) throw new Error("Unsupported desktop target.");
  if (!path.isAbsolute(outputDir)) throw new Error("Desktop output must be absolute.");
  const [platform, arch] = target.split("-") as ["darwin" | "win32", "arm64" | "x64"];
  if (identity && process.platform !== platform) throw new Error("Managed desktop packaging requires its native build host.");
  const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
  const version = packageJson.devDependencies?.electron;
  if (version !== "46.0.0-alpha.5") throw new Error("Desktop build requires the exact approved Electron pin.");
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const outputStat = await fs.lstat(outputDir);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink() || await fs.realpath(outputDir) !== outputDir) {
    throw new Error("Desktop output directory is unsafe.");
  }
  const expectedOutput = path.join(outputDir, `Equinox Local-${target}`);
  try {
    await fs.lstat(expectedOutput);
    throw new Error("Desktop output already exists; choose a new output directory.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-desktop-build-"));
  try {
    const application = path.join(stage, "application");
    await fs.mkdir(application, { mode: 0o700 });
    for (const relative of SHELL_FILES) {
      const source = path.join(rootDir, relative);
      const stat = await fs.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Desktop build input is not a normal file: ${relative}`);
      const destination = path.join(application, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    }
    await fs.writeFile(path.join(application, "package.json"), JSON.stringify({
      name: "equinox-local-desktop", productName: "Equinox Local", version: EQUINOX_LOCAL_VERSION,
      type: "module", main: "desktop/main.js", equinoxRuntimeRole: identity ? "managed" : "development",
      ...(identity ? { equinoxDesktopSchema: 1, equinoxSourceSha: identity.sourceSha } : {}),
      description: "Equinox Local Control Center", author: "Samet Basbug", license: "AGPL-3.0-only",
    }, null, 2), { mode: 0o600 });
    let icon: string | undefined;
    let nativeResource: string | undefined;
    if (platform === "darwin" && process.platform === "darwin") {
      icon = path.join(stage, "EquinoxLocal.icns");
      await createIcns(path.join(rootDir, "app", "EquinoxLocal.png"), icon, stage);
      const helper = await buildEquinoxLocalProcessSessionHelper({ rootDir, outputDir: stage, target: `darwin-${arch}` });
      nativeResource = path.dirname(helper);
    } else if (platform === "win32") {
      icon = path.join(rootDir, "native", "windows", "EquinoxLocal.WindowsShell", "Assets", "EquinoxLocal.ico");
    }
    const outputs = await packager({
      dir: application, name: "Equinox Local", executableName: platform === "darwin" ? "applet" : "EquinoxLocal",
      platform, arch, electronVersion: version, appVersion: EQUINOX_LOCAL_VERSION,
      appBundleId: identity ? "dev.equinox.local" : "dev.equinox.local.development", appCategoryType: "public.app-category.developer-tools",
      asar: true, prune: false, overwrite: false, out: outputDir, ...(icon ? { icon } : {}),
      ...(nativeResource ? { extraResource: nativeResource } : {}),
      extendInfo: { NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
        ...(identity ? { ...nativePermissionIdentityInfoPlist(), EquinoxLocalNativeShellVersion: identity.shellVersion, EquinoxLocalSourceSha: identity.sourceSha } : {}),
      },
    });
    if (outputs.length !== 1 || outputs[0] !== expectedOutput) throw new Error("Desktop packager returned an unexpected target.");
    if (platform === "darwin" && process.platform === "darwin") {
      const bundle = path.join(expectedOutput, "Equinox Local.app");
      // Sign nested code first with its own identities; apply the existing stable requirement to the outer app only.
      await execFile("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", bundle], { timeout: 120_000 });
      if (identity) await execFile("/usr/bin/codesign", ["--force", "--sign", "-", "-r", `=${nativePermissionDesignatedRequirementSource()}`, bundle], { timeout: 120_000 });
      await execFile("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], { timeout: 120_000 });
    }
    const executable = platform === "darwin"
      ? path.join(expectedOutput, "Equinox Local.app", "Contents", "MacOS", "applet")
      : path.join(expectedOutput, "EquinoxLocal.exe");
    const executableStat = await fs.lstat(executable);
    if (!executableStat.isFile() || executableStat.isSymbolicLink()) throw new Error("Desktop executable is missing.");
    return { target, electron: version, role: identity ? "managed" : "development", output: expectedOutput, executable };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const allowed = new Set(["--target", "--output"]);
  const options = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]!;
    const value = process.argv[index + 1];
    if (!allowed.has(key) || !value || options.has(key)) throw new Error("Use --target <target> and/or --output <absolute directory>.");
    options.set(key, value);
  }
  const result = await packageDevelopmentDesktopShell({
    ...(options.has("--target") ? { target: options.get("--target")! } : {}),
    ...(options.has("--output") ? { outputDir: options.get("--output")! } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
}
