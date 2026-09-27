using System.Net;
using System.Net.Http;

namespace EquinoxLocal.WindowsShell;

internal enum RuntimeHealthState
{
    Starting,
    Healthy,
    Unavailable,
}

internal sealed record RuntimeHealthSnapshot(RuntimeHealthState State, string Detail)
{
    internal static RuntimeHealthSnapshot Starting() => new(RuntimeHealthState.Starting, "Checking runtime");
    internal static RuntimeHealthSnapshot Healthy() => new(RuntimeHealthState.Healthy, "Runtime healthy");
    internal static RuntimeHealthSnapshot Unavailable() => new(RuntimeHealthState.Unavailable, "Runtime unavailable");
}

internal sealed class RuntimeStatusMonitor : IDisposable
{
    private static readonly Uri HealthUri = new("http://127.0.0.1:24891/api/v1/health", UriKind.Absolute);
    private static readonly TimeSpan ProbeInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(1);

    private readonly HttpClient _client;
    private readonly CancellationTokenSource _shutdown = new();
    private Task? _loop;
    private RuntimeHealthSnapshot _current = RuntimeHealthSnapshot.Starting();

    internal RuntimeStatusMonitor(HttpMessageHandler? handler = null)
    {
        _client = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: true);
        _client.Timeout = ProbeTimeout;
    }

    internal RuntimeHealthSnapshot Current => _current;

    internal event EventHandler<RuntimeHealthSnapshot>? StatusChanged;

    internal void Start()
    {
        if (_loop is not null) return;
        _loop = Task.Run(() => MonitorLoopAsync(_shutdown.Token));
    }

    internal async Task<RuntimeHealthSnapshot> ProbeOnceAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, HealthUri);
            using var response = await _client.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken).ConfigureAwait(false);
            return response.StatusCode == HttpStatusCode.OK
                ? RuntimeHealthSnapshot.Healthy()
                : RuntimeHealthSnapshot.Unavailable();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            return RuntimeHealthSnapshot.Unavailable();
        }
    }

    private async Task MonitorLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            RuntimeHealthSnapshot next;
            try
            {
                next = await ProbeOnceAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }

            if (next != _current)
            {
                _current = next;
                StatusChanged?.Invoke(this, next);
            }

            try
            {
                await Task.Delay(ProbeInterval, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
        }
    }

    public void Dispose()
    {
        _shutdown.Cancel();
        _client.Dispose();
        _shutdown.Dispose();
    }
}
