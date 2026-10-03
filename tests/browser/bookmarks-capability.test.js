import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createExtensionVmContext } from "../helpers/extension-vm-import-scripts.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EXTENSION_ROOT = path.join(REPO_ROOT, "extension");

function bookmarkFixture() {
  const calls = [];
  const nodes = new Map([
    ["0", { id: "0", title: "", parentId: null, index: 0 }],
    ["1", { id: "1", title: "Bookmarks bar", parentId: "0", index: 0 }],
    ["2", { id: "2", title: "Other bookmarks", parentId: "0", index: 1 }],
    ["10", { id: "10", title: "Original", parentId: "1", index: 0, url: "https://example.test/?token=secret" }],
  ]);
  let failMove = false;
  return {
    calls,
    nodes,
    chrome: {
      bookmarks: {
        async get(id) { calls.push(["get", String(id)]); return nodes.has(String(id)) ? [{ ...nodes.get(String(id)) }] : []; },
        async getChildren(id) { calls.push(["getChildren", String(id)]); return [...nodes.values()].filter((node) => node.parentId === String(id)).map((node) => ({ ...node })); },
        async search(query) { calls.push(["search", query]); return [...nodes.values()].filter((node) => node.title.includes(query)).map((node) => ({ ...node })); },
        async create(details) { calls.push(["create", { ...details }]); const node = { id: "20", index: 0, parentId: "1", ...details }; nodes.set(node.id, node); return { ...node }; },
        async update(id, changes) { calls.push(["update", String(id), { ...changes }]); Object.assign(nodes.get(String(id)), changes); return { ...nodes.get(String(id)) }; },
        async move(id, destination) { calls.push(["move", String(id), { ...destination }]); if (failMove) throw new Error("move failed"); Object.assign(nodes.get(String(id)), destination); return { ...nodes.get(String(id)) }; },
        async remove(id) { calls.push(["remove", String(id)]); nodes.delete(String(id)); },
        async removeTree(id) { calls.push(["removeTree", String(id)]); nodes.delete(String(id)); },
      },
    },
    failMove(value) { failMove = value; },
  };
}

function createCapability(fixture, context = "agent") {
  const worker = createExtensionVmContext({
    sandbox: {},
    extensionRoot: EXTENSION_ROOT,
    allowedScripts: ["bookmarks.js"],
  });
  worker.importScripts("bookmarks.js");
  return worker.EquinoxBrowserBookmarks.createBrowserBookmarksCapability({
    chrome: fixture.chrome,
    getBrowserContext: () => context,
    ensureBrowserIdentityLoaded: async () => {},
    safeObservedUrl(rawUrl) {
      const parsed = new URL(rawUrl);
      if (parsed.searchParams.has("token")) parsed.searchParams.set("token", "[REDACTED]");
      parsed.hash = "";
      return parsed.toString();
    },
  });
}

test("classic bookmarks capability bounds results and projects URLs through redaction", async () => {
  const fixture = bookmarkFixture();
  const capability = createCapability(fixture);
  const result = await capability.browserBookmarksList({ parentId: "1", limit: 1 });
  assert.equal(result.bookmarksVersion, 2);
  assert.equal(result.returned, 1);
  assert.equal(result.items[0].url, "https://example.test/?token=%5BREDACTED%5D");
  assert.equal(result.items[0].path, "Bookmarks bar / Original");
  await assert.rejects(capability.browserBookmarksSearch({ query: "a", limit: 101 }), /between 1 and 100/u);
});

test("classic bookmarks capability fails closed outside Agent Browser before touching Chrome", async () => {
  const fixture = bookmarkFixture();
  const capability = createCapability(fixture, "user");
  await assert.rejects(capability.browserBookmarksList({}), /only in Agent Browser/u);
  assert.deepEqual(fixture.calls, []);
});

test("bookmark title update is rolled back when the subsequent move fails", async () => {
  const fixture = bookmarkFixture();
  fixture.failMove(true);
  const capability = createCapability(fixture);
  await assert.rejects(
    capability.browserBookmarkUpdateMove({ id: "10", title: "Changed", parentId: "2" }),
    /move failed/u,
  );
  assert.deepEqual(fixture.calls.filter(([method]) => method === "update").map(([, , changes]) => changes), [
    { title: "Changed" },
    { title: "Original", url: "https://example.test/?token=secret" },
  ]);
  assert.equal(fixture.nodes.get("10").title, "Original");
});
