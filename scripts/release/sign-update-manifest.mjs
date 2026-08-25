import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signPayload,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalUpdateManifestPayload,
  EQUINOX_LOCAL_UPDATE_CHANNEL,
  EQUINOX_LOCAL_UPDATE_SCHEMA_VERSION,
  EQUINOX_LOCAL_SUPPORTED_UPDATE_TARGETS,
  parseEquinoxVersion,
  validateSignedUpdateManifest,
} from "../../src/equinox-local-updater.js";

const UPDATE_ORIGIN = "https://local.sametbasbug.dev";
const UPDATE_PATH_PREFIX = "/downloads/updates/";
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_PRIVATE_KEY_BYTES = 16 * 1024;

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function sha256File(filePath) {
  const handle = await fs.open(filePath, "r");
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of handle.createReadStream()) {
      bytes += chunk.length;
      digest.update(chunk);
    }
  } finally {
    await handle.close().catch(() => {});
  }
  return Object.freeze({ bytes, sha256: digest.digest("hex") });
}

export function updateArtifactUrl({ version, target }) {
  parseEquinoxVersion(version);
  if (!EQUINOX_LOCAL_SUPPORTED_UPDATE_TARGETS.includes(target)) {
    throw new Error(`Unsupported Equinox Local update target: ${target}`);
  }
  return `${UPDATE_ORIGIN}${UPDATE_PATH_PREFIX}equinox-local-${version}-${target}.tar.gz`;
}

export async function readPrivateUpdateSigningKey(privateKeyPath, {
  repositoryRoot,
  fsImpl = fs,
  uid = typeof process.getuid === "function" ? process.getuid() : null,
} = {}) {
  if (typeof privateKeyPath !== "string" || !path.isAbsolute(privateKeyPath)) {
    throw new Error("Update signing key path must be absolute.");
  }
  const resolved = path.resolve(privateKeyPath);
  if (repositoryRoot && inside(path.resolve(repositoryRoot), resolved)) {
    throw new Error("Update signing private key must live outside the repository.");
  }
  const stat = await fsImpl.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Update signing private key must be a normal file.");
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new Error("Update signing private key permissions must be 0600.");
  }
  if (Number.isInteger(uid) && Number.isInteger(stat.uid) && stat.uid !== uid) {
    throw new Error("Update signing private key must be owned by the current user.");
  }
  if (stat.size < 1 || stat.size > MAX_PRIVATE_KEY_BYTES) {
    throw new Error("Update signing private key size is invalid.");
  }
  const pem = await fsImpl.readFile(resolved, "utf8");
  const privateKey = createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Update signing key must be an Ed25519 private key.");
  }
  return privateKey;
}

export async function createSignedUpdateManifest({
  version,
  target,
  artifactPath,
  keyId,
  privateKey,
  publishedAt = new Date().toISOString(),
} = {}) {
  parseEquinoxVersion(version);
  if (!EQUINOX_LOCAL_SUPPORTED_UPDATE_TARGETS.includes(target)) {
    throw new Error(`Unsupported Equinox Local update target: ${target}`);
  }
  if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) {
    throw new Error("Update signing key id is invalid.");
  }
  const normalizedPublishedAt = new Date(publishedAt).toISOString();
  if (normalizedPublishedAt === "Invalid Date") throw new Error("Update publishedAt is invalid.");
  if (typeof artifactPath !== "string" || !path.isAbsolute(artifactPath)) {
    throw new Error("Update artifact path must be absolute.");
  }
  const artifactStat = await fs.lstat(artifactPath);
  if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
    throw new Error("Update artifact must be a normal file.");
  }
  const keyObject = typeof privateKey === "string" || Buffer.isBuffer(privateKey)
    ? createPrivateKey(privateKey)
    : privateKey;
  if (!keyObject || keyObject.asymmetricKeyType !== "ed25519") {
    throw new Error("An Ed25519 update signing private key is required.");
  }

  const digest = await sha256File(artifactPath);
  const unsigned = Object.freeze({
    schemaVersion: EQUINOX_LOCAL_UPDATE_SCHEMA_VERSION,
    channel: EQUINOX_LOCAL_UPDATE_CHANNEL,
    target,
    version,
    publishedAt: normalizedPublishedAt,
    artifact: Object.freeze({
      url: updateArtifactUrl({ version, target }),
      sha256: digest.sha256,
      bytes: digest.bytes,
    }),
  });
  const signature = signPayload(
    null,
    Buffer.from(canonicalUpdateManifestPayload(unsigned), "utf8"),
    keyObject,
  ).toString("base64");
  const manifest = Object.freeze({
    ...unsigned,
    signature: Object.freeze({
      algorithm: "ed25519",
      keyId,
      value: signature,
    }),
  });
  const publicKeyPem = createPublicKey(keyObject).export({ type: "spki", format: "pem" }).toString();

  // Fail closed before anything is written: the exact runtime verifier must accept the output.
  validateSignedUpdateManifest(manifest, {
    publicKeys: { [keyId]: publicKeyPem },
    target,
  });

  return Object.freeze({ manifest, publicKeyPem, ...digest });
}

export function renderBootstrapInstallManifest(manifest) {
  const artifact = manifest?.artifact;
  if (
    manifest?.schemaVersion !== EQUINOX_LOCAL_UPDATE_SCHEMA_VERSION ||
    manifest?.channel !== EQUINOX_LOCAL_UPDATE_CHANNEL ||
    !EQUINOX_LOCAL_SUPPORTED_UPDATE_TARGETS.includes(manifest?.target) ||
    typeof manifest?.version !== "string" ||
    typeof artifact?.url !== "string" ||
    typeof artifact?.sha256 !== "string" ||
    !Number.isSafeInteger(artifact?.bytes)
  ) {
    throw new Error("A validated Equinox Local update manifest is required for bootstrap metadata.");
  }
  parseEquinoxVersion(manifest.version);
  return [
    `schemaVersion=${manifest.schemaVersion}`,
    `channel=${manifest.channel}`,
    `target=${manifest.target}`,
    `version=${manifest.version}`,
    `artifactUrl=${artifact.url}`,
    `artifactSha256=${artifact.sha256}`,
    `artifactBytes=${artifact.bytes}`,
    "",
  ].join("\n");
}

export async function writeSignedUpdateBundle({
  repositoryRoot,
  version,
  target,
  artifactPath,
  privateKeyPath,
  keyId,
  outputDir,
  publishedAt,
} = {}) {
  const privateKey = await readPrivateUpdateSigningKey(privateKeyPath, { repositoryRoot });
  const result = await createSignedUpdateManifest({
    version,
    target,
    artifactPath,
    keyId,
    privateKey,
    publishedAt,
  });
  const resolvedOutput = path.resolve(outputDir);
  await fs.mkdir(resolvedOutput, { recursive: true, mode: 0o700 });
  const artifactName = `equinox-local-${version}-${target}.tar.gz`;
  const destinationArtifact = path.join(resolvedOutput, artifactName);
  const manifestPath = path.join(resolvedOutput, `stable-${target}.json`);
  const bootstrapManifestPath = path.join(resolvedOutput, `bootstrap-${target}.txt`);
  const installerSourcePath = path.join(path.resolve(repositoryRoot), "scripts", "install-equinox-local.sh");
  const installerPath = path.join(resolvedOutput, "install-equinox-local.sh");
  const tempManifest = `${manifestPath}.part-${process.pid}`;
  const tempBootstrapManifest = `${bootstrapManifestPath}.part-${process.pid}`;

  const sourceStat = await fs.lstat(artifactPath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("Update artifact changed before bundle write.");
  const installerStat = await fs.lstat(installerSourcePath);
  if (!installerStat.isFile() || installerStat.isSymbolicLink() || installerStat.size < 1 || installerStat.size > 64 * 1024) {
    throw new Error("Tracked Equinox Local public installer is missing or unsafe.");
  }
  await fs.copyFile(artifactPath, destinationArtifact);
  const copied = await sha256File(destinationArtifact);
  if (copied.bytes !== result.bytes || copied.sha256 !== result.sha256) {
    await fs.rm(destinationArtifact, { force: true });
    throw new Error("Copied update artifact failed final SHA-256 verification.");
  }
  await fs.copyFile(installerSourcePath, installerPath);
  await fs.chmod(installerPath, 0o644);
  const installerDigest = await sha256File(installerPath);
  try {
    await fs.writeFile(tempBootstrapManifest, renderBootstrapInstallManifest(result.manifest), { flag: "wx", mode: 0o600 });
    await fs.rename(tempBootstrapManifest, bootstrapManifestPath);
    await fs.writeFile(tempManifest, `${JSON.stringify(result.manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fs.rename(tempManifest, manifestPath);
  } catch (error) {
    await fs.rm(tempBootstrapManifest, { force: true }).catch(() => {});
    await fs.rm(tempManifest, { force: true }).catch(() => {});
    throw error;
  }
  return Object.freeze({
    artifactPath: destinationArtifact,
    manifestPath,
    bootstrapManifestPath,
    installerPath,
    installerBytes: installerDigest.bytes,
    installerSha256: installerDigest.sha256,
    publicKeyPem: result.publicKeyPem,
    bytes: result.bytes,
    sha256: result.sha256,
  });
}

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error("Signing CLI expects --flag value pairs.");
    values[flag.slice(2)] = value;
  }
  const allowed = new Set(["version", "target", "artifact", "key-id", "key-file", "output"]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw new Error(`Unsupported signing argument: --${key}`);
  }
  for (const required of ["version", "target", "artifact", "key-id", "key-file", "output"]) {
    if (!values[required]) throw new Error(`Missing required signing argument: --${required}`);
  }
  return values;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && import.meta.url === invokedPath) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  Promise.resolve()
    .then(async () => {
      const args = parseCli(process.argv.slice(2));
      const result = await writeSignedUpdateBundle({
        repositoryRoot,
        version: args.version,
        target: args.target,
        artifactPath: path.resolve(args.artifact),
        privateKeyPath: path.resolve(args["key-file"]),
        keyId: args["key-id"],
        outputDir: path.resolve(args.output),
      });
      process.stdout.write(`${JSON.stringify({
        artifactPath: result.artifactPath,
        manifestPath: result.manifestPath,
        bootstrapManifestPath: result.bootstrapManifestPath,
        installerPath: result.installerPath,
        installerBytes: result.installerBytes,
        installerSha256: result.installerSha256,
        bytes: result.bytes,
        sha256: result.sha256,
        publicKeyPem: result.publicKeyPem,
      }, null, 2)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
