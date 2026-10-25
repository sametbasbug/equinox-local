import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {verifyOriginalSignedWindowsGuardianTerminal} from './smoke-main-upgrade-windows.mjs';

const a = 'a'.repeat(40), b = 'b'.repeat(40);
const id = `main-${'c'.repeat(32)}`;
const target = 'win32-x64';
const timestamp = '2026-10-25T10:00:00.000Z';
const exitA = Object.freeze({schemaVersion:1,transactionId:id,disposition:'stable-shell-quiesced-only',
  shellPid:410, shellStartTimeUtcTicks:'639000000000000000', workerPid:510,
  workerStartTimeUtcTicks:'639000000000000001',guardianPid:610,preparedJournalSha256:'d'.repeat(64)});
const exitB = Object.freeze({schemaVersion:1,transactionId:id,disposition:'b-shell-quiesced-only',
  stage:'rollback_started',sequence:6,shellPid:420,shellStartTimeUtcTicks:'639000000000000002',
  workerPid:510,workerStartTimeUtcTicks:'639000000000000001',guardianPid:610,
  rollbackJournalSha256:'e'.repeat(64),handoffSha256:'f'.repeat(64)});
function journal(negative) {
  return {schemaVersion:1,channel:'main',transactionId:id,target,currentSha:a,targetSha:b,
    receiptStartedAt:timestamp,previousNative:{kind:'stable',version:'6.1.2'},
    targetRuntimeContractSha256:'d'.repeat(64),stage:negative?'rolled_back':'committed',
    sequence:negative?9:6,createdAt:timestamp,updatedAt:timestamp};
}
async function fixture(negative,fn) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'equinox-guardian-terminal-'));
  try {
    await fs.mkdir(path.join(root,'guardian-journal'));
    const write=(name,value)=>fs.writeFile(path.join(root,'guardian-journal',`${id}.${name}`),JSON.stringify(value));
    await fs.writeFile(path.join(root,'guardian-journal',`${id}.json`),JSON.stringify(journal(negative)));
    await write('stable-shell-quiesce.json',exitA);
    await write('native-authority.json',{schemaVersion:1,transactionId:id,stage:'prepared',sequence:0,
      workerPid:510,workerStartTimeUtcTicks:'639000000000000001',guardianPid:610,
      journalSha256:'1'.repeat(64),handoffSha256:'2'.repeat(64)});
    if (negative) await write('b-shell-quiesce.json',exitB);
    await fn({root,write});
  } finally { await fs.rm(root,{recursive:true,force:true}); }
}
const verify=(root,negative)=>verifyOriginalSignedWindowsGuardianTerminal({
  transactionRoot:root,id,a,b,target,negative,firstWpfPid:410});

test('hosted original Guardian terminal evidence accepts exact A and distinct bad B schemas',async()=>{
  await fixture(false,async({root})=>assert.equal((await verify(root,false)).stage,'committed'));
  await fixture(true,async({root})=>assert.equal((await verify(root,true)).stage,'rolled_back'));
});

test('hosted evidence rejects old A PID reuse, spoofed Guardian and missing bad B OS exit',async()=>{
  await fixture(false,async({root,write})=>{
    await write('stable-shell-quiesce.json',{...exitA,shellPid:499});
    await assert.rejects(verify(root,false),/original A WPF/u);
  });
  await fixture(true,async({root,write})=>{
    await write('b-shell-quiesce.json',{...exitB,guardianPid:611});
    await assert.rejects(verify(root,true),/original signed Guardian/u);
    await fs.unlink(path.join(root,'guardian-journal',`${id}.b-shell-quiesce.json`));
    await assert.rejects(verify(root,true),/ENOENT/u);
  });
});
