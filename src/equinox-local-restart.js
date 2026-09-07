import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { launchDetachedHelper } from "./equinox-local-detached-helper.js";

const DEFAULT_HELPER_PATH = fileURLToPath(new URL("./equinox-local-restart-helper.js", import.meta.url));

export function restartHelperEnvironment(installation, sourceEnv = process.env) {
  const env = {
    HOME: sourceEnv.HOME,
    USER: sourceEnv.USER,
    LOGNAME: sourceEnv.LOGNAME,
    TMPDIR: sourceEnv.TMPDIR,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    EQUINOX_LOCAL_INSTALL_ROOT: installation?.installRoot,
    EQUINOX_LOCAL_RELEASE_DIR: installation?.releaseDir,
  };
  return Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string" && value.length > 0));
}

export async function scheduleEquinoxLocalRestart({
  installation,
  spawnImpl = spawnChild,
  nodePath = process.execPath,
  helperPath = DEFAULT_HELPER_PATH,
  sourceEnv = process.env,
} = {}) {
  if (!installation?.selfUpdateSupported || !installation?.managed) {
    throw new Error("A managed Equinox Local installation is required to schedule restart.");
  }
  await launchDetachedHelper({
    spawnImpl,
    command: nodePath,
    args: [helperPath, "--restart"],
    options: {
      detached: true,
      stdio: "ignore",
      env: restartHelperEnvironment(installation, sourceEnv),
    },
    label: "Equinox Local restart helper",
  });
  return Object.freeze({ scheduled: true });
}

export async function scheduleSourceCheckoutRestart({
  fsImpl = fs,
  pathImpl = path,
  processImpl = process,
  spawnImpl = spawnChild,
  moduleUrl = import.meta.url,
} = {}) {
  const serverPath = fileURLToPath(moduleUrl);
  const moduleDir = pathImpl.dirname(serverPath);
  const sourceRoot = pathImpl.basename(moduleDir) === "src"
    ? pathImpl.dirname(moduleDir)
    : moduleDir;
  const scriptPath = pathImpl.join(
    sourceRoot,
    "scripts",
    "restart-runtime.sh",
  );
  const scriptStats = await fsImpl.lstat(scriptPath);

  if (scriptStats.isSymbolicLink() || !scriptStats.isFile()) {
    throw new Error(
      "Source runtime yeniden başlatma scripti normal bir dosya değil.",
    );
  }

  const sourceRestartEnv = {
    HOME: processImpl.env.HOME,
    USER: processImpl.env.USER,
    LOGNAME: processImpl.env.LOGNAME,
    TMPDIR: processImpl.env.TMPDIR,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    EQUINOX_LOCAL_DEV_NODE: processImpl.execPath,
    EQUINOX_LOCAL_DEV_RUNTIME_CONFIG:
      processImpl.env.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG,
  };
  const child = spawnImpl(
    "/bin/bash",
    [scriptPath],
    {
      detached: true,
      stdio: "ignore",
      env: Object.fromEntries(
        Object.entries(sourceRestartEnv).filter(
          ([, value]) =>
            typeof value === "string" &&
            value.length > 0,
        ),
      ),
    },
  );

  child.unref();
  return Object.freeze({
    scheduled: true,
    scriptPath,
    logPath: pathImpl.join(
      processImpl.env.TMPDIR ?? "/tmp",
      "equinox-local-restart.log",
    ),
  });
}

export function registerRestartRuntimeTool({
  registerTextTool,
  installation,
  scheduleManagedRestart = scheduleEquinoxLocalRestart,
  scheduleSourceRestart = scheduleSourceCheckoutRestart,
  sourceModuleUrl = import.meta.url,
  fsImpl = fs,
  pathImpl = path,
  processImpl = process,
  markRestartPending = () => {},
  textResult,
  errorResult,
} = {}) {
  registerTextTool(
    "restart_runtime",
    {
      description:
        "Equinox Local runtime'ını kurulum türüne uygun güvenli restart yoluyla yeniden başlatmayı zamanlar. " +
        "Managed kurulumlar bundled LaunchAgent helper'ını, source checkout geliştirme ortamları ise private developer runtime config'ini kullanır. " +
        "Bu araç başarılı döndükten sonra AYNI ASİSTAN TURUNDA başka Equinox Local aracı çağırma; kullanıcıya hemen final durum yanıtı ver.",
      inputSchema: {},
      annotations: {
        title:
          "Equinox Local runtime'ını yeniden başlat",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        if (
          installation.managed &&
          installation.selfUpdateSupported
        ) {
          await scheduleManagedRestart({
            installation,
          });
          markRestartPending();

          return textResult(
            [
              "Equinox Local managed yeniden başlatması zamanlandı.",
              "Bundled LaunchAgent helper kısa bir gecikmeden sonra aktif sürümü yeniden başlatacak.",
              "Bu çağrıdan sonra aynı asistan turunda başka Equinox Local aracı çağrılmamalı.",
              "MCP bağlantısı kısa süreliğine kesilip yeniden kurulabilir.",
            ].join("\n"),
          );
        }

        const sourceRestart = await scheduleSourceRestart({
          fsImpl,
          pathImpl,
          processImpl,
          moduleUrl: sourceModuleUrl,
        });
        markRestartPending();

        return textResult(
          [
            "Equinox Local source-checkout yeniden başlatması zamanlandı.",
            "Private developer runtime config üzerinden yaklaşık 8 saniye içinde başlayacak.",
            "Bu çağrıdan sonra aynı asistan turunda başka Equinox Local aracı çağrılmamalı.",
            "MCP bağlantısı kısa süreliğine kesilip yeniden kurulabilir.",
            `Kayıt: ${sourceRestart.logPath}`,
          ].join("\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
    {
      projectAware: false,
      mutationScopes: ["global"],
    },
  );
}
