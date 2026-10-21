import path from "node:path";

export type GitWorktreeRecord = {
  path:string;
  head:string|null;
  branch:string|null;
  bare:boolean;
  detached:boolean;
  locked:boolean;
  lockReason:string|null;
  prunable:boolean;
  pruneReason:string|null;
};

export type PublicWorktreeRecord = GitWorktreeRecord & {
  managed:boolean;
  workspaceRelativePath:string|null;
};

// Lexical containment only. Callers admitting filesystem access must separately
// enforce resolved-root and symlink ownership rules.
export function isPathInside(rootPath:string, targetPath:string):boolean {
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

export function parseGitWorktreePorcelain(text:unknown):GitWorktreeRecord[] {
  const records:GitWorktreeRecord[] = [];
  let current:GitWorktreeRecord|null = null;

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
}: {
  record:GitWorktreeRecord;
  workspaceRoot:string;
}):PublicWorktreeRecord {
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
