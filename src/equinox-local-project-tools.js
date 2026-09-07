export function registerProjectDiscoveryTools({
  registerTextTool,
  projectIds,
  projectDefinitions,
  fileRootIds,
  fileRootDefinitions,
  fullFileAccess,
  defaultProject,
  resolveProjectContext,
  resolveFileRootContext,
  execFileImpl,
  fsImpl,
  gitEnv,
  textResult,
} = {}) {
  registerTextTool(
    "list_projects",
    {
      description:
        "Equinox Local için yapılandırılmış proje/kök kısayollarını ve etkin Agent Access dosya modunu listeler. Full modda home veya erişilebilir mutlak klasör yolu ayrıca doğrudan kullanılabilir.",
      inputSchema: {},
      annotations: {
        title: "Proje ve erişim köklerini listele",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const sections = [];

      for (const projectId of projectIds) {
        const definition = projectDefinitions[projectId];

        try {
          const context = await resolveProjectContext(projectId);
          const gitResult = await execFileImpl(
            "/usr/bin/git",
            ["rev-parse", "--show-toplevel"],
            {
              cwd: context.rootRealPath,
              timeout: 15_000,
              maxBuffer: 1024 * 1024,
              env: {
                ...gitEnv,
                GIT_OPTIONAL_LOCKS: "0",
                GIT_TERMINAL_PROMPT: "0",
                LC_ALL: "C",
              },
            },
          );
          const gitRoot = await fsImpl.realpath(gitResult.stdout.trim());

          if (gitRoot !== context.rootRealPath) {
            throw new Error("İzinli yol bağımsız Git repo kökü değil.");
          }

          const [branchResult, statusResult, originResult] = await Promise.all([
            execFileImpl(
              "/usr/bin/git",
              ["symbolic-ref", "--quiet", "--short", "HEAD"],
              {
                cwd: context.rootRealPath,
                timeout: 15_000,
                maxBuffer: 1024 * 1024,
                env: {
                  ...gitEnv,
                  GIT_OPTIONAL_LOCKS: "0",
                  GIT_TERMINAL_PROMPT: "0",
                  LC_ALL: "C",
                },
              },
            ).catch(() => ({ stdout: "DETACHED" })),
            execFileImpl(
              "/usr/bin/git",
              ["status", "--porcelain=v1", "--untracked-files=all"],
              {
                cwd: context.rootRealPath,
                timeout: 15_000,
                maxBuffer: 2 * 1024 * 1024,
                env: {
                  ...gitEnv,
                  GIT_OPTIONAL_LOCKS: "0",
                  GIT_TERMINAL_PROMPT: "0",
                  LC_ALL: "C",
                },
              },
            ),
            execFileImpl(
              "/usr/bin/git",
              ["remote", "get-url", "origin"],
              {
                cwd: context.rootRealPath,
                timeout: 15_000,
                maxBuffer: 1024 * 1024,
                env: {
                  ...gitEnv,
                  GIT_OPTIONAL_LOCKS: "0",
                  GIT_TERMINAL_PROMPT: "0",
                  LC_ALL: "C",
                },
              },
            ).catch(() => ({ stdout: "" })),
          ]);

          const changeCount = statusResult.stdout
            .split("\n")
            .filter(Boolean)
            .length;
          const origin = String(originResult.stdout ?? "")
            .replace(/https?:\/\/[^@\s/]+@/gi, "https://[REDACTED]@")
            .trim();

          sections.push(
            [
              `${projectId} — ${definition.name}`,
              `Kök: ${context.rootRealPath}`,
              `Branch: ${String(branchResult.stdout ?? "").trim() || "DETACHED"}`,
              `Çalışma ağacı: ${changeCount === 0 ? "Temiz" : `${changeCount} değişiklik`}`,
              `Origin: ${origin || "Yok"}`,
            ].join("\n"),
          );
        } catch (error) {
          sections.push(
            [
              `${projectId} — ${definition.name}`,
              `Kök: ${definition.root}`,
              "Durum: Kullanılamıyor",
              `Neden: ${error instanceof Error ? error.message : String(error)}`,
            ].join("\n"),
          );
        }
      }

      for (const rootId of fileRootIds) {
        if (projectDefinitions[rootId]) continue;

        const definition = fileRootDefinitions[rootId];
        try {
          const context = await resolveFileRootContext(rootId);
          sections.push(
            [
              `${rootId} — ${definition.name}`,
              `Kök: ${context.rootRealPath}`,
              "Tür: Yapılandırılmış dosya kökü",
              "Genel dosya CRUD/arama wrapperları Terminal-first akışına taşındı; özel capability’ler kendi kök kurallarını uygular.",
            ].join("\n"),
          );
        } catch (error) {
          sections.push(
            [
              `${rootId} — ${definition.name}`,
              `Kök: ${definition.root}`,
              "Durum: Kullanılamıyor",
              `Neden: ${error instanceof Error ? error.message : String(error)}`,
            ].join("\n"),
          );
        }
      }

      return textResult(
        [
          `Dosya erişim modu: ${fullFileAccess ? "FULL" : "SELECTED"}`,
          `Varsayılan proje: ${defaultProject}`,
          fullFileAccess
            ? "Yapılandırılmış kimliklerin yanında project alanında home veya erişilebilir mutlak klasör yolu kullanılabilir. Git araçları seçilen kökün Git repo olmasını ayrıca doğrular."
            : "Git araçlarında project; dosya araçlarında project alanı yalnız yapılandırılmış kökü seçer.",
          ...sections,
        ].join("\n\n"),
      );
    },
    {
      projectAware: false,
    },
  );

}
