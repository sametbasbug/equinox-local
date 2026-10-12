import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloadVerifiedPinnedWindowsDependency } from '../../scripts/release/package-managed-release-windows.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinned-win-download-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const data = Buffer.from('pinned archive byte-level fixture');
  return { root, data, digest: createHash('sha256').update(data).digest('hex') };
}

test('HTTP 500/503 retries preserve same signed URL, signal, and byte digest', async t => {
  const f = await fixture(t);
  const calls = [], waits = [];
  const url = 'https://nodejs.org/dist/verified.zip';
  const result = await downloadVerifiedPinnedWindowsDependency(url, path.join(f.root, 'good.zip'), f.digest, {
    fetchImpl: async (requested, options) => {
      calls.push({ requested, options });
      return calls.length < 3 ? new Response('unavailable', { status: calls.length === 1 ? 500 : 503 }) : new Response(f.data);
    },
    retryDelayImpl: async ms => { waits.push(ms); },
  });
  assert.deepEqual(waits, [300, 900]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.requested === url && c.options.method === 'GET' && c.options.redirect === 'follow'));
  assert.equal(new Set(calls.map(c => c.options.signal)).size, 1);
  assert.equal(result.sha256, f.digest);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'good.zip')), f.data);
  assert.deepEqual(await fs.readdir(f.root), ['good.zip']);
});

test('persistent HTTP 500 fails closed after two bounded retries', async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(downloadVerifiedPinnedWindowsDependency('https://nodejs.org/fail.zip', path.join(f.root, 'fail.zip'), f.digest, {
    fetchImpl: async () => { calls++; return new Response('error', { status: 500 }); },
    retryDelayImpl: async () => {},
  }), /HTTP 500/u);
  assert.equal(calls, 3);
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('HTTP 403/404 and signed SHA mismatches never retry or leave partial archives', async t => {
  const f = await fixture(t);
  for (const [name, status, digest, expected] of [
    ['forbidden', 403, f.digest, /HTTP 403/u],
    ['missing', 404, f.digest, /HTTP 404/u],
    ['digest', 200, 'b'.repeat(64), /SHA-256 verification failed/u],
  ]) {
    let calls = 0;
    const target = path.join(f.root, `${name}.zip`);
    await assert.rejects(downloadVerifiedPinnedWindowsDependency('https://nodejs.org/verified.zip', target, digest, {
      fetchImpl: async () => { calls++; return status === 200 ? new Response(f.data) : new Response('not available', { status }); },
      retryDelayImpl: () => assert.fail('must never retry an untrusted response'),
    }), expected);
    assert.equal(calls, 1);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  }
  assert.deepEqual(await fs.readdir(f.root), []);
});

test('one absolute timeout covers network retry delay and refuses re-fetch', async t => {
  const f = await fixture(t);
  let calls = 0;
  await assert.rejects(downloadVerifiedPinnedWindowsDependency('https://nodejs.org/archive.zip', path.join(f.root, 'expired.zip'), f.digest, {
    timeoutMs: 15,
    fetchImpl: async () => { calls++; return new Response('down', { status: 503 }); },
  }), /AbortError|abort/u);
  assert.equal(calls, 1);
  assert.deepEqual(await fs.readdir(f.root), []);
});
