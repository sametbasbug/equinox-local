using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    // Immutable SPKI from the shipped product Ed25519 root stable-2026-01.
    // NEVER accept key material from the candidate, journal, env or command line.
    private const string MainBTrustedSpkiDer = "MCowBQYDK2VwAyEAmFYwZkZ7Aabb8QZ/RAwhxr3D4RenekD4Cf2vhs7Vk/A=";
    private const string MainBSignatureDomain = "equinox-local-main-native-b-authorization-v1\n";
    // Invoked solely by the OS Guardian using its already fingerprint-checked
    // original A native-store Node. No script on disk, no B code, no shell,
    // and no untrusted executable. Native Guardian owns the result/decision.
    private const string MainBVerifyScript = "'use strict';const {verify,createPublicKey}=require('node:crypto');" +
        "const fs=require('node:fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));" +
        "const k=createPublicKey({key:Buffer.from('" + MainBTrustedSpkiDer + "','base64'),format:'der',type:'spki'});" +
        "if(!verify(null,Buffer.from(x.payload,'utf8'),k,Buffer.from(x.signature,'base64')))process.exit(70);" +
        "process.stdout.write('VERIFIED\\n');";

    private static void InspectOwnedSignedMainBCandidate()
    {
        InspectionPhase = "native-b-authorization-owner";
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrWhiteSpace(local) || !Path.IsPathFullyQualified(local))
            throw new InvalidDataException("Signed Main B current-user root unavailable.");
        var install = Path.Combine(local, "Equinox Local");
        var tx = Path.Combine(install, "state", "main-update");
        using var activeDoc = ReadOwnedTransitionRecord(Path.Combine(tx, "active.json"), 8192);
        var active = activeDoc.RootElement;
        var aSha = active.GetProperty("currentSha").GetString() ?? "";
        var bSha = active.GetProperty("targetSha").GetString() ?? "";
        var target = RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => "win32-x64",
            Architecture.Arm64 => "win32-arm64",
            _ => throw new PlatformNotSupportedException("Unsupported signed Main B target."),
        };
        if (!SourceShaPattern.IsMatch(aSha) || !SourceShaPattern.IsMatch(bSha) || aSha == bSha)
            throw new InvalidDataException("Signed B active source identity is invalid.");
        var store = Path.Combine(tx, "native-store", target, bSha);
        RequireNormalDirectory(store);
        // A forged/synthetic digest-only B is refused before any state mutation.
        InspectionPhase = "native-b-authorization-file";
        var file = Path.Combine(store, "main-b-authorization.json");
        using var signedDoc = ReadOwnedTransitionRecord(file, 8192);
        var signed = signedDoc.RootElement;
        RequireExactKeys(signed, ["schemaVersion", "channel", "previousSourceSha", "sourceSha", "target",
            "runtimeContractSha256", "artifact", "releaseFingerprint", "signature"]);
        using var manifestDoc = ReadOwnedTransitionRecord(Path.Combine(store, "native-store.json"), 8192);
        var manifest = manifestDoc.RootElement;
        var artifact = signed.GetProperty("artifact");
        var fingerprint = signed.GetProperty("releaseFingerprint");
        var signature = signed.GetProperty("signature");
        RequireExactKeys(artifact, ["sha256", "bytes"]);
        RequireExactKeys(fingerprint, ["sha256", "entries", "bytes"]);
        RequireExactKeys(signature, ["algorithm", "keyId", "value"]);
        if (signed.GetProperty("schemaVersion").GetInt32() != 1 ||
            signed.GetProperty("channel").GetString() != "main" ||
            signed.GetProperty("previousSourceSha").GetString() != aSha ||
            signed.GetProperty("sourceSha").GetString() != bSha ||
            signed.GetProperty("target").GetString() != target ||
            signed.GetProperty("runtimeContractSha256").GetString() != manifest.GetProperty("runtimeContractSha256").GetString() ||
            artifact.GetProperty("sha256").GetString() != manifest.GetProperty("artifactSha256").GetString() ||
            artifact.GetProperty("bytes").GetInt64() != manifest.GetProperty("artifactBytes").GetInt64() ||
            fingerprint.GetProperty("sha256").GetString() != manifest.GetProperty("releaseFingerprint").GetProperty("sha256").GetString() ||
            fingerprint.GetProperty("entries").GetInt64() != manifest.GetProperty("releaseFingerprint").GetProperty("entries").GetInt64() ||
            fingerprint.GetProperty("bytes").GetInt64() != manifest.GetProperty("releaseFingerprint").GetProperty("bytes").GetInt64() ||
            !DigestPattern.IsMatch(signed.GetProperty("runtimeContractSha256").GetString() ?? "") ||
            !DigestPattern.IsMatch(artifact.GetProperty("sha256").GetString() ?? "") ||
            !DigestPattern.IsMatch(fingerprint.GetProperty("sha256").GetString() ?? "") ||
            artifact.GetProperty("bytes").GetInt64() is < 1 or > 1_073_741_824 ||
            fingerprint.GetProperty("entries").GetInt64() is < 1 or > 50_000 ||
            fingerprint.GetProperty("bytes").GetInt64() is < 1 or > 1_073_741_824 ||
            signature.GetProperty("algorithm").GetString() != "ed25519" ||
            signature.GetProperty("keyId").GetString() != "stable-2026-01")
            throw new InvalidDataException("Signed B authorization is not bound to the installed original A/native-store manifest.");
        var base64 = signature.GetProperty("value").GetString() ?? "";
        if (base64.Length != 88 || !base64.EndsWith('=') ||
            Convert.ToBase64String(Convert.FromBase64String(base64)) != base64 ||
            Convert.FromBase64String(base64).Length != 64)
            throw new InvalidDataException("Signed B Ed25519 signature is not canonical.");
        // The self-contained Guardian is PublishTrimmed=true. Use explicit
        // Utf8JsonWriter property order rather than reflection-based JSON
        // serialization, so the signed bytes exactly match the TS signer.
        static string WriteFixedJson(Action<Utf8JsonWriter> write)
        {
            using var buffer = new MemoryStream();
            using (var writer = new Utf8JsonWriter(buffer)) { write(writer); writer.Flush(); }
            return Encoding.UTF8.GetString(buffer.ToArray());
        }
        var canonical = MainBSignatureDomain + WriteFixedJson(writer =>
        {
            writer.WriteStartObject();
            writer.WriteNumber("schemaVersion", 1);
            writer.WriteString("channel", "main");
            writer.WriteString("previousSourceSha", aSha);
            writer.WriteString("sourceSha", bSha);
            writer.WriteString("target", target);
            writer.WriteString("runtimeContractSha256", signed.GetProperty("runtimeContractSha256").GetString());
            writer.WritePropertyName("artifact");
            writer.WriteStartObject();
            writer.WriteString("sha256", artifact.GetProperty("sha256").GetString());
            writer.WriteNumber("bytes", artifact.GetProperty("bytes").GetInt64());
            writer.WriteEndObject();
            writer.WritePropertyName("releaseFingerprint");
            writer.WriteStartObject();
            writer.WriteString("sha256", fingerprint.GetProperty("sha256").GetString());
            writer.WriteNumber("entries", fingerprint.GetProperty("entries").GetInt64());
            writer.WriteNumber("bytes", fingerprint.GetProperty("bytes").GetInt64());
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
        var verificationStdin = WriteFixedJson(writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("payload", canonical);
            writer.WriteString("signature", base64);
            writer.WriteEndObject();
        });
        // Original Main A + native B source Git/fingerprint are checked by the
        // *native OS owner* independently of any updater/worker callback.
        InspectOwnedTargetMainSource();
        InspectionPhase = "native-b-original-a-pinned-crypto";
        var node = ResolveOwnedMainWorkerNodePath(install, target);
        RequireNormalFile(node);
        var psi = new ProcessStartInfo(node)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            WorkingDirectory = install,
        };
        // Keep only the inherited product-neutral OS environment; no dynamic
        // B module loader, Node injection, ambient PATH, network or scripts.
        foreach (var name in psi.Environment.Keys.Where(name => name.StartsWith("NODE_", StringComparison.OrdinalIgnoreCase) ||
            name.Equals("PATH", StringComparison.OrdinalIgnoreCase)).ToArray()) psi.Environment.Remove(name);
        psi.ArgumentList.Add("--no-warnings");
        psi.ArgumentList.Add("-e");
        psi.ArgumentList.Add(MainBVerifyScript);
        using var child = Process.Start(psi) ?? throw new IOException("Original Main A pinned Ed25519 verifier did not start.");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(12));
        try
        {
            var stdin = child.StandardInput.WriteAsync(verificationStdin);
            stdin.WaitAsync(timeout.Token).GetAwaiter().GetResult();
            child.StandardInput.Close();
            var stdout = child.StandardOutput.ReadToEndAsync();
            var stderr = child.StandardError.ReadToEndAsync();
            child.WaitForExitAsync(timeout.Token).GetAwaiter().GetResult();
            var result = stdout.WaitAsync(timeout.Token).GetAwaiter().GetResult();
            var error = stderr.WaitAsync(timeout.Token).GetAwaiter().GetResult();
            if (child.ExitCode != 0 || result != "VERIFIED\n" || error.Length != 0)
                throw new InvalidDataException("Native Guardian rejected signed B production Ed25519 authorization.");
        }
        catch
        {
            if (!child.HasExited) child.Kill(entireProcessTree: true);
            throw;
        }
        InspectionPhase = "native-b-signed-audited-no-stage-authorization";
        // NO journal stage/lease, NativeMessaging registry, pointer or WPF
        // changes here. The live owner still needs a separate stage protocol.
    }
}
