using System.Net;
using System.Net.Http;
using System.Text;
using EquinoxLocal.WindowsShell;

var requests = new List<HttpRequestMessage>();
var setupHandler = new StubHandler(requests, """
{"ok":true,"status":{"presentation":{"state":"setup_required","label":"Setup Required","detail":"Open Control Center to finish first-time setup"}}}
""");
using (var monitor = new ShellPresentationMonitor(setupHandler))
{
    var setup = await monitor.ProbeOnceAsync();
    if (setup.State != ShellPresentationState.SetupRequired || setup.Label != "Setup Required")
        throw new InvalidOperationException("shared setup-required presentation was not preserved");
    if (!setup.Detail.Contains("Control Center", StringComparison.Ordinal))
        throw new InvalidOperationException("setup detail was not preserved");
}

if (requests.Count != 1 || requests[0].RequestUri?.AbsolutePath != "/api/v1/status")
    throw new InvalidOperationException("native presentation monitor did not use the shared status endpoint");
if (!requests[0].Headers.TryGetValues("X-Equinox-Background-Refresh", out var values) || values.SingleOrDefault() != "1")
    throw new InvalidOperationException("native presentation polling did not mark background refresh");

using (var monitor = new ShellPresentationMonitor(new StubHandler([], """
{"ok":true,"status":{"presentation":{"state":"working","label":"Working","detail":"1 managed operation active"}}}
""")))
{
    var working = await monitor.ProbeOnceAsync();
    if (working.State != ShellPresentationState.Working || working.Detail != "1 managed operation active")
        throw new InvalidOperationException("working presentation was not preserved");
}

using (var monitor = new ShellPresentationMonitor(new StubHandler([], "{}", HttpStatusCode.ServiceUnavailable)))
{
    var offline = await monitor.ProbeOnceAsync();
    if (offline.State != ShellPresentationState.Offline)
        throw new InvalidOperationException("unavailable runtime did not fail closed to Offline");
}

using (var monitor = new ShellPresentationMonitor(new StubHandler([], """
{"ok":true,"status":{"presentation":{"state":"future_unknown","label":"Mystery","detail":"Unknown state"}}}
""")))
{
    var unknown = await monitor.ProbeOnceAsync();
    if (unknown.State != ShellPresentationState.Offline)
        throw new InvalidOperationException("unknown presentation state did not fail closed");
}

Console.WriteLine("WINDOWS_SHELL_PRESENTATION_PASS");

sealed class StubHandler(List<HttpRequestMessage> requests, string body, HttpStatusCode statusCode = HttpStatusCode.OK) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var clone = new HttpRequestMessage(request.Method, request.RequestUri);
        foreach (var header in request.Headers) clone.Headers.TryAddWithoutValidation(header.Key, header.Value);
        requests.Add(clone);
        return Task.FromResult(new HttpResponseMessage(statusCode)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        });
    }
}
