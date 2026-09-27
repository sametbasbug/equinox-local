using System.Diagnostics;
using System.Net.Http;
using System.Net.Sockets;
using EquinoxLocal.WindowsShell;

var repo = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
var nodeSource = Environment.GetEnvironmentVariable("EQUINOX_TEST_NODE_EXE");
if (string.IsNullOrWhiteSpace(nodeSource) || !File.Exists(nodeSource)) throw new InvalidOperationException("EQUINOX_TEST_NODE_EXE is required.");
var root = Path.Combine(Path.GetTempPath(), $"equinox-shell-runtime-{Guid.NewGuid():N}");
var nodeDir = Path.Combine(root, "runtime", "node", "bin");
Directory.CreateDirectory(nodeDir);
File.Copy(nodeSource, Path.Combine(nodeDir, "node.exe"));
File.Copy(Path.Combine(repo, "src", "equinox-local-windows-job-object.ps1"), Path.Combine(root, "equinox-local-windows-job-object.ps1"));
File.Copy(Path.Combine(repo, "src", "equinox-local-windows-process-gate.ps1"), Path.Combine(root, "equinox-local-windows-process-gate.ps1"));
await File.WriteAllTextAsync(Path.Combine(root, "server.js"), """
import net from 'node:net';
import http from 'node:http';
const child = net.createServer(); child.listen(24892, '127.0.0.1');
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

try
{
    await using var supervisor = new RuntimeSupervisor(root);
    await supervisor.StartAsync();
    await WaitForAsync(HealthyAsync, "runtime did not become healthy");
    await WaitForAsync(() => PortOpenAsync(24892), "descendant did not start");
    var firstPid = supervisor.RuntimeProcessId ?? throw new InvalidOperationException("missing first runtime pid");
    await supervisor.StartAsync();
    if (supervisor.RuntimeProcessId != firstPid) throw new InvalidOperationException("idempotent start duplicated runtime");
    await supervisor.RestartAsync();
    await WaitForAsync(HealthyAsync, "runtime did not recover after restart");
    var secondPid = supervisor.RuntimeProcessId ?? throw new InvalidOperationException("missing restarted runtime pid");
    if (secondPid == firstPid) throw new InvalidOperationException("restart did not replace runtime");
    Process.GetProcessById(secondPid).Kill();
    await WaitForAsync(async () => supervisor.RuntimeProcessId is int pid && pid != secondPid && await HealthyAsync(), "crash recovery did not replace runtime", 15000);
    await supervisor.StopAsync();
    await WaitForAsync(async () => !await HealthyAsync() && !await PortOpenAsync(24892), "stop did not drain owned tree");
    if (supervisor.RuntimeProcessId is not null || supervisor.DesiredRunning) throw new InvalidOperationException("stop left ownership active");
    Console.WriteLine("WINDOWS_SHELL_RUNTIME_SUPERVISION_PASS");
}
finally { try { Directory.Delete(root, recursive: true); } catch { } }
