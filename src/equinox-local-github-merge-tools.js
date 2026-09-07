export function registerGithubMergeTool({
  registerTextTool,
  z,
  assertNoGitOperationInProgress,
  assertCleanGitWorktree,
  getCurrentGitBranch,
  getExactHeadCommit,
  runGitWithCode,
  sanitizeGitNetworkOutput,
  assertGhAuthenticated,
  getGitHubRepoSlug,
  readPullRequestByNumber,
  assertSafeMutablePullRequest,
  readPullRequestChecksForMerge,
  runGhWithCode,
  parseJsonOutput,
  textResult,
  errorResult,
}) {
  registerTextTool(
    "merge_pull_request",
    {
      description:
        "Seçilen GitHub deposunda yalnızca main hedefli, draft olmayan, SHA doğrulanmış ve kontrolleri başarılı bir equinox/ pull request'ini squash yöntemiyle merge eder. Admin, bypass, auto-merge veya branch silme kullanmaz.",
      inputSchema: {
        pr_number: z
          .number()
          .int()
          .min(1),
        expected_head_sha: z
          .string()
          .regex(
            /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
            "Beklenen PR HEAD SHA 40 veya 64 onaltılık karakter olmalı.",
          ),
        expected_main_sha: z
          .string()
          .regex(
            /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
            "Beklenen main SHA 40 veya 64 onaltılık karakter olmalı.",
          ),
        allow_no_checks: z
          .boolean()
          .default(false)
          .describe(
            "Repo hiç CI kontrolü raporlamıyorsa bilinçli olarak merge'e izin ver",
          ),
      },
      annotations: {
        title: "Pull request'i squash merge et",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      pr_number,
      expected_head_sha,
      expected_main_sha,
      allow_no_checks,
    }) => {
      let mergeCommandCompleted = false;

      try {
        const expectedHead =
          expected_head_sha.toLowerCase();
        const expectedMain =
          expected_main_sha.toLowerCase();

        await assertNoGitOperationInProgress();
        await assertCleanGitWorktree();

        const branch =
          await getCurrentGitBranch();

        if (branch !== "main") {
          throw new Error(
            [
              "PR merge işlemi yalnızca temiz yerel main branch'inde yapılabilir.",
              `Mevcut branch: ${branch}`,
            ].join("\n"),
          );
        }

        const localMain =
          await getExactHeadCommit();

        if (localMain !== expectedMain) {
          throw new Error(
            [
              "Yerel main SHA beklenen değerle uyuşmuyor.",
              `Beklenen: ${expectedMain}`,
              `Yerel:    ${localMain}`,
            ].join("\n"),
          );
        }

        const fetchMain =
          await runGitWithCode(
            [
              "fetch",
              "--no-tags",
              "origin",
              "refs/heads/main:refs/remotes/origin/main",
            ],
            120_000,
          );

        if (fetchMain.code !== 0) {
          throw new Error(
            [
              "Origin/main merge öncesinde yenilenemedi.",
              sanitizeGitNetworkOutput(
                fetchMain.stderr ||
                fetchMain.stdout,
              ),
            ].join("\n"),
          );
        }

        const remoteMainResult =
          await runGitWithCode([
            "rev-parse",
            "--verify",
            "refs/remotes/origin/main^{commit}",
          ]);

        const remoteMain =
          remoteMainResult.stdout
            .trim()
            .toLowerCase();

        if (
          remoteMainResult.code !== 0 ||
          remoteMain !== expectedMain
        ) {
          throw new Error(
            [
              "Origin/main SHA beklenen değerle uyuşmuyor; Terminal üzerinden fetch edip main dalını normal fast-forward akışıyla eşitle.",
              `Beklenen: ${expectedMain}`,
              `Origin:   ${remoteMain || "alınamadı"}`,
            ].join("\n"),
          );
        }

        await assertGhAuthenticated();
        const repoSlug =
          await getGitHubRepoSlug();
        const pullRequest =
          await readPullRequestByNumber(
            repoSlug,
            pr_number,
          );

        assertSafeMutablePullRequest(
          pullRequest,
          expectedHead,
        );

        if (pullRequest.isDraft) {
          throw new Error(
            "Draft pull request merge edilemez. Önce set_pull_request_draft ile review'a hazır yap.",
          );
        }

        const baseOid = String(
          pullRequest.baseRefOid ?? "",
        ).toLowerCase();

        if (baseOid !== expectedMain) {
          throw new Error(
            [
              "PR base SHA beklenen main SHA ile uyuşmuyor.",
              `Beklenen: ${expectedMain}`,
              `GitHub:   ${baseOid || "alınamadı"}`,
            ].join("\n"),
          );
        }

        if (
          pullRequest.mergeable !==
          "MERGEABLE"
        ) {
          throw new Error(
            `PR şu anda merge edilebilir değil: ${pullRequest.mergeable}`,
          );
        }

        if (
          pullRequest.mergeStateStatus !==
          "CLEAN"
        ) {
          throw new Error(
            [
              "PR merge durumu CLEAN değil; otomatik merge yapılmadı.",
              `Merge state: ${pullRequest.mergeStateStatus}`,
            ].join("\n"),
          );
        }

        if (
          pullRequest.reviewDecision ===
          "CHANGES_REQUESTED"
        ) {
          throw new Error(
            "PR üzerinde değişiklik talebi var; merge yapılmadı.",
          );
        }

        const checks =
          await readPullRequestChecksForMerge(
            repoSlug,
            pr_number,
          );

        if (
          checks.length === 0 &&
          !allow_no_checks
        ) {
          throw new Error(
            "PR için hiçbir CI kontrolü raporlanmadı. Bilinçli merge için allow_no_checks: true kullan.",
          );
        }

        const blockingChecks =
          checks.filter((check) => {
            const bucket = String(
              check.bucket ?? "other",
            );

            return ![
              "pass",
              "skipping",
            ].includes(bucket);
          });

        if (blockingChecks.length > 0) {
          throw new Error(
            [
              "PR kontrollerinin tamamı başarılı değil; merge yapılmadı.",
              ...blockingChecks.map(
                (check) =>
                  `- ${check.workflow ?? "Workflow"} / ${check.name ?? "Kontrol"}: ${check.bucket ?? "?"} (${check.state ?? "?"})`,
              ),
            ].join("\n"),
          );
        }

        /*
         * gh pr merge --match-head-commit seçeneği bazı
         * dağıtılmış gh sürümlerinde bulunmuyor. GitHub'ın
         * resmi REST merge endpoint'i aynı atomik korumayı
         * `sha` alanıyla sağlıyor: PR HEAD değişmişse istek
         * 409 Conflict ile reddediliyor.
         */
        const mergeRequestBody =
          JSON.stringify({
            sha: expectedHead,
            merge_method: "squash",
          });

        const mergeResult =
          await runGhWithCode(
            [
              "api",
              "--method",
              "PUT",
              "-H",
              "Accept: application/vnd.github+json",
              "-H",
              "X-GitHub-Api-Version: 2022-11-28",
              `repos/${repoSlug}/pulls/${pr_number}/merge`,
              "--input",
              "-",
            ],
            mergeRequestBody,
            180_000,
          );

        if (mergeResult.code !== 0) {
          throw new Error(
            [
              "Pull request squash merge edilemedi.",
              sanitizeGitNetworkOutput(
                mergeResult.stderr ||
                mergeResult.stdout,
              ) ||
                "GitHub API ayrıntılı hata döndürmedi.",
            ].join("\n"),
          );
        }

        const mergeResponse =
          parseJsonOutput(
            mergeResult.stdout,
            "GitHub merge yanıtı",
          );

        if (mergeResponse.merged !== true) {
          throw new Error(
            [
              "GitHub API merge işlemini tamamlamadı.",
              `Mesaj: ${mergeResponse.message ?? "Ayrıntı yok"}`,
            ].join("\n"),
          );
        }

        mergeCommandCompleted = true;

        const finalPullRequest =
          await readPullRequestByNumber(
            repoSlug,
            pr_number,
          );

        if (
          finalPullRequest.state !==
          "MERGED"
        ) {
          return textResult(
            [
              "GitHub merge komutunu kabul etti ancak PR henüz MERGED durumuna geçmedi.",
              `PR #${pr_number}: ${finalPullRequest.url}`,
              `Durum: ${finalPullRequest.state}`,
              `Merge state: ${finalPullRequest.mergeStateStatus}`,
              "Repo merge queue kullanıyor olabilir. Admin, bypass veya auto-merge kullanılmadı.",
            ].join("\n\n"),
          );
        }

        const mergeCommitResult =
          await runGhWithCode([
            "api",
            `repos/${repoSlug}/pulls/${pr_number}`,
            "--jq",
            ".merge_commit_sha // \"\"",
          ]);

        const mergeCommit =
          mergeCommitResult.code === 0
            ? mergeCommitResult.stdout.trim()
            : "";

        return textResult(
          [
            `Pull request squash merge edildi: #${pr_number}`,
            `Başlık: ${finalPullRequest.title}`,
            `Adres: ${finalPullRequest.url}`,
            `Base: ${finalPullRequest.baseRefName}`,
            `Head: ${finalPullRequest.headRefName}`,
            `Doğrulanan HEAD SHA: ${expectedHead}`,
            `Doğrulanan main SHA: ${expectedMain}`,
            `CI kontrol sayısı: ${checks.length}`,
            `Merge zamanı: ${finalPullRequest.mergedAt || "GitHub döndürmedi"}`,
            mergeCommit
              ? `Squash merge commit'i: ${mergeCommit}`
              : "Merge commit SHA ayrıca alınamadı.",
            "Admin, bypass, auto-merge, force veya branch silme kullanılmadı.",
            "Yerel main otomatik güncellenmedi; Terminal üzerinden main dalına geçip normal fetch + fast-forward akışıyla ayrıca eşitle.",
          ].join("\n\n"),
        );
      } catch (error) {
        const message = sanitizeGitNetworkOutput(
          error instanceof Error
            ? error.message
            : String(error),
        );

        if (mergeCommandCompleted) {
          return textResult(
            [
              "GitHub merge komutu tamamlandı ancak son doğrulama adımlarından biri başarısız oldu.",
              message,
              "PR durumunu get_pull_request ile ayrıca doğrula.",
            ].join("\n\n"),
          );
        }

        return errorResult(
          new Error(message),
        );
      }
    },
  );
}
