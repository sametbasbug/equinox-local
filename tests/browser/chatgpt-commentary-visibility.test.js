import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const script = await fs.readFile(path.resolve('extension/chatgpt-commentary-visibility.js'), 'utf8');
const url = 'https://chatgpt.com/backend-api/f/conversation';
const publicMessage = (overrides = {}) => ({
  id: 'public-commentary-4', author: { role: 'assistant' }, channel: 'commentary', recipient: 'all',
  content: { content_type: 'text', parts: ['İlerleme 4 🟢'] },
  metadata: { is_thinking_preamble_message: false, is_visually_hidden_from_conversation: true },
  ...overrides,
});
const sse = (data) => 'event: message\ndata: ' + JSON.stringify({ message: data }) + '\n\n';
const streamOf = (parts, onCancel) => new ReadableStream({
  start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); },
  cancel: onCancel,
});
const install = (responseFn) => {
  const window = { fetch: responseFn };
  vm.runInNewContext(script, { window, location: new URL('https://chatgpt.com/c/example'), URL, Request, Response,
    Headers, ReadableStream, TransformStream, TextDecoder, TextEncoder }, { filename: 'chatgpt-commentary-visibility.js' });
  return window.fetch;
};

test('SSE selectively unhides only confirmed public commentary, never analysis, preambles or other hidden messages', async () => {
  const privateAnalysis = publicMessage({ id: 'private-1', channel: 'analysis' });
  const preamble = publicMessage({ id: 'private-2', metadata: { is_thinking_preamble_message: true, is_visually_hidden_from_conversation: true } });
  const privateFlag = publicMessage({ id: 'private-3', metadata: { is_thinking_preamble_message: false, is_visually_hidden_from_conversation: true, is_visually_hidden: true } });
  const missingIdentity = publicMessage({ id: undefined });
  const missingChannel = publicMessage({ channel: undefined });
  const frames = [sse(privateAnalysis), sse(preamble), sse(privateFlag), sse(missingIdentity), sse(missingChannel), sse(publicMessage()), 'data: [DONE]\n\n'];
  const all = frames.join('');
  const split = all.indexOf('🟢');
  const raw = new TextEncoder().encode(all);
  const rawParts = [raw.slice(0,split), raw.slice(split,split+2), raw.slice(split+2)];
  const native = async () => new Response(new ReadableStream({ start(controller) { rawParts.forEach((part) => controller.enqueue(part)); controller.close(); } }),
    { headers: { 'content-type': 'text/event-stream', 'content-length': String(raw.length) } });
  const fetch = install(native);
  const response = await fetch(url, { method: 'POST' });
  assert.equal(response.headers.get('content-length'), null);
  const text = await response.text();
  const records = text.split('\n\n');
  for(let i=0;i<5;i++) assert.equal(records[i], frames[i].trimEnd());
  const changed = JSON.parse(records[5].split('data: ')[1]).message;
  assert.equal(changed.metadata.is_visually_hidden_from_conversation, false);
  assert.equal(changed.content.parts[0], 'İlerleme 4 🟢');
  assert.equal(records[6], 'data: [DONE]');
});

test('unrelated origins, methods, JSON responses and malformed SSE pass through unchanged', async () => {
  const malformed = 'data: {oops\n\n';
  const native = async () => new Response(streamOf([malformed]), { headers: { 'content-type': 'text/event-stream' } });
  const fetch = install(native);
  for (const [where, options] of [
    ['https://chatgpt.com/backend-api/conversation', { method: 'POST' }],
    ['https://example.org/backend-api/f/conversation', { method: 'POST' }],
    [url, { method: 'GET' }],
  ]) assert.equal((await fetch(where, options)).body instanceof ReadableStream, true);
  assert.equal(await (await fetch(url, { method: 'POST' })).text(), malformed);
  const json = install(async () => new Response(JSON.stringify({ message: publicMessage() }), { headers: { 'content-type': 'application/json' } }));
  const unchanged = await json(url, { method: 'POST' });
  assert.equal((await unchanged.json()).message.metadata.is_visually_hidden_from_conversation, true);
});

test('five public commentary events survive arbitrarily fragmented SSE and final event', async () => {
  const body = Array.from({ length: 5 }, (_, i) => sse(publicMessage({ id: `progress-${i + 1}`, content: { content_type: 'text', parts: [`KONTROL${i + 1}`] } }))).join('') + 'data: [DONE]\n\n';
  const bytes = new TextEncoder().encode(body);
  const native = async () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
  const result = await (await install(native)(url, { method: 'POST' })).text();
  assert.equal((result.match(/"is_visually_hidden_from_conversation":false/g) || []).length, 5);
  for(let i=1;i<=5;i++) assert.ok(result.includes(`KONTROL${i}`));
  assert.ok(result.endsWith('data: [DONE]\n\n'));
});

test('SSE cancellation stops the original response reader; CRLF and unknown events remain intact', async () => {
  let cancelled = false;
  const untouched = 'event: internal\r\ndata: {"metadata":{"is_visually_hidden_from_conversation":true}}\r\n\r\n';
  const target = sse(publicMessage({ id: 'progress-last' })).replaceAll('\n','\r\n');
  const native = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(untouched + target)); },
    cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/event-stream' } });
  const response = await install(native)(url, { method: 'POST' });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(first, untouched, 'unrelated event remains byte-for-byte the same');
  await reader.cancel('user aborted generation');
  assert.equal(cancelled, true, 'the underlying fetch body receives cancellation');
});
