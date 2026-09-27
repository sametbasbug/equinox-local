using System.Net;
using System.Net.Http;
using System.Text.Json;

namespace EquinoxLocal.WindowsShell;

internal enum ShellPresentationState
{
    Connecting,
    SetupRequired,
    Idle,
    Working,
    Waiting,
    Success,
    NeedsAttention,
    EmergencyStopped,
    Offline,
}

internal sealed record ShellPresentationSnapshot(ShellPresentationState State, string Label, string Detail)
{
    internal static ShellPresentationSnapshot Connecting() => new(ShellPresentationState.Connecting, "Connecting", "Waiting for runtime");
    internal static ShellPresentationSnapshot Offline() => new(ShellPresentationState.Offline, "Offline", "Runtime unavailable");
}

internal sealed class ShellPresentationMonitor : IDisposable
{
    private const int MaxStatusBytes = 64 * 1024;
    private const int MaxLabelChars = 48;
    private const int MaxDetailChars = 160;
    private static readonly Uri StatusUri = new("http://127.0.0.1:24891/api/v1/status", UriKind.Absolute);
    private static readonly TimeSpan ProbeInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(1);

    private readonly HttpClient _client;
    private readonly CancellationTokenSource _shutdown = new();
    private Task? _loop;
    private ShellPresentationSnapshot _current = ShellPresentationSnapshot.Connecting();

    internal ShellPresentationMonitor(HttpMessageHandler? handler = null)
    {
        _client = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: true);
        _client.Timeout = ProbeTimeout;
    }

    internal ShellPresentationSnapshot Current => _current;

    internal event EventHandler<ShellPresentationSnapshot>? StatusChanged;

    internal void Start()
    {
        if (_loop is not null) return;
        _loop = Task.Run(() => MonitorLoopAsync(_shutdown.Token));
    }

    internal async Task<ShellPresentationSnapshot> ProbeOnceAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, StatusUri);
            request.Headers.TryAddWithoutValidation("X-Equinox-Background-Refresh", "1");
            using var response = await _client.SendAsync(
                request,
                HttpCompletionOption.ResponseHeadersRead,
                cancellationToken).ConfigureAwait(false);
            if (response.StatusCode != HttpStatusCode.OK) return ShellPresentationSnapshot.Offline();
            if (response.Content.Headers.ContentLength is long declared && declared > MaxStatusBytes)
                return ShellPresentationSnapshot.Offline();

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            using var body = new MemoryStream();
            var buffer = new byte[8192];
            while (true)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken).ConfigureAwait(false);
                if (read == 0) break;
                if (body.Length + read > MaxStatusBytes) return ShellPresentationSnapshot.Offline();
                body.Write(buffer, 0, read);
            }
            body.Position = 0;
            using var document = await JsonDocument.ParseAsync(body, cancellationToken: cancellationToken).ConfigureAwait(false);
            if (!document.RootElement.TryGetProperty("status", out var status)
                || !status.TryGetProperty("presentation", out var presentation))
                return ShellPresentationSnapshot.Offline();

            var rawState = presentation.TryGetProperty("state", out var stateElement) ? stateElement.GetString() : null;
            var state = ParseState(rawState);
            if (state is null) return ShellPresentationSnapshot.Offline();
            var fallbackLabel = LabelFor(state.Value);
            var label = BoundedText(presentation, "label", fallbackLabel, MaxLabelChars);
            var detail = BoundedText(presentation, "detail", fallbackLabel, MaxDetailChars);
            return new ShellPresentationSnapshot(state.Value, label, detail);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            return ShellPresentationSnapshot.Offline();
        }
    }

    private static ShellPresentationState? ParseState(string? value) => value switch
    {
        "setup_required" => ShellPresentationState.SetupRequired,
        "idle" => ShellPresentationState.Idle,
        "working" => ShellPresentationState.Working,
        "waiting" => ShellPresentationState.Waiting,
        "success" => ShellPresentationState.Success,
        "needs_attention" => ShellPresentationState.NeedsAttention,
        "emergency_stopped" => ShellPresentationState.EmergencyStopped,
        _ => null,
    };

    private static string LabelFor(ShellPresentationState state) => state switch
    {
        ShellPresentationState.SetupRequired => "Setup Required",
        ShellPresentationState.Working => "Working",
        ShellPresentationState.Waiting => "Waiting",
        ShellPresentationState.Success => "Completed",
        ShellPresentationState.NeedsAttention => "Needs Attention",
        ShellPresentationState.EmergencyStopped => "Emergency Stopped",
        ShellPresentationState.Idle => "Idle",
        ShellPresentationState.Offline => "Offline",
        _ => "Connecting",
    };

    private static string BoundedText(JsonElement source, string property, string fallback, int maxChars)
    {
        if (!source.TryGetProperty(property, out var element) || element.ValueKind != JsonValueKind.String)
            return fallback;
        var value = element.GetString()?.Trim() ?? string.Empty;
        if (value.Length == 0 || value.Any(char.IsControl)) return fallback;
        return value.Length <= maxChars ? value : value[..(maxChars - 1)] + "…";
    }

    private async Task MonitorLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            ShellPresentationSnapshot next;
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
