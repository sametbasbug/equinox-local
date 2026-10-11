using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private static readonly Regex WorkerTokenPattern = new("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex WorkerTicksPattern = new("^[0-9]{1,19}$", RegexOptions.CultureInvariant);

    // Independently prove the OS PID/start-time/executable triple. A signed
    // ownership record by itself is not proof of a live owner, and PID reuse
    // must never authorize a WPF shutdown or a journal replay. This remains a
    // read-only provenance test, NOT an authenticated worker command line or
    // an update/rollback authorization.
    private static void InspectOwnedNativeWorkerProcess()
    {
        InspectOwnedNativeTransitionJournal();
        InspectionPhase = "native-worker-owned-release";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var install = Path.Combine(local, "Equinox Local");
        var tx = Path.Combine(install, "state", "main-update");
        using var activeDoc = ReadOwnedTransitionRecord(Path.Combine(tx, "active.json"), 8192);
        var id = activeDoc.RootElement.GetProperty("transactionId").GetString() ?? "";
        if (!NativeTransactionPattern.IsMatch(id))
            throw new InvalidDataException("Native worker has no exact active journal transaction owner.");

        var target = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture switch
        {
            System.Runtime.InteropServices.Architecture.X64 => "win32-x64",
            System.Runtime.InteropServices.Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported native worker architecture."),
        };
        using var stablePointer = ReadJson(Path.Combine(install, "current-version.json"), MaxPointerBytes);
        var stable = stablePointer.RootElement;
        RequireExactKeys(stable, ["schemaVersion", "version", "target"]);
        if (stable.GetProperty("schemaVersion").GetInt32() != 1 ||
            stable.GetProperty("target").GetString() != target)
            throw new InvalidDataException("Native worker baseline pointer target has drifted.");
        var version = stable.GetProperty("version").GetString() ?? "";
        if (!VersionRegex().IsMatch(version))
            throw new InvalidDataException("Native worker baseline version is not canonical.");
        var releases = Path.Combine(install, "releases");
        var release = Path.Combine(releases, version);
        RequireNormalDirectory(releases);
        RequireNormalDirectory(release);
        var nodeRoot = Path.Combine(release, "runtime", "node");
        var nodeBin = Path.Combine(nodeRoot, "bin");
        RequireNormalDirectory(Path.Combine(release, "runtime"));
        RequireNormalDirectory(nodeRoot);
        RequireNormalDirectory(nodeBin);
        var expectedNode = Path.Combine(nodeBin, "node.exe");
        RequireNormalFile(expectedNode);

        InspectionPhase = "native-worker-ownership-record";
        var handoff = Path.Combine(tx, "handoff");
        RequireNormalDirectory(handoff);
        var ownerPath = Path.Combine(handoff, id + ".windows-worker.json");
        using var ownerDoc = ReadOwnedTransitionRecord(ownerPath, 8192);
        var owner = ownerDoc.RootElement;
        RequireExactKeys(owner, ["schemaVersion", "transactionId", "pid", "startTimeUtcTicks", "token", "nodePath"]);
        var pid = owner.GetProperty("pid").GetInt32();
        var ticks = owner.GetProperty("startTimeUtcTicks").GetString() ?? "";
        var token = owner.GetProperty("token").GetString() ?? "";
        var nodePath = owner.GetProperty("nodePath").GetString() ?? "";
        if (owner.GetProperty("schemaVersion").GetInt32() != 1 ||
            owner.GetProperty("transactionId").GetString() != id || pid < 1 ||
            !WorkerTicksPattern.IsMatch(ticks) || !WorkerTokenPattern.IsMatch(token) ||
            !Path.IsPathFullyQualified(nodePath) ||
            !Compare.Equals(Path.GetFullPath(nodePath), Path.GetFullPath(expectedNode)))
            throw new InvalidDataException("Native worker ownership record is not an exact product-owned process identity.");

        InspectionPhase = "native-worker-live-process";
        using var running = Process.GetProcessById(pid);
        if (running.HasExited)
            throw new InvalidDataException("Claimed native worker has already exited.");
        var actualTicks = running.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        if (actualTicks != ticks)
            throw new InvalidDataException("Native worker PID was reused or its creation time changed.");
        var actualExecutable = running.MainModule?.FileName ?? "";
        if (!Path.IsPathFullyQualified(actualExecutable) ||
            !Compare.Equals(Path.GetFullPath(actualExecutable), Path.GetFullPath(expectedNode)))
            throw new InvalidDataException("Native worker PID belongs to a different OS executable.");
        InspectionPhase = "native-worker-process-provenance-complete";
        // Trust is deliberately incomplete: the worker command line, token in
        // process environment, exact receipt writer, system ACL and full
        // transaction recovery still need independent supervisor attestation.
    }
}
