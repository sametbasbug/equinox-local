using System.Buffers.Binary;
using System.Diagnostics;
using System.Globalization;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private static readonly Regex WorkerTokenPattern = new("^[a-f0-9]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex WorkerTicksPattern = new("^[0-9]{1,19}$", RegexOptions.CultureInvariant);

    private sealed record OwnedWorkerClaim(int Pid, string Ticks, string TransactionId, string Token);
    private const string ProofDomain = "equinox-local-native-main-proof-v1:";

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);

    private const uint TokenQuery = 0x0008;
    private const int TokenStatisticsClass = 10;
    private const int Win32InsufficientBuffer = 122;
    // TOKEN_STATISTICS has two consecutive Windows LUIDs: TokenId at 0,
    // AuthenticationId at 8. Both Windows x64 and ARM64 are little-endian.
    private const int AuthenticationIdOffset = 8;
    private const int MinimumTokenStatisticsBytes = 16;
    private const int MaximumTokenStatisticsBytes = 512;

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess,
        out SafeAccessTokenHandle tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(SafeAccessTokenHandle tokenHandle,
        int tokenInformationClass, [Out] byte[]? tokenInformation,
        int tokenInformationLength, out int returnLength);

    private static long ReadWindowsLogonAuthenticationId(SafeAccessTokenHandle token)
    {
        if (GetTokenInformation(token, TokenStatisticsClass, null, 0, out var requiredBytes) ||
            Marshal.GetLastWin32Error() != Win32InsufficientBuffer ||
            requiredBytes is < MinimumTokenStatisticsBytes or > MaximumTokenStatisticsBytes)
            throw new InvalidDataException("Windows token statistics length or ownership is invalid.");
        var bytes = new byte[requiredBytes];
        if (!GetTokenInformation(token, TokenStatisticsClass, bytes, bytes.Length, out var writtenBytes) ||
            writtenBytes < MinimumTokenStatisticsBytes || writtenBytes > bytes.Length)
            throw new InvalidDataException("Cannot independently read Windows worker logon identity.");
        return BinaryPrimitives.ReadInt64LittleEndian(bytes.AsSpan(AuthenticationIdOffset, sizeof(long)));
    }

    // Independently prove the OS PID/start-time/executable/user-SID tuple. A signed
    // ownership record by itself is not proof of a live owner, and PID reuse
    // must never authorize a WPF shutdown or a journal replay. This remains a
    // read-only provenance test, NOT an authenticated worker command line or
    // an update/rollback authorization.
    private static OwnedWorkerClaim InspectOwnedNativeWorkerProcess(bool signedNativeReadOnly = false)
    {
        if (signedNativeReadOnly)
            InspectOwnedSignedNativeJournalWithoutGrant();
        else
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
        var expectedNode = signedNativeReadOnly
            ? ResolveSignedNativeBNodeForReadOnlyAudit(tx, id, target)
            : ResolveOwnedMainWorkerNodePath(install, target);

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

        InspectionPhase = "native-worker-user-identity";
        // Compare Windows kernel access-token owner SIDs for the live process
        // and the running per-user Guardian, never process name, environment
        // USERNAME or user-writable JSON. This is not impersonation and does
        // not elevate or grant any filesystem permissions.
        if (!OpenProcessToken(running.Handle, TokenQuery, out var workerToken))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot query owned native worker token.");
        using (workerToken)
        using (var workerIdentity = new WindowsIdentity(workerToken.DangerousGetHandle()))
        using (var guardianIdentity = WindowsIdentity.GetCurrent())
        {
            var workerSid = workerIdentity.User;
            var guardianSid = guardianIdentity.User;
            if (workerSid is null || guardianSid is null || !workerSid.Equals(guardianSid))
                throw new InvalidDataException("Detached worker user SID differs from current Guardian owner.");
            InspectionPhase = "native-worker-logon-authentication";
            // SID and Terminal Services SessionId equality do not establish a
            // shared logon. Compare the OS-assigned TOKEN_STATISTICS AuthenticationId
            // LUID (not usernames, environment data or a worker-owned receipt).
            var workerLogon = ReadWindowsLogonAuthenticationId(workerToken);
            var guardianLogon = ReadWindowsLogonAuthenticationId(guardianIdentity.AccessToken);
            if (workerLogon == 0 || guardianLogon == 0 || workerLogon != guardianLogon)
                throw new InvalidDataException("Detached worker Windows logon authentication identity differs from Guardian.");
        }
        InspectionPhase = "native-worker-os-session";
        // A Windows user SID identifies the account, not the interactive/logon
        // session. Query both session IDs from the live OS process handles,
        // never from a self-declared ownership JSON or environment variable.
        // Session equality is necessary but not sufficient for update authority:
        // full argv, environment-token and journal-writer attestation remain
        // independently required before any native mutation can be enabled.
        using (var guardian = Process.GetCurrentProcess())
        {
            if (running.SessionId != guardian.SessionId)
                throw new InvalidDataException("Detached worker belongs to a different Windows OS session.");
        }
        // Pin the same process handle to its original birth timestamp again;
        // changing the ownership JSON cannot turn a recycled PID into proof.
        if (running.HasExited || running.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != ticks)
            throw new InvalidDataException("Native worker exited or identity changed during user token inspection.");
        InspectionPhase = "native-worker-process-provenance-complete";
        // Trust is deliberately incomplete: the worker command line, token in
        // process environment, exact receipt writer, system ACL and full
        // transaction recovery still need independent supervisor attestation.
        return new OwnedWorkerClaim(pid, ticks, id, token);
    }

    // Read-only interactive proof: the Windows kernel attests the server PID
    // for THIS pipe handle; the live Node worker must additionally possess
    // its launch-time token to MAC a fresh nonce. Never mutate journal/WPF here.
    private static void InspectOwnedNativeWorkerPipeProof(bool signedNativeReadOnly = false)
    {
        var owner = InspectOwnedNativeWorkerProcess(signedNativeReadOnly);
        InspectionPhase = "native-worker-os-pipe-peer";
        using var pipe = new NamedPipeClientStream(".", "EquinoxLocalMainOwner-" + owner.TransactionId,
            PipeDirection.InOut, PipeOptions.Asynchronous);
        pipe.Connect(1500);
        if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out var serverPid) ||
            serverPid != owner.Pid)
            throw new InvalidDataException("Windows named pipe server PID is not the audited detached worker.");
        using var observed = Process.GetProcessById(owner.Pid);
        if (observed.HasExited || observed.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
            throw new InvalidDataException("Windows native worker identity changed before live proof.");
        InspectionPhase = "native-worker-live-token-proof";
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        var nonce = RandomNumberGenerator.GetBytes(32);
        var request = Encoding.ASCII.GetBytes(Convert.ToHexStringLower(nonce) + "\n");
        pipe.WriteAsync(request.AsMemory(), deadline.Token).AsTask().GetAwaiter().GetResult();
        pipe.FlushAsync(deadline.Token).GetAwaiter().GetResult();
        var response = new byte[65];
        for (var offset = 0; offset < response.Length;)
        {
            var read = pipe.ReadAsync(response.AsMemory(offset, response.Length - offset), deadline.Token).AsTask().GetAwaiter().GetResult();
            if (read < 1) throw new InvalidDataException("Windows worker pipe proof response ended early.");
            offset += read;
            if (response[offset - 1] == (byte)'\n')
            {
                if (offset != response.Length) throw new InvalidDataException("Windows worker pipe response has invalid length.");
                var hex = Encoding.ASCII.GetString(response, 0, 64);
                if (!WorkerTokenPattern.IsMatch(hex)) throw new InvalidDataException("Windows worker pipe proof is malformed.");
                var actual = Convert.FromHexString(hex);
                var key = Convert.FromHexString(owner.Token);
                var message = new byte[Encoding.ASCII.GetByteCount(ProofDomain) + nonce.Length];
                Encoding.ASCII.GetBytes(ProofDomain, message);
                nonce.CopyTo(message.AsSpan(Encoding.ASCII.GetByteCount(ProofDomain)));
                var expected = HMACSHA256.HashData(key.AsSpan(), message.AsSpan());
                if (!CryptographicOperations.FixedTimeEquals(actual, expected))
                    throw new InvalidDataException("Windows worker did not prove its live launch token.");
                CryptographicOperations.ZeroMemory(key);
                if (observed.HasExited || observed.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != owner.Ticks)
                    throw new InvalidDataException("Windows worker identity changed after IPC proof.");
                return;
            }
        }
        throw new InvalidDataException("Windows worker pipe response exceeded its fixed bound.");
    }
}
