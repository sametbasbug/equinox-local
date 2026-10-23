using System.Diagnostics;
using System.Text;

namespace EquinoxLocal.Guardian;

internal static partial class Program
{
    private const string PinnedWindowsGit = "2.56.0-1";
    private const int MaxGitOutput = 8192;

    // Never execute ambient Git, a source-owned binary, an arbitrary program,
    // shell command or an untrusted Git alias. This is a read-only inspection
    // step, NOT independent authorization to launch Main.
    private static void InspectOwnedMainGit(string install, string target, string sourceRoot, string sourceSha)
    {
        InspectionPhase = "main-git-owner";
        var runtime = Path.Combine(install, "runtime");
        var toolchain = Path.Combine(runtime, "toolchain");
        var gitRoot = Path.Combine(toolchain, "git");
        var versionRoot = Path.Combine(gitRoot, PinnedWindowsGit);
        var targetRoot = Path.Combine(versionRoot, target);
        var cmdDir = Path.Combine(targetRoot, "cmd");
        foreach (var dir in new[] { runtime, toolchain, gitRoot, versionRoot, targetRoot, cmdDir })
            RequireNormalDirectory(dir);
        var gitExe = Path.Combine(cmdDir, "git.exe");
        RequireNormalFile(gitExe);

        InspectionPhase = "main-git-top-level";
        var topLevel = RunOwnedGit(gitExe, sourceRoot, "rev-parse", "--show-toplevel");
        if (!Compare.Equals(Path.GetFullPath(topLevel), Path.GetFullPath(sourceRoot)))
            throw new InvalidDataException("Main Git checkout is not its exact canonical root.");
        InspectionPhase = "main-git-head";
        if (RunOwnedGit(gitExe, sourceRoot, "rev-parse", "HEAD") != sourceSha)
            throw new InvalidDataException("Main Git HEAD changed from active source pointer.");
        InspectionPhase = "main-git-branch";
        if (RunOwnedGit(gitExe, sourceRoot, "symbolic-ref", "--quiet", "--short", "HEAD") != "main")
            throw new InvalidDataException("Main Git checkout is detached or on a foreign branch.");
        InspectionPhase = "main-git-remote";
        var remote = RunOwnedGit(gitExe, sourceRoot, "remote", "get-url", "origin");
        if (remote is not ("https://github.com/sametbasbug/equinox-local.git" or
            "https://github.com/sametbasbug/equinox-local" or
            "git@github.com:sametbasbug/equinox-local.git" or
            "ssh://git@github.com/sametbasbug/equinox-local.git"))
            throw new InvalidDataException("Main Git origin is outside the canonical repository.");
        InspectionPhase = "main-git-dirty";
        if (RunOwnedGit(gitExe, sourceRoot, "status", "--porcelain=v1", "--untracked-files=normal").Length != 0)
            throw new InvalidDataException("Main Git checkout has uncommitted or untracked changes.");
    }

    private static string RunOwnedGit(string executable, string sourceRoot, params string[] fixedArgs)
    {
        var start = new ProcessStartInfo(executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = sourceRoot,
        };
        foreach (var name in start.Environment.Keys.Where(name => name.StartsWith("GIT_", StringComparison.OrdinalIgnoreCase)).ToArray())
            start.Environment.Remove(name);
        start.Environment["GIT_OPTIONAL_LOCKS"] = "0";
        start.Environment["GIT_TERMINAL_PROMPT"] = "0";
        start.Environment["GIT_CONFIG_NOSYSTEM"] = "1";
        // Windows Git for Windows clones with CRLF conversion enabled by its
        // system config. We deliberately disable system config to avoid
        // untrusted machine hooks, so recreate the expected normalization
        // explicitly. Otherwise a legitimate hosted checkout looks like
        // hundreds of tracked edits when Git rereads CRLF working-tree files.
        // Command-line -c has higher precedence than repository configuration.
        foreach (var config in new[] { "core.autocrlf=true", "core.fsmonitor=false" })
        {
            start.ArgumentList.Add("-c");
            start.ArgumentList.Add(config);
        }
        start.ArgumentList.Add("-C");
        start.ArgumentList.Add(sourceRoot);
        foreach (var arg in fixedArgs) start.ArgumentList.Add(arg);
        using var git = Process.Start(start) ?? throw new IOException("Pinned Git executable could not start.");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        // Never stop consuming a redirected pipe when its output exceeds the
        // trust bound: Git can block forever on a full pipe before exiting.
        // Continue draining into a fixed buffer, record overflow and refuse
        // the response AFTER the process exits. No unbounded allocations.
        async Task<(string Text, bool Overflow)> ReadBounded(StreamReader reader)
        {
            var output = new StringBuilder();
            var buffer = new char[512];
            var overflow = false;
            while (true)
            {
                var count = await reader.ReadAsync(buffer.AsMemory(), timeout.Token);
                if (count == 0) break;
                if (output.Length + count > MaxGitOutput)
                {
                    overflow = true;
                    count = Math.Max(0, MaxGitOutput - output.Length);
                }
                if (count != 0) output.Append(buffer, 0, count);
            }
            return (output.ToString().Trim(), overflow);
        }
        var stdout = ReadBounded(git.StandardOutput);
        var stderr = ReadBounded(git.StandardError);
        try
        {
            git.WaitForExitAsync(timeout.Token).GetAwaiter().GetResult();
            var result = stdout.GetAwaiter().GetResult();
            var error = stderr.GetAwaiter().GetResult();
            if (result.Overflow || error.Overflow)
                throw new InvalidDataException("Pinned Git source status exceeded its strict output bound.");
            if (git.ExitCode != 0) throw new InvalidDataException("Pinned Git rejected Main source inspection.");
            return result.Text;
        }
        catch
        {
            if (!git.HasExited) git.Kill(entireProcessTree: true);
            throw;
        }
    }
}
