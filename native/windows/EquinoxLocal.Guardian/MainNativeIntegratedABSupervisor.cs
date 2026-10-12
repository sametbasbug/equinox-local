using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // This is a SINGLE native-owner transaction, not an externally callable
    // journal advance. No caller-supplied paths, stage names, or executables.
    // It authenticates A, independently fingerprints the pre-staged B payload,
    // shuts down the exact A WPF process, and durably records the first TWO
    // true journal milestones under one continuous OS writer lease.
    // No B swap or activation until the remainder of this same supervisor is
    // implemented and independently tested. Installed updater stays disabled.
    private static void RunOwnedIntegratedMainABSupervisor(OwnedWorkerClaim owner, string journalRoot, Process worker)
    {
        InspectionPhase = "native-integrated-ab-verify-staged-b";
        var tx = Path.GetDirectoryName(journalRoot) ?? throw new InvalidDataException("Native journal root is invalid.");
        var journalPath = Path.Combine(journalRoot, owner.TransactionId + ".json");
        using var prepared = ReadOwnedTransitionRecord(journalPath, 8192);
        var record = prepared.RootElement;
        if (record.GetProperty("transactionId").GetString() != owner.TransactionId ||
            record.GetProperty("stage").GetString() != "prepared" || record.GetProperty("sequence").GetInt32() != 0 ||
            record.GetProperty("previousNative").GetProperty("kind").GetString() != "stable")
            throw new InvalidDataException("Integrated native A/B requires exact prepared Stable A ownership.");
        var currentSha = record.GetProperty("currentSha").GetString() ?? "";
        var targetSha = record.GetProperty("targetSha").GetString() ?? "";
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64", Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported Windows native A/B architecture."),
        };
        if (!SourceShaPattern.IsMatch(currentSha) || !SourceShaPattern.IsMatch(targetSha) || currentSha == targetSha ||
            record.GetProperty("target").GetString() != target)
            throw new InvalidDataException("Native staged B differs from the owning Main transaction.");
        InspectBaseline(allowActiveOrphanForReconciliation: true); // Exact installed Stable A file tree.
        RequireNormalDirectory(Path.Combine(tx, "native-store"));
        RequireNormalDirectory(Path.Combine(tx, "native-store", target));
        var candidate = Path.Combine(tx, "native-store", target, targetSha);
        RequireNormalDirectory(candidate);
        using var envelope = ReadOwnedTransitionRecord(Path.Combine(candidate, "native-store.json"), 8192);
        var meta = envelope.RootElement;
        RequireExactKeys(meta, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256",
            "artifactSha256", "artifactBytes", "payloadVersion", "releaseFingerprint"]);
        if (meta.GetProperty("schemaVersion").GetInt32() != 1 ||
            meta.GetProperty("channel").GetString() != "main" ||
            meta.GetProperty("sourceSha").GetString() != targetSha ||
            meta.GetProperty("target").GetString() != target ||
            meta.GetProperty("runtimeContractSha256").GetString() != record.GetProperty("targetRuntimeContractSha256").GetString() ||
            !DigestPattern.IsMatch(meta.GetProperty("artifactSha256").GetString() ?? "") ||
            meta.GetProperty("artifactBytes").GetInt64() is < 1 or > 1_073_741_824 ||
            !VersionRegex().IsMatch(meta.GetProperty("payloadVersion").GetString() ?? ""))
            throw new InvalidDataException("Staged native Main B has a foreign store contract or artifact identity.");
        var expected = meta.GetProperty("releaseFingerprint");
        RequireExactKeys(expected, ["schemaVersion", "sha256", "entries", "bytes"]);
        if (expected.GetProperty("schemaVersion").GetInt32() != 1 ||
            !DigestPattern.IsMatch(expected.GetProperty("sha256").GetString() ?? "") ||
            expected.GetProperty("entries").GetInt32() < 1 || expected.GetProperty("bytes").GetInt64() < 1)
            throw new InvalidDataException("Staged B fingerprint claim has invalid bounds.");
        var release = Path.Combine(candidate, "release");
        RequireNormalDirectory(release);
        using var releaseDoc = ReadOwnedTransitionRecord(Path.Combine(release, "release.json"), 16384);
        var releaseMeta = releaseDoc.RootElement;
        if (releaseMeta.GetProperty("schemaVersion").GetInt32() != 1 ||
            releaseMeta.GetProperty("target").GetString() != target ||
            releaseMeta.GetProperty("version").GetString() != meta.GetProperty("payloadVersion").GetString() ||
            releaseMeta.GetProperty("serverEntry").GetString() != "server.js")
            throw new InvalidDataException("Staged native B release identity disagrees with its store envelope.");
        var measured = FingerprintNativeMainRelease(release);
        if (measured.Sha256 != expected.GetProperty("sha256").GetString() ||
            measured.Entries != expected.GetProperty("entries").GetInt32() ||
            measured.Bytes != expected.GetProperty("bytes").GetInt64())
            throw new InvalidDataException("Staged native B full release fingerprint differs from the owned manifest.");
        RequireNormalDirectory(Path.Combine(release, "runtime"));
        var stagedWpf = Path.Combine(release, "runtime", "shell");
        RequireNormalDirectory(stagedWpf);
        RequireNormalFile(Path.Combine(stagedWpf, "EquinoxLocal.exe"));
        RequireNormalFile(Path.Combine(stagedWpf, "coreclr.dll"));
        RequireNormalFile(Path.Combine(release, "runtime", "browser", "equinox-browser-native-host.exe"));

        // The native owner has not touched A or stopped its GUI until exact B
        // bytes were independently measured. Quiesce performs its own fresh
        // token/pipe-server OS PID proof and persists the observed exit.
        InspectionPhase = "native-integrated-ab-graceful-a-quiesce";
        QuiesceOwnedStableShell(owner, journalRoot, worker);
        var quiescePath = Path.Combine(journalRoot, owner.TransactionId + ".stable-shell-quiesce.json");
        using (var quiesce = ReadOwnedTransitionRecord(quiescePath, 8192))
        {
            var proof = quiesce.RootElement;
            if (proof.GetProperty("transactionId").GetString() != owner.TransactionId ||
                proof.GetProperty("disposition").GetString() != "stable-shell-quiesced-only" ||
                proof.GetProperty("guardianPid").GetInt32() != Environment.ProcessId)
                throw new InvalidDataException("Guardian cannot bind actual Stable WPF exit to its own transaction.");
        }
        if (worker.HasExited || worker.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Native worker died before independently authorized stage writes.");
        WriteIntegratedOwnedNativeStage(owner, journalPath, "prepared", 0, "native_staged", 1);
        WriteIntegratedOwnedNativeStage(owner, journalPath, "native_staged", 1, "shell_stopped", 2);
        // The existing shared JS slot primitive is the only swap engine.
        // Guardian supplies a narrow OS-authenticated action grant and audits
        // the actual installed B plus deterministic intact A rollback tree.
        RequestOwnedIntegratedABSlotSwap(owner, journalRoot, worker, release);
        InspectionPhase = "native-integrated-ab-a-stopped-journaled-b-not-switched";
        // A remains on disk with its exact Stable bytes; the persistent
        // Guardian writer lease blocks any automatic or unverified replay.
    }

    private static void WriteIntegratedOwnedNativeStage(OwnedWorkerClaim owner, string path,
        string from, int originalSequence, string to, int nextSequence)
    {
        if (!((from == "prepared" && originalSequence == 0 && to == "native_staged" && nextSequence == 1) ||
              (from == "native_staged" && originalSequence == 1 && to == "shell_stopped" && nextSequence == 2)))
            throw new InvalidDataException("Native integrated stage transition is not independently authorized.");
        RequireNormalFile(path);
        var original = File.ReadAllBytes(path);
        if (original.Length is < 2 or > 8192) throw new InvalidDataException("Native milestone journal exceeds bound.");
        using var doc = JsonDocument.Parse(original);
        var state = doc.RootElement;
        RequireExactKeys(state, ["schemaVersion", "channel", "transactionId", "target", "currentSha", "targetSha",
            "receiptStartedAt", "previousNative", "targetRuntimeContractSha256", "stage", "sequence", "createdAt", "updatedAt"]);
        if (state.GetProperty("schemaVersion").GetInt32() != 1 || state.GetProperty("channel").GetString() != "main" ||
            state.GetProperty("transactionId").GetString() != owner.TransactionId ||
            state.GetProperty("stage").GetString() != from || state.GetProperty("sequence").GetInt32() != originalSequence)
            throw new InvalidDataException("Native milestone cannot advance stale or foreign journal generation.");
        var before = SHA256.HashData(original);
        var clock = DateTimeOffset.UtcNow.ToString(CanonicalUtcTime, CultureInfo.InvariantCulture);
        if (string.CompareOrdinal(clock, state.GetProperty("updatedAt").GetString()) < 0)
            throw new InvalidDataException("Native milestone timestamp regressed.");
        var root = Path.GetDirectoryName(path) ?? throw new InvalidDataException("Milestone journal root missing.");
        var temp = Path.Combine(root, "." + owner.TransactionId + ".json." +
            Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)) + ".tmp");
        InspectionPhase = "native-integrated-ab-create-" + to;
        using (var fd = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var writer = new Utf8JsonWriter(fd))
            {
                writer.WriteStartObject();
                foreach (var entry in state.EnumerateObject())
                {
                    if (entry.NameEquals("stage")) writer.WriteString("stage", to);
                    else if (entry.NameEquals("sequence")) writer.WriteNumber("sequence", nextSequence);
                    else if (entry.NameEquals("updatedAt")) writer.WriteString("updatedAt", clock);
                    else entry.WriteTo(writer);
                }
                writer.WriteEndObject();
                writer.Flush();
            }
            fd.Flush(flushToDisk: true);
            if (fd.Length > 8192) throw new InvalidDataException("Native milestone candidate exceeds bound.");
        }
        if (!CryptographicOperations.FixedTimeEquals(before, SHA256.HashData(File.ReadAllBytes(path))))
            throw new InvalidDataException("Native journal mutated during exclusive milestone write.");
        File.Move(temp, path, overwrite: true); // same volume; no cleanup on crash.
        using var promoted = ReadOwnedTransitionRecord(path, 8192);
        if (promoted.RootElement.GetProperty("transactionId").GetString() != owner.TransactionId ||
            promoted.RootElement.GetProperty("stage").GetString() != to ||
            promoted.RootElement.GetProperty("sequence").GetInt32() != nextSequence)
            throw new InvalidDataException("Native milestone journal write did not persist exact stage.");
        var marker = Path.Combine(root, owner.TransactionId + "." + to + ".commit.json");
        using (var fd = new FileStream(marker, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            using (var writer = new Utf8JsonWriter(fd))
            {
                writer.WriteStartObject();
                writer.WriteNumber("schemaVersion", 1);
                writer.WriteString("transactionId", owner.TransactionId);
                writer.WriteString("stage", to);
                writer.WriteNumber("sequence", nextSequence);
                writer.WriteNumber("guardianPid", Environment.ProcessId);
                writer.WriteString("journalSha256", Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(path))));
                writer.WriteEndObject();
                writer.Flush();
            }
            fd.Flush(flushToDisk: true);
        }
        InspectionPhase = "native-integrated-ab-committed-" + to;
    }
}
