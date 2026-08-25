import http from "node:http";

const MAIN_PORT = 47840;
const CROSS_PORT = 47841;

const html = (body, script = "") => `<!doctype html>
<html><head><meta charset="utf-8"><title>Equinox Frame Fixture</title></head>
<body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

const mainPage = html(`
  <h1>Equinox Frame Fixture</h1>
  <div id="parent-status" role="status">Parent waiting</div>
  <iframe id="same-frame" title="Same origin fixture" src="/same"></iframe>
  <iframe id="cross-frame" title="Cross origin fixture" src="http://localhost:${CROSS_PORT}/cross"></iframe>
`, `
  window.addEventListener('message', (event) => {
    if (!event.data || event.data.type !== 'fixture-click') return;
    document.querySelector('#parent-status').textContent = event.data.message;
  });
`);

const samePage = html(`
  <h2>Same origin child</h2>
  <label>Same value <input id="same-input" aria-label="Same frame input"></label>
  <button id="same-button">Same frame button</button>
`, `
  document.querySelector('#same-button').addEventListener('click', () => {
    parent.postMessage({ type: 'fixture-click', message: 'Same clicked: ' + document.querySelector('#same-input').value }, '*');
  });
`);

const crossPage = html(`
  <h2>Cross origin child</h2>
  <label>Cross value <input id="cross-input" aria-label="Cross frame input"></label>
  <button id="cross-button">Cross frame button</button>
`, `
  document.querySelector('#cross-button').addEventListener('click', () => {
    parent.postMessage({ type: 'fixture-click', message: 'Cross clicked: ' + document.querySelector('#cross-input').value }, '*');
  });
`);

function respond(res, body) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "cross-origin-resource-policy": "cross-origin",
  });
  res.end(body);
}

const mainServer = http.createServer((req, res) => {
  if (String(req.url || "").startsWith("/same")) return respond(res, samePage);
  return respond(res, mainPage);
});
const crossServer = http.createServer((_req, res) => respond(res, crossPage));

await Promise.all([
  new Promise((resolve, reject) => {
    mainServer.once("error", reject);
    mainServer.listen(MAIN_PORT, "127.0.0.1", resolve);
  }),
  new Promise((resolve, reject) => {
    crossServer.once("error", reject);
    crossServer.listen(CROSS_PORT, "127.0.0.1", resolve);
  }),
]);

console.log(`FRAME_FIXTURE_READY http://127.0.0.1:${MAIN_PORT}/ cross=http://localhost:${CROSS_PORT}/cross`);

const shutdown = () => {
  Promise.all([
    new Promise((resolve) => mainServer.close(() => resolve())),
    new Promise((resolve) => crossServer.close(() => resolve())),
  ]).finally(() => process.exit(0));
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
