import http from "node:http";

const PORT = 47850;

const sourcePage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Equinox Popup Fixture</title></head>
<body>
  <h1>Equinox Popup Fixture</h1>
  <button id="popup">Open popup window</button>
  <button id="tab">Open new tab</button>
  <div id="status">Ready</div>
  <script>
    document.querySelector('#popup').addEventListener('click', () => {
      const child = window.open('/child?kind=popup', 'equinox-popup-fixture', 'popup,width=520,height=420');
      document.querySelector('#status').textContent = child ? 'Popup requested' : 'Popup blocked';
    });
    document.querySelector('#tab').addEventListener('click', () => {
      const child = window.open('/child?kind=tab', '_blank');
      document.querySelector('#status').textContent = child ? 'Tab requested' : 'Tab blocked';
    });
  </script>
</body></html>`;

const childPage = (kind) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Equinox ${kind}</title></head>
<body><h1>${kind === 'popup' ? 'Popup child' : 'New tab child'}</h1><p id="kind">${kind}</p></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/child') {
    res.end(childPage(url.searchParams.get('kind') || 'unknown'));
    return;
  }
  res.end(sourcePage);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`POPUP_FIXTURE_READY http://127.0.0.1:${PORT}/`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
