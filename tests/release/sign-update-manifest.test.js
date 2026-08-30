import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateSignedUpdateManifest } from "../../src/equinox-local-updater.js";
import {
  createSignedUpdateManifest,
  readPrivateUpdateSigningKey,
  renderBootstrapInstallManifest,
  updateArtifactUrl,
  writeSignedUpdateBundle,
} from "../../scripts/release/sign-update-manifest.mjs";

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

test("signed update manifest matches the runtime verifier exactly", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-sign-update-"));
  try {
    const artifactPath = path.join(root, "release.tar.gz");
    await fs.writeFile(artifactPath, Buffer.from("deterministic release bytes"));
    const keys = keyPair();
    const result = await createSignedUpdateManifest({
      version: "4.2.1",
      target: "darwin-arm64",
      artifactPath,
      keyId: "stable-2026",
      privateKey: keys.privateKey,
      publishedAt: "2026-08-25T03:00:00.000Z",
    });

    assert.equal(result.manifest.artifact.url, updateArtifactUrl({ version: "4.2.1", target: "darwin-arm64" }));
    assert.equal(result.manifest.signature.algorithm, "ed25519");
    assert.equal(result.manifest.signature.keyId, "stable-2026");
    assert.equal(result.publicKeyPem, keys.publicPem);
    const verified = validateSignedUpdateManifest(result.manifest, {
      publicKeys: { "stable-2026": result.publicKeyPem },
      target: "darwin-arm64",
    });
    assert.equal(verified.version, "4.2.1");
    assert.equal(verified.artifact.sha256, result.sha256);
    assert.equal(verified.artifact.bytes, result.bytes);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("private update signing key must be external, private, owned and Ed25519", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-sign-key-"));
  const repositoryRoot = path.join(root, "repo");
  const externalRoot = path.join(root, "keys");
  await fs.mkdir(repositoryRoot, { mode: 0o700 });
  await fs.mkdir(externalRoot, { mode: 0o700 });
  const keys = keyPair();
  try {
    const insideKey = path.join(repositoryRoot, "private.pem");
    await fs.writeFile(insideKey, keys.privatePem, { mode: 0o600 });
    await assert.rejects(
      readPrivateUpdateSigningKey(insideKey, { repositoryRoot }),
      /outside the repository/u,
    );

    const externalKey = path.join(externalRoot, "private.pem");
    await fs.writeFile(externalKey, keys.privatePem, { mode: 0o600 });
    const loaded = await readPrivateUpdateSigningKey(externalKey, { repositoryRoot });
    assert.equal(loaded.asymmetricKeyType, "ed25519");

    await fs.chmod(externalKey, 0o644);
    await assert.rejects(
      readPrivateUpdateSigningKey(externalKey, { repositoryRoot }),
      /0600/u,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bootstrap install manifest is a strict shell-friendly projection of the verified release", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-bootstrap-manifest-"));
  try {
    const artifactPath = path.join(root, "release.tar.gz");
    await fs.writeFile(artifactPath, Buffer.from("bootstrap release bytes"));
    const keys = keyPair();
    const result = await createSignedUpdateManifest({
      version: "4.2.1",
      target: "darwin-arm64",
      artifactPath,
      keyId: "stable-2026",
      privateKey: keys.privateKey,
      publishedAt: "2026-08-25T03:00:00.000Z",
    });
    const text = renderBootstrapInstallManifest(result.manifest);
    assert.equal(text, [
      "schemaVersion=1",
      "channel=stable",
      "target=darwin-arm64",
      "version=4.2.1",
      `artifactUrl=${result.manifest.artifact.url}`,
      `artifactSha256=${result.manifest.artifact.sha256}`,
      `artifactBytes=${result.manifest.artifact.bytes}`,
      "",
    ].join("\n"));
    assert.doesNotMatch(text, /signature|private|BEGIN/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("signed update bundle copies verified artifact and writes public update plus bootstrap manifests", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-sign-bundle-"));
  const repositoryRoot = path.join(root, "repo");
  const keysRoot = path.join(root, "keys");
  const outputDir = path.join(root, "publish");
  await fs.mkdir(repositoryRoot, { mode: 0o700 });
  await fs.mkdir(keysRoot, { mode: 0o700 });
  try {
    const keys = keyPair();
    const privateKeyPath = path.join(keysRoot, "release.pem");
    await fs.writeFile(privateKeyPath, keys.privatePem, { mode: 0o600 });
    const artifactPath = path.join(root, "source-release.tar.gz");
    await fs.writeFile(artifactPath, Buffer.from("release artifact for publishing"));
    const installerSource = path.join(repositoryRoot, "scripts", "install-equinox-local.sh");
    await fs.mkdir(path.dirname(installerSource), { recursive: true, mode: 0o700 });
    await fs.writeFile(installerSource, "#!/bin/bash\necho fixture\n", { mode: 0o644 });

    const result = await writeSignedUpdateBundle({
      repositoryRoot,
      version: "4.2.1",
      target: "darwin-arm64",
      artifactPath,
      privateKeyPath,
      keyId: "stable-2026",
      outputDir,
      publishedAt: "2026-08-25T03:00:00.000Z",
    });

    assert.equal(path.basename(result.artifactPath), "equinox-local-4.2.1-darwin-arm64.tar.gz");
    assert.equal(path.basename(result.manifestPath), "stable-darwin-arm64.json");
    assert.equal(path.basename(result.bootstrapManifestPath), "bootstrap-darwin-arm64.txt");
    assert.equal(path.basename(result.installerPath), "install-equinox-local.sh");
    assert.equal(await fs.readFile(result.installerPath, "utf8"), "#!/bin/bash\necho fixture\n");
    assert.equal(result.installerBytes, Buffer.byteLength("#!/bin/bash\necho fixture\n"));
    assert.match(result.installerSha256, /^[a-f0-9]{64}$/u);
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, "utf8"));
    validateSignedUpdateManifest(manifest, {
      publicKeys: { "stable-2026": result.publicKeyPem },
      target: "darwin-arm64",
    });
    assert.equal(await fs.readFile(result.bootstrapManifestPath, "utf8"), renderBootstrapInstallManifest(manifest));
    assert.equal((await fs.readFile(result.artifactPath)).toString(), "release artifact for publishing");
    assert.equal((await fs.readdir(outputDir)).some((name) => name.includes("private") || name.endsWith(".pem")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
