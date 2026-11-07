import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchDetachedHelper } from "./equinox-local-detached-helper.js";
import { projectDarwinDetachedHelperEnvironment } from "./equinox-local-darwin-helper-environment.js";
import { requestWindowsShellRuntimeRestart } from "./equinox-local-windows-shell-control.js";
import { requestDesktopRuntimeRestart } from "./equinox-local-desktop-control.js";
const DEFAULT_HELPER_PATH = fileURLToPath(new URL("./equinox-local-restart-helper.js", import.meta.url));
export function restartHelperEnvironment(installation, sourceEnv = process.env) {
    return projectDarwinDetachedHelperEnvironment({ installation, sourceEnv });
}
export async function scheduleEquinoxLocalRestart({ installation, spawnImpl = spawnChild, nodePath = process.execPath, helperPath = DEFAULT_HELPER_PATH, sourceEnv = process.env, platform = process.platform, requestWindowsRestartImpl = requestWindowsShellRuntimeRestart, } = {}) {
    if (!installation?.selfUpdateSupported || !installation?.managed) {
        throw new Error("A managed Equinox Local installation is required to schedule restart.");
    }
    if (platform === "win32") {
        // Windows is supervised by its native WPF shell. The detached macOS
        // launchctl helper cannot restart it; use the existing same-user pipe.
        const response = await requestWindowsRestartImpl({ platform });
        if (response?.requested !== true)
            throw new Error("Windows shell did not accept the runtime restart request.");
        return Object.freeze({ scheduled: true });
    }
    if (platform !== "darwin")
        throw new Error("Runtime restart is unsupported on this platform.");
    if (sourceEnv.EQUINOX_LOCAL_DESKTOP_OWNER === "1") {
        const response = await requestDesktopRuntimeRestart({ platform });
        if (response.requested !== true)
            throw new Error("Desktop owner did not accept the runtime restart request.");
        return Object.freeze({ scheduled: true });
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
export async function scheduleSourceCheckoutRestart({ fsImpl = fs, pathImpl = path, processImpl = process, spawnImpl = spawnChild, moduleUrl = import.meta.url, } = {}) {
    if (processImpl.env.EQUINOX_LOCAL_DESKTOP_OWNER === "1") {
        const home = processImpl.env.HOME;
        if (!home || !path.isAbsolute(home))
            throw new Error("Source desktop restart requires the canonical user home.");
        // The Electron owner no longer passes through restart-runtime.sh, which
        // used to synchronize Source Peekaboo/tunnel versions and the app wrapper.
        // Reuse the pinned, integrity-checked Source synchronizers before restart.
        const sourceHelperUrl = new URL("../scripts/release/prepare-source-app-host.mjs", moduleUrl).href;
        const sourceHelper = await import(sourceHelperUrl);
        if (typeof sourceHelper.synchronizeSourceDesktopRuntimes !== "function")
            throw new Error("Source desktop runtime synchronizer is unavailable.");
        const { synchronizeSourceDesktopRuntimes } = sourceHelper;
        await synchronizeSourceDesktopRuntimes({
            ...(processImpl.env.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG
                ? { configPath: processImpl.env.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG }
                : {}),
            homeDir: home,
        });
        const response = await requestDesktopRuntimeRestart({ platform: process.platform, homeDir: home });
        if (response.requested !== true)
            throw new Error("Source desktop owner did not accept restart.");
        return Object.freeze({ scheduled: true, logPath: pathImpl.join(home, "Library", "Logs", "Equinox Local Source.log") });
    }
    const serverPath = fileURLToPath(moduleUrl);
    const moduleDir = pathImpl.dirname(serverPath);
    const sourceRoot = pathImpl.basename(moduleDir) === "src"
        ? pathImpl.dirname(moduleDir)
        : moduleDir;
    const scriptPath = pathImpl.join(sourceRoot, "scripts", "restart-runtime.sh");
    const scriptStats = await fsImpl.lstat(scriptPath);
    if (scriptStats.isSymbolicLink() || !scriptStats.isFile()) {
        throw new Error("Source runtime yeniden başlatma scripti normal bir dosya değil.");
    }
    const sourceRestartEnv = projectDarwinDetachedHelperEnvironment({
        sourceEnv: processImpl.env,
        includeDeveloperRuntimeConfig: true,
    });
    await launchDetachedHelper({
        spawnImpl,
        command: "/bin/bash",
        args: [scriptPath],
        options: {
            detached: true,
            stdio: "ignore",
            env: sourceRestartEnv,
        },
        label: "Equinox Local source restart helper",
    });
    return Object.freeze({
        scheduled: true,
        scriptPath,
        logPath: pathImpl.join(processImpl.env.TMPDIR ?? "/tmp", "equinox-local-restart.log"),
    });
}
export function registerRestartRuntimeTool({ registerTextTool, installation, scheduleManagedRestart = scheduleEquinoxLocalRestart, scheduleSourceRestart = scheduleSourceCheckoutRestart, sourceModuleUrl = import.meta.url, fsImpl = fs, pathImpl = path, processImpl = process, markRestartPending = () => { }, beforeRestart = async () => { }, restartFailed = async () => { }, textResult, errorResult, }) {
    registerTextTool("restart_runtime", {
        description: "Equinox Local runtime'ını kurulum türüne uygun güvenli restart yoluyla yeniden başlatmayı zamanlar. " +
            "Kurulumun aktif uygulama sahibine uygun restart yolunu ve mevcut source/managed ayrımını korur. " +
            "Bu araç başarılı döndükten sonra AYNI ASİSTAN TURUNDA başka Equinox Local aracı çağırma; kullanıcıya hemen final durum yanıtı ver.",
        inputSchema: {},
        annotations: {
            title: "Equinox Local runtime'ını yeniden başlat",
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        },
    }, async () => {
        let restartBoundaryEntered = false;
        try {
            restartBoundaryEntered = true;
            await beforeRestart();
            if (installation.managed &&
                installation.selfUpdateSupported) {
                await scheduleManagedRestart({
                    installation,
                });
                markRestartPending();
                return textResult([
                    "Equinox Local managed yeniden başlatması zamanlandı.",
                    "Aktif uygulama sahibi kısa bir gecikmeden sonra çalışma zamanını güvenli biçimde yeniden başlatacak.",
                    "Bu çağrıdan sonra aynı asistan turunda başka Equinox Local aracı çağrılmamalı.",
                    "MCP bağlantısı kısa süreliğine kesilip yeniden kurulabilir.",
                ].join("\n"));
            }
            const sourceRestart = await scheduleSourceRestart({
                fsImpl,
                pathImpl,
                processImpl,
                moduleUrl: sourceModuleUrl,
            });
            markRestartPending();
            return textResult([
                "Equinox Local source-checkout yeniden başlatması zamanlandı.",
                processImpl.env.EQUINOX_LOCAL_DESKTOP_OWNER === "1"
                    ? "Uygulama sahibi aynı source checkout çalışma zamanını kısa bir gecikmeyle yeniden başlatacak."
                    : "Private developer runtime config üzerinden yaklaşık 8 saniye içinde başlayacak; açık foreground shell varsa yeni native bundle ile otomatik yenilenecek.",
                "Bu çağrıdan sonra aynı asistan turunda başka Equinox Local aracı çağrılmamalı.",
                "MCP bağlantısı kısa süreliğine kesilip yeniden kurulabilir.",
                `Kayıt: ${sourceRestart.logPath}`,
            ].join("\n"));
        }
        catch (error) {
            if (restartBoundaryEntered) {
                try {
                    await restartFailed();
                }
                catch (recoveryError) {
                    const primary = error instanceof Error ? error.message : String(error);
                    const recovery = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
                    return errorResult(new Error(`${primary}; restart continuity recovery failed: ${recovery}`));
                }
            }
            return errorResult(error);
        }
    }, {
        projectAware: false,
        mutationScopes: ["global"],
    });
}
