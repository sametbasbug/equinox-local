#!/usr/bin/env node
// eqlocal: agent-first client for the already running Equinox Local runtime.
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const HELP = `eqlocal — Equinox Local agent CLI (JSON output by default)

  eqlocal status
  eqlocal tools list [domain]
  eqlocal tools describe domain.operation
  eqlocal call domain.operation [--args JSON | --args-file PATH]
  eqlocal tasks list [--status active|completed|cancelled] [--limit N]
  eqlocal tasks read TASK_ID
  eqlocal tasks create --objective TEXT [--title TEXT]
  eqlocal tasks finish|cancel TASK_ID
  eqlocal chat start --task TASK_ID [--wait]
  eqlocal chat send --task TASK_ID --message TEXT [--agent NAME] [--request-id ID] [--wait]
  eqlocal chat read|wait --task TASK_ID --receipt JSON [--timeout SECONDS]

  --json     Machine-readable output (always the default)
  --help     Show command usage

'--args-file -' and '--message-file -' read stdin. Chat delivery never auto-retries.
Save the chat send receipt to poll its final response after disconnects.`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = process.argv.slice(2);
let pendingRequestId = null;
function parseOptions(input) {
  const positional = [];
  const options = {};
  for (let index = 0; index < input.length; index++) {
    const word = input[index];
    if (word === '--json') continue;
    if (word === '--wait') {options.wait = true; continue;}
    if (word === '--help' || word === '-h') {options.help = true; continue;}
    if (!word.startsWith('--')) {positional.push(word); continue;}
    const key = word.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (!new Set(['args', 'argsFile', 'title', 'objective', 'task', 'message', 'messageFile', 'agent', 'requestId', 'receipt', 'status', 'limit', 'timeout', 'userEpoch', 'previousTurn']).has(key)) throw new Error(`Unknown option ${word}.`);
    if (++index >= input.length) throw new Error(`Missing value for ${word}.`);
    options[key] = input[index];
  }
  return {positional, options};
}
function required(value, label) {if (typeof value !== 'string' || !value.length) throw new Error(`Missing ${label}.`); return value;}
function operationName(value) {
  const name = required(value, 'domain.operation');
  const index = name.indexOf('.');
  if (index <= 0 || index === name.length - 1) throw new Error('Expected domain.operation, e.g. runtime.task_list.');
  return {domain: name.slice(0, index), operation: name.slice(index + 1)};
}
async function readJsonOption(value) {
  const raw = value === '-' ? await new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {text += chunk; if (text.length > 128 * 1024) reject(new Error('stdin too large.'));});
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  }) : await fs.readFile(value, 'utf8');
  if (raw.length > 128 * 1024) throw new Error('Input is too large.');
  return raw;
}
const stateRoot = process.platform === 'win32'
  ? path.join(required(process.env.LOCALAPPDATA, 'LOCALAPPDATA'), 'Equinox Local', 'state')
  : path.join(os.homedir(), 'Library', 'Application Support', 'Equinox Local');

async function request(payload) {
  let discovery;
  try {discovery = JSON.parse(await fs.readFile(path.join(stateRoot, 'cli-ipc.json'), 'utf8'));}
  catch {throw new Error('Equinox Local CLI bridge is unavailable. Start or update Equinox Local first.');}
  if (discovery.version !== 1 || typeof discovery.endpoint !== 'string' || typeof discovery.token !== 'string') throw new Error('Invalid CLI bridge discovery data.');
  const message = JSON.stringify({token: discovery.token, ...payload});
  if (Buffer.byteLength(message) > 128 * 1024) throw new Error('CLI request exceeds 128 KiB.');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(discovery.endpoint);
    let buffer = '';
    let settled = false;
    const fail = (error) => {if (!settled) {settled = true; socket.destroy(); reject(error);}};
    socket.setTimeout(150_000, () => fail(new Error('CLI bridge request timed out. Outcome may be ambiguous for mutations.')));
    socket.once('connect', () => socket.write(message + '\n'));
    socket.on('data', (data) => {
      if (settled) return;
      buffer += data.toString('utf8');
      if (buffer.length > 512 * 1024) {fail(new Error('CLI response exceeds 512 KiB.')); return;}
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (!response.ok) {const error = new Error(response.error?.message || 'CLI operation failed.'); error.code = response.error?.code || 'CLI_ERROR'; fail(error); return;}
        settled = true; socket.end(); resolve(response.result);
      } catch (error) {fail(error);}
    });
    socket.on('error', fail);
    socket.on('end', () => {if (!settled) fail(new Error('CLI bridge disconnected. Check whether the operation completed before retrying.'));});
  });
}

async function poll(task, receipt, seconds = 120) {
  if (!receipt || typeof receipt !== 'object' || typeof receipt.userEpoch !== 'string') throw new Error('Receipt must include userEpoch.');
  const previousAssistantTurnKey = receipt.previousAssistantTurnKey;
  if (previousAssistantTurnKey !== null && typeof previousAssistantTurnKey !== 'string') throw new Error('Receipt must include previousAssistantTurnKey (string or null).');
  const max = Number(seconds);
  if (!Number.isFinite(max) || max < 1 || max > 600) throw new Error('Timeout must be between 1 and 600 seconds.');
  const deadline = Date.now() + max * 1000;
  while (Date.now() < deadline) {
    const result = await request({action: 'chat.read', task, userEpoch: receipt.userEpoch, previousAssistantTurnKey});
    if (result.status === 'ready') return {status: 'ready', receipt, response: result};
    await sleep(Math.min(1600, Math.max(0, deadline - Date.now())));
  }
  return {status: 'waiting', receipt, note: 'No automatic re-send. Run chat wait with this receipt to continue waiting.'};
}

async function initialReceipt(task, candidate, timeoutSeconds = 120) {
  if (candidate?.userEpoch) return candidate;
  const deadline = Date.now() + Number(timeoutSeconds) * 1000;
  while (Date.now() < deadline) {
    const current = await request({action: 'chat.initial', task});
    if (current?.userEpoch) return current;
    await sleep(1200);
  }
  return candidate;
}

async function main() {
  const {positional: pos, options: opt} = parseOptions(args);
  const [group, command, third] = pos;
  if (!group || group === 'help' || opt.help) {process.stdout.write(HELP); return;}
  let result;
  if (group === 'status' && !command) result = await request({action: 'status'});
  else if (group === 'tools' && command === 'list') result = await request({action: 'tools.list', ...(third ? {domain: third} : {})});
  else if (group === 'tools' && command === 'describe') result = await request({action: 'tools.describe', ...operationName(third)});
  else if (group === 'call') {
    if (opt.args && opt.argsFile) throw new Error('Use --args or --args-file, not both.');
    const raw = opt.argsFile ? await readJsonOption(opt.argsFile) : (opt.args ?? '{}');
    result = await request({action: 'tools.call', ...operationName(command), args: JSON.parse(raw)});
  } else if (group === 'tasks' && command === 'list') result = await request({action: 'tasks.list', ...(opt.status ? {status: opt.status} : {}), ...(opt.limit ? {limit: Number(opt.limit)} : {})});
  else if (group === 'tasks' && command === 'read') result = await request({action: 'tasks.read', task: required(third, 'task id')});
  else if (group === 'tasks' && command === 'create') result = await request({action: 'tasks.create', objective: required(opt.objective, '--objective'), ...(opt.title ? {title: opt.title} : {})});
  else if (group === 'tasks' && ['finish', 'cancel'].includes(command)) result = await request({action: 'tools.call', domain: 'runtime', operation: command === 'finish' ? 'task_finish' : 'task_cancel', args: {task_id: required(third, 'task id')}});
  else if (group === 'chat' && command === 'start') {
    const task = required(opt.task, '--task');
    const started = await request({action: 'chat.start', task});
    if (opt.wait) {
      const receipt = await initialReceipt(task, started.initialTurn, opt.timeout || 120);
      result = receipt?.userEpoch ? await poll(task, receipt, opt.timeout || 120) : {status: 'waiting', task, receipt};
    } else result = started;
  }
  else if (group === 'chat' && command === 'send') {
    if (opt.message && opt.messageFile) throw new Error('Use --message or --message-file, not both.');
    const message = opt.messageFile ? await readJsonOption(opt.messageFile) : required(opt.message, '--message');
    // Print request ID before crossing the send boundary, so callers can retain it on errors.
    const requestId = opt.requestId || randomBytes(12).toString('hex');
    pendingRequestId = requestId;
    const receipt = await request({action: 'chat.send', task: required(opt.task, '--task'), message, requestId, ...(opt.agent ? {agent: opt.agent} : {})});
    result = opt.wait ? await poll(opt.task, receipt, opt.timeout || 120) : receipt;
  } else if (group === 'chat' && ['read', 'wait'].includes(command)) {
    const receipt = opt.receipt ? JSON.parse(opt.receipt) : {userEpoch: required(opt.userEpoch, '--user-epoch'), previousAssistantTurnKey: opt.previousTurn === 'null' ? null : required(opt.previousTurn, '--previous-turn')};
    result = command === 'wait' ? await poll(required(opt.task, '--task'), receipt, opt.timeout || 120)
      : await request({action: 'chat.read', task: required(opt.task, '--task'), userEpoch: receipt.userEpoch, previousAssistantTurnKey: receipt.previousAssistantTurnKey});
  } else throw new Error('Unknown command. Run eqlocal --help.');
  pendingRequestId = null;
  process.stdout.write(JSON.stringify({ok: true, result}) + '\n');
}
main().catch((error) => {
  process.stderr.write(JSON.stringify({ok: false, error: {code: error.code || 'CLI_ERROR', message: error.message || String(error), ...(pendingRequestId ? {requestId: pendingRequestId} : {})}}) + '\n');
  process.exitCode = 1;
});
