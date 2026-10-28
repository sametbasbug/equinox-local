using System.Globalization;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Production trust root is the ORIGINAL pinned public update key,
    // never user input, a network response, environment or the native store.
    // Raw 32-byte Ed25519 key from the same SPKI pinned in
    // src/equinox-local-update-keys.ts (stable-2026-01).
    private const string OriginalMainKeyId = "stable-2026-01";
    private const string OriginalMainPublicKey = "mFYwZkZ7Aabb8QZ/RAwhxr3D4RenekD4Cf2vhs7Vk/A=";
    private const string MainSnapshotsBase = "https://main.local.sametbasbug.dev/snapshots/";
    private static readonly string[] MainTargets =
        ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];
    private static readonly Regex MainKeyIdPattern = new(
        @"\A[a-z0-9][a-z0-9._-]{0,63}\z", RegexOptions.CultureInvariant);

    private sealed record OriginalSignedTarget(string Contract, string ArtifactSha256,
        long ArtifactBytes, string Version);

    // Reproduce the validated signed JSON.stringify(payload) wire object,
    // not raw arbitrary JSON formatting. This MUST match the ORIGINAL Node
    // validateTrustedMainInstallPointer signature payload property order.
    private static OriginalSignedTarget VerifyOriginalSignedNativeMainSelector(
        string selectorPath, string expectedSourceSha, string hostTarget)
    {
        InspectionPhase = "signed-native-original-ed25519";
        using var selectorDoc = ReadOwnedTransitionRecord(selectorPath, 16 * 1024);
        var pointer = selectorDoc.RootElement;
        RequireExactKeys(pointer, ["schemaVersion", "channel", "sourceSha", "version",
            "publishedAt", "targets", "signature"]);
        if (pointer.GetProperty("schemaVersion").GetInt32() != 1 ||
            pointer.GetProperty("channel").GetString() != "main" ||
            pointer.GetProperty("sourceSha").GetString() != expectedSourceSha ||
            !SourceShaPattern.IsMatch(expectedSourceSha) ||
            !MainTargets.Contains(hostTarget, StringComparer.Ordinal))
            throw new InvalidDataException("Original production Main signature source identity differs from native B.");

        var version = pointer.GetProperty("version").GetString() ?? "";
        var publishedAt = pointer.GetProperty("publishedAt").GetString() ?? "";
        if (!VersionRegex().IsMatch(version) ||
            !DateTimeOffset.TryParseExact(publishedAt,
                "yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out var published) ||
            published.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture) != publishedAt)
            throw new InvalidDataException("Original production Main signed version/timestamp is invalid.");

        var sig = pointer.GetProperty("signature");
        RequireExactKeys(sig, ["algorithm", "keyId", "value"]);
        var keyId = sig.GetProperty("keyId").GetString() ?? "";
        if (sig.GetProperty("algorithm").GetString() != "ed25519" ||
            !MainKeyIdPattern.IsMatch(keyId) || keyId != OriginalMainKeyId)
            throw new InvalidDataException("Original Main Ed25519 signer is not the pinned production root.");
        var signatureBase64 = sig.GetProperty("value").GetString() ?? "";
        if (signatureBase64.Length != 88)
            throw new InvalidDataException("Original Main Ed25519 signature length is invalid.");
        byte[] signature;
        try { signature = Convert.FromBase64String(signatureBase64); }
        catch (FormatException ex) { throw new InvalidDataException("Original Main Ed25519 base64 is invalid.", ex); }
        if (signature.Length != 64 ||
            Convert.ToBase64String(signature) != signatureBase64)
            throw new InvalidDataException("Original Main Ed25519 signature encoding is noncanonical.");

        var targets = pointer.GetProperty("targets");
        if (targets.ValueKind != JsonValueKind.Array || targets.GetArrayLength() != 4)
            throw new InvalidDataException("Original signed Main requires all FOUR ordered native targets.");
        OriginalSignedTarget? selected = null;
        var payloadBuffer = new MemoryStream();
        using (var writer = new Utf8JsonWriter(payloadBuffer, new JsonWriterOptions {
            Indented = false, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        }))
        {
            writer.WriteStartObject();
            writer.WriteNumber("schemaVersion", 1);
            writer.WriteString("channel", "main");
            writer.WriteString("sourceSha", expectedSourceSha);
            writer.WriteString("version", version);
            writer.WriteString("publishedAt", publishedAt);
            writer.WritePropertyName("targets");
            writer.WriteStartArray();
            for (var i = 0; i < MainTargets.Length; i++)
            {
                var item = targets[i];
                RequireExactKeys(item, ["target", "runtimeContractSha256", "artifact"]);
                var target = item.GetProperty("target").GetString() ?? "";
                var contract = item.GetProperty("runtimeContractSha256").GetString() ?? "";
                var artifact = item.GetProperty("artifact");
                RequireExactKeys(artifact, ["url", "sha256", "bytes"]);
                var url = artifact.GetProperty("url").GetString() ?? "";
                var digest = artifact.GetProperty("sha256").GetString() ?? "";
                var bytes = artifact.GetProperty("bytes").GetInt64();
                var archive = "equinox-local-main-" + expectedSourceSha + "-" + target +
                    (target.StartsWith("win32-", StringComparison.Ordinal) ? ".zip" : ".tar.gz");
                if (target != MainTargets[i] ||
                    !DigestPattern.IsMatch(contract) || !DigestPattern.IsMatch(digest) ||
                    bytes is < 1 or > 1024L * 1024 * 1024 ||
                    url != MainSnapshotsBase + expectedSourceSha + "/" + archive)
                    throw new InvalidDataException("Original Ed25519 Main target archive identity is invalid.");
                writer.WriteStartObject();
                writer.WriteString("target", target);
                writer.WriteString("runtimeContractSha256", contract);
                writer.WritePropertyName("artifact");
                writer.WriteStartObject();
                writer.WriteString("url", url);
                writer.WriteString("sha256", digest);
                writer.WriteNumber("bytes", bytes);
                writer.WriteEndObject();
                writer.WriteEndObject();
                if (target == hostTarget)
                    selected = new OriginalSignedTarget(contract, digest, bytes, version);
            }
            writer.WriteEndArray();
            writer.WriteEndObject();
            writer.Flush();
        }
        if (selected is null)
            throw new InvalidDataException("Original production signed Main has no native Windows target.");

        var verifier = new Ed25519Signer();
        var key = Convert.FromBase64String(OriginalMainPublicKey);
        if (key.Length != 32)
            throw new InvalidDataException("Pinned original Main public key is invalid.");
        verifier.Init(false, new Ed25519PublicKeyParameters(key, 0));
        var canonical = payloadBuffer.ToArray();
        verifier.BlockUpdate(canonical, 0, canonical.Length);
        if (!verifier.VerifySignature(signature))
            throw new InvalidDataException("Original Main Ed25519 production signature verification failed.");

        InspectionPhase = "signed-native-original-ed25519-verified-read-only";
        return selected;
    }
}
