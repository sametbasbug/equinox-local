import http from "node:http";

const PORT = 47870;

function pdfBuffer() {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    "4 0 obj\n<< /Length 56 >>\nstream\nBT /F1 18 Tf 40 110 Td (Equinox PDF Fixture) Tj ET\nendstream\nendobj\n",
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n`;
  body += "0000000000 65535 f \n";
  for (let index = 1; index <= objects.length; index += 1) {
    body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

const pdf = pdfBuffer();

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  if (url.pathname === "/fixture.pdf") {
    response.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.length),
      "Cache-Control": "no-store",
    });
    response.end(pdf);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  response.end("<!doctype html><meta charset=utf-8><title>Equinox Restricted Fixture</title><h1>Equinox Restricted Fixture</h1><a href='/fixture.pdf'>Open PDF</a>");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`RESTRICTED_FIXTURE_READY http://127.0.0.1:${PORT}/`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
