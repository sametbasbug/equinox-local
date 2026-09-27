using System.IO.Pipes;
using System.Text;

namespace EquinoxLocal.WindowsShell;

internal sealed class SingleInstanceCoordinator : IDisposable
{
    private const string MutexName = @"Local\EquinoxLocal.WindowsShell.SingleInstance";
    private const string PipeName = "EquinoxLocal.WindowsShell.Reopen";
    private readonly Mutex _mutex = new(false, MutexName);
    private readonly CancellationTokenSource _shutdown = new();
    private Task? _listener;
    private bool _ownsMutex;

    internal SingleInstanceCoordinator()
    {
        try
        {
            _ownsMutex = _mutex.WaitOne(0, false);
        }
        catch (AbandonedMutexException)
        {
            _ownsMutex = true;
        }
    }

    internal bool IsPrimary => _ownsMutex;

    internal event EventHandler? ReopenRequested;

    internal void StartListening()
    {
        if (!IsPrimary || _listener is not null) return;
        _listener = Task.Run(() => ListenLoopAsync(_shutdown.Token));
    }

    internal async Task SignalPrimaryAsync()
    {
        using var client = new NamedPipeClientStream(
            ".",
            PipeName,
            PipeDirection.Out,
            PipeOptions.Asynchronous);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await client.ConnectAsync(timeout.Token).ConfigureAwait(false);
        await using var writer = new StreamWriter(client, new UTF8Encoding(false), leaveOpen: true)
        {
            AutoFlush = true,
        };
        await writer.WriteLineAsync("reopen").ConfigureAwait(false);
    }

    private async Task ListenLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await using var server = new NamedPipeServerStream(
                    PipeName,
                    PipeDirection.In,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await server.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
                using var reader = new StreamReader(server, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, leaveOpen: true);
                var command = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
                if (string.Equals(command, "reopen", StringComparison.Ordinal))
                {
                    ReopenRequested?.Invoke(this, EventArgs.Empty);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (IOException) when (!cancellationToken.IsCancellationRequested)
            {
                await Task.Delay(100, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    public void Dispose()
    {
        _shutdown.Cancel();
        if (_ownsMutex)
        {
            _mutex.ReleaseMutex();
            _ownsMutex = false;
        }
        _mutex.Dispose();
        _shutdown.Dispose();
    }
}
