import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  downloadVerifiedUpdateArtifact,
  inspectEquinoxReleaseArchive,
  prepareManagedEquinoxRelease,
} from "../../src/equinox-local-release-manager.js";

const execFile = promisify(execFileCallback);

async function makeFixture({ version = "4.3.0", target = "darwin-arm64", withSymlink = false, nativeApp = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-release-manager-"));
  const sourceRoot = path.join(root, "source");
  const releaseRoot = path.join(sourceRoot, "release");
  await fs.mkdir(path.join(releaseRoot, "node_modules", "fixture"), { recursive: true });
  await fs.mkdir(path.join(releaseRoot, "runtime", "node", "bin"), { recursive: true });
  await fs.mkdir(path.join(releaseRoot, "runtime", "tunnel"), { recursive: true });
  await fs.mkdir(path.join(releaseRoot, "runtime", "peekaboo"), { recursive: true });
  await fs.writeFile(path.join(releaseRoot, "release.json"), JSON.stringify({
    schemaVersion: 1,
    version,
    target,
    nodeVersion: "24.19.0",
    tunnelClientVersion: "0.0.12",
    ...(nativeApp ? { nativeAppShellVersion: 1 } : {}),
    serverEntry: "server.js",
  }));
  await fs.writeFile(path.join(releaseRoot, "server.js"), "console.log('fixture');\n");
  await fs.writeFile(path.join(releaseRoot, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  await fs.writeFile(path.join(releaseRoot, "equinox-local-version.js"), `export const EQUINOX_LOCAL_VERSION = ${JSON.stringify(version)};\n`);
  await fs.writeFile(path.join(releaseRoot, "node_modules", "fixture", "index.js"), "export default true;\n");
  const nodeBinary = path.join(releaseRoot, "runtime", "node", "bin", "node");
  await fs.writeFile(nodeBinary, "fixture-node\n");
  await fs.chmod(nodeBinary, 0o755);
  for (const name of ["tunnel-client", "cloudflared"]) {
    const binary = path.join(releaseRoot, "runtime", "tunnel", name);
    await fs.writeFile(binary, `${name}\n`);
    await fs.chmod(binary, 0o755);
  }
  await fs.writeFile(path.join(releaseRoot, "runtime", "tunnel", "LICENSE"), "fixture license\n");
  await fs.writeFile(path.join(releaseRoot, "runtime", "tunnel", "NOTICE"), "fixture notice\n");
  for (const name of ["peekaboo", "libswiftCompatibilitySpan.dylib"]) {
    const binary = path.join(releaseRoot, "runtime", "peekaboo", name);
    await fs.writeFile(binary, `${name}\n`);
    await fs.chmod(binary, 0o755);
  }
  await fs.writeFile(path.join(releaseRoot, "runtime", "peekaboo", "LICENSE"), "fixture license\n");
  await fs.writeFile(path.join(releaseRoot, "runtime", "peekaboo", "README.md"), "fixture readme\n");
  await fs.writeFile(path.join(releaseRoot, "runtime", "peekaboo", "VERSION"), "4.2.2\n");
  if (nativeApp) {
    const appRoot = path.join(releaseRoot, "runtime", "app");
    await fs.mkdir(appRoot, { recursive: true });
    await fs.writeFile(path.join(appRoot, "applet"), "fixture app\n");
    await fs.chmod(path.join(appRoot, "applet"), 0o755);
    await fs.writeFile(path.join(appRoot, "EquinoxLocal.png"), "fixture icon\n");
    await fs.writeFile(path.join(appRoot, "native-app.json"), "{}\n");
  }
  if (withSymlink) await fs.symlink("server.js", path.join(releaseRoot, "server-link.js"));

  const archivePath = path.join(root, "release.tar.gz");
  await execFile("/usr/bin/tar", ["-czf", archivePath, "-C", sourceRoot, "release"]);
  const bytes = await fs.readFile(archivePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { root, archivePath, bytes, sha256, version, target };
}

function installationFor(root) {
  const installRoot = path.join(root, "managed");
  return {
    kind: "managed",
    managed: true,
    selfUpdateSupported: true,
    installRoot,
    releasesRoot: path.join(installRoot, "releases"),
    stagingRoot: path.join(installRoot, "staging"),
    currentLink: path.join(installRoot, "current"),
    launchAgentLabel: "dev.equinox.local",
  };
}

function responseFor(bytes) {
  return new Response(bytes, {
    status: 200,
    headers: { "content-length": String(bytes.length), "content-type": "application/gzip" },
  });
}

test("verified artifact download requires exact signed bytes and SHA-256", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const destination = path.join(fixture.root, "download", "artifact.tar.gz");
  const artifact = {
    url: "https://local.sametbasbug.dev/downloads/updates/release.tar.gz",
    sha256: fixture.sha256,
    bytes: fixture.bytes.length,
  };
  const result = await downloadVerifiedUpdateArtifact(artifact, destination, {
    fetchImpl: async () => responseFor(fixture.bytes),
  });
  assert.equal(result.bytes, fixture.bytes.length);
  assert.equal(result.sha256, fixture.sha256);
  assert.deepEqual(await fs.readFile(destination), fixture.bytes);

  await assert.rejects(
    downloadVerifiedUpdateArtifact({ ...artifact, sha256: "b".repeat(64) }, `${destination}.bad`, {
      fetchImpl: async () => responseFor(fixture.bytes),
    }),
    /SHA-256 verification failed/u,
  );
  await assert.rejects(fs.lstat(`${destination}.bad`), /ENOENT/u);
});

test("archive inspection rejects symbolic links before extraction", async (t) => {
  const fixture = await makeFixture({ withSymlink: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(
    inspectEquinoxReleaseArchive(fixture.archivePath),
    /regular files and directories/u,
  );
});

test("managed release preparation verifies, extracts and atomically promotes the release tree", async (t) => {
  const fixture = await makeFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const installation = installationFor(fixture.root);
  const result = await prepareManagedEquinoxRelease({
    installation,
    manifest: {
      version: fixture.version,
      target: fixture.target,
      artifact: {
        url: "https://local.sametbasbug.dev/downloads/updates/equinox-local-4.3.0-darwin-arm64.tar.gz",
        sha256: fixture.sha256,
        bytes: fixture.bytes.length,
      },
    },
    fetchImpl: async () => responseFor(fixture.bytes),
  });

  assert.equal(result.version, "4.3.0");
  assert.equal(result.targetReleaseDir, path.join(installation.releasesRoot, "4.3.0"));
  assert.equal(JSON.parse(await fs.readFile(path.join(result.targetReleaseDir, "release.json"), "utf8")).version, "4.3.0");
  assert.equal((await fs.lstat(path.join(result.targetReleaseDir, "server.js"))).isFile(), true);
  assert.equal((await fs.readdir(installation.stagingRoot)).length, 0);

  await assert.rejects(
    prepareManagedEquinoxRelease({
      installation,
      manifest: {
        version: fixture.version,
        target: fixture.target,
        artifact: {
          url: "https://local.sametbasbug.dev/downloads/updates/equinox-local-4.3.0-darwin-arm64.tar.gz",
          sha256: fixture.sha256,
          bytes: fixture.bytes.length,
        },
      },
      fetchImpl: async () => responseFor(fixture.bytes),
    }),
    /already present/u,
  );
});

test("managed release preparation accepts the native app shell while keeping legacy releases compatible", async (t) => {
  const fixture = await makeFixture({ nativeApp: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const installation = installationFor(fixture.root);
  const result = await prepareManagedEquinoxRelease({
    installation,
    manifest: {
      version: fixture.version,
      target: fixture.target,
      artifact: {
        url: "https://local.sametbasbug.dev/downloads/updates/equinox-local-4.3.0-darwin-arm64.tar.gz",
        sha256: fixture.sha256,
        bytes: fixture.bytes.length,
      },
    },
    fetchImpl: async () => responseFor(fixture.bytes),
  });
  const metadata = JSON.parse(await fs.readFile(path.join(result.targetReleaseDir, "release.json"), "utf8"));
  assert.equal(metadata.nativeAppShellVersion, 1);
  assert.equal((await fs.lstat(path.join(result.targetReleaseDir, "runtime", "app", "applet"))).isFile(), true);
});
