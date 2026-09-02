import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  equinoxBrowserSocketDirectory,
  equinoxBrowserSocketPath,
  prepareEquinoxBrowserSocketDirectory,
} from "../../src/equinox-browser-socket.js";

test("browser socket path stays short, user-specific and supports isolated smoke namespaces", () => {
  const uid = 501;
  assert.equal(equinoxBrowserSocketDirectory({ uid }), "/tmp/equinox-local-501");
  assert.equal(equinoxBrowserSocketPath({ uid }), "/tmp/equinox-local-501/browser.sock");
  assert.equal(equinoxBrowserSocketPath({ uid, namespace: "smoke-123" }), "/tmp/equinox-local-501-smoke-123/browser.sock");
  assert.equal(Buffer.byteLength(equinoxBrowserSocketPath({ uid, namespace: "smoke-123" }), "utf8") < 100, true);
  assert.throws(() => equinoxBrowserSocketPath({ uid, namespace: "../unsafe" }), /namespace is invalid/u);
});

test("browser socket directory is private and owned by the current user", async (t) => {
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || uid < 1) return;
  const directory = equinoxBrowserSocketDirectory({ uid });
  await fs.rm(directory, { recursive: true, force: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  assert.equal(await prepareEquinoxBrowserSocketDirectory({ uid }), directory);
  const stat = await fs.lstat(directory);
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.uid, uid);
  assert.equal(stat.mode & 0o077, 0);
});

test("root or missing uid is rejected", async () => {
  assert.throws(() => equinoxBrowserSocketPath({ uid: 0 }), /non-root user id/u);
  await assert.rejects(
    prepareEquinoxBrowserSocketDirectory({ uid: 0 }),
    /non-root user id/u,
  );
});
