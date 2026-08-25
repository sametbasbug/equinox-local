import path from "node:path";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,59}$/u;

export function validateWorktreeSlug(slug) {
  if (typeof slug !== "string" || !SLUG_PATTERN.test(slug)) {
    throw new Error(
      "Worktree slug değeri küçük harf, sayı, nokta, alt çizgi veya tire içermeli ve 1-60 karakter olmalı.",
    );
  }

  return slug;
}

export function isPathInside(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);

  return (
    relative === "" ||
    (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

export function buildManagedWorktreePath({
  workspaceRoot,
  projectId,
  slug,
}) {
  validateWorktreeSlug(slug);

  const target = path.resolve(
    workspaceRoot,
    "worktrees",
    projectId,
    slug,
  );

  if (!isPathInside(workspaceRoot, target)) {
    throw new Error("Yönetilen worktree yolu workspace dışına çıkıyor.");
  }

  return target;
}

export function parseGitWorktreePorcelain(text) {
  const records = [];
  let current = null;

  const flush = () => {
    if (current?.path) {
      records.push(current);
    }
    current = null;
  };

  for (const rawLine of String(text ?? "").split(/\r?\n/u)) {
    const line = rawLine.trimEnd();

    if (!line) {
      flush();
      continue;
    }

    const separator = line.indexOf(" ");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1);

    if (key === "worktree") {
      flush();
      current = {
        path: value,
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false,
        pruneReason: null,
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (key === "HEAD") {
      current.head = value || null;
    } else if (key === "branch") {
      current.branch = value
        ? value.replace(/^refs\/heads\//u, "")
        : null;
    } else if (key === "bare") {
      current.bare = true;
    } else if (key === "detached") {
      current.detached = true;
    } else if (key === "locked") {
      current.locked = true;
      current.lockReason = value || null;
    } else if (key === "prunable") {
      current.prunable = true;
      current.pruneReason = value || null;
    }
  }

  flush();
  return records;
}

export function publicWorktreeRecord({
  record,
  workspaceRoot,
}) {
  const managedRoot = path.resolve(workspaceRoot, "worktrees");
  const managed = isPathInside(managedRoot, path.resolve(record.path));

  return {
    ...record,
    managed,
    workspaceRelativePath: managed
      ? path.relative(workspaceRoot, record.path)
      : null,
  };
}

export const __test = Object.freeze({
  SLUG_PATTERN,
});
