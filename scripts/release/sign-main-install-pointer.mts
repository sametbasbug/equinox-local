import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readPrivateUpdateSigningKey } from "./sign-update-manifest.mjs";
import { readBoundedNormalFile } from "../../src/equinox-local-safe-file.js";
import { createSignedMainInstallPointer } from "../../src/equinox-local-main-install-pointer.js";
import { EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS } from "../../src/equinox-local-platform.js";

const SOURCE_SHA = /^[a-f0-9]{40}$/u;
const MAX_MANIFEST = 16 * 1024;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(args: string[]) {
  if (args.length !== 12) throw new Error("Expected exact --source-sha --version --manifest-dir --key-file --key-id --output pairs.");
  const result = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1]!;
    if (!["--source-sha", "--version", "--manifest-dir", "--key-file", "--key-id", "--output"].includes(key) ||
      result.has(key) || !value || value.startsWith("--")) {
      throw new Error("Signed Main pointer command arguments are invalid.");
    }
    result.set(key, value);
  }
  return result;
}

async function signFromVerifiedNativeManifestFiles(args: string[]) {
  const parsed = parseArgs(args);
  const sourceSha = parsed.get("--source-sha")!;
  if (!SOURCE_SHA.test(sourceSha)) throw new Error("Signed Main source SHA must be the complete Git commit.");
  const directory = path.resolve(parsed.get("--manifest-dir")!);
  const output = path.resolve(parsed.get("--output")!);
  const keyPath = path.resolve(parsed.get("--key-file")!);
  if (!path.isAbsolute(parsed.get("--key-file")!) || !path.isAbsolute(parsed.get("--manifest-dir")!) ||
    !path.isAbsolute(parsed.get("--output")!)) {
    throw new Error("Signing input/output/key paths must be absolute.");
  }
  const privateKey = await readPrivateUpdateSigningKey(keyPath, { repositoryRoot: ROOT });
  const manifests = [];
  for (const target of EQUINOX_LOCAL_SUPPORTED_RELEASE_TARGETS) {
    const file = path.join(directory, "equinox-local-main-" + sourceSha + "-" + target + ".json");
    const { data } = await readBoundedNormalFile(file, {
      minBytes: 1, maxBytes: MAX_MANIFEST, encoding: "utf8", label: "Main native snapshot manifest",
    });
    manifests.push(JSON.parse(data));
  }
  const pointer = createSignedMainInstallPointer({
    sourceSha,
    version: parsed.get("--version")!,
    publishedAt: new Date().toISOString(),
    nativeManifests: manifests,
    keyId: parsed.get("--key-id")!,
    privateKey,
  });
  const handle = await open(output, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(pointer, null, 2) + "\n", "utf8");
  } finally {
    await handle.close();
  }
  return pointer;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const pointer = await signFromVerifiedNativeManifestFiles(process.argv.slice(2));
    process.stdout.write("Signed Main pointer created for " + pointer.sourceSha + "; version " + pointer.version + "\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : "Signing failed") + "\n");
    process.exitCode = 1;
  }
}
