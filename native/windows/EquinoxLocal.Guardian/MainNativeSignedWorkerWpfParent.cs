using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Proof ONLY. Original signed B's worker must have been CREATED by the
    // ORIGINAL installed WPF in the same Windows logon, and that WPF must
    // still own its original kernel named-pipe listener. A claimed PID in
    // private JSON (or shell executable name) is insufficient. This
    // establishes no Guardian OS journal writer or A/B mutation authority.
    private static void InspectSignedNativeWorkerWpfParentWithoutGrant(OwnedWorkerClaim worker)
    {
        InspectionPhase = "signed-native-wpf-original-parent";
        if (IntPtr.Size != 8)
            throw new PlatformNotSupportedException("Original signed-native parent proof requires 64-bit Windows.");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Original signed-native WPF has no Windows user profile.");
        var shellPath = Path.GetFullPath(Path.Combine(local, "Programs", "Equinox Local", "EquinoxLocal.exe"));
        RequireNormalFile(shellPath);

        using var parent = FindSingleOwnedStableShell(shellPath);
        using var process = Process.GetProcessById(worker.Pid);
        if (process.HasExited || parent.HasExited || parent.Id == worker.Pid ||
            process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != worker.Ticks)
            throw new InvalidDataException("Original signed-native worker or WPF parent changed.");

        // NtQueryInformationProcess(ProcessBasicInformation=0) returns a
        // 64-bit PROCESS_BASIC_INFORMATION whose inherited parent PID is
        // the native pointer-sized field at offset 40 on Windows x64/ARM64.
        // Read from the actual WORKER HANDLE, never user-owned JSON.
        const int processBasicInformation = 0;
        const int processBasicInformationBytes = 48;
        var buffer = Marshal.AllocHGlobal(processBasicInformationBytes);
        try
        {
            var status = NtQueryInformationProcess(process.Handle, processBasicInformation,
                buffer, processBasicInformationBytes, out var returned);
            if (status != 0 || returned < processBasicInformationBytes ||
                returned > processBasicInformationBytes ||
                Marshal.ReadIntPtr(buffer, 40).ToInt64() != parent.Id)
                throw new InvalidDataException("Native signed B worker was not spawned by original installed WPF.");
        }
        finally { Marshal.FreeHGlobal(buffer); }

        InspectionPhase = "signed-native-wpf-parent-logon";
        using var guardian = Process.GetCurrentProcess();
        if (parent.SessionId != guardian.SessionId)
            throw new InvalidDataException("Original WPF is not in Guardian's Windows interactive session.");
        if (!OpenProcessToken(parent.Handle, TokenQuery, out var parentToken))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot query original signed-native WPF token.");
        using (parentToken)
        using (var shellIdentity = new WindowsIdentity(parentToken.DangerousGetHandle()))
        using (var guardianIdentity = WindowsIdentity.GetCurrent())
        {
            if (shellIdentity.User is null || guardianIdentity.User is null ||
                !shellIdentity.User.Equals(guardianIdentity.User) ||
                ReadWindowsLogonAuthenticationId(parentToken) !=
                    ReadWindowsLogonAuthenticationId(guardianIdentity.AccessToken))
                throw new InvalidDataException("Original WPF logon SID/LUID differs from independent Guardian.");
        }

        InspectionPhase = "signed-native-wpf-parent-kernel-pipe";
        var ticks = parent.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture);
        using var pipe = new NamedPipeClientStream(".", "EquinoxLocal.WindowsShell.Reopen",
            PipeDirection.InOut, PipeOptions.Asynchronous);
        pipe.Connect(1500);
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid) ||
            serverPid != parent.Id || parent.HasExited ||
            parent.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != ticks ||
            process.HasExited ||
            process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != worker.Ticks)
            throw new InvalidDataException("Original signed-native WPF pipe/worker birth identity changed.");
        // Do not send a command to WPF. A parent PID can also be spoofed by
        // a privileged creator, so a positive read-only proof NEVER stands
        // in for a signed Guardian mutation lease or shutdown permission.
        InspectionPhase = "signed-native-wpf-parent-read-only-complete";
    }
}
