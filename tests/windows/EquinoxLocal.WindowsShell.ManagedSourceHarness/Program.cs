using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.Json;
using EquinoxLocal.WindowsShell;

var repo = Environment.CurrentDirectory;
var nodeSource = Environment.GetEnvironmentVariable("EQUINOX_TEST_NODE_EXE");
if (string.IsNullOrWhiteSpace(nodeSource) || !File.Exists(nodeSource))
    throw new InvalidOperationException("EQUINOX_TEST_NODE_EXE is required.");

var target = RuntimeInformation.ProcessArchitecture switch
{
    Architecture.X64 => "win32-x64",
    Architecture.Arm64 => "win32-arm64",
    _ => throw new PlatformNotSupportedException($"Unsupported Windows test architecture: {RuntimeInformation.ProcessArchitecture}."),
};
var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
if (string.IsNullOrWhiteSpace(localAppData))
    throw new InvalidOperationException("LocalAppData is unavailable.");
var installRoot = Path.GetFullPath(Path.Combine(localAppData, "Equinox Local"));
if (Directory.Exists(installRoot) || File.Exists(installRoot))
    throw new InvalidOperationException("Managed-source acceptance refuses to touch an existing Equinox Local installation.");

var stableVersion = "5.2.0";
var nativeVersion = "5.2.1";
var sourceA = new string('1', 40);
var sourceB = new string('2', 40);
var digestB = new string('b', 64);
var releasesRoot = Path.Combine(installRoot, "releases");
var stableRelease = Path.Combine(releasesRoot, stableVersion);
var transactionRoot = Path.Combine(installRoot, "state", "main-update");
var sourceRootA = Path.Combine(transactionRoot, "sources", sourceA);
var sourceRootB = Path.Combine(transactionRoot, "sources", sourceB);
var nativePayloadRoot = Path.Combine(transactionRoot, "native-store", target, sourceB);
var nativeRelease = Path.Combine(nativePayloadRoot, "release");
var sourcePointerPath = Path.Combine(transactionRoot, "current-source.conf");
var nativePointerPath = Path.Combine(transactionRoot, "current-native.json");

var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
var port = ((IPEndPoint)listener.LocalEndpoint).Port;
listener.Stop();

var previousPort = Environment.GetEnvironmentVariable("EQUINOX_TEST_MANAGED_SOURCE_PORT");
var previousRelease = Environment.GetEnvironmentVariable("EQUINOX_LOCAL_RELEASE_DIR");
Environment.SetEnvironmentVariable("EQUINOX_TEST_MANAGED_SOURCE_PORT", port.ToString());
Environment.SetEnvironmentVariable("EQUINOX_LOCAL_RELEASE_DIR", null);

RuntimeSupervisor? supervisor = null;
try
{
    Directory.CreateDirectory(transactionRoot);
    await WriteRuntimeReleaseAsync(stableRelease, stableVersion, target, nodeSource, repo);
    await WriteSourceAsync(sourceRootA, "A");
    await WriteSourceAsync(sourceRootB, "B");

    await File.WriteAllTextAsync(
        Path.Combine(installRoot, "current-version.json"),
        JsonSerializer.Serialize(new { schemaVersion = 1, target, version = stableVersion }) + "\n");
    await File.WriteAllTextAsync(
        Path.Combine(transactionRoot, "install.json"),
        JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            channel = "main",
            repository = "sametbasbug/equinox-local",
            branch = "main",
            bootstrapSha = sourceA,
        }) + "\n");
    await WriteSourcePointerAsync(sourcePointerPath, sourceRootA, sourceA);

    AssertLocation(
        WindowsManagedSourceRuntimeLocator.Resolve(),
        stableRelease,
        sourceRootA,
        stableRelease,
        installRoot,
        "initial");

    supervisor = RuntimeSupervisor.TryCreateFromEnvironmentOrManagedInstall()
        ?? throw new InvalidOperationException("Managed-source RuntimeSupervisor was not created.");
    await supervisor.StartAsync();
    await WaitForIdentityAsync(port, "A", Path.Combine(stableRelease, "runtime", "node", "bin", "node.exe"), sourceRootA, "initial");

    // reuse_native: source advances, native runtime deliberately remains on the Stable baseline.
    await WriteSourcePointerAsync(sourcePointerPath, sourceRootB, sourceB);
    AssertLocation(
        WindowsManagedSourceRuntimeLocator.Resolve(),
        stableRelease,
        sourceRootB,
        stableRelease,
        installRoot,
        "reuse_native");
    await supervisor.RestartAsync();
    await WaitForIdentityAsync(port, "B", Path.Combine(stableRelease, "runtime", "node", "bin", "node.exe"), sourceRootB, "reuse_native");

    // artifact_required: admitted native state advances independently from the source pointer.
    await WriteRuntimeReleaseAsync(nativeRelease, nativeVersion, target, nodeSource, repo);
    Directory.CreateDirectory(nativePayloadRoot);
    await File.WriteAllTextAsync(
        Path.Combine(nativePayloadRoot, "native-store.json"),
        JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            channel = "main",
            sourceSha = sourceB,
            target,
            runtimeContractSha256 = digestB,
            artifactSha256 = new string('d', 64),
            artifactBytes = 1,
            payloadVersion = nativeVersion,
            releaseFingerprint = new
            {
                schemaVersion = 1,
                sha256 = new string('e', 64),
                entries = 1,
                bytes = 1,
            },
        }) + "\n");
    await File.WriteAllTextAsync(
        nativePointerPath,
        JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            channel = "main",
            sourceSha = sourceB,
            target,
            runtimeContractSha256 = digestB,
        }) + "\n");
    AssertLocation(
        WindowsManagedSourceRuntimeLocator.Resolve(),
        nativeRelease,
        sourceRootB,
        stableRelease,
        installRoot,
        "artifact_required");
    await supervisor.RestartAsync();
    await WaitForIdentityAsync(port, "B", Path.Combine(nativeRelease, "runtime", "node", "bin", "node.exe"), sourceRootB, "artifact_required");

    // Rollback restores both source and native identity to the Stable baseline.
    File.Delete(nativePointerPath);
    await WriteSourcePointerAsync(sourcePointerPath, sourceRootA, sourceA);
    AssertLocation(
        WindowsManagedSourceRuntimeLocator.Resolve(),
        stableRelease,
        sourceRootA,
        stableRelease,
        installRoot,
        "rollback");
    await supervisor.RestartAsync();
    await WaitForIdentityAsync(port, "A", Path.Combine(stableRelease, "runtime", "node", "bin", "node.exe"), sourceRootA, "rollback");

    await supervisor.StopAsync();
    Console.WriteLine($"WINDOWS_MANAGED_SOURCE_ACCEPTANCE_PASS target={target}");
}
finally
{
    if (supervisor is not null)
    {
        try { await supervisor.DisposeAsync(); } catch { }
    }
    Environment.SetEnvironmentVariable("EQUINOX_TEST_MANAGED_SOURCE_PORT", previousPort);
    Environment.SetEnvironmentVariable("EQUINOX_LOCAL_RELEASE_DIR", previousRelease);
    try { if (Directory.Exists(installRoot)) Directory.Delete(installRoot, recursive: true); } catch { }
}

static async Task WriteRuntimeReleaseAsync(string releaseDir, string version, string target, string nodeSource, string repo)
{
    var nodeDir = Path.Combine(releaseDir, "runtime", "node", "bin");
    Directory.CreateDirectory(nodeDir);
    File.Copy(nodeSource, Path.Combine(nodeDir, "node.exe"), overwrite: false);
    File.Copy(Path.Combine(repo, "src", "equinox-local-windows-job-object.ps1"), Path.Combine(releaseDir, "equinox-local-windows-job-object.ps1"), overwrite: false);
    File.Copy(Path.Combine(repo, "src", "equinox-local-windows-process-gate.ps1"), Path.Combine(releaseDir, "equinox-local-windows-process-gate.ps1"), overwrite: false);
    await File.WriteAllTextAsync(
        Path.Combine(releaseDir, "release.json"),
        JsonSerializer.Serialize(new { schemaVersion = 1, version, target, serverEntry = "server.js" }) + "\n");
    await File.WriteAllTextAsync(Path.Combine(releaseDir, "server.js"), "setInterval(() => {}, 1000);\n");
}

static async Task WriteSourceAsync(string sourceRoot, string marker)
{
    var srcRoot = Path.Combine(sourceRoot, "src");
    Directory.CreateDirectory(srcRoot);
    Directory.CreateDirectory(Path.Combine(sourceRoot, "node_modules"));
    await File.WriteAllTextAsync(
        Path.Combine(sourceRoot, "package.json"),
        JsonSerializer.Serialize(new { name = "equinox-managed-source-acceptance", type = "module" }) + "\n");
    var markerJson = JsonSerializer.Serialize(marker);
    var server =
        "import http from 'node:http';\n" +
        $"const marker = {markerJson};\n" +
        "const port = Number(process.env.EQUINOX_TEST_MANAGED_SOURCE_PORT);\n" +
        "if (!Number.isInteger(port) || port < 1) throw new Error('fixture port missing');\n" +
        "const server = http.createServer((req, res) => {\n" +
        "  if (req.url !== '/identity') { res.writeHead(404); res.end(); return; }\n" +
        "  res.writeHead(200, {'content-type':'application/json'});\n" +
        "  res.end(JSON.stringify({marker, execPath: process.execPath, cwd: process.cwd()}));\n" +
        "});\n" +
        "server.listen(port, '127.0.0.1');\n";
    await File.WriteAllTextAsync(Path.Combine(srcRoot, "server.js"), server);
}

static Task WriteSourcePointerAsync(string pointerPath, string sourceRoot, string sha) =>
    File.WriteAllTextAsync(pointerPath, $"schemaVersion=1\nsourceRoot={sourceRoot}\nsha={sha}\n");

static void AssertLocation(
    WindowsRuntimeLocation location,
    string expectedNativeRelease,
    string expectedSourceRoot,
    string expectedBootstrapRelease,
    string expectedInstallRoot,
    string stage)
{
    if (!location.ManagedSource) throw new InvalidOperationException($"{stage}: runtime is not managed-source.");
    AssertPath(location.NativeReleaseDir, expectedNativeRelease, $"{stage}: native release");
    AssertPath(location.SourceRoot, expectedSourceRoot, $"{stage}: source root");
    AssertPath(location.ServerPath, Path.Combine(expectedSourceRoot, "src", "server.js"), $"{stage}: server path");
    AssertPath(location.BootstrapReleaseDir, expectedBootstrapRelease, $"{stage}: bootstrap release");
    AssertPath(location.InstallRoot, expectedInstallRoot, $"{stage}: install root");
}

static async Task WaitForIdentityAsync(int port, string marker, string nodePath, string sourceRoot, string stage)
{
    using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(750) };
    var deadline = DateTime.UtcNow.AddSeconds(15);
    Exception? lastError = null;
    while (DateTime.UtcNow < deadline)
    {
        try
        {
            using var response = await client.GetAsync($"http://127.0.0.1:{port}/identity");
            response.EnsureSuccessStatusCode();
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            var root = document.RootElement;
            var actualMarker = root.GetProperty("marker").GetString();
            var actualNode = root.GetProperty("execPath").GetString();
            var actualCwd = root.GetProperty("cwd").GetString();
            if (actualMarker == marker
                && actualNode is not null
                && actualCwd is not null
                && PathsEqual(actualNode, nodePath)
                && PathsEqual(actualCwd, sourceRoot))
            {
                Console.WriteLine($"WINDOWS_MANAGED_SOURCE_STAGE {stage} PASS");
                return;
            }
            throw new InvalidOperationException(
                $"{stage}: identity drift marker={actualMarker} node={actualNode} cwd={actualCwd}");
        }
        catch (Exception error)
        {
            lastError = error;
            await Task.Delay(100);
        }
    }
    throw new InvalidOperationException($"{stage}: runtime identity did not converge.", lastError);
}

static bool PathsEqual(string left, string right) =>
    string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);

static void AssertPath(string actual, string expected, string label)
{
    if (!PathsEqual(actual, expected))
        throw new InvalidOperationException($"{label} mismatch: expected {expected}, got {actual}");
}
