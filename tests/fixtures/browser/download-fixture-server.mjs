import http from "node:http";

const PORT = 47860;
const token = Date.now();
const filename = `equinox-browser-download-smoke-${token}.txt`;
const payload = Buffer.from("Equinox Browser download smoke\n", "utf8");

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Equinox Download Fixture</title></head><body>
<h1>Equinox Download Fixture</h1>
<a id="download" href="/download?token=${token}">Download fixture</a>
<div id="status">Ready</div>
<script>document.querySelector('#download').addEventListener('click',()=>{document.querySelector('#status').textContent='Download requested';});</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/download" && url.searchParams.get("token") === String(token)) {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": payload.length,
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    });
    res.end(payload);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(page);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
});
console.log(`DOWNLOAD_FIXTURE_READY http://127.0.0.1:${PORT}/ filename=${filename}`);

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
