import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import {
  equinoxLocalMainSnapshotArtifactUrl,
  equinoxLocalMainSnapshotManifestUrl,
  inspectStagedEquinoxLocalMainSnapshotArtifact,
  stageEquinoxLocalMainSnapshotArtifact,
  fetchEquinoxLocalMainSnapshotManifest,
} from "../../src/equinox-local-main-snapshot.js";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);
const TARGET = "darwin-arm64";
const MANIFEST = Object.freeze({
  schemaVersion: 1,
  channel: "main",
  sourceSha: SHA,
  target: TARGET,
  runtimeContractSha256: DIGEST,
  artifact: Object.freeze({
    name: `equinox-local-main-${SHA}-${TARGET}.tar.gz`,
    sha256: "c".repeat(64),
    bytes: 12345,
  }),
});

function jsonResponse(value, { status = 200, contentLength = null } = {}) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-length" ? (contentLength ?? String(bytes.length)) : null },
    body: (async function* () { yield bytes; })(),
  };
}

function bytesResponse(bytes, { status = 200, contentLength = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-length" ? (contentLength ?? String(bytes.length)) : null },
    body: (async function* () { yield bytes; })(),
  };
}

function manifestWithArtifact(artifact) {
  return { ...MANIFEST, artifact };
}

test("Main snapshot URLs are deterministic exact-SHA public paths", () => {
  assert.equal(
    equinoxLocalMainSnapshotManifestUrl(SHA, TARGET),
    `https://main.local.sametbasbug.dev/snapshots/${SHA}/equinox-local-main-${SHA}-${TARGET}.json`,
  );
  assert.equal(
    equinoxLocalMainSnapshotArtifactUrl(SHA, "win32-x64"),
    `https://main.local.sametbasbug.dev/snapshots/${SHA}/equinox-local-main-${SHA}-win32-x64.zip`,
  );
  assert.throws(() => equinoxLocalMainSnapshotManifestUrl("../main", TARGET), /source SHA is invalid/u);
  assert.throws(() => equinoxLocalMainSnapshotArtifactUrl(SHA, "linux-x64"), /target is unsupported/u);
});

test("Main snapshot manifest fetch is tokenless bounded and exact-contract validated", async () => {
  const calls = [];
  const result = await fetchEquinoxLocalMainSnapshotManifest({
    sourceSha: SHA,
    target: TARGET,
    expectedRuntimeContractSha256: DIGEST,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(MANIFEST);
    },
  });
  assert.equal(result.manifest.sourceSha, SHA);
  assert.equal(result.manifest.target, TARGET);
  assert.equal(result.manifest.runtimeContractSha256, DIGEST);
  assert.equal(result.artifactUrl, equinoxLocalMainSnapshotArtifactUrl(SHA, TARGET));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, equinoxLocalMainSnapshotManifestUrl(SHA, TARGET));
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.credentials, "omit");
  assert.equal(calls[0].options.cache, "no-store");
});

test("Main snapshot manifest fetch fails closed on identity and response drift", async () => {
  const fetchManifest = (value, options) => fetchEquinoxLocalMainSnapshotManifest({
    sourceSha: SHA,
    target: TARGET,
    expectedRuntimeContractSha256: DIGEST,
    fetchImpl: async () => jsonResponse(value, options),
  });

  await assert.rejects(fetchManifest({ ...MANIFEST, sourceSha: "d".repeat(40) }), /source SHA does not match/u);
  await assert.rejects(fetchManifest({ ...MANIFEST, target: "darwin-x64" }), /target does not match/u);
  await assert.rejects(fetchManifest({ ...MANIFEST, runtimeContractSha256: "e".repeat(64) }), /runtime contract digest does not match/u);
  await assert.rejects(fetchManifest(MANIFEST, { status: 404 }), /HTTP 404/u);
  await assert.rejects(fetchManifest(MANIFEST, { contentLength: String(64 * 1024 + 1) }), /size limit/u);
  await assert.rejects(fetchEquinoxLocalMainSnapshotManifest({
    sourceSha: SHA,
    target: TARGET,
    expectedRuntimeContractSha256: DIGEST,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, body: (async function* () { yield Buffer.alloc(64 * 1024 + 1); })() }),
  }), /size limit/u);
  await assert.rejects(fetchEquinoxLocalMainSnapshotManifest({
    sourceSha: SHA,
    target: TARGET,
    expectedRuntimeContractSha256: DIGEST,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => "8" }, body: (async function* () { yield Buffer.from("not-json"); })() }),
  }), /not valid JSON/u);
});

test("Main snapshot artifact staging streams into transaction-owned storage and verifies exact bytes", async (t) => {
  const fixtureBase = path.dirname(fileURLToPath(import.meta.url));
  const root = await fs.mkdtemp(path.join(fixtureBase, ".equinox-main-snapshot-stage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionId = `main-${"d".repeat(32)}`;
  const transactionDir = path.join(root, "staging", transactionId);
  await fs.mkdir(transactionDir, { recursive: true, mode: 0o700 });
  const artifactBytes = Buffer.from("verified-main-native-artifact");
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  const manifest = manifestWithArtifact({ name: `equinox-local-main-${SHA}-darwin-arm64.tar.gz`, sha256: artifactSha256, bytes: artifactBytes.length });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? jsonResponse(manifest) : bytesResponse(artifactBytes);
  };
  const result = await stageEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId, fetchImpl,
  });
  assert.equal(result.bytes, artifactBytes.length);
  assert.equal(result.sha256, artifactSha256);
  assert.equal(await fs.readFile(result.artifactPath, "utf8"), artifactBytes.toString("utf8"));
  assert.equal((await fs.lstat(result.artifactPath)).isFile(), true);
  assert.deepEqual(JSON.parse(await fs.readFile(result.manifestPath, "utf8")), manifest);
  const inspected = await inspectStagedEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId,
  });
  assert.equal(inspected.artifactPath, result.artifactPath);
  assert.equal(inspected.manifestPath, result.manifestPath);
  assert.equal(inspected.sha256, artifactSha256);
  assert.equal(inspected.bytes, artifactBytes.length);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, equinoxLocalMainSnapshotArtifactUrl(SHA, "darwin-arm64"));
  assert.equal(calls[1].options.redirect, "error");
  assert.equal(calls[1].options.credentials, "omit");
});

test("Main snapshot does not publish a same-length substituted artifact after digest verification", async (t) => {
  const fixtureBase = path.dirname(fileURLToPath(import.meta.url));
  const root = await fs.mkdtemp(path.join(fixtureBase, ".equinox-main-snapshot-inode-publication-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionId = `main-${"9".repeat(32)}`;
  await fs.mkdir(path.join(root, "staging", transactionId), { recursive: true, mode: 0o700 });
  const original = Buffer.from("verified-native-archive");
  const replacement = Buffer.from("forged!!-native-archive");
  assert.equal(original.length, replacement.length);
  const manifest = manifestWithArtifact({
    name: `equinox-local-main-${SHA}-darwin-arm64.tar.gz`,
    sha256: createHash("sha256").update(original).digest("hex"), bytes: original.length,
  });
  const fsImpl = Object.create(fs);
  let substituted = false;
  fsImpl.link = async (from, to) => {
    if (!substituted && path.basename(from).startsWith(".artifact-part-")) {
      substituted = true;
      await fs.unlink(from);
      await fs.writeFile(from, replacement, { mode: 0o600 });
    }
    return fs.link(from, to);
  };
  await assert.rejects(stageEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId, fsImpl,
    fetchImpl: async (url) => url.endsWith(".json") ? jsonResponse(manifest) : bytesResponse(original),
  }), /original.*inode|staged artifact.*changed|temporary artifact.*changed/u);
  assert.equal(substituted, true, "The actual hard-link publication must experience the substituted temp inode");
});

test("Main snapshot staging rejects a same-length foreign manifest substituted after descriptor close", async (t) => {
  const root = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), ".equinox-main-snapshot-publish-manifest-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionId = `main-${"6".repeat(32)}`;
  await fs.mkdir(path.join(root, "staging", transactionId), { recursive: true, mode: 0o700 });
  const bytes = Buffer.from("verified native archive");
  const manifest = manifestWithArtifact({
    name: `equinox-local-main-${SHA}-${TARGET}.tar.gz`,
    sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
  });
  const manifestName = `equinox-local-main-${SHA}-${TARGET}.json`;
  const fsImpl = Object.create(fs);
  let substituted = false;
  fsImpl.open = async (candidate, ...args) => {
    const handle = await fs.open(candidate, ...args);
    if (path.basename(String(candidate)) !== manifestName || args[0] !== "wx") return handle;
    return new Proxy(handle, {
      get(target, property) {
        if (property === "close") return async () => {
          await target.close();
          substituted = true;
          const original = await fs.readFile(candidate);
          await fs.unlink(candidate);
          await fs.writeFile(candidate, Buffer.alloc(original.length, 0x58), { mode: 0o600 });
        };
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  await assert.rejects(stageEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: TARGET, expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId, fsImpl,
    fetchImpl: async (url) => url.endsWith(".json") ? jsonResponse(manifest) : bytesResponse(bytes),
  }), /staged manifest.*changed|manifest.*original|manifest.*identity/u);
  assert.equal(substituted, true, "The replacement happened after the original manifest descriptor closed");
});

test("Main snapshot failed staging must preserve a foreign directory replacing its native scratch", async (t) => {
  const root = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), ".equinox-main-snapshot-foreign-directory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionId = `main-${"7".repeat(32)}`;
  const transactionDir = path.join(root, "staging", transactionId);
  const nativeDir = path.join(transactionDir, "native");
  const displaced = path.join(transactionDir, ".original-native-displaced");
  const foreignPath = path.join(nativeDir, "FOREIGN-OWNER-MARKER.txt");
  const foreignBytes = "other-writer-owned-temporary-data\n";
  await fs.mkdir(transactionDir, { recursive: true, mode: 0o700 });
  let replaced = false;
  const fetchImpl = async (url) => {
    if (url.endsWith(".json")) return jsonResponse(MANIFEST);
    replaced = true;
    await fs.rename(nativeDir, displaced);
    await fs.mkdir(nativeDir, { mode: 0o700 });
    await fs.writeFile(foreignPath, foreignBytes, { mode: 0o600 });
    throw new Error("synthetic artifact network failure after same-name foreign directory replacement");
  };
  await assert.rejects(stageEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: TARGET, expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId, fetchImpl,
  }), /synthetic artifact network failure/u);
  assert.equal(replaced, true, "Another writer must replace the native scratch before cleanup");
  assert.equal(await fs.readFile(foreignPath, "utf8"), foreignBytes,
    "Failure cleanup must not recursively delete another writer's normal directory");
  assert.equal((await fs.lstat(displaced)).isDirectory(), true);
});

test("Main snapshot artifact staging cleans partial state on byte digest and destination collisions", async (t) => {
  const fixtureBase = path.dirname(fileURLToPath(import.meta.url));
  const root = await fs.mkdtemp(path.join(fixtureBase, ".equinox-main-snapshot-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionId = `main-${"e".repeat(32)}`;
  const transactionDir = path.join(root, "staging", transactionId);
  await fs.mkdir(transactionDir, { recursive: true, mode: 0o700 });
  const artifactBytes = Buffer.from("artifact-bytes");
  const manifest = manifestWithArtifact({ name: `equinox-local-main-${SHA}-darwin-arm64.tar.gz`, sha256: "f".repeat(64), bytes: artifactBytes.length });
  const fetchImpl = async (url) => url.endsWith(".json") ? jsonResponse(manifest) : bytesResponse(artifactBytes);
  await assert.rejects(stageEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId, fetchImpl,
  }), /SHA-256/u);
  await assert.rejects(fs.lstat(path.join(transactionDir, "native")), { code: "ENOENT" });

  await fs.mkdir(path.join(transactionDir, "native"), { mode: 0o700 });
  await assert.rejects(stageEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId, fetchImpl,
  }), { code: "EEXIST" });
});

test("Main snapshot artifact staging rejects symlinked transaction storage before network access", async (t) => {
  const fixtureBase = path.dirname(fileURLToPath(import.meta.url));
  const root = await fs.mkdtemp(path.join(fixtureBase, ".equinox-main-snapshot-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionId = `main-${"1".repeat(32)}`;
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.mkdir(path.join(root, "staging"));
  await fs.symlink(outside, path.join(root, "staging", transactionId));
  let called = false;
  await assert.rejects(stageEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId, fetchImpl: async () => { called = true; throw new Error("must not fetch"); },
  }), /canonical normal directory/u);
  assert.equal(called, false);
});


test("staged Main snapshot inspection revalidates local manifest identity, bytes and directory ownership", async (t) => {
  const fixtureBase = path.dirname(fileURLToPath(import.meta.url));
  const root = await fs.mkdtemp(path.join(fixtureBase, ".equinox-main-snapshot-inspect-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionId = `main-${"2".repeat(32)}`;
  const nativeDir = path.join(root, "staging", transactionId, "native");
  await fs.mkdir(nativeDir, { recursive: true, mode: 0o700 });
  const artifactBytes = Buffer.from("transaction-bound-native-artifact");
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex");
  const manifest = manifestWithArtifact({ name: `equinox-local-main-${SHA}-darwin-arm64.tar.gz`, sha256: artifactSha256, bytes: artifactBytes.length });
  const manifestPath = path.join(nativeDir, `equinox-local-main-${SHA}-darwin-arm64.json`);
  const artifactPath = path.join(nativeDir, manifest.artifact.name);
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  await fs.writeFile(artifactPath, artifactBytes, { mode: 0o600 });

  await assert.rejects(inspectStagedEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: "e".repeat(64), transactionRoot: root, transactionId,
  }), /runtime contract digest does not match/u);

  await fs.appendFile(artifactPath, "tamper");
  await assert.rejects(inspectStagedEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST, transactionRoot: root, transactionId,
  }), /byte size does not match/u);
  await fs.writeFile(artifactPath, artifactBytes);
  await fs.writeFile(path.join(nativeDir, "unexpected.txt"), "nope");
  await assert.rejects(inspectStagedEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: "darwin-arm64", expectedRuntimeContractSha256: DIGEST, transactionRoot: root, transactionId,
  }), /unexpected entries/u);
});

test("staged Main snapshot refuses symlinked manifest and artifact before opening foreign files", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), ".equinox-main-snapshot-symlinks-")));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const id = "main-"+"3".repeat(32);
  const nativeDir = path.join(root,"staging",id,"native");
  await fs.mkdir(nativeDir,{recursive:true});
  const content = Buffer.from("valid signed native archive bytes");
  const manifest = manifestWithArtifact({
    name: "equinox-local-main-"+SHA+"-"+TARGET+".tar.gz",
    sha256: createHash("sha256").update(content).digest("hex"), bytes:content.length,
  });
  const manifestPath = path.join(nativeDir,"equinox-local-main-"+SHA+"-"+TARGET+".json");
  const artifactPath = path.join(nativeDir,manifest.artifact.name);
  const foreign = path.join(root,"outside");
  await fs.mkdir(foreign);
  const foreignManifest = path.join(foreign,"manifest.json");
  const foreignArchive = path.join(foreign,"native.tar.gz");
  await fs.writeFile(foreignManifest,JSON.stringify(manifest));
  await fs.writeFile(foreignArchive,content);
  const args = {sourceSha:SHA,target:TARGET,expectedRuntimeContractSha256:DIGEST,transactionRoot:root,transactionId:id};
  for(const symlinkTarget of ["manifest","archive"]){
    await fs.rm(manifestPath,{force:true});
    await fs.rm(artifactPath,{force:true});
    await fs.writeFile(manifestPath,JSON.stringify(manifest));
    await fs.writeFile(artifactPath,content);
    const swapped=symlinkTarget==="manifest"?manifestPath:artifactPath;
    await fs.unlink(swapped);
    await fs.symlink(symlinkTarget==="manifest"?foreignManifest:foreignArchive,swapped);
    let trustedFileOpened=false;
    const mockFs=Object.create(fs);
    mockFs.open=async (filePath,...opts) => {
      if(filePath===swapped) trustedFileOpened=true;
      return fs.open(filePath,...opts);
    };
    await assert.rejects(inspectStagedEquinoxLocalMainSnapshotArtifact({...args,fsImpl:mockFs}),/normal, non-symlink file/u);
    assert.equal(trustedFileOpened,false,symlinkTarget+" must be denied before open");
    assert.equal((await fs.lstat(swapped)).isSymbolicLink(),true);
    assert.equal(await fs.readFile(foreignManifest,"utf8"),JSON.stringify(manifest));
    assert.deepEqual(await fs.readFile(foreignArchive),content);
  }
});

test("staged Main snapshot rejects hard-linked manifest and artifact before opening foreign bytes", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), ".equinox-main-snapshot-hardlinks-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = "main-" + "7".repeat(32);
  const nativeDir = path.join(root, "staging", id, "native");
  await fs.mkdir(nativeDir, { recursive: true });
  const artifactBytes = Buffer.from("valid signed native archive bytes");
  const manifest = manifestWithArtifact({
    name: `equinox-local-main-${SHA}-${TARGET}.tar.gz`,
    sha256: createHash("sha256").update(artifactBytes).digest("hex"),
    bytes: artifactBytes.length,
  });
  const manifestPath = path.join(nativeDir, `equinox-local-main-${SHA}-${TARGET}.json`);
  const artifactPath = path.join(nativeDir, manifest.artifact.name);
  const foreignDir = path.join(root, "outside");
  await fs.mkdir(foreignDir);
  const args = { sourceSha: SHA, target: TARGET, expectedRuntimeContractSha256: DIGEST, transactionRoot: root, transactionId: id };
  for (const name of ["manifest", "artifact"]) {
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await fs.writeFile(artifactPath, artifactBytes);
    const protectedPath = name === "manifest" ? manifestPath : artifactPath;
    const foreign = path.join(foreignDir, `${name}.bin`);
    const bytes = await fs.readFile(protectedPath);
    await fs.writeFile(foreign, bytes);
    await fs.unlink(protectedPath);
    try { await fs.link(foreign, protectedPath); }
    catch (error) {
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) { t.skip("Hard links unsupported"); return; }
      throw error;
    }
    assert.equal((await fs.stat(foreign)).nlink, 2);
    let opened = false;
    const mockFs = Object.create(fs);
    mockFs.open = async (candidate, ...options) => {
      if (candidate === protectedPath) opened = true;
      return fs.open(candidate, ...options);
    };
    await assert.rejects(inspectStagedEquinoxLocalMainSnapshotArtifact({ ...args, fsImpl: mockFs }), /normal, non-symlink file|hard.link/u);
    assert.equal(opened, false, "Hard-linked foreign snapshots cannot be opened");
    assert.deepEqual(await fs.readFile(foreign), bytes);
    await fs.unlink(protectedPath);
    await fs.unlink(foreign);
  }
});

test("staged Main snapshot manifest read is bounded even if the opened inode grows after fstat", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), ".equinox-main-snapshot-growth-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const transactionId = `main-${"8".repeat(32)}`;
  const nativeDir = path.join(root, "staging", transactionId, "native");
  await fs.mkdir(nativeDir, { recursive: true });
  const bytes = Buffer.from("valid disposable native snapshot");
  const manifest = manifestWithArtifact({
    name: `equinox-local-main-${SHA}-${TARGET}.tar.gz`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
  const manifestPath = path.join(nativeDir, `equinox-local-main-${SHA}-${TARGET}.json`);
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await fs.writeFile(path.join(nativeDir, manifest.artifact.name), bytes);
  let unboundedReads = 0;
  let descriptorReads = 0;
  let requestedBytes = 0;
  let closed = 0;
  const mockFs = Object.create(fs);
  mockFs.open = async (candidate, ...options) => {
    const original = await fs.open(candidate, ...options);
    if (candidate !== manifestPath) return original;
    return {
      stat: (...args) => original.stat(...args),
      readFile: (...args) => { unboundedReads++; return original.readFile(...args); },
      read: async (buffer, offset, length) => {
        // Model a concurrent writer extending the opened inode after stat().
        // The real file is never modified; only descriptor reads are injected.
        descriptorReads++;
        requestedBytes += length;
        buffer.fill(0x20, offset, offset + length);
        return { bytesRead: length, buffer };
      },
      close: async () => { closed++; await original.close(); },
    };
  };
  await assert.rejects(inspectStagedEquinoxLocalMainSnapshotArtifact({
    sourceSha: SHA, target: TARGET, expectedRuntimeContractSha256: DIGEST,
    transactionRoot: root, transactionId, fsImpl: mockFs,
  }), /manifest exceeds the size limit/u);
  assert.equal(unboundedReads, 0, "Never read an unbounded manifest into memory");
  assert.ok(descriptorReads > 0, "Read using the pinned descriptor with explicit lengths");
  assert.equal(requestedBytes, 64 * 1024 + 1, "The absolute read budget is 64 KiB plus one");
  assert.equal(closed, 1, "Rejected manifest descriptor is closed exactly once");
  assert.equal(await fs.readFile(manifestPath, "utf8"), JSON.stringify(manifest));
});

test("staged Main snapshot rejects a swapped manifest inode before trusting JSON",async(t)=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), ".equinox-main-snapshot-inode-")));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const id="main-"+"4".repeat(32),nativeDir=path.join(root,"staging",id,"native");
  await fs.mkdir(nativeDir,{recursive:true});
  const manifestPath=path.join(nativeDir,"equinox-local-main-"+SHA+"-"+TARGET+".json");
  await fs.writeFile(manifestPath,JSON.stringify(MANIFEST));
  const mockFs=Object.create(fs);
  mockFs.lstat=async(filePath)=>{
    const stat=await fs.lstat(filePath);
    if(filePath!==manifestPath)return stat;
    return new Proxy(stat,{get(target,property,receiver){
      if(property==="ino")return target.ino+1;
      return Reflect.get(target,property,receiver);
    }});
  };
  await assert.rejects(inspectStagedEquinoxLocalMainSnapshotArtifact({
    sourceSha:SHA,target:TARGET,expectedRuntimeContractSha256:DIGEST,transactionRoot:root,transactionId:id,fsImpl:mockFs,
  }),/changed while opening/u);
  assert.deepEqual(JSON.parse(await fs.readFile(manifestPath,"utf8")),MANIFEST);
});

test("Main snapshot rejects dishonest streamed artifact lengths and retains no partial native candidate",async(t)=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), ".equinox-main-snapshot-lengths-")));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const id="main-"+"5".repeat(32);
  await fs.mkdir(path.join(root,"staging",id),{recursive:true});
  const content=Buffer.from("verifiable artifact");
  const manifest=manifestWithArtifact({
    name:"equinox-local-main-"+SHA+"-"+TARGET+".tar.gz",
    sha256:createHash("sha256").update(content).digest("hex"),bytes:content.length,
  });
  for(const scenario of [
    {name:"declared length too small",body:content,declared:String(content.length-1),message:/Content-Length/u},
    {name:"body oversized",body:Buffer.concat([content,Buffer.from("extra")]),declared:String(content.length),message:/exceeded the manifest byte size/u},
    {name:"body truncated",body:content.subarray(0,-1),declared:String(content.length),message:/byte size does not match/u},
  ]){
    const fetchImpl=async(url)=>url.endsWith(".json")?jsonResponse(manifest):
      bytesResponse(scenario.body,{contentLength:scenario.declared});
    await assert.rejects(stageEquinoxLocalMainSnapshotArtifact({
      sourceSha:SHA,target:TARGET,expectedRuntimeContractSha256:DIGEST,transactionRoot:root,transactionId:id,fetchImpl,
    }),scenario.message,scenario.name);
    await assert.rejects(fs.lstat(path.join(root,"staging",id,"native")),{code:"ENOENT"},scenario.name);
  }
});
