using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Read-only prerequisite for an eventual OS-owned Main A/B supervisor.
    // A healthy worker identity is not WPF identity: separately measure A's
    // installed native bytes and live WPF PID, creation time and logon token.
    // No shutdown, journal mutation, B launch or transition capability here.
    private static void InspectOwnedMainWpfProcess()
    {
        InspectionPhase = "native-wpf-audit-owned-worker";
        var owner = InspectOwnedNativeWorkerProcess();
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var install = Path.Combine(local, "Equinox Local");
        var transactionRoot = Path.Combine(install, "state", "main-update");
        using var doc = ReadOwnedTransitionRecord(
            Path.Combine(transactionRoot, "guardian-journal", owner.TransactionId + ".json"), 8192);
        var record = doc.RootElement;
        if (record.GetProperty("stage").GetString() != "prepared" ||
            record.GetProperty("sequence").GetInt32() != 0)
            throw new InvalidDataException("Live native A shell audit requires an unmodified prepared journal.");

        var nativeA = record.GetProperty("previousNative");
        var kind = nativeA.GetProperty("kind").GetString();
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported WPF native audit architecture."),
        };
        string release;
        if (kind == "stable")
        {
            RequireExactKeys(nativeA, ["kind", "version"]);
            var version = nativeA.GetProperty("version").GetString() ?? "";
            if (!VersionRegex().IsMatch(version))
                throw new InvalidDataException("Previous signed Stable native version is malformed.");
            using var pointerDoc = ReadOwnedTransitionRecord(
                Path.Combine(install, "current-version.json"), 4096);
            var pointer = pointerDoc.RootElement;
            RequireExactKeys(pointer, ["schemaVersion", "target", "version"]);
            if (pointer.GetProperty("schemaVersion").GetInt32() != 1 ||
                pointer.GetProperty("target").GetString() != target ||
                pointer.GetProperty("version").GetString() != version)
                throw new InvalidDataException("Previous signed Stable A differs from the installed native pointer.");
            release = Path.Combine(install, "releases", version);
        }
        else if (kind == "main")
        {
            RequireExactKeys(nativeA, ["kind", "sourceSha", "runtimeContractSha256"]);
            var sourceSha = nativeA.GetProperty("sourceSha").GetString() ?? "";
            var contractSha = nativeA.GetProperty("runtimeContractSha256").GetString() ?? "";
            if (!SourceShaPattern.IsMatch(sourceSha) || !DigestPattern.IsMatch(contractSha) ||
                record.GetProperty("currentSha").GetString() != sourceSha)
                throw new InvalidDataException("Previous Main native identity is not an exact SHA and contract.");
            using var pointerDoc = ReadOwnedTransitionRecord(
                Path.Combine(transactionRoot, "current-native.json"), 8192);
            var pointer = pointerDoc.RootElement;
            RequireExactKeys(pointer, ["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256"]);
            if (pointer.GetProperty("schemaVersion").GetInt32() != 1 ||
                pointer.GetProperty("channel").GetString() != "main" ||
                pointer.GetProperty("sourceSha").GetString() != sourceSha ||
                pointer.GetProperty("target").GetString() != target ||
                pointer.GetProperty("runtimeContractSha256").GetString() != contractSha)
                throw new InvalidDataException("Active Main native pointer no longer identifies original A.");
            // Reinspect original A's canonical immutable source with the
            // product-owned Git (never ambient PATH) and bound Native Messaging
            // registration. Native shell bytes alone are not source identity.
            var sourceRoot = Path.Combine(transactionRoot, "sources", sourceSha);
            RequireNormalDirectory(sourceRoot);
            InspectOwnedMainGit(install, target, sourceRoot, sourceSha);
            release = Path.Combine(transactionRoot, "native-store", target, sourceSha, "release");
            InspectOwnedMainNativeMessaging(install, release);
        }
        else throw new InvalidDataException("Main WPF audit cannot identify original native A.");

        InspectionPhase = "native-wpf-audit-original-a-bytes";
        var originalShell = Path.Combine(release, "runtime", "shell");
        var installedShell = Path.Combine(local, "Programs", "Equinox Local");
        RequireNormalDirectory(release);
        RequireNormalDirectory(originalShell);
        RequireNormalDirectory(installedShell);
        CompareNativeTrees(originalShell, installedShell);
        var executable = Path.Combine(installedShell, "EquinoxLocal.exe");
        RequireNormalFile(executable);

        InspectionPhase = "native-wpf-audit-live-process";
        using var shell = FindSingleOwnedStableShell(executable);
        var pid = shell.Id;
        var ticks = shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        using var guardian = Process.GetCurrentProcess();
        if (shell.HasExited || shell.SessionId != guardian.SessionId || pid == owner.Pid)
            throw new InvalidDataException("Original A WPF is not an independent live shell in the Guardian session.");
        if (!OpenProcessToken(shell.Handle, TokenQuery, out var handle))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot inspect native WPF logon identity.");
        using (handle)
        using (var shellIdentity = new WindowsIdentity(handle.DangerousGetHandle()))
        using (var guardianIdentity = WindowsIdentity.GetCurrent())
        {
            if (shellIdentity.User is null || guardianIdentity.User is null ||
                !shellIdentity.User.Equals(guardianIdentity.User) ||
                ReadWindowsLogonAuthenticationId(handle) != ReadWindowsLogonAuthenticationId(guardianIdentity.AccessToken))
                throw new InvalidDataException("Original A WPF belongs to a different Windows logon.");
        }

        InspectionPhase = "native-wpf-audit-kernel-pipe";
        using var pipe = new NamedPipeClientStream(".", "EquinoxLocal.WindowsShell.Reopen",
            PipeDirection.InOut, PipeOptions.Asynchronous);
        pipe.Connect(1500);
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid) ||
            serverPid != pid ||
            shell.HasExited ||
            shell.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != ticks)
            throw new InvalidDataException("Original A WPF ownership pipe is not backed by the same kernel process.");

        InspectionPhase = "native-wpf-audit-read-only-complete";
        // No command is sent on this pipe. Success is ONLY an observation,
        // never an admitted native supervisor or authority to replace WPF.
    }
}
