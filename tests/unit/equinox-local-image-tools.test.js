import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import * as z from "zod/v4";

import {
  inspectImageBuffer,
  MAX_IMAGE_VIEW_BYTES,
  registerImageViewTools,
  resolveImageViewPath,
} from "../../src/equinox-local-image-tools.js";

function tinyPng() {
  const png = new PNG({ width: 2, height: 3 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

function registrationHarness(options = {}) {
  let record;
  registerImageViewTools({
    registerRawTool: (name, config, handler, toolOptions) => { record = { name, config, handler, toolOptions }; },
    z,
    fullFileAccess: true,
    fileRootIds: [],
    resolveFileRootContext: async () => { throw new Error("unused"); },
    homeDir: options.homeDir ?? os.homedir(),
    ...options,
  });
  return record;
}

test("image_view returns real MCP image content for a bounded PNG", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-image-view-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "sample.png");
  const png = tinyPng();
  await fs.writeFile(filePath, png);
  const tool = registrationHarness({ homeDir: root });

  assert.equal(tool.name, "image_view");
  assert.equal(tool.toolOptions.capabilityDomain, "files");
  assert.equal(tool.config.annotations.title, "Inspect local image directly");
  assert.match(tool.config.description, /Preferred first choice/u);
  assert.match(tool.config.description, /without file_export/u);
  const result = await tool.handler({ path: filePath });
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /2x3/u);
  assert.deepEqual(result.content[1], {
    type: "image",
    data: png.toString("base64"),
    mimeType: "image/png",
  });
});

test("image inspection recognizes JPEG and WebP dimensions from file signatures", () => {
  const jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    0x00, 0x07,
    0x00, 0x09,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  assert.deepEqual(inspectImageBuffer(jpeg), { mimeType: "image/jpeg", width: 9, height: 7 });

  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBP", 8, "ascii");
  webp.write("VP8X", 12, "ascii");
  webp.writeUInt32LE(10, 16);
  const widthMinusOne = 12;
  const heightMinusOne = 10;
  webp[24] = widthMinusOne & 0xff;
  webp[25] = (widthMinusOne >> 8) & 0xff;
  webp[26] = (widthMinusOne >> 16) & 0xff;
  webp[27] = heightMinusOne & 0xff;
  webp[28] = (heightMinusOne >> 8) & 0xff;
  webp[29] = (heightMinusOne >> 16) & 0xff;
  assert.deepEqual(inspectImageBuffer(webp), { mimeType: "image/webp", width: 13, height: 11 });
});

test("image inspection rejects arbitrary bytes and absurd PNG dimensions", () => {
  assert.throws(() => inspectImageBuffer(Buffer.from("not-an-image")), /Unsupported image format/u);
  const bomb = Buffer.from(tinyPng());
  bomb.writeUInt32BE(50_000, 16);
  bomb.writeUInt32BE(50_000, 20);
  assert.throws(() => inspectImageBuffer(bomb), /dimensions exceed|pixel safety/u);
});

test("image_view rejects symlink files and oversized files before reading", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-image-path-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const real = path.join(root, "real.png");
  const link = path.join(root, "link.png");
  await fs.writeFile(real, tinyPng());
  await fs.symlink(real, link);

  await assert.rejects(resolveImageViewPath({
    filePath: link,
    fullFileAccess: true,
    fileRootIds: [],
    resolveFileRootContext: async () => null,
    homeDir: root,
  }), /non-symlink/u);

  const fakeFs = {
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: MAX_IMAGE_VIEW_BYTES + 1 }),
    realpath: async (value) => value,
  };
  await assert.rejects(resolveImageViewPath({
    filePath: path.join(root, "large.png"),
    fullFileAccess: true,
    fileRootIds: [],
    resolveFileRootContext: async () => null,
    homeDir: root,
    fsImpl: fakeFs,
  }), /12 MB/u);
});

test("image_view blocks protected application and credential paths before filesystem access", async () => {
  const homeDir = "/Users/tester";
  let touchedFilesystem = false;
  const fakeFs = {
    lstat: async () => { touchedFilesystem = true; throw new Error("unexpected filesystem access"); },
    realpath: async () => { touchedFilesystem = true; throw new Error("unexpected filesystem access"); },
  };
  await assert.rejects(resolveImageViewPath({
    filePath: path.join(homeDir, "Library/Application Support/Equinox Local/private.png"),
    fullFileAccess: true,
    fileRootIds: [],
    resolveFileRootContext: async () => null,
    homeDir,
    fsImpl: fakeFs,
  }), /protected credential or application-data/u);
  assert.equal(touchedFilesystem, false);
});

test("Selected Agent Access contains image_view to configured roots including realpath", async (t) => {
  const allowed = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-image-allowed-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-image-outside-"));
  t.after(() => Promise.all([
    fs.rm(allowed, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true }),
  ]));
  const allowedImage = path.join(allowed, "ok.png");
  const outsideImage = path.join(outside, "no.png");
  await fs.writeFile(allowedImage, tinyPng());
  await fs.writeFile(outsideImage, tinyPng());
  const resolver = async () => ({ rootRealPath: await fs.realpath(allowed) });

  const accepted = await resolveImageViewPath({
    filePath: allowedImage,
    fullFileAccess: false,
    fileRootIds: ["allowed"],
    resolveFileRootContext: resolver,
    homeDir: allowed,
  });
  assert.equal(accepted.absolutePath, await fs.realpath(allowedImage));

  await assert.rejects(resolveImageViewPath({
    filePath: outsideImage,
    fullFileAccess: false,
    fileRootIds: ["allowed"],
    resolveFileRootContext: resolver,
    homeDir: allowed,
  }), /outside the configured Selected/u);
});

test("image_view rejects a symlink substituted between realpath and open without exposing foreign bytes",async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"equinox-image-race-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const imagePath=path.join(root,"image.png");
  const foreign=path.join(root,"private-outside.png");
  await fs.writeFile(imagePath,tinyPng());
  await fs.writeFile(foreign,Buffer.from("private bytes must not appear in image output"));
  let swapped=false;
  const fsImpl={
    ...fs,
    realpath:async p=>{
      const original=await fs.realpath(p);
      if(!swapped&&p===imagePath){
        swapped=true;
        await fs.unlink(imagePath);
        await fs.symlink(foreign,imagePath);
      }
      return original;
    },
  };
  const tool=registrationHarness({homeDir:root,fsImpl});
  await assert.rejects(tool.handler({path:imagePath}),{code:"ELOOP"});
  assert.equal(swapped,true);
  assert.equal((await fs.lstat(imagePath)).isSymbolicLink(),true);
  assert.equal(await fs.readFile(foreign,"utf8"),"private bytes must not appear in image output");
});

test("image_view rejects files that change size after path admission and closes opened descriptor",async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"equinox-image-fd-race-"));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const imagePath=path.join(root,"image.png");
  await fs.writeFile(imagePath,tinyPng());
  let opened=0,closed=0;
  const fsImpl={
    ...fs,
    open:async(p,flags)=>{
      opened++;
      const handle=await fs.open(p,flags);
      const originalClose=handle.close.bind(handle);
      handle.close=async()=>{closed++;return originalClose()};
      await fs.appendFile(p,Buffer.from("changed after lstat"));
      return handle;
    }
  };
  const tool=registrationHarness({homeDir:root,fsImpl});
  await assert.rejects(tool.handler({path:imagePath}),/Image file changed while it was being read/u);
  assert.equal(opened,1);
  assert.equal(closed,1);
});

test("image_view rejects JPEG and WebP decompression-size claims without decoding or disclosing bytes",()=>{
  const png=tinyPng();
  const excessive=Buffer.from(png);
  excessive.writeUInt32BE(20_000,16);
  excessive.writeUInt32BE(20_000,20);
  assert.throws(()=>inspectImageBuffer(excessive),/pixel safety budget/u);
  const empty=Buffer.alloc(30);
  empty.write("RIFF",0,"ascii");empty.writeUInt32LE(22,4);
  empty.write("WEBP",8,"ascii");empty.write("VP8X",12,"ascii");empty.writeUInt32LE(10,16);
  // 20,000 x 20,000 is within the per-axis cap but above the pixel limit.
  for(const off of [24,27]){const n=19999;empty[off]=n&255;empty[off+1]=(n>>8)&255;empty[off+2]=(n>>16)&255}
  assert.throws(()=>inspectImageBuffer(empty),/pixel safety budget/u);
});
