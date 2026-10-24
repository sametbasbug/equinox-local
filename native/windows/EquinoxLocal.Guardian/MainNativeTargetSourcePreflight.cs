using System.Runtime.InteropServices;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // The staged artifact digest cannot vouch for its SOURCE: a caller could
    // copy A's perfectly valid PE files into an arbitrary B-SHA directory.
    // This separate source-only audit verifies the actual product-owned B Git
    // checkout and old-A ancestry before inspecting B's native-store bytes.
    // It intentionally DOES NOT verify a release signature or authorize any
    // milestone, journal write, pointer change or WPF shutdown.
    private static void InspectOwnedTargetMainSource()
    {
        InspectionPhase = "native-b-source-journal-preflight";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Native B target source current-user root is unavailable.");
        var install = Path.Combine(local, "Equinox Local");
        var tx = Path.Combine(install, "state", "main-update");
        InspectOwnedNativeTransitionJournal();
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported native B source architecture."),
        };
        using var active = ReadOwnedTransitionRecord(Path.Combine(tx, "active.json"), 8192);
        var currentSha = active.RootElement.GetProperty("currentSha").GetString() ?? "";
        var bSha = active.RootElement.GetProperty("targetSha").GetString() ?? "";
        var id = active.RootElement.GetProperty("transactionId").GetString() ?? "";
        if (!NativeTransactionPattern.IsMatch(id) || !SourceShaPattern.IsMatch(currentSha) ||
            !SourceShaPattern.IsMatch(bSha) || currentSha == bSha)
            throw new InvalidDataException("Native B source lacks an exact original Main transaction.");
        using var journalDoc = ReadOwnedTransitionRecord(
            Path.Combine(tx, "guardian-journal", id + ".json"), 8192);
        var journal = journalDoc.RootElement;
        if (journal.GetProperty("stage").GetString() != "prepared" ||
            journal.GetProperty("sequence").GetInt32() != 0 ||
            journal.GetProperty("previousNative").GetProperty("kind").GetString() != "main" ||
            journal.GetProperty("currentSha").GetString() != currentSha ||
            journal.GetProperty("targetSha").GetString() != bSha ||
            journal.GetProperty("target").GetString() != target)
            throw new InvalidDataException("Native B source is not the prepared original-A successor.");
        var sources = Path.Combine(tx, "sources");
        var stagedSource = Path.Combine(sources, bSha);
        RequireNormalDirectory(sources);
        RequireNormalDirectory(stagedSource);
        // The exact product Git verifies canonical origin, full clean checkout,
        // HEAD, non-detached main and pinned executable rather than invoking
        // Git or hooks from staged source B or the system PATH.
        InspectOwnedMainGit(install, target, stagedSource, bSha);
        InspectionPhase = "native-b-source-original-a-git-ancestry";
        var git = Path.Combine(install, "runtime", "toolchain", "git", PinnedWindowsGit,
            target, "cmd", "git.exe");
        RequireNormalFile(git);
        // Exit 0 is proof A is an ancestor of B in the real checked-out Git
        // graph. The pinned Git runner treats any nonzero exit as a refusal.
        RunOwnedGit(git, stagedSource, "merge-base", "--is-ancestor", currentSha, bSha);
        // Only after independently validating the B checkout may we inspect
        // the exact full B native release payload. Both remain read-only.
        InspectOwnedStagedBNativeCandidate();
        InspectionPhase = "native-b-git-and-payload-audited-not-signed-no-stage";
    }
}
