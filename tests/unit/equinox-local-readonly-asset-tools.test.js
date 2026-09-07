import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";

import { registerReadonlyAssetTools } from "../../src/equinox-local-readonly-asset-tools.js";

function fileEntry(name, { file = true, symlink = false } = {}) {
  return {
    name,
    isFile: () => file,
    isSymbolicLink: () => symlink,
  };
}

function createHarness(overrides = {}) {
  const registrations = new Map();
  const inspected = [];
  const textResult = (text) => ({ content: [{ type: "text", text }] });
  const errorResult = (error) => ({
    content: [{ type: "text", text: `Hata: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  });

  const dependencies = {
    registerTextTool(name, config, handler, options = {}) {
      registrations.set(name, { config, handler, options });
    },
    z,
    resolveAssetInboxRoot: async () => "/tmp/Equinox-Local-Inbox",
    fsImpl: {
      async readdir() {
        return [fileEntry("b.png"), fileEntry(".hidden.png"), fileEntry("link.png", { symlink: true }), fileEntry("a.svg")];
      },
    },
    inspectInboxAsset: async (name) => {
      inspected.push(name);
      if (name === "a.svg") {
        return {
          fileName: name,
          kind: "svg",
          mime: "image/svg+xml",
          extension: ".svg",
          sha256: "a".repeat(64),
          stats: { size: 1500 },
        };
      }
      return {
        fileName: name,
        kind: "png",
        mime: "image/png",
        extension: ".png",
        sha256: "b".repeat(64),
        stats: { size: 2048 },
      };
    },
    formatAssetBytes: (bytes) => `${bytes} B`,
    textResult,
    errorResult,
    ...overrides,
  };

  registerReadonlyAssetTools(dependencies);
  return { registrations, inspected };
}

test("readonly asset tools preserve project-independent registration metadata", () => {
  const { registrations } = createHarness();
  assert.deepEqual([...registrations.keys()], ["list_asset_inbox", "inspect_inbox_asset"]);

  for (const registration of registrations.values()) {
    assert.equal(registration.config.annotations.readOnlyHint, true);
    assert.equal(registration.config.annotations.destructiveHint, false);
    assert.equal(registration.config.annotations.idempotentHint, true);
    assert.equal(registration.config.annotations.openWorldHint, false);
    assert.deepEqual(registration.options, { projectAware: false });
  }
});

test("list_asset_inbox filters, sorts and bounds candidates before inspection", async () => {
  const { registrations, inspected } = createHarness();
  const result = await registrations.get("list_asset_inbox").handler({ max_results: 1 });

  assert.deepEqual(inspected, ["a.svg"]);
  assert.match(result.content[0].text, /Inbox: \/tmp\/Equinox-Local-Inbox/u);
  assert.match(result.content[0].text, new RegExp(`a\\.svg \\| svg \\| 1500 B \\| ${"a".repeat(64)}`, "u"));
  assert.match(result.content[0].text, /Liste sonuç sınırı veya desteklenmeyen\/gizli öğeler/u);
});

test("inspect_inbox_asset preserves SVG and binary validation messages", async () => {
  const { registrations } = createHarness();
  const svg = await registrations.get("inspect_inbox_asset").handler({ file: "a.svg" });
  assert.match(svg.content[0].text, /MIME: image\/svg\+xml/u);
  assert.match(svg.content[0].text, /SVG aktif kod ve dış kaynak kontrollerinden geçti/u);

  const png = await registrations.get("inspect_inbox_asset").handler({ file: "b.png" });
  assert.match(png.content[0].text, /MIME: image\/png/u);
  assert.match(png.content[0].text, /Dosya uzantısı ile ikili imzası eşleşiyor/u);
});
