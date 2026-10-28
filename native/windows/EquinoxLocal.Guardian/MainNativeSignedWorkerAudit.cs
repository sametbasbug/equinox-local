using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using EquinoxLocal.NativeShared;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // READ-ONLY native SHA worker OS-argv audit within the ORIGINAL Guardian.
    // Signed-native status/receipts are not legacy Git receipts; matching
    // these bytes grants NO kernel lease, HMAC or WPF swap authority.
    private static void InspectSignedNativeWorkerArgvWithoutGrant(
        JsonElement marker, OwnedWorkerClaim worker)
    {
        RequireExactKeys(marker, ["schemaVersion", "kind", "transactionId",
            "sourceSha", "target", "runtimeContractSha256"]);
        if (marker.GetProperty("schemaVersion").GetInt32() != 1 ||
            marker.GetProperty("kind").GetString() != "signed-native" ||
            marker.GetProperty("transactionId").GetString() != worker.TransactionId)
            throw new InvalidDataException("Signed-native worker owner has an unknown transaction.");

        var sha = marker.GetProperty("sourceSha").GetString() ?? "";
        var target = marker.GetProperty("target").GetString() ?? "";
        var contract = marker.GetProperty("runtimeContractSha256").GetString() ?? "";
        if (contract.Length != 64 ||
            contract.Any(ch => !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'))))
            throw new InvalidDataException("Signed-native worker runtime contract is malformed.");
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Signed-native worker has no original Windows user root.");

        var root = Path.Combine(local, "Equinox Local", "state", "main-update");
        var expected = MainSignedNativeWorkerContract.ForSignedNativeB(
            worker.TransactionId, sha, target, root);
        MainSignedNativeWorkerContract.ValidateOriginalReleaseFiles(expected);
        using var receiptDoc = ReadOwnedTransitionRecord(Path.Combine(
            root, "receipts", worker.TransactionId + ".signed-native.json"), 8192);
        var receipt = receiptDoc.RootElement;
        RequireExactKeys(receipt, ["schemaVersion", "kind", "transactionId",
            "sourceSha", "target", "runtimeContractSha256", "status"]);
        if (receipt.GetProperty("schemaVersion").GetInt32() != 1 ||
            receipt.GetProperty("kind").GetString() != "signed-native" ||
            receipt.GetProperty("transactionId").GetString() != worker.TransactionId ||
            receipt.GetProperty("sourceSha").GetString() != sha ||
            receipt.GetProperty("target").GetString() != target ||
            receipt.GetProperty("runtimeContractSha256").GetString() != contract ||
            receipt.GetProperty("status").GetString() is not ("admitted" or "activating"))
            throw new InvalidDataException("Signed-native worker receipt differs from original B.");

        using var process = Process.GetProcessById(worker.Pid);
        if (process.HasExited ||
            process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != worker.Ticks)
            throw new InvalidDataException("Signed-native worker PID/birth changed before OS argv audit.");
        MainSignedNativeWorkerContract.ValidateOsArgv(
            ParseWindowsOsArgv(ReadOsProcessCommandLine(process)), expected);
        if (process.HasExited ||
            process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture) != worker.Ticks)
            throw new InvalidDataException("Signed-native worker PID/birth changed after OS argv audit.");

        InspectionPhase = "signed-native-os-argv-read-only-incomplete";
        // Caller deliberately REJECTS the session until Ed25519 signer,
        // original HMAC guardian journal and WPF ownership are all proved.
    }
}
