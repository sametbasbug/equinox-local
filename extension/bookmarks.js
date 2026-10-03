(function installEquinoxBrowserBookmarks(global) {
  "use strict";

  const BOOKMARKS_VERSION = 2;
  const MAX_BOOKMARK_PATH_DEPTH = 16;
  const MAX_BOOKMARK_PATH_CHARS = 2_000;

  function createBrowserBookmarksCapability({
    chrome,
    getBrowserContext,
    ensureBrowserIdentityLoaded,
    safeObservedUrl,
    bookmarksVersion = BOOKMARKS_VERSION,
  } = {}) {
    async function requireAgentBookmarkContext() {
      await ensureBrowserIdentityLoaded();
      if (getBrowserContext() !== "agent") {
        throw new Error("Bookmark automation is available only in Agent Browser; Your Browser bookmarks are intentionally unavailable.");
      }
      if (!chrome.bookmarks) throw new Error("Chrome bookmarks API is unavailable in this extension context.");
    }

    function normalizeBookmarkId(value, field = "bookmark id") {
      const normalized = String(value == null ? "" : value).trim();
      if (!normalized || normalized.length > 128 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
        throw new Error(`${field} must be a bounded Chrome bookmark id.`);
      }
      return normalized;
    }

    function normalizeBookmarkTitle(value, { allowEmpty = true } = {}) {
      const normalized = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
      if ((!allowEmpty && !normalized) || normalized.length > 500) {
        throw new Error(`Bookmark title must be ${allowEmpty ? "at most" : "between 1 and"} 500 characters.`);
      }
      return normalized;
    }

    function normalizeBookmarkUrl(value) {
      const raw = String(value == null ? "" : value).trim();
      if (!raw || raw.length > 4_000) throw new Error("Bookmark URL must be between 1 and 4000 characters.");
      let parsed;
      try {
        parsed = new URL(raw);
      } catch {
        throw new Error("Bookmark URL must be a valid HTTP(S) URL.");
      }
      if (!new Set(["http:", "https:"]).has(parsed.protocol)) throw new Error("Bookmark URL must use http or https.");
      return parsed.toString();
    }

    function normalizeBookmarkLimit(value) {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Bookmark result limit must be an integer between 1 and 100.");
      return limit;
    }

    function normalizeBookmarkIndex(value) {
      const index = Number(value);
      if (!Number.isInteger(index) || index < 0 || index > 100_000) throw new Error("Bookmark index must be an integer between 0 and 100000.");
      return index;
    }

    function projectBookmarkNode(node) {
      return {
        id: String(node?.id || ""),
        parentId: node?.parentId == null ? null : String(node.parentId),
        index: Number.isInteger(node?.index) ? node.index : null,
        title: String(node?.title || "").slice(0, 500),
        url: node?.url ? safeObservedUrl(node.url) : null,
        type: node?.url ? "bookmark" : "folder",
      };
    }

    async function bookmarkNodeById(id, cache) {
      const normalizedId = String(id || "");
      if (!normalizedId) return null;
      if (cache.has(normalizedId)) return cache.get(normalizedId);
      const nodes = await chrome.bookmarks.get(normalizedId);
      const node = nodes?.[0] || null;
      cache.set(normalizedId, node);
      return node;
    }

    async function bookmarkFolderPath(folderId, cache) {
      let currentId = folderId == null ? null : String(folderId);
      if (!currentId || currentId === "0") return { path: "", truncated: false };
      const segments = [];
      const seen = new Set();
      let truncated = false;
      let depth = 0;
      while (currentId && currentId !== "0") {
        if (depth >= MAX_BOOKMARK_PATH_DEPTH || seen.has(currentId)) {
          truncated = true;
          break;
        }
        seen.add(currentId);
        const node = await bookmarkNodeById(currentId, cache);
        if (!node) break;
        const title = normalizeBookmarkTitle(node.title);
        if (title) segments.unshift(title);
        currentId = node.parentId == null ? null : String(node.parentId);
        depth += 1;
      }
      let path = segments.join(" / ");
      if (path.length > MAX_BOOKMARK_PATH_CHARS) {
        path = `… / ${path.slice(-(MAX_BOOKMARK_PATH_CHARS - 4))}`;
        truncated = true;
      }
      return { path, truncated };
    }

    async function projectBookmarkNodeWithPath(node, cache) {
      const projected = projectBookmarkNode(node);
      const parent = await bookmarkFolderPath(projected.parentId, cache);
      let path = [parent.path, projected.title].filter(Boolean).join(" / ");
      let pathTruncated = parent.truncated;
      if (path.length > MAX_BOOKMARK_PATH_CHARS) {
        path = `… / ${path.slice(-(MAX_BOOKMARK_PATH_CHARS - 4))}`;
        pathTruncated = true;
      }
      return {
        ...projected,
        parentPath: parent.path || null,
        path: path || null,
        pathTruncated,
      };
    }

    async function browserBookmarksList({ parentId = "0", limit = 50 } = {}) {
      await requireAgentBookmarkContext();
      const normalizedParentId = normalizeBookmarkId(parentId, "parentId");
      const boundedLimit = normalizeBookmarkLimit(limit);
      const cache = new Map();
      const folderNode = normalizedParentId === "0"
        ? { id: "0", parentId: null, index: 0, title: "" }
        : await bookmarkNodeById(normalizedParentId, cache);
      if (!folderNode) throw new Error(`Bookmark folder not found: ${normalizedParentId}`);
      if (folderNode.url) throw new Error(`Bookmark id ${normalizedParentId} is not a folder.`);
      cache.set(normalizedParentId, folderNode);
      const folderPath = await bookmarkFolderPath(normalizedParentId, cache);
      const nodes = await chrome.bookmarks.getChildren(normalizedParentId);
      const items = [];
      for (const node of nodes.slice(0, boundedLimit)) items.push(await projectBookmarkNodeWithPath(node, cache));
      return {
        bookmarksVersion: bookmarksVersion,
        parentId: normalizedParentId,
        folder: {
          id: normalizedParentId,
          title: String(folderNode.title || "").slice(0, 500),
          path: folderPath.path || null,
          pathTruncated: folderPath.truncated,
        },
        items,
        returned: Math.min(nodes.length, boundedLimit),
        totalChildren: nodes.length,
        truncated: nodes.length > boundedLimit,
      };
    }

    async function browserBookmarksSearch({ query, limit = 50 } = {}) {
      await requireAgentBookmarkContext();
      const normalizedQuery = String(query == null ? "" : query).trim();
      if (!normalizedQuery || normalizedQuery.length > 500) throw new Error("Bookmark search query must be between 1 and 500 characters.");
      const boundedLimit = normalizeBookmarkLimit(limit);
      const cache = new Map();
      const nodes = await chrome.bookmarks.search(normalizedQuery);
      const items = [];
      for (const node of nodes.slice(0, boundedLimit)) items.push(await projectBookmarkNodeWithPath(node, cache));
      return {
        bookmarksVersion: bookmarksVersion,
        query: normalizedQuery,
        items,
        returned: Math.min(nodes.length, boundedLimit),
        totalMatches: nodes.length,
        truncated: nodes.length > boundedLimit,
      };
    }

    async function browserBookmarkAdd({ title, url, parentId, index } = {}) {
      await requireAgentBookmarkContext();
      const created = await chrome.bookmarks.create({
        ...(parentId != null ? { parentId: normalizeBookmarkId(parentId, "parentId") } : {}),
        ...(index != null ? { index: normalizeBookmarkIndex(index) } : {}),
        title: normalizeBookmarkTitle(title, { allowEmpty: false }),
        url: normalizeBookmarkUrl(url),
      });
      const item = await projectBookmarkNodeWithPath(created, new Map());
      return { bookmarksVersion: bookmarksVersion, item };
    }

    async function browserBookmarkFolderCreate({ title, parentId, index } = {}) {
      await requireAgentBookmarkContext();
      const created = await chrome.bookmarks.create({
        ...(parentId != null ? { parentId: normalizeBookmarkId(parentId, "parentId") } : {}),
        ...(index != null ? { index: normalizeBookmarkIndex(index) } : {}),
        title: normalizeBookmarkTitle(title, { allowEmpty: false }),
      });
      const item = await projectBookmarkNodeWithPath(created, new Map());
      return { bookmarksVersion: bookmarksVersion, item };
    }

    async function browserBookmarkUpdateMove({ id, title, url, parentId, index } = {}) {
      await requireAgentBookmarkContext();
      const normalizedId = normalizeBookmarkId(id);
      const existing = await chrome.bookmarks.get(normalizedId);
      const original = existing?.[0];
      if (!original) throw new Error(`Bookmark not found: ${normalizedId}`);
      const update = {};
      if (title != null) update.title = normalizeBookmarkTitle(title);
      if (url != null) {
        if (!original.url) throw new Error("A bookmark folder cannot be converted into a URL bookmark.");
        update.url = normalizeBookmarkUrl(url);
      }
      const move = {};
      if (parentId != null) move.parentId = normalizeBookmarkId(parentId, "parentId");
      if (index != null) move.index = normalizeBookmarkIndex(index);
      if (Object.keys(update).length === 0 && Object.keys(move).length === 0) {
        throw new Error("Bookmark update/move requires title, url, parentId and/or index.");
      }
      let node = original;
      let updated = false;
      try {
        if (Object.keys(update).length > 0) {
          node = await chrome.bookmarks.update(normalizedId, update);
          updated = true;
        }
        if (Object.keys(move).length > 0) node = await chrome.bookmarks.move(normalizedId, move);
      } catch (error) {
        if (updated && Object.keys(move).length > 0) {
          await chrome.bookmarks.update(normalizedId, {
            title: String(original.title || ""),
            ...(original.url ? { url: original.url } : {}),
          }).catch(() => {});
        }
        throw error;
      }
      const item = await projectBookmarkNodeWithPath(node, new Map());
      return { bookmarksVersion: bookmarksVersion, item };
    }

    async function browserBookmarkRemove({ id, recursive = false } = {}) {
      await requireAgentBookmarkContext();
      const normalizedId = normalizeBookmarkId(id);
      const existing = await chrome.bookmarks.get(normalizedId);
      const node = existing?.[0];
      if (!node) throw new Error(`Bookmark not found: ${normalizedId}`);
      const removed = await projectBookmarkNodeWithPath(node, new Map());
      if (!node.url && recursive) await chrome.bookmarks.removeTree(normalizedId);
      else await chrome.bookmarks.remove(normalizedId);
      return { bookmarksVersion: bookmarksVersion, removed, recursive: Boolean(recursive && !node.url) };
    }

    return Object.freeze({
      browserBookmarksList,
      browserBookmarksSearch,
      browserBookmarkAdd,
      browserBookmarkFolderCreate,
      browserBookmarkUpdateMove,
      browserBookmarkRemove,
    });
  }

  global.EquinoxBrowserBookmarks = Object.freeze({
    BOOKMARKS_VERSION,
    createBrowserBookmarksCapability,
  });
})(globalThis);
