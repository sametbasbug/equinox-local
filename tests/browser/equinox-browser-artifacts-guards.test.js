import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";

import {
  augmentSnapshotWithPdfText,
  decodeBrowserPdfData,
  decodeScreenshotPng,
  pruneScreenshotStorage,
  resolveScreenshotPath,
  screenshotTarget,
  validateScreenshotName,
  writeScreenshotAtomic,
  SCREENSHOT_RETENTION_MS,
} from "../../src/equinox-browser-artifacts.js";

const CAPTURE = "capture-0000000000001-11111111-2222-4333-8444-555555555555";
const TEMP_ROOT = process.env.TMPDIR || os.tmpdir();

test("Browser PDF content redacts synthetic credentials before returning page text and synthetic nodes",()=>{
  const unsafeText = [
    "Bearer abcdefghijklmnopqrstuvwxyz012345",
    "Authorization: synthetic-secret-value",
    "Verification code 123456",
    "Password=examplepassword",
    "token=fixtureSyntheticToken999",
    "safe heading",
  ].join("\r\n");
  const snapshot={
    text:"existing",
    elementCount:0,
    returnedElementCount:0,
    elements:[],
    privacy:{sensitiveTextRedaction:true,sensitiveRedactionCount:2},
    tab:{url:"https://example.invalid/file.pdf"},
    frames:[{process:"oopif",url:"https://example.invalid/file.pdf",id:"pdf-frame"}],
    snapshot:{mainFrameId:"main-frame"},
  };
  const original=structuredClone(snapshot);
  const enriched=augmentSnapshotWithPdfText(snapshot,{
    parser:"pdfjs-dist",pageCount:1,
    pages:[{pageNumber:1,text:unsafeText}],truncated:false,
  },2);
  assert.equal(enriched.pdfContent.pdfTextRedaction,undefined);
  assert.equal(enriched.privacy.pdfTextRedaction,true);
  assert.equal(enriched.pdfContent.sensitiveRedactionCount,5);
  assert.equal(enriched.privacy.sensitiveRedactionCount,7);
  assert.equal(enriched.elements[0].frameId,"pdf-frame");
  assert.equal(enriched.elements[0].frameProcess,"oopif");
  assert.match(enriched.text,/safe heading/u);
  assert.doesNotMatch(enriched.text,/abcdefghijklmnopqrstuvwxyz012345|synthetic-secret-value|123456|examplepassword|fixtureSyntheticToken999/u);
  assert.doesNotMatch(enriched.elements[0].name,/synthetic-secret-value|123456|examplepassword|fixtureSyntheticToken999/u);
  assert.deepEqual(snapshot,original,"PDF enrichment must not mutate the private Browser snapshot");
  assert.equal(augmentSnapshotWithPdfText({deltaOnly:true}, {pages:[{text:unsafeText}]}).deltaOnly,true);
});

test("Browser screenshot PNG bounds reject malformed signature, IHDR and oversized pixel budgets",()=>{
  const good=PNG.sync.write({width:2,height:2,data:Buffer.alloc(16,255)});
  assert.equal(decodeScreenshotPng(good.toString("base64")).png.height,2);
  const cases=[
    [Buffer.from("not PNG data"),/PNG imzası/u],
    [good.subarray(0,24),/IHDR|boyut/u],
    [(()=>{const x=Buffer.from(good);x.writeUInt32BE(0,16);return x})(),/boyutları/u],
    [(()=>{const x=Buffer.from(good);x.writeUInt32BE(20001,16);return x})(),/20000px/u],
    [(()=>{const x=Buffer.from(good);x.writeUInt32BE(10000,16);x.writeUInt32BE(2001,20);return x})(),/20000000 pixel/u],
  ];
  for(const [data,error] of cases){
    assert.throws(()=>decodeScreenshotPng(data.toString("base64")),error);
  }
  assert.throws(()=>decodeScreenshotPng(""),/boş screenshot/u);
  for(const invalid of ["","UPPERCASE","../outside","has slash","has space","x".repeat(81),null]){
    assert.throws(()=>validateScreenshotName(invalid,"fixture"),/1-80 karakter/u);
  }
});

test("Browser screenshot writes use private owned paths and never overwrite an existing artifact",async()=>{
  const root=await fs.mkdtemp(path.join(TEMP_ROOT,"equinox-artifact-write-"));
  try{
    const screenshotRoot=path.join(root,"browser-screenshots");
    const target=screenshotTarget(screenshotRoot,{captureId:CAPTURE,collection:"screen",name:"fixture"});
    const binary=Buffer.from("synthetic-png-byte-fixture");
    await writeScreenshotAtomic({absolutePath:target.absolutePath,buffer:binary});
    assert.deepEqual(await fs.readFile(target.absolutePath),binary);
    assert.equal((await fs.stat(path.dirname(target.absolutePath))).mode&0o077,0);
    await assert.rejects(writeScreenshotAtomic({
      absolutePath:target.absolutePath,buffer:Buffer.from("must-not-overwrite"),
    }),{code:"EEXIST"});
    assert.deepEqual(await fs.readFile(target.absolutePath),binary);
    assert.equal((await fs.stat(target.absolutePath)).mode&0o077,0);
    assert.deepEqual(await fs.readdir(path.dirname(target.absolutePath)),["fixture.png"],
      "temporary artifacts must not remain after a failed hard-link collision");
    const resolved=resolveScreenshotPath(screenshotRoot,target.relativePath);
    assert.equal(resolved.absolutePath,target.absolutePath);
    for(const invalid of [
      "../secret.png",
      "browser-screenshots/../../escape/screen/fixture.png",
      `browser-screenshots/${CAPTURE}/screen/../secret.png`,
      `browser-screenshots/${CAPTURE}/screen/invalid.jpg`,
      "browser-screenshots/no-capture/screen/fixture.png",
      `browser-screenshots/${CAPTURE}/screen/fixture.png/`,
    ]){
      assert.throws(()=>resolveScreenshotPath(screenshotRoot,invalid),Error,invalid);
    }
  }finally{await fs.rm(root,{recursive:true,force:true})}
});

test("Browser capture cleanup prunes stale owned captures while preserving symlinks, unsafe trees and unrelated data",async()=>{
  const root=await fs.mkdtemp(path.join(TEMP_ROOT,"equinox-artifact-prune-"));
  try{
    const screenshotRoot=path.join(root,"browser-screenshots");
    const now=Date.now();
    await fs.mkdir(screenshotRoot,{recursive:true});
    const oldId="capture-0000000000002-11111111-2222-4333-8444-555555555555";
    const newId="capture-0000000000003-11111111-2222-4333-8444-555555555555";
    const unsafeId="capture-0000000000004-11111111-2222-4333-8444-555555555555";
    const symlinkId="capture-0000000000005-11111111-2222-4333-8444-555555555555";
    const outsider=path.join(root,"outside-private");
    await fs.mkdir(outsider);
    await fs.writeFile(path.join(outsider,"keep.txt"),"fixture-outside-private");
    const old=path.join(screenshotRoot,oldId);
    const fresh=path.join(screenshotRoot,newId);
    const unsafe=path.join(screenshotRoot,unsafeId);
    await fs.mkdir(old);await fs.mkdir(fresh);await fs.mkdir(unsafe);
    await fs.writeFile(path.join(old,"old.png"),"old");
    await fs.writeFile(path.join(fresh,"new.png"),"new");
    await fs.symlink(outsider,path.join(unsafe,"outside-link"));
    await fs.symlink(outsider,path.join(screenshotRoot,symlinkId));
    const ago=new Date(now-SCREENSHOT_RETENTION_MS-120000);
    await fs.utimes(path.join(old,"old.png"),ago,ago);
    await fs.utimes(old,ago,ago);
    await fs.utimes(unsafe,ago,ago);
    await fs.mkdir(path.join(screenshotRoot,"unrelated"));
    const result=await pruneScreenshotStorage(screenshotRoot,now);
    assert.equal(result.removedCaptures,1);
    assert.equal(result.reclaimedBytes,3);
    assert.equal(result.retainedCaptures,1);
    await assert.rejects(fs.lstat(old),{code:"ENOENT"});
    assert.equal(await fs.readFile(path.join(fresh,"new.png"),"utf8"),"new");
    assert.equal((await fs.lstat(unsafe)).isDirectory(),true);
    assert.equal((await fs.lstat(path.join(screenshotRoot,symlinkId))).isSymbolicLink(),true);
    assert.equal(await fs.readFile(path.join(outsider,"keep.txt"),"utf8"),"fixture-outside-private");
    assert.equal((await fs.lstat(path.join(screenshotRoot,"unrelated"))).isDirectory(),true);
  }finally{await fs.rm(root,{recursive:true,force:true})}
});
