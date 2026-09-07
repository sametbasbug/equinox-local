export function registerGithubReadonlyTools({
  registerTextTool,
  z,
  assertGhAuthenticated,
  getGitHubRepoSlug,
  readPullRequestByNumber,
  runGhWithCode,
  parsePullRequestChecksResult,
  parseJsonOutput,
  readWorkflowRunById,
  formatWorkflowJobs,
  sanitizeGitNetworkOutput,
  textResult,
  errorResult,
} = {}) {
  registerTextTool(
    "get_pull_request",
    {
      description:
        "Seçilen GitHub deposundaki bir pull request'in branch, SHA, draft, merge ve değişiklik bilgilerini salt okunur biçimde gösterir.",
      inputSchema: {
        pr_number: z.number().int().min(1),
      },
      annotations: {
        title: "Pull request bilgisi",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ pr_number }) => {
      try {
        await assertGhAuthenticated();
        const repoSlug = await getGitHubRepoSlug();
        const pr = await readPullRequestByNumber(
          repoSlug,
          pr_number,
        );

        return textResult(
          [
            `PR #${pr.number}: ${pr.title}`,
            `Adres: ${pr.url}`,
            `Durum: ${pr.state}`,
            `Draft: ${pr.isDraft ? "Evet" : "Hayır"}`,
            `Base: ${pr.baseRefName} (${pr.baseRefOid})`,
            `Head: ${pr.headRefName} (${pr.headRefOid})`,
            `Mergeable: ${pr.mergeable}`,
            `Merge state: ${pr.mergeStateStatus}`,
            `Review decision: ${pr.reviewDecision || "Yok"}`,
            `Değişiklik: ${pr.changedFiles} dosya, +${pr.additions} / -${pr.deletions}`,
            `Oluşturulma: ${pr.createdAt}`,
            `Güncellenme: ${pr.updatedAt}`,
            pr.mergedAt
              ? `Merge zamanı: ${pr.mergedAt}`
              : "Merge zamanı: Yok",
            pr.closedAt
              ? `Kapanma zamanı: ${pr.closedAt}`
              : "Kapanma zamanı: Yok",
            `Maintainer düzenlemesi: ${pr.maintainerCanModify ? "Açık" : "Kapalı"}`,
            `Açıklama:\n${pr.body || "(boş)"}`,
          ].join("\n\n"),
        );
      } catch (error) {
        return errorResult(
          new Error(
            sanitizeGitNetworkOutput(
              error instanceof Error
                ? error.message
                : String(error),
            ),
          ),
        );
      }
    },
  );

  registerTextTool(
    "get_pull_request_checks",
    {
      description:
        "Seçilen GitHub deposundaki bir pull request'in CI ve GitHub Actions kontrol durumlarını salt okunur biçimde gösterir.",
      inputSchema: {
        pr_number: z.number().int().min(1),
        required_only: z.boolean().default(false),
      },
      annotations: {
        title: "Pull request kontrolleri",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ pr_number, required_only }) => {
      try {
        await assertGhAuthenticated();
        const repoSlug = await getGitHubRepoSlug();

        const args = [
          "pr",
          "checks",
          String(pr_number),
          "--repo",
          repoSlug,
          "--json",
          "bucket,completedAt,description,event,link,name,startedAt,state,workflow",
        ];

        if (required_only) {
          args.push("--required");
        }

        const result = await runGhWithCode(args);
        const checks = parsePullRequestChecksResult(
          result,
          `PR #${pr_number} kontrol sorgusu`,
        );

        const counts = {
          pass: 0,
          fail: 0,
          pending: 0,
          skipping: 0,
          cancel: 0,
          other: 0,
        };

        for (const check of checks) {
          const bucket = String(check.bucket ?? "other");
          if (Object.hasOwn(counts, bucket)) {
            counts[bucket] += 1;
          } else {
            counts.other += 1;
          }
        }

        return textResult(
          [
            `PR #${pr_number} kontrol sayısı: ${checks.length}`,
            `Özet: pass=${counts.pass}, fail=${counts.fail}, pending=${counts.pending}, skipping=${counts.skipping}, cancel=${counts.cancel}, other=${counts.other}`,
            checks.length > 0
              ? checks
                  .map((check) =>
                    [
                      `[${check.bucket}] ${check.name}`,
                      check.workflow
                        ? `workflow=${check.workflow}`
                        : "",
                      `state=${check.state}`,
                      check.description || "",
                      check.link || "",
                    ]
                      .filter(Boolean)
                      .join(" | "),
                  )
                  .join("\n")
              : "Kontrol bulunamadı.",
          ].join("\n\n"),
        );
      } catch (error) {
        return errorResult(
          new Error(
            sanitizeGitNetworkOutput(
              error instanceof Error
                ? error.message
                : String(error),
            ),
          ),
        );
      }
    },
  );

  registerTextTool(
    "list_workflow_runs",
    {
      description:
        "Seçilen GitHub deposundaki son GitHub Actions workflow çalıştırmalarını durum, sonuç, branch ve SHA bilgileriyle listeler.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20),
        branch: z
          .string()
          .min(1)
          .max(100)
          .optional()
          .describe(
            "İsteğe bağlı main veya equinox/ branch filtresi",
          ),
        status: z
          .enum([
            "queued",
            "completed",
            "in_progress",
            "requested",
            "waiting",
            "pending",
            "action_required",
            "cancelled",
            "failure",
            "neutral",
            "skipped",
            "stale",
            "startup_failure",
            "success",
            "timed_out",
          ])
          .optional(),
        workflow: z
          .string()
          .min(1)
          .max(200)
          .optional(),
        commit_sha: z
          .string()
          .regex(
            /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
            "Commit SHA 40 veya 64 onaltılık karakter olmalı.",
          )
          .optional(),
      },
      annotations: {
        title: "GitHub Actions çalıştırmalarını listele",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ limit, branch, status, workflow, commit_sha }) => {
      try {
        if (branch) {
          if (
            branch !== "main" &&
            !/^equinox\/[a-z0-9][a-z0-9._-]{0,59}$/.test(
              branch,
            )
          ) {
            throw new Error(
              "Branch filtresi yalnızca main veya güvenli equinox/ branch'i olabilir.",
            );
          }
        }

        if (
          workflow &&
          (
            workflow.trim() !== workflow ||
            /[\u0000-\u001f\u007f]/.test(workflow)
          )
        ) {
          throw new Error(
            "Workflow filtresi kontrol karakteri içeremez veya boşlukla başlayıp bitemez.",
          );
        }

        await assertGhAuthenticated();
        const repoSlug = await getGitHubRepoSlug();

        const args = [
          "run",
          "list",
          "--repo",
          repoSlug,
          "--limit",
          String(limit),
          "--json",
          "attempt,conclusion,createdAt,databaseId,displayTitle,event,headBranch,headSha,name,number,startedAt,status,updatedAt,url,workflowDatabaseId,workflowName",
        ];

        if (branch) {
          args.push("--branch", branch);
        }

        if (status) {
          args.push("--status", status);
        }

        if (workflow) {
          args.push("--workflow", workflow);
        }

        if (commit_sha) {
          args.push("--commit", commit_sha.toLowerCase());
        }

        const result = await runGhWithCode(args);

        if (result.code !== 0) {
          throw new Error(
            [
              "Workflow çalıştırmaları listelenemedi.",
              sanitizeGitNetworkOutput(
                result.stderr || result.stdout,
              ),
            ].join("\n"),
          );
        }

        const runs = parseJsonOutput(
          result.stdout,
          "Workflow run listesi",
        );

        if (!Array.isArray(runs)) {
          throw new Error(
            "Workflow run sorgusu beklenen liste biçiminde değil.",
          );
        }

        return textResult(
          [
            `Depo: ${repoSlug}`,
            `Workflow run sayısı: ${runs.length}`,
            runs.length > 0
              ? runs
                  .map((run) =>
                    [
                      `#${run.databaseId} | ${run.workflowName || run.name || "Workflow"}`,
                      `Başlık: ${run.displayTitle || "-"}`,
                      `Durum: ${run.status || "?"}/${run.conclusion || "-"}`,
                      `Branch/SHA: ${run.headBranch || "-"} / ${run.headSha || "-"}`,
                      `Event: ${run.event || "-"}; attempt: ${run.attempt ?? "?"}`,
                      `Başlangıç: ${run.startedAt || run.createdAt || "-"}`,
                      `Adres: ${run.url || "-"}`,
                    ].join("\n"),
                  )
                  .join("\n\n")
              : "Eşleşen workflow run bulunamadı.",
          ].join("\n\n"),
        );
      } catch (error) {
        return errorResult(
          new Error(
            sanitizeGitNetworkOutput(
              error instanceof Error
                ? error.message
                : String(error),
            ),
          ),
        );
      }
    },
  );

  registerTextTool(
    "get_workflow_run",
    {
      description:
        "Seçilen GitHub Actions workflow çalıştırmasının job ve adım durumlarını gösterir; istenirse yalnızca başarısız adımların loglarını getirir.",
      inputSchema: {
        run_id: z.number().int().min(1),
        include_failed_logs: z.boolean().default(false),
      },
      annotations: {
        title: "GitHub Actions çalıştırmasını göster",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ run_id, include_failed_logs }) => {
      try {
        await assertGhAuthenticated();
        const repoSlug = await getGitHubRepoSlug();
        const run = await readWorkflowRunById(
          repoSlug,
          run_id,
        );

        let failedLogs = "";

        if (include_failed_logs) {
          const logs = await runGhWithCode(
            [
              "run",
              "view",
              String(run_id),
              "--repo",
              repoSlug,
              "--log-failed",
            ],
            "",
            180_000,
          );

          failedLogs = sanitizeGitNetworkOutput(
            logs.stdout || logs.stderr,
          );
        }

        return textResult(
          [
            `Workflow run: #${run.databaseId}`,
            `Workflow: ${run.workflowName || run.name || "-"}`,
            `Başlık: ${run.displayTitle || "-"}`,
            `Durum: ${run.status || "?"}/${run.conclusion || "-"}`,
            `Event: ${run.event || "-"}`,
            `Branch: ${run.headBranch || "-"}`,
            `HEAD SHA: ${run.headSha || "-"}`,
            `Attempt: ${run.attempt ?? "?"}`,
            `Başlangıç: ${run.startedAt || run.createdAt || "-"}`,
            `Güncellenme: ${run.updatedAt || "-"}`,
            `Adres: ${run.url || "-"}`,
            `Job'lar:\n${formatWorkflowJobs(run.jobs)}`,
            include_failed_logs
              ? `Başarısız adım logları:\n${failedLogs || "Başarısız adım logu bulunamadı."}`
              : "Başarısız loglar istenmedi.",
          ].join("\n\n"),
        );
      } catch (error) {
        return errorResult(
          new Error(
            sanitizeGitNetworkOutput(
              error instanceof Error
                ? error.message
                : String(error),
            ),
          ),
        );
      }
    },
  );
}
