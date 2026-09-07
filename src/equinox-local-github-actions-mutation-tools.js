export function registerGithubActionsMutationTools({
  registerTextTool,
  z,
  assertGhAuthenticated,
  getGitHubRepoSlug,
  readWorkflowRunById,
  normalizeWorkflowHeadSha,
  runGhWithCode,
  delayMilliseconds,
  sanitizeGitNetworkOutput,
  textResult,
  errorResult,
}) {
  registerTextTool(
    "rerun_failed_workflow",
    {
      description:
        "SHA ve attempt değeri doğrulanan, tamamlanmış ve başarısız bir GitHub Actions run'ındaki yalnızca başarısız job'ları bağımlılıklarıyla yeniden çalıştırır. Debug modu kullanmaz.",
      inputSchema: {
        run_id: z
          .number()
          .int()
          .min(1),
        expected_head_sha: z
          .string()
          .regex(
            /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
          ),
        expected_attempt: z
          .number()
          .int()
          .min(1),
      },
      annotations: {
        title: "Başarısız workflow job'larını yeniden çalıştır",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      run_id,
      expected_head_sha,
      expected_attempt,
    }) => {
      try {
        await assertGhAuthenticated();
        const repoSlug =
          await getGitHubRepoSlug();
        const run =
          await readWorkflowRunById(
            repoSlug,
            run_id,
          );
        const headSha =
          normalizeWorkflowHeadSha(run);

        if (
          headSha !==
          expected_head_sha.toLowerCase()
        ) {
          throw new Error(
            [
              "Workflow HEAD SHA beklenen değerle uyuşmuyor.",
              `Beklenen: ${expected_head_sha.toLowerCase()}`,
              `GitHub:   ${headSha}`,
            ].join("\n"),
          );
        }

        if (
          Number(run.attempt) !==
          expected_attempt
        ) {
          throw new Error(
            [
              "Workflow attempt değeri değişmiş; yeniden çalıştırma yapılmadı.",
              `Beklenen: ${expected_attempt}`,
              `GitHub:   ${run.attempt}`,
            ].join("\n"),
          );
        }

        if (run.status !== "completed") {
          throw new Error(
            `Yalnızca tamamlanmış workflow yeniden çalıştırılabilir. Durum: ${run.status}`,
          );
        }

        if (
          ![
            "failure",
            "timed_out",
            "startup_failure",
          ].includes(run.conclusion)
        ) {
          throw new Error(
            `Yalnızca başarısız workflow run yeniden çalıştırılabilir. Sonuç: ${run.conclusion}`,
          );
        }

        const rerunResult =
          await runGhWithCode([
            "run",
            "rerun",
            String(run_id),
            "--repo",
            repoSlug,
            "--failed",
          ]);

        if (rerunResult.code !== 0) {
          throw new Error(
            [
              "Başarısız workflow job'ları yeniden başlatılamadı.",
              sanitizeGitNetworkOutput(
                rerunResult.stderr ||
                rerunResult.stdout,
              ),
            ].join("\n"),
          );
        }

        await delayMilliseconds(2000);

        let updatedRun;

        try {
          updatedRun =
            await readWorkflowRunById(
              repoSlug,
              run_id,
            );
        } catch {
          updatedRun = undefined;
        }

        return textResult(
          [
            `Workflow yeniden çalıştırma isteği gönderildi: #${run_id}`,
            `Workflow: ${run.workflowName || run.name || "-"}`,
            `Doğrulanan HEAD SHA: ${headSha}`,
            `Önceki attempt: ${expected_attempt}`,
            updatedRun
              ? `Güncel durum: ${updatedRun.status}/${updatedRun.conclusion || "-"}; attempt ${updatedRun.attempt}`
              : "Güncel run durumu henüz yeniden okunamadı.",
            "Yalnızca başarısız job'lar ve bağımlılıkları yeniden çalıştırıldı; debug modu kullanılmadı.",
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
    "cancel_workflow_run",
    {
      description:
        "SHA ve attempt değeri doğrulanan aktif bir GitHub Actions workflow çalıştırmasına normal iptal isteği gönderir. Force cancel kullanmaz.",
      inputSchema: {
        run_id: z
          .number()
          .int()
          .min(1),
        expected_head_sha: z
          .string()
          .regex(
            /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
          ),
        expected_attempt: z
          .number()
          .int()
          .min(1),
      },
      annotations: {
        title: "Workflow çalıştırmasını iptal et",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      run_id,
      expected_head_sha,
      expected_attempt,
    }) => {
      try {
        await assertGhAuthenticated();
        const repoSlug =
          await getGitHubRepoSlug();
        const run =
          await readWorkflowRunById(
            repoSlug,
            run_id,
          );
        const headSha =
          normalizeWorkflowHeadSha(run);

        if (
          headSha !==
          expected_head_sha.toLowerCase()
        ) {
          throw new Error(
            "Workflow HEAD SHA beklenen değerle uyuşmuyor; iptal edilmedi.",
          );
        }

        if (
          Number(run.attempt) !==
          expected_attempt
        ) {
          throw new Error(
            "Workflow attempt değeri değişmiş; iptal edilmedi.",
          );
        }

        const cancellableStates =
          new Set([
            "queued",
            "in_progress",
            "requested",
            "waiting",
            "pending",
          ]);

        if (
          !cancellableStates.has(
            run.status,
          )
        ) {
          throw new Error(
            `Workflow aktif ve iptal edilebilir durumda değil: ${run.status}/${run.conclusion || "-"}`,
          );
        }

        const cancelResult =
          await runGhWithCode([
            "run",
            "cancel",
            String(run_id),
            "--repo",
            repoSlug,
          ]);

        if (cancelResult.code !== 0) {
          throw new Error(
            [
              "Workflow iptal isteği gönderilemedi.",
              sanitizeGitNetworkOutput(
                cancelResult.stderr ||
                cancelResult.stdout,
              ),
            ].join("\n"),
          );
        }

        let finalRun = run;

        for (
          let attempt = 0;
          attempt < 5;
          attempt += 1
        ) {
          await delayMilliseconds(2000);
          finalRun =
            await readWorkflowRunById(
              repoSlug,
              run_id,
            );

          if (
            !cancellableStates.has(
              finalRun.status,
            )
          ) {
            break;
          }
        }

        return textResult(
          [
            `Workflow iptal isteği gönderildi: #${run_id}`,
            `Workflow: ${run.workflowName || run.name || "-"}`,
            `Doğrulanan HEAD SHA: ${headSha}`,
            `Attempt: ${expected_attempt}`,
            `Önceki durum: ${run.status}/${run.conclusion || "-"}`,
            `Güncel durum: ${finalRun.status}/${finalRun.conclusion || "-"}`,
            "Force cancel kullanılmadı.",
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
