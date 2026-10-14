using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Deliberately narrow OS witness for the FIRST supported rejected-B case:
    // the exact B WPF launched by this Guardian is gone, and no exact-B
    // healthy backend answers four independent bounded localhost probes.
    // A still-running but unhealthy B requires a separate, authenticated
    // owner-quiesce protocol; never treat an arbitrary HTTP timeout as a
    // license to kill a live user's WPF window.
    private static void RequireOwnedIntegratedBExitedAndUnhealthy(
        OwnedWorkerClaim owner, string journalRoot, Process worker, string targetSha)
    {
        InspectionPhase = "native-integrated-a-rollback-b-exit-witness";
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        var originalJournalSha = SHA256.HashData(File.ReadAllBytes(journalPath));
        using var evidence = ReadOwnedTransitionRecord(
            Path.Combine(journalRoot, owner.TransactionId + ".wpf-b-restarted.json"), 8192);
        var prior = evidence.RootElement;
        if (prior.GetProperty("transactionId").GetString() != owner.TransactionId ||
            prior.GetProperty("sourceSha").GetString() != targetSha ||
            prior.GetProperty("guardianPid").GetInt32() != Environment.ProcessId ||
            prior.GetProperty("shellPid").GetInt32() <= 0 ||
            !long.TryParse(prior.GetProperty("shellStartTimeUtcTicks").GetString(), out var shellStartTicks) ||
            shellStartTicks < 1)
            throw new InvalidDataException("Native rollback requires this Guardian's exact B WPF launch witness.");
        var shellPid = prior.GetProperty("shellPid").GetInt32();
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (!Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Native rollback cannot attest the installed B WPF path.");
        var executable = Path.Combine(local, "Programs", "Equinox Local", "EquinoxLocal.exe");
        RequireNormalFile(executable);

        void RequireExactBAlreadyExited()
        {
            try
            {
                using var candidate = Process.GetProcessById(shellPid);
                // A recycled PID or an uninspectable process is ambiguous,
                // never accepted as the original WPF's clean disappearance.
                if (!candidate.HasExited)
                {
                    if (candidate.StartTime.ToUniversalTime().Ticks != shellStartTicks)
                        throw new InvalidDataException("Native rollback B WPF PID was reused by a different OS process.");
                    throw new InvalidDataException("Native rollback refuses a still-running B WPF without owner quiesce.");
                }
            }
            catch (ArgumentException)
            {
                // The OS has no process with the original admitted B PID.
            }
            using var active = FindExactRunningWpfOrNull(executable);
            if (active is not null)
                throw new InvalidDataException("Native rollback refuses a competing installed WPF process.");
        }
        RequireExactBAlreadyExited();
        using var handler = new HttpClientHandler
        {
            UseCookies = false, UseProxy = false, AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.None,
        };
        using var http = new HttpClient(handler) { Timeout = TimeSpan.FromMilliseconds(2000) };
        const string statusUrl = "http://127.0.0.1:24891/api/v1/status";
        for (var sample = 0; sample < 4; sample++)
        {
            InspectionPhase = "native-integrated-a-rollback-b-negative-health-sample";
            RequireExactBAlreadyExited();
            try
            {
                // One deadline spans response headers AND every streamed body
                // byte, so an untrusted listener cannot stall the writer lease.
                using var sampleCutoff = new CancellationTokenSource(TimeSpan.FromMilliseconds(1500));
                using var response = http.GetAsync(statusUrl, HttpCompletionOption.ResponseHeadersRead,
                    sampleCutoff.Token).GetAwaiter().GetResult();
                if (response.StatusCode == HttpStatusCode.OK)
                {
                    // Never buffer an untrusted local server's unbounded
                    // response while deciding whether rollback is permitted.
                    using var stream = response.Content.ReadAsStreamAsync(sampleCutoff.Token)
                        .GetAwaiter().GetResult();
                    var bytes = new byte[8193];
                    var read = 0;
                    while (read < bytes.Length)
                    {
                        var length = stream.ReadAsync(bytes.AsMemory(read, bytes.Length - read),
                            sampleCutoff.Token).AsTask().GetAwaiter().GetResult();
                        if (length == 0) break;
                        read += length;
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
                            install.TryGetProperty("sourceSha", out var sha) && sha.GetString() == targetSha)
                            throw new InvalidDataException("Native rollback refuses an independently healthy B backend.");
                    }
                }
            }
            catch (HttpRequestException) { }
            catch (OperationCanceledException) { }
            catch (IOException) { }
            catch (JsonException) { }
            // Do not swallow an independently observed HEALTHY exact B.
            RequireExactBAlreadyExited();
            if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(
                System.Globalization.CultureInfo.InvariantCulture) != owner.Ticks ||
                !CryptographicOperations.FixedTimeEquals(originalJournalSha, SHA256.HashData(File.ReadAllBytes(journalPath))))
                throw new InvalidDataException("Native rollback's original worker or B journal changed during OS rejection proof.");
            if (sample < 3) Thread.Sleep(500);
        }
        InspectionPhase = "native-integrated-a-rollback-b-exited-four-negative-samples";
    }
}
