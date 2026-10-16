import { equinoxLocalFiniteShell } from './equinox-local-platform.js';
import { buildGenericExecutionEnvironment } from './equinox-local-generic-execution.js';

// Run only on an explicit system_doctor request, not on background status polling.
export async function probeWindowsTerminalExecution({ processManager, cwd, env, arch }) {
  let processId = null;
  try {
    const shell = equinoxLocalFiniteShell({ platform: 'win32', arch, env });
    const start = await processManager.start({
      projectId: 'home', projectName: 'Equinox Local', cwd,
      command: shell.command,
      args: shell.argsFor("Write-Output 'EQUINOX_TERMINAL_PROBE_OK'; exit 17"),
      purpose: 'terminal_exec',
      env: buildGenericExecutionEnvironment({ runtimeEnv: env, platform: 'win32', arch }),
      label: 'system-doctor-terminal',
    });
    processId = start.processId;
    const result = await processManager.waitForExit({ processId, waitMs: 6_000 });
    if (result.running) return { healthy: false };
    const output = processManager.snapshotOutput({ processId, maxChars: 2_000, stripAnsiCodes: true });
    return { healthy: result.exitCode === 17 && output.stdout.includes('EQUINOX_TERMINAL_PROBE_OK') };
  } catch {
    return { healthy: false };
  } finally {
    if (processId) await processManager.stop({ processId, force: true, timeoutMs: 700, remove: true }).catch(() => {});
  }
}
