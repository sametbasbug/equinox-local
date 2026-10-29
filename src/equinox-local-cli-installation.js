import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const execFile = promisify(execFileCallback);
const MAC_PATH_MARKER = '# Equinox Local CLI (managed)';
const MAC_PATH_BLOCK = `${MAC_PATH_MARKER}\nexport PATH="$HOME/.local/bin:$PATH"`;
const MAX_PROFILE_BYTES = 256 * 1024;
async function normalFileOrAbsent(file) {
    const stat = await fs.lstat(file).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
        throw new Error(`Equinox CLI path is not a normal file: ${path.basename(file)}`);
    return stat;
}
async function normalDir(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Equinox CLI directory must be a normal directory.");
}
function quoteShell(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
function windowsPowershell(env) {
    const root = env.SystemRoot || env.SYSTEMROOT || env.WINDIR;
    if (!root || !path.win32.isAbsolute(root))
        throw new Error("Windows SystemRoot is unavailable.");
    return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
async function windowsPath(ownedBin, add, env) {
    // The owned directory is passed only as a process variable; never interpolate it into a PS script.
    const command = [
        "$ErrorActionPreference = 'Stop'",
        "$dir = $env:EQUINOX_LOCAL_CLI_BIN",
        "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')",
        "if ($null -eq $key) { throw 'Cannot open current-user environment' }",
        "try {",
        "  $current = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
        "  if ($null -eq $current -and $env:EQUINOX_LOCAL_CLI_PATH_ADD -ne '1') { return }",
        "  $old = [string]$current",
        "  $parts = @($old.Split(';') | Where-Object { $_ -and $_.TrimEnd('\\') -ine $dir.TrimEnd('\\') })",
        "  if ($env:EQUINOX_LOCAL_CLI_PATH_ADD -eq '1') { $parts += $dir }",
        "  $newValue = $parts -join ';'",
        "  if ($newValue -cne $old) {",
        "    if ($newValue.Length -gt 30000) { throw 'User PATH is too long' }",
        "    if ($newValue.Length -eq 0) { $key.DeleteValue('Path', $false) }",
        "    else {",
        "      $kind = if ($null -eq $current) { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $key.GetValueKind('Path') }",
        "      $key.SetValue('Path', $newValue, $kind)",
        "    }",
        "  }",
        "} finally { $key.Dispose() }",
    ].join("\n");
    await execFile(windowsPowershell(env), ["-NoProfile", "-NonInteractive", "-Command", command], {
        windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024,
        env: { SystemRoot: env.SystemRoot || env.SYSTEMROOT, WINDIR: env.WINDIR || env.SystemRoot, USERPROFILE: env.USERPROFILE, TEMP: env.TEMP, EQUINOX_LOCAL_CLI_BIN: ownedBin, EQUINOX_LOCAL_CLI_PATH_ADD: add ? "1" : "0" },
    });
}
async function updateMacProfile(homeDir, add) {
    const profile = path.posix.join(homeDir, ".zprofile");
    const stat = await normalFileOrAbsent(profile);
    if (stat && stat.size > MAX_PROFILE_BYTES)
        throw new Error("Shell profile is too large to update safely.");
    let source = stat ? await fs.readFile(profile, "utf8") : "";
    // Edit only our own exact pair, never arbitrary PATH lines.
    if (source.includes(MAC_PATH_MARKER) && !source.includes(MAC_PATH_BLOCK))
        throw new Error("Equinox CLI shell profile marker was modified; refusing to change it.");
    if (source.includes(MAC_PATH_BLOCK))
        source = source.replace(`${MAC_PATH_BLOCK}\n`, "").replace(MAC_PATH_BLOCK, "");
    if (add)
        source = `${source}${source && !source.endsWith("\n") ? "\n" : ""}${MAC_PATH_BLOCK}\n`;
    if (!stat && !add)
        return;
    if (stat && (await fs.readFile(profile, "utf8")) === source)
        return;
    await fs.writeFile(profile, source, { mode: stat ? stat.mode & 0o777 : 0o600 });
}
export async function installEquinoxLocalCli({ platform = process.platform, homeDir, installRoot, releaseDir, env = process.env }) {
    if (!releaseDir)
        throw new Error("Signed release directory is required for CLI installation.");
    const api = platform === "win32" ? path.win32 : path.posix;
    const nodePath = api.join(releaseDir, "runtime", "node", "bin", platform === "win32" ? "node.exe" : "node");
    const cliPath = api.join(releaseDir, "scripts", "eqlocal.mjs");
    for (const file of [nodePath, cliPath]) {
        if (!await normalFileOrAbsent(file))
            throw new Error(`Signed CLI release component is unavailable: ${api.basename(file)}`);
    }
    const bin = api.join(installRoot, "bin");
    await normalDir(bin);
    if (platform === "win32") {
        // Avoid embedding Unicode usernames in a CMD file (legacy code-page decoding).
        // The installed native release is always below the signed-in user's LOCALAPPDATA.
        const prefix = `${api.normalize(installRoot)}\\`;
        if (!api.normalize(nodePath).toLowerCase().startsWith(prefix.toLowerCase()) ||
            !api.normalize(cliPath).toLowerCase().startsWith(prefix.toLowerCase()))
            throw new Error("CLI native release is outside the product-owned installation.");
        const nodeArg = `%LOCALAPPDATA%\\Equinox Local\\${api.relative(installRoot, nodePath)}`;
        const cliArg = `%LOCALAPPDATA%\\Equinox Local\\${api.relative(installRoot, cliPath)}`;
        if (/[\r\n"%!^]/u.test(api.relative(installRoot, nodePath) + api.relative(installRoot, cliPath)))
            throw new Error("Unsupported Windows CLI release path characters.");
        const launcher = api.join(bin, "eqlocal.cmd");
        const pwshLauncher = api.join(bin, "eqlocal.ps1");
        await normalFileOrAbsent(launcher);
        await normalFileOrAbsent(pwshLauncher);
        await fs.writeFile(launcher, `@echo off\r\n"${nodeArg}" "${cliArg}" %*\r\nexit /b %ERRORLEVEL%\r\n`, { mode: 0o600 });
        // PowerShell prioritizes .ps1 over .cmd. Passing @args directly to the
        // pinned native Node preserves embedded JSON quotes and Unicode input.
        // CMD callers retain the .cmd shim and can use --args-file for JSON.
        const scriptNode = `$env:LOCALAPPDATA\\Equinox Local\\${api.relative(installRoot, nodePath)}`;
        const scriptCli = `$env:LOCALAPPDATA\\Equinox Local\\${api.relative(installRoot, cliPath)}`;
        const psScript = [
            // Windows PowerShell 5.1 strips literal nested JSON quotes when passing
            // native arguments; PowerShell 7+ already preserves them via @args.
            '$nativeArgs = if ($PSVersionTable.PSVersion.Major -lt 7) {',
            `  @($args | ForEach-Object { $_.Replace('"', '\\"') })`,
            '} else { $args }',
            `& "${scriptNode}" "${scriptCli}" @nativeArgs`,
            'exit $LASTEXITCODE',
        ].join("\r\n") + "\r\n";
        await fs.writeFile(pwshLauncher, psScript, { mode: 0o600 });
        await windowsPath(bin, true, env);
        return { installed: true, launcher, pwshLauncher };
    }
    if (platform !== "darwin")
        throw new Error("Unsupported CLI installation platform.");
    const launcher = api.join(bin, "eqlocal");
    await normalFileOrAbsent(launcher);
    await fs.writeFile(launcher, `#!/bin/sh\nexec ${quoteShell(nodePath)} ${quoteShell(cliPath)} "$@"\n`, { mode: 0o700 });
    await fs.chmod(launcher, 0o700);
    const userBin = api.join(homeDir, ".local", "bin");
    await normalDir(userBin);
    const userCommand = api.join(userBin, "eqlocal");
    const stat = await fs.lstat(userCommand).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (stat) {
        if (!stat.isSymbolicLink() || await fs.readlink(userCommand) !== launcher)
            throw new Error("Another application owns ~/.local/bin/eqlocal.");
    }
    else
        await fs.symlink(launcher, userCommand);
    await updateMacProfile(homeDir, true);
    return { installed: true, launcher: userCommand };
}
export async function removeEquinoxLocalCli({ platform = process.platform, homeDir, installRoot, env = process.env }) {
    const api = platform === "win32" ? path.win32 : path.posix;
    const bin = api.join(installRoot, "bin");
    if (platform === "win32") {
        for (const name of ["eqlocal.cmd", "eqlocal.ps1"]) {
            const launcher = api.join(bin, name);
            if (await normalFileOrAbsent(launcher))
                await fs.unlink(launcher);
        }
        await windowsPath(bin, false, env);
    }
    else if (platform === "darwin") {
        const launcher = api.join(bin, "eqlocal");
        const userCommand = api.join(homeDir, ".local", "bin", "eqlocal");
        const link = await fs.lstat(userCommand).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
        if (link?.isSymbolicLink() && await fs.readlink(userCommand) === launcher)
            await fs.unlink(userCommand);
        if (await normalFileOrAbsent(launcher))
            await fs.unlink(launcher);
        await updateMacProfile(homeDir, false);
    }
    else
        throw new Error("Unsupported CLI removal platform.");
    const stat = await fs.lstat(bin).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (stat?.isDirectory() && !stat.isSymbolicLink() && (await fs.readdir(bin)).length === 0)
        await fs.rmdir(bin);
    // The service normally removes discovery on shutdown. An interrupted
    // uninstall can otherwise retain an unusable credential-bearing descriptor.
    const descriptor = api.join(installRoot, ...(platform === "win32" ? ["state", "cli-ipc.json"] : ["cli-ipc.json"]));
    if (await normalFileOrAbsent(descriptor))
        await fs.unlink(descriptor);
}
