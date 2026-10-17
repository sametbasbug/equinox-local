using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Windows provides ProcessCommandLineInformation (60) for a live process
    // handle. This is read-only evidence, not an authorization or a substitute
    // for immutable source attestation, pipe ownership and journal writer ACL.
    private const int ProcessCommandLineInformation = 60;
    private const int MaxWorkerCommandBytes = 16 * 1024;

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr handle, int informationClass,
        IntPtr information, int informationBytes, out int returnBytes);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CommandLineToArgvW(string commandLine, out int argc);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    private static string ReadOsProcessCommandLine(Process process)
    {
        var buffer = Marshal.AllocHGlobal(MaxWorkerCommandBytes);
        try
        {
            // Do not trust a user-owned worker record for argv: ask Windows
            // directly for the command line associated with this PID handle.
            var status = NtQueryInformationProcess(process.Handle, ProcessCommandLineInformation,
                buffer, MaxWorkerCommandBytes, out var used);
            if (status != 0 || used is < 16 or > MaxWorkerCommandBytes || IntPtr.Size != 8)
                throw new InvalidDataException("Windows worker OS command line cannot be read safely.");
            var byteLength = (ushort)Marshal.ReadInt16(buffer, 0);
            var byteCapacity = (ushort)Marshal.ReadInt16(buffer, 2);
            var stringPointer = Marshal.ReadIntPtr(buffer, 8);
            long offset;
            try { offset = checked(stringPointer.ToInt64() - buffer.ToInt64()); }
            catch (OverflowException) { throw new InvalidDataException("Windows command line buffer pointer overflowed."); }
            if (byteLength < 2 || byteLength % 2 != 0 || byteCapacity < byteLength ||
                byteLength > MaxWorkerCommandBytes - 16 || offset < 16 ||
                offset + byteLength > used)
                throw new InvalidDataException("Windows worker OS command line has an invalid bounded string.");
            return Marshal.PtrToStringUni(stringPointer, byteLength / 2)
                ?? throw new InvalidDataException("Windows worker OS command line is missing.");
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    private static string[] ParseWindowsOsArgv(string commandLine)
    {
        var pointer = CommandLineToArgvW(commandLine, out var count);
        if (pointer == IntPtr.Zero || count is < 1 or > 10)
        {
            if (pointer != IntPtr.Zero) _ = LocalFree(pointer);
            throw new InvalidDataException("Windows worker command-line argv cannot be parsed within its bound.");
        }
        try
        {
            var args = new string[count];
            for (var i = 0; i < count; i++)
            {
                args[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, i * IntPtr.Size))
                    ?? throw new InvalidDataException("Windows worker command-line argv includes missing content.");
            }
            return args;
        }
        finally { _ = LocalFree(pointer); }
    }

    private static void InspectOwnedNativeWorkerOsArguments()
    {
        var worker = InspectOwnedNativeWorkerProcess();
        InspectionPhase = "native-worker-os-command-line";
        var install = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Equinox Local");
        var tx = Path.Combine(install, "state", "main-update");
        using var markerDocument = ReadOwnedTransitionRecord(Path.Combine(tx, "active.json"), 8192);
        var marker = markerDocument.RootElement;
        var currentSha = marker.GetProperty("currentSha").GetString() ?? "";
        var targetSha = marker.GetProperty("targetSha").GetString() ?? "";
        if (!SourceShaPattern.IsMatch(currentSha) || !SourceShaPattern.IsMatch(targetSha))
            throw new InvalidDataException("Windows worker has no canonical Main source transaction.");
        using var receiptDocument = ReadOwnedTransitionRecord(Path.Combine(tx, "receipts", worker.TransactionId + ".json"), 65536);
        var receipt = receiptDocument.RootElement;
        var sources = Path.Combine(tx, "sources");
        RequireNormalDirectory(sources);
        var rollback = Path.Combine(sources, currentSha);
        var target = Path.Combine(sources, targetSha);
        RequireNormalDirectory(rollback);
        RequireNormalDirectory(target);
        if (!Compare.Equals(receipt.GetProperty("rollbackSourceRoot").GetString(), rollback) ||
            !Compare.Equals(receipt.GetProperty("targetSourceRoot").GetString(), target))
            throw new InvalidDataException("Windows worker receipt source roots do not belong to exact immutable transaction folders.");
        var scriptDir = Path.Combine(target, "src");
        RequireNormalDirectory(scriptDir);
        var script = Path.Combine(scriptDir, "equinox-local-main-update-worker.js");
        RequireNormalFile(script);
        var targetHost = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported Main worker CPU architecture."),
        };
        var node = ResolveOwnedMainWorkerNodePath(install, targetHost);


        using var process = Process.GetProcessById(worker.Pid);
        if (process.HasExited || process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != worker.Ticks)
            throw new InvalidDataException("Windows worker changed before OS command line admission.");
        var arguments = ParseWindowsOsArgv(ReadOsProcessCommandLine(process));
        var expected = new[] { node, script, "--transaction-id", worker.TransactionId,
            "--source-root", rollback, "--transaction-root", tx };
        if (arguments.Length != expected.Length)
            throw new InvalidDataException("Windows worker OS process argv count differs from its exact native Main contract.");
        for (var i = 0; i < expected.Length; i++)
        {
            var same = i is 0 or 1 or 5 or 7
                ? Compare.Equals(arguments[i], expected[i])
                : StringComparer.Ordinal.Equals(arguments[i], expected[i]);
            if (!same)
                throw new InvalidDataException("Windows worker OS process argv differs from its exact Main transaction contract.");
        }
        if (process.HasExited || process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != worker.Ticks)
            throw new InvalidDataException("Windows worker changed after OS argv admission.");
        InspectionPhase = "native-worker-os-command-line-complete";
        // Never return a mutation capability from this standalone audit.
    }
}
