using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Independent READ-ONLY OS witness. A running WPF and native pipe do
    // not prove backend A health; the exact signed A must answer fresh HTTP.
    private static void RequireOriginalGuardianRestoredAWpfReceipt(
        OwnedWorkerClaim owner, string journalRoot, Process worker,
        FileStream lease, Stopwatch leaseAge, string program, byte[] journalSha)
    {
        using var receipt = ReadOwnedTransitionRecord(
            Path.Combine(journalRoot, owner.TransactionId + ".wpf-a-restarted.json"), 4096);
        using var journal = ReadOwnedTransitionRecord(
            Path.Combine(journalRoot, owner.TransactionId + ".json"), 8192);
        var identity = receipt.RootElement;
        if (identity.GetProperty("schemaVersion").GetInt32() != 1 ||
            identity.GetProperty("transactionId").GetString() != owner.TransactionId ||
            identity.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            identity.GetProperty("stage6JournalSha256").GetString() != Convert.ToHexStringLower(journalSha) ||
            identity.GetProperty("sourceSha").GetString() != journal.RootElement.GetProperty("currentSha").GetString() ||
            identity.GetProperty("stableVersion").GetString() !=
                journal.RootElement.GetProperty("previousNative").GetProperty("version").GetString())
            throw new InvalidDataException("WPF A receipt is not bound to original Guardian's durable stage6.");
        var pid = identity.GetProperty("shellPid").GetInt32();
        if (pid < 1 || !long.TryParse(identity.GetProperty("shellStartTimeUtcTicks").GetString(),
                NumberStyles.None, CultureInfo.InvariantCulture, out var ticks) || ticks < 1)
            throw new InvalidDataException("WPF A OS PID/birth evidence invalid.");
        using var process = Process.GetProcessById(pid);
        var executable = Path.Combine(program, "EquinoxLocal.exe");
        if (process.HasExited || process.StartTime.ToUniversalTime().Ticks != ticks ||
            process.SessionId != Process.GetCurrentProcess().SessionId ||
            !Compare.Equals(Path.GetFullPath(process.MainModule?.FileName ?? ""), Path.GetFullPath(executable)))
            throw new InvalidDataException("WPF A is no longer the original Guardian-launched OS image.");
        using (var installed = FindExactRunningWpfOrNull(executable))
            if (installed is null || installed.Id != pid || installed.StartTime.ToUniversalTime().Ticks != ticks)
                throw new InvalidDataException("WPF A installed shell owner drifted.");
        if (!OpenProcessToken(process.Handle, TokenQuery, out var token))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "WPF A token not verifiable.");
        using (token)
        using (var shell = new WindowsIdentity(token.DangerousGetHandle()))
        using (var guardian = WindowsIdentity.GetCurrent())
            if (shell.User is null || guardian.User is null || !shell.User.Equals(guardian.User) ||
                ReadWindowsLogonAuthenticationId(token) != ReadWindowsLogonAuthenticationId(guardian.AccessToken))
                throw new InvalidDataException("WPF A SID or Windows logon identity drifted.");
        if (worker.HasExited || lease.SafeFileHandle.IsClosed || lease.SafeFileHandle.IsInvalid ||
            leaseAge.Elapsed >= TimeSpan.FromMinutes(20) ||
            worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Original Guardian OS writer/worker expired during WPF A witness.");
    }

    // Requires four DIFFERENT bounded loopback responses spaced in time;
    // every response is sandwiched between full signed A identity audits.
    private static void RequireOwnedRestoredAFourBackendHealthSamples(
        OwnedWorkerClaim owner, string journalRoot, Process worker,
        FileStream lease, Stopwatch leaseAge)
    {
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var originalSha = SHA256.HashData(File.ReadAllBytes(journalPath));
        using var record = ReadOwnedTransitionRecord(journalPath, 8192);
        var oldSha = record.RootElement.GetProperty("currentSha").GetString() ?? "";
        var version = record.RootElement.GetProperty("previousNative").GetProperty("version").GetString() ?? "";
        if (record.RootElement.GetProperty("stage").GetString() != "rollback_native_restored" ||
            record.RootElement.GetProperty("sequence").GetInt32() != 6)
            throw new InvalidDataException("Four A health samples require exact original stage6.");
        using var handler = new HttpClientHandler {
            UseCookies = false, UseProxy = false, AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
        };
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(3) };
        var consecutive = 0;
        var healthClock = Stopwatch.StartNew();
        for (var i = 0; i < 75 && consecutive < 4 &&
            healthClock.Elapsed < TimeSpan.FromSeconds(75); i++)
        {
            InspectionPhase = "native-integrated-a-health-independent-sample";
            RequireOwnedRestoredAIdentityWitness(owner, journalRoot, worker, lease, leaseAge,
                requireDurableStage6: true, allowRestoredAWpf: true);
            var healthy = false;
            try
            {
                using var sampleCutoff = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                using var response = http.GetAsync("http://127.0.0.1:24891/api/v1/status",
                    HttpCompletionOption.ResponseHeadersRead, sampleCutoff.Token).GetAwaiter().GetResult();
                if (response.StatusCode == HttpStatusCode.OK)
                {
                    using var stream = response.Content.ReadAsStreamAsync(sampleCutoff.Token)
                        .GetAwaiter().GetResult();
                    var bytes = new byte[8193];
                    var read = 0;
                    while (read < bytes.Length)
                    {
                        var got = stream.ReadAsync(bytes.AsMemory(read, bytes.Length - read),
                            sampleCutoff.Token).AsTask().GetAwaiter().GetResult();
                        if (got == 0) break;
                        read += got;
                    }
                    if (read is > 0 and <= 8192)
                    {
                        using var body = JsonDocument.Parse(bytes.AsMemory(0, read));
                        var envelope = body.RootElement;
                        if (envelope.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True &&
                            envelope.TryGetProperty("status", out var status) &&
                            status.TryGetProperty("health", out var health) &&
                            health.TryGetProperty("state", out var state) && state.GetString() == "HEALTHY" &&
                            status.TryGetProperty("installation", out var install) &&
                            install.TryGetProperty("kind", out var kind) && kind.GetString() == "managed-source" &&
                            install.TryGetProperty("sourceSha", out var sha) && sha.GetString() == oldSha &&
                            status.TryGetProperty("server", out var server) &&
                            server.TryGetProperty("version", out var release) && release.GetString() == version)
                            healthy = true;
                    }
                }
            }
            catch (HttpRequestException) { }
            catch (OperationCanceledException) { }
            catch (IOException) { }
            catch (JsonException) { }
            // A healthy HTTP response does not grant permission if WPF PID,
            // native source, NM registry, B quarantine or owner has drifted.
            RequireOwnedRestoredAIdentityWitness(owner, journalRoot, worker, lease, leaseAge,
                requireDurableStage6: true, allowRestoredAWpf: true);
            if (!CryptographicOperations.FixedTimeEquals(originalSha, SHA256.HashData(File.ReadAllBytes(journalPath))))
                throw new InvalidDataException("Original stage6 drifted during four A health samples.");
            consecutive = healthy ? consecutive + 1 : 0;
            if (consecutive < 4) Thread.Sleep(500);
        }
        if (consecutive != 4)
            throw new InvalidDataException("Original A backend did not produce four consecutive SHA-bound healthy responses.");
        InspectionPhase = "native-integrated-a-health-four-samples-read-only-proven";
    }
}
