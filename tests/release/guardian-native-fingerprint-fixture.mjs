import { fingerprintEquinoxLocalNativeState } from "../../src/equinox-local-native-state-fingerprint.js";

// Hosted Windows installed-client acceptance only. This file does not write
// state; it computes the canonical JS fingerprint for a disposable native slot.
const [root] = process.argv.slice(2);
if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "win32" || !root) {
  console.error("Guardian fingerprint fixture requires an exact hosted Windows root.");
  process.exitCode = 2;
} else {
  const fingerprint = await fingerprintEquinoxLocalNativeState(root);
  process.stdout.write(`${JSON.stringify(fingerprint)}\n`);
}
