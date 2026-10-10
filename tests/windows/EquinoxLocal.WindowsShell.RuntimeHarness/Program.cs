using System.Diagnostics;
using System.Net.Http;
using System.Net.Sockets;
using EquinoxLocal.WindowsShell;

var repo = Environment.CurrentDirectory;
var nodeSource = Environment.GetEnvironmentVariable("EQUINOX_TEST_NODE_EXE");
if (string.IsNullOrWhiteSpace(nodeSource) || !File.Exists(nodeSource)) throw new InvalidOperationException("EQUINOX_TEST_NODE_EXE is required.");
var root = Path.Combine(Path.GetTempPath(), $"equinox-shell-runtime-{Guid.NewGuid():N}");
var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
if (string.IsNullOrWhiteSpace(localAppData)) throw new InvalidOperationException("LocalAppData is unavailable.");
var diagnosticInstallRoot = Path.Combine(localAppData, "Equinox Local");
var diagnosticLogsRoot = Path.Combine(diagnosticInstallRoot, "logs");
var diagnosticLog = Path.Combine(diagnosticLogsRoot, WindowsShellDiagnostics.RuntimeFailureLogName);
var diagnosticLogExisted = File.Exists(diagnosticLog);
var nodeDir = Path.Combine(root, "runtime", "node", "bin");
Directory.CreateDirectory(nodeDir);
File.Copy(nodeSource, Path.Combine(nodeDir, "node.exe"));
File.Copy(Path.Combine(repo, "src", "equinox-local-windows-job-object.ps1"), Path.Combine(root, "equinox-local-windows-job-object.ps1"));
File.Copy(Path.Combine(repo, "src", "equinox-local-windows-process-gate.ps1"), Path.Combine(root, "equinox-local-windows-process-gate.ps1"));
File.Copy(Path.Combine(repo, "src", "equinox-local-windows-runtime-gate.mjs"), Path.Combine(root, "equinox-local-windows-runtime-gate.mjs"));
// The lifecycle harness uses a fixture-only wrapper to exercise the native
// gate + Job Object contract without requiring real OpenAI tunnel credentials.
await File.WriteAllTextAsync(Path.Combine(root, "equinox-local-windows-runtime-supervisor.js"), """
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, [process.argv[2]], { stdio: 'inherit', windowsHide: true });
child.once('error', () => { process.exitCode = 1; });
child.once('exit', (code) => { process.exitCode = code ?? 1; });
""");
await File.WriteAllTextAsync(Path.Combine(root, "server.js"), """
import { spawn } from 'node:child_process';
import http from 'node:http';
process.stdin.resume();
process.stdin.once('end', () => process.exit(42));
spawn(process.execPath, ['-e', `require('node:net').createServer().listen(24892,'127.0.0.1');setInterval(()=>{},1000)`], { stdio: 'ignore' });
const server = http.createServer((req,res) => { if (req.url === '/api/v1/health') { res.writeHead(200); res.end('ok'); } else { res.writeHead(404); res.end(); } });
server.listen(24891, '127.0.0.1'); setInterval(() => {}, 1000);
""");

static async Task<bool> HealthyAsync()
{
    using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(500) };
    try { using var response = await client.GetAsync("http://127.0.0.1:24891/api/v1/health"); return response.IsSuccessStatusCode; } catch { return false; }
}
static async Task<bool> PortOpenAsync(int port)
{
    try { using var client = new TcpClient(); await client.ConnectAsync("127.0.0.1", port).WaitAsync(TimeSpan.FromMilliseconds(500)); return true; } catch { return false; }
}
static async Task WaitForAsync(Func<Task<bool>> predicate, string message, int timeoutMs = 10000)
{
    var deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
    while (DateTime.UtcNow < deadline) { if (await predicate()) return; await Task.Delay(100); }
    throw new InvalidOperationException(message);
}

static async Task RunStageAsync(string name, Func<Task> action, int timeoutMs = 45000)
{
    Console.WriteLine($"WINDOWS_SHELL_RUNTIME_STAGE {name} START");
    try
    {
        await action().WaitAsync(TimeSpan.FromMilliseconds(timeoutMs));
        Console.WriteLine($"WINDOWS_SHELL_RUNTIME_STAGE {name} PASS");
    }
    catch (Exception error)
    {
        Console.Error.WriteLine($"WINDOWS_SHELL_RUNTIME_STAGE {name} FAIL {error.GetType().Name}: {error.Message}");
        throw;
    }
}

const int RuntimeHealthTimeoutMs = 20_000;
const int RuntimeHealthStageTimeoutMs = 25_000;

RuntimeSupervisor? supervisor = null;
try
{
    supervisor = new RuntimeSupervisor(root);
    await RunStageAsync("start", () => supervisor.StartAsync());
    await RunStageAsync("initial-health", () => WaitForAsync(HealthyAsync, "runtime did not become healthy", RuntimeHealthTimeoutMs), RuntimeHealthStageTimeoutMs);
    await RunStageAsync("descendant-health", () => WaitForAsync(() => PortOpenAsync(24892), "descendant did not start", RuntimeHealthTimeoutMs), RuntimeHealthStageTimeoutMs);
    var firstPid = supervisor.RuntimeProcessId ?? throw new InvalidOperationException("missing first runtime pid");
    await RunStageAsync("idempotent-start", () => supervisor.StartAsync());
    if (supervisor.RuntimeProcessId != firstPid) throw new InvalidOperationException("idempotent start duplicated runtime");
    await RunStageAsync("restart", () => supervisor.RestartAsync());
    await RunStageAsync("restart-health", () => WaitForAsync(HealthyAsync, "runtime did not recover after restart", RuntimeHealthTimeoutMs), RuntimeHealthStageTimeoutMs);
    var secondPid = supervisor.RuntimeProcessId ?? throw new InvalidOperationException("missing restarted runtime pid");
    if (secondPid == firstPid) throw new InvalidOperationException("restart did not replace runtime");
    Console.WriteLine("WINDOWS_SHELL_RUNTIME_STAGE crash-recovery START");
    Process.GetProcessById(secondPid).Kill();
    await RunStageAsync("crash-recovery", () => WaitForAsync(async () => supervisor.RuntimeProcessId is int pid && pid != secondPid && await HealthyAsync(), "crash recovery did not replace runtime", RuntimeHealthTimeoutMs), RuntimeHealthStageTimeoutMs);
    await RunStageAsync("stop", () => supervisor.StopAsync());
    await RunStageAsync("drain", () => WaitForAsync(async () => !await HealthyAsync() && !await PortOpenAsync(24892), "stop did not drain owned tree"), 15000);
    if (supervisor.RuntimeProcessId is not null || supervisor.DesiredRunning) throw new InvalidOperationException("stop left ownership active");
    Console.WriteLine("WINDOWS_SHELL_RUNTIME_SUPERVISION_PASS");
}
finally
{
    if (supervisor is not null)
    {
        await RunStageAsync("dispose", () => supervisor.DisposeAsync().AsTask(), 30000);
    }
    if (!diagnosticLogExisted)
    {
        try { if (File.Exists(diagnosticLog)) File.Delete(diagnosticLog); } catch { }
        try { if (Directory.Exists(diagnosticLogsRoot) && !Directory.EnumerateFileSystemEntries(diagnosticLogsRoot).Any()) Directory.Delete(diagnosticLogsRoot); } catch { }
        try { if (Directory.Exists(diagnosticInstallRoot) && !Directory.EnumerateFileSystemEntries(diagnosticInstallRoot).Any()) Directory.Delete(diagnosticInstallRoot); } catch { }
    }
    try { Directory.Delete(root, recursive: true); } catch { }
}
