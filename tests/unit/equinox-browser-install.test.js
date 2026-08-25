import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const INSTALL = path.join(ROOT, "scripts", "install-browser-host.sh");
const UNINSTALL = path.join(ROOT, "scripts", "uninstall-browser-host.sh");
const PRODUCTION_ID = "npdneefcobilfkjlihghjgjnknenhfoj";
const LEGACY_ID = "kdjmfldngbfaillaamoinegmogfkhdfn";

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("native host install/update/uninstall is idempotent and supports dual-id migration", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-browser-install-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home };
  const runtimeDir = path.join(home, "Library", "Application Support", "Equinox Local");
  const manifestPath = path.join(
    home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    "dev.equinox.browser.json",
  );

  await execFileAsync("/bin/bash", [INSTALL], { env });
  const firstManifestText = await fs.readFile(manifestPath, "utf8");
  const firstManifest = JSON.parse(firstManifestText);
  assert.deepEqual(firstManifest.allowed_origins, [`chrome-extension://${PRODUCTION_ID}/`]);
  assert.equal(firstManifest.path, path.join(runtimeDir, "equinox-browser-native-host"));

  const sourceHost = await fs.readFile(path.join(ROOT, "src", "equinox-browser-native-host.js"));
  const sourceRuntime = await fs.readFile(path.join(ROOT, "src", "equinox-browser-native-host-runtime.js"));
  assert.deepEqual(await fs.readFile(path.join(runtimeDir, "equinox-browser-native-host.js")), sourceHost);
  assert.deepEqual(await fs.readFile(path.join(runtimeDir, "equinox-browser-native-host-runtime.js")), sourceRuntime);

  await execFileAsync("/bin/bash", [INSTALL], { env });
  assert.equal(await fs.readFile(manifestPath, "utf8"), firstManifestText);

  await execFileAsync("/bin/bash", [INSTALL, PRODUCTION_ID, LEGACY_ID], { env });
  const migrationManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.deepEqual(migrationManifest.allowed_origins, [
    `chrome-extension://${PRODUCTION_ID}/`,
    `chrome-extension://${LEGACY_ID}/`,
  ]);

  await execFileAsync("/bin/bash", [INSTALL], { env });
  assert.deepEqual(JSON.parse(await fs.readFile(manifestPath, "utf8")).allowed_origins, [`chrome-extension://${PRODUCTION_ID}/`]);

  await execFileAsync("/bin/bash", [UNINSTALL], { env });
  await execFileAsync("/bin/bash", [UNINSTALL], { env });
  assert.equal(await exists(manifestPath), false);
  assert.equal(await exists(path.join(runtimeDir, "equinox-browser-native-host")), false);
  assert.equal(await exists(path.join(runtimeDir, "equinox-browser-native-host.js")), false);
  assert.equal(await exists(path.join(runtimeDir, "equinox-browser-native-host-runtime.js")), false);
});
