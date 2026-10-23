import assert from "node:assert/strict";
import test from "node:test";

import { installPinnedPeekabooRuntime, installPinnedTunnelRuntime } from "../../scripts/release/package-managed-release.mjs";

test("source runtime sync pinned packager exports match the narrow authored TypeScript declarations", () => {
  assert.equal(typeof installPinnedPeekabooRuntime, "function");
  assert.equal(installPinnedPeekabooRuntime.length, 1, "Peekaboo installer requires a release directory");
  assert.equal(typeof installPinnedTunnelRuntime, "function");
  assert.equal(installPinnedTunnelRuntime.length, 2, "Tunnel installer requires target and release directory");
});
