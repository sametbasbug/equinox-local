using Microsoft.Win32;
using System.Text.Json;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const string NativeMessagingHost = "dev.equinox.browser";
    private const string NativeMessagingRegistrySubkey =
        @"Software\Google\Chrome\NativeMessagingHosts\dev.equinox.browser";
    private const string ExpectedChromeOrigin = "chrome-extension://npdneefcobilfkjlihghjgjnknenhfoj/";
    private const string ExpectedBridgeDescription = "Equinox Browser native messaging bridge";

    // Read-only Chrome Native Messaging ownership verification. Only the
    // current user's 64-bit native HKCU view and the SHA-addressed immutable
    // Main native release may own this bridge. No registry/manifest mutation.
    private static void InspectOwnedMainNativeMessaging(string install, string selectedRelease)
    {
        InspectionPhase = "main-native-messaging-owner";
        var browserRoot = Path.Combine(install, "browser");
        var manifestRoot = Path.Combine(browserRoot, "native-messaging");
        var manifestPath = Path.Combine(manifestRoot, NativeMessagingHost + ".json");
        RequireNormalDirectory(browserRoot);
        RequireNormalDirectory(manifestRoot);
        RequireNormalFile(manifestPath);

        using var registry = Registry.CurrentUser.OpenSubKey(NativeMessagingRegistrySubkey, writable: false);
        if (registry is null || registry.GetValueKind("") != RegistryValueKind.String ||
            registry.GetValue("", null, RegistryValueOptions.DoNotExpandEnvironmentNames) is not string registered ||
            !Path.IsPathFullyQualified(registered) ||
            !Compare.Equals(Path.GetFullPath(registered), Path.GetFullPath(manifestPath)))
            throw new InvalidDataException("Chrome Native Messaging registry has a foreign or missing owner.");

        InspectionPhase = "main-native-messaging-manifest";
        using var manifestDoc = ReadJson(manifestPath, 16 * 1024);
        var manifest = manifestDoc.RootElement;
        RequireExactKeys(manifest, ["name", "description", "path", "type", "allowed_origins"]);
        if (manifest.GetProperty("name").GetString() != NativeMessagingHost ||
            manifest.GetProperty("description").GetString() != ExpectedBridgeDescription ||
            manifest.GetProperty("type").GetString() != "stdio")
            throw new InvalidDataException("Chrome Native Messaging manifest identity is foreign.");
        var origins = manifest.GetProperty("allowed_origins");
        if (origins.ValueKind != JsonValueKind.Array || origins.GetArrayLength() != 1 ||
            origins[0].GetString() != ExpectedChromeOrigin)
            throw new InvalidDataException("Chrome Native Messaging extensions differ from the owned store ID.");
        var launcher = manifest.GetProperty("path").GetString();
        var expectedLauncher = Path.Combine(selectedRelease, "runtime", "browser", "equinox-browser-native-host.exe");
        if (string.IsNullOrWhiteSpace(launcher) || !Path.IsPathFullyQualified(launcher) ||
            !Compare.Equals(Path.GetFullPath(launcher), Path.GetFullPath(expectedLauncher)))
            throw new InvalidDataException("Chrome Native Messaging launcher is outside its exact native Main slot.");

        InspectionPhase = "main-native-messaging-launcher";
        RequireNormalDirectory(Path.Combine(selectedRelease, "runtime", "browser"));
        RequireNormalFile(expectedLauncher);
    }
}
