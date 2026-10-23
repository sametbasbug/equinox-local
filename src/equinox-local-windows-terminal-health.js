import { equinoxLocalFiniteShell } from './equinox-local-platform.js';
import { buildGenericExecutionEnvironment } from './equinox-local-generic-execution.js';
// Run only on an explicit system_doctor request, not on background status polling.
export async function probeWindowsTerminalExecution({ processManager, cwd, env, arch }) {
    let processId = null;
    let healthy = false;
    try {
        const shell = equinoxLocalFiniteShell({ platform: 'win32', arch, env });
        const start = await processManager.start({
            projectId: 'home', projectName: 'Equinox Local', cwd,
            command: shell.command,
            // The installed host must run native EXEs, not only PowerShell cmdlets.
            args: shell.argsFor("Write-Output 'EQUINOX_TERMINAL_PROBE_OK'; & $env:ComSpec /d /c 'echo EQUINOX_NATIVE_PROBE_OK & exit /b 23'; if ($LASTEXITCODE -ne 23) { throw 'Native command was not executed.' }; exit 17"),
            purpose: 'terminal_exec',
            env: buildGenericExecutionEnvironment({ runtimeEnv: env, platform: 'win32', arch }),
            label: 'system-doctor-terminal',
        });
        if (typeof start?.processId !== "string" || start.processId.length === 0) {
            return { healthy: false };
        }
        processId = start.processId;
        const result = await processManager.waitForExit({ processId, waitMs: 6_000 });
        if (!result.running) {
            const output = processManager.snapshotOutput({ processId, maxChars: 2_000, stripAnsiCodes: true });
            healthy = result.exitCode === 17 && output.stdout.includes('EQUINOX_TERMINAL_PROBE_OK') && output.stdout.includes('EQUINOX_NATIVE_PROBE_OK');
        }
    }
    catch {
        healthy = false;
    }
    finally {
        if (processId) {
            try {
                await processManager.stop({ processId, force: true, timeoutMs: 700, remove: true });
            }
            catch {
                // A probe with unconfirmed owned process cleanup is not healthy.
                healthy = false;
            }
        }
    }
    return { healthy };
}
