import assert from "node:assert/strict";

if (process.platform !== "win32" || !["x64", "arm64"].includes(process.arch)) {
  throw new Error(`Windows node-pty smoke requires native Windows x64/ARM64; got ${process.platform}-${process.arch}.`);
}

const module = await import("node-pty");
const spawn = module.spawn ?? module.default?.spawn;
assert.equal(typeof spawn, "function", "node-pty spawn is unavailable");

const terminal = spawn("powershell.exe", ["-NoLogo", "-NoProfile"], {
  name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env, useConpty: true,
});
let output = "";
const completed = new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    terminal.kill();
    reject(new Error("Windows node-pty/ConPTY smoke timed out."));
  }, 10_000);
  terminal.onData((data) => { output += data; });
  terminal.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 ? resolve() : reject(new Error(`Windows node-pty host exited ${exitCode}.`)); });
});
terminal.write('Write-Output "__EQUINOX_CONPTY_OK__"; exit\r');
await completed;
assert.match(output, /__EQUINOX_CONPTY_OK__/u);
process.stdout.write(`${JSON.stringify({ ok: true, platform: process.platform, arch: process.arch, conpty: true }, null, 2)}\n`);
