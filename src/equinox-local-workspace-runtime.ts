import fs from "node:fs/promises";
import path from "node:path";

type WorkspaceRootKey =
  | "worktreeRoot"
  | "visualRoot"
  | "browserScreenshotRoot"
  | "workflowRoot"
  | "taskRoot"
  | "releaseGateRoot"
  | "observabilityRoot"
  | "repairRoot"
  | "recoveryPolicyRoot"
  | "janitorRoot";

type WorkspaceDirectoryDescriptor = Readonly<{
  key: WorkspaceRootKey;
  directory: string;
  mode: number;
  enforceMode?: boolean;
}>;

type WorkspaceContext = {rootRealPath: string};
type WorkspaceRuntimePaths = Readonly<{
  workspace: WorkspaceContext;
} & Record<WorkspaceRootKey, string>>;

type WorkspaceRuntimeOptions = {
  workspaceProjectId?: string;
  resolveProjectContext: (projectId: string | undefined) => Promise<WorkspaceContext>;
  fsImpl?: Pick<typeof fs, "readFile" | "mkdir" | "appendFile" | "chmod">;
  pathImpl?: Pick<typeof path, "join" | "dirname">;
};

const WORKSPACE_DIRECTORY_DESCRIPTORS: readonly WorkspaceDirectoryDescriptor[] = Object.freeze([
  Object.freeze({ key: "worktreeRoot", directory: "worktrees", mode: 0o755 }),
  Object.freeze({ key: "visualRoot", directory: "visual-regression", mode: 0o755 }),
  Object.freeze({
    key: "browserScreenshotRoot",
    directory: "browser-screenshots",
    mode: 0o700,
    enforceMode: true,
  }),
  Object.freeze({ key: "workflowRoot", directory: "workflows", mode: 0o700, enforceMode: true }),
  Object.freeze({ key: "taskRoot", directory: "tasks", mode: 0o700, enforceMode: true }),
  Object.freeze({ key: "releaseGateRoot", directory: "release-gates", mode: 0o700, enforceMode: true }),
  Object.freeze({ key: "observabilityRoot", directory: "observability", mode: 0o700, enforceMode: true }),
  Object.freeze({ key: "repairRoot", directory: "repairs", mode: 0o700, enforceMode: true }),
  Object.freeze({ key: "recoveryPolicyRoot", directory: "recovery-policies", mode: 0o700, enforceMode: true }),
  Object.freeze({ key: "janitorRoot", directory: "janitor", mode: 0o700, enforceMode: true }),
]);

const GIT_EXCLUDE_ENTRIES = Object.freeze([
  "/worktrees/",
  "/visual-regression/",
  "/workflows/",
  "/tasks/",
  "/release-gates/",
  "/observability/",
  "/repairs/",
  "/recovery-policies/",
  "/janitor/",
  "/V4.0_OBSERVABILITY_SELF_HEALING_PLAN.md",
]);

export function createEquinoxLocalWorkspaceRuntime({
  workspaceProjectId,
  resolveProjectContext,
  fsImpl = fs,
  pathImpl = path,
}: WorkspaceRuntimeOptions) {
  const resolveWorkspaceRuntimePaths = async (): Promise<WorkspaceRuntimePaths> => {
    const workspace = await resolveProjectContext(workspaceProjectId);
    return Object.freeze({
      workspace,
      ...Object.fromEntries(WORKSPACE_DIRECTORY_DESCRIPTORS.map(({ key, directory }) => [
        key,
        pathImpl.join(workspace.rootRealPath, directory),
      ])) as Record<WorkspaceRootKey, string>,
    });
  };

  const ensureWorkspaceRuntimeDirectories = async () => {
    const runtimePaths = await resolveWorkspaceRuntimePaths();
    const { workspace } = runtimePaths;
    const gitExcludePath = pathImpl.join(
      workspace.rootRealPath,
      ".git",
      "info",
      "exclude",
    );

    let existing = "";
    try {
      existing = await fsImpl.readFile(gitExcludePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "ENOENT") {
        throw error;
      }
    }

    const existingLines = new Set(
      existing
        .split(/\r?\n/u)
        .map((line) => line.trim()),
    );
    const missing = GIT_EXCLUDE_ENTRIES.filter((entry) => !existingLines.has(entry));

    if (missing.length > 0) {
      await fsImpl.mkdir(pathImpl.dirname(gitExcludePath), {
        recursive: true,
        mode: 0o755,
      });
      const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
      await fsImpl.appendFile(
        gitExcludePath,
        `${prefix}${missing.join("\n")}\n`,
        { mode: 0o644 },
      );
    }

    await Promise.all(WORKSPACE_DIRECTORY_DESCRIPTORS.map(({ key, mode }) =>
      fsImpl.mkdir(runtimePaths[key], {
        recursive: true,
        mode,
      }),
    ));
    for (const { key, enforceMode } of WORKSPACE_DIRECTORY_DESCRIPTORS) {
      if (enforceMode) {
        await fsImpl.chmod(runtimePaths[key], 0o700).catch(() => {});
      }
    }

    return {
      workspace,
      ...Object.fromEntries(WORKSPACE_DIRECTORY_DESCRIPTORS.map(({ key }) => [key, runtimePaths[key]])),
    };
  };

  return Object.freeze({
    resolveWorkspaceRuntimePaths,
    ensureWorkspaceRuntimeDirectories,
  });
}
