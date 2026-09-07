export function registerGithubPrMutationTools({
  registerTextTool,
  z,
  assertGhAuthenticated,
  assertNoGitOperationInProgress,
  assertCleanGitWorktree,
  getCurrentGitBranch,
  assertPushableEquinoxBranch,
  getExactHeadCommit,
  runGitWithCode,
  assertRemoteBranchAtHead,
  getGitHubRepoSlug,
  readPullRequestByNumber,
  assertSafeMutablePullRequest,
  runGhWithCode,
  parseJsonOutput,
  sanitizeGitNetworkOutput,
  textResult,
  errorResult,
}) {
  registerTextTool(
    "create_pull_request",
    {
      description:
        "Aktif ve origin'a push edilmiş equinox/ çalışma branch'inden yalnızca main branch'ine GitHub pull request oluşturur. Merge, close veya branch silme yapamaz.",
      inputSchema: {
        expected_head_sha: z
          .string()
          .regex(
            /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
            "Beklenen HEAD SHA 40 veya 64 onaltılık karakter olmalı.",
          )
          .describe(
            "`git rev-parse HEAD` ile doğrulanan tam HEAD SHA değeri",
          ),
        title: z
          .string()
          .min(5)
          .max(120)
          .describe(
            "Pull request başlığı",
          ),
        body: z
          .string()
          .max(10_000)
          .optional()
          .describe(
            "Pull request açıklaması",
          ),
        draft: z
          .boolean()
          .optional()
          .describe(
            "Belirtilmezse PR draft olarak oluşturulur",
          ),
      },
      annotations: {
        title: "Proje pull request oluştur",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      expected_head_sha,
      title,
      body,
      draft,
    }) => {
      let pullRequestCreated = false;

      try {
        const expectedHead =
          expected_head_sha.toLowerCase();

        if (
          title.trim() !== title ||
          title.includes("\n") ||
          title.includes("\r") ||
          title.includes("\0")
        ) {
          throw new Error(
            "PR başlığı tek satır olmalı ve başında veya sonunda boşluk bulunmamalı.",
          );
        }

        if (body?.includes("\0")) {
          throw new Error(
            "PR açıklaması NUL karakteri içeremez.",
          );
        }

        await assertNoGitOperationInProgress();
        await assertCleanGitWorktree();

        const branch =
          await getCurrentGitBranch();

        assertPushableEquinoxBranch(
          branch,
        );

        const currentHead =
          await getExactHeadCommit();

        if (currentHead !== expectedHead) {
          throw new Error(
            [
              "HEAD SHA uyuşmazlığı nedeniyle PR oluşturulmadı.",
              `Beklenen: ${expectedHead}`,
              `Mevcut:  ${currentHead}`,
              "Branch, HEAD SHA doğrulamasından sonra değişmiş olabilir.",
            ].join("\n"),
          );
        }

        const mainRef =
          await runGitWithCode([
            "rev-parse",
            "--verify",
            "refs/heads/main^{commit}",
          ]);

        if (mainRef.code !== 0) {
          throw new Error(
            "Yerel main branch'i bulunamadı.",
          );
        }

        const ancestorCheck =
          await runGitWithCode([
            "merge-base",
            "--is-ancestor",
            "refs/heads/main",
            "HEAD",
          ]);

        if (ancestorCheck.code === 1) {
          throw new Error(
            "Aktif çalışma branch'i mevcut yerel main branch'inden türemiyor.",
          );
        }

        if (ancestorCheck.code !== 0) {
          throw new Error(
            `Branch kökeni doğrulanamadı: ${ancestorCheck.stderr.trim()}`,
          );
        }

        const aheadCountResult =
          await runGitWithCode([
            "rev-list",
            "--count",
            "refs/heads/main..HEAD",
          ]);

        const aheadCount =
          Number.parseInt(
            aheadCountResult.stdout.trim(),
            10,
          );

        if (
          aheadCountResult.code !== 0 ||
          !Number.isInteger(aheadCount)
        ) {
          throw new Error(
            "Main'e göre commit sayısı hesaplanamadı.",
          );
        }

        if (aheadCount < 1) {
          throw new Error(
            "Aktif branch main'e göre yeni commit içermiyor; PR oluşturulmadı.",
          );
        }

        const remoteHead =
          await assertRemoteBranchAtHead(
            branch,
            expectedHead,
          );

        const repoSlug =
          await getGitHubRepoSlug();

        const authStatus =
          await runGhWithCode([
            "auth",
            "status",
            "--hostname",
            "github.com",
            "--active",
          ]);

        if (authStatus.code !== 0) {
          throw new Error(
            [
              "GitHub CLI oturumu geçerli değil.",
              "Terminalde 'gh auth login --hostname github.com --web' çalıştır.",
              sanitizeGitNetworkOutput(
                authStatus.stderr ||
                authStatus.stdout,
              ),
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }

        const existingResult =
          await runGhWithCode([
            "pr",
            "list",
            "--repo",
            repoSlug,
            "--state",
            "open",
            "--head",
            branch,
            "--base",
            "main",
            "--limit",
            "10",
            "--json",
            "number,url,title,isDraft,headRefName,baseRefName,state",
          ]);

        if (existingResult.code !== 0) {
          throw new Error(
            [
              "Mevcut PR kontrolü başarısız.",
              sanitizeGitNetworkOutput(
                existingResult.stderr ||
                existingResult.stdout,
              ),
            ].join("\n"),
          );
        }

        const existingPullRequests =
          parseJsonOutput(
            existingResult.stdout,
            "Mevcut PR sorgusu",
          );

        if (
          !Array.isArray(
            existingPullRequests,
          )
        ) {
          throw new Error(
            "Mevcut PR sorgusu beklenen liste biçiminde değil.",
          );
        }

        if (
          existingPullRequests.length > 0
        ) {
          const existing =
            existingPullRequests[0];

          throw new Error(
            [
              "Bu branch için zaten açık bir PR mevcut.",
              `PR #${existing.number}: ${existing.title}`,
              `Adres: ${existing.url}`,
            ].join("\n"),
          );
        }

        /*
         * --head:
         * gh'nin branch push etmesini veya fork
         * oluşturmayı teklif etmesini engeller.
         *
         * --body-file -:
         * PR gövdesini stdin üzerinden güvenli
         * biçimde iletir.
         *
         * --no-maintainer-edit:
         * Diğer yazma yetkisine sahip kullanıcıların
         * head branch'e doğrudan commit eklemesini
         * engeller.
         */
        const createArgs = [
          "pr",
          "create",
          "--repo",
          repoSlug,
          "--base",
          "main",
          "--head",
          branch,
          "--title",
          title,
          "--body-file",
          "-",
          "--no-maintainer-edit",
        ];

        const shouldCreateDraft =
          draft ?? true;

        if (shouldCreateDraft) {
          createArgs.push(
            "--draft",
          );
        }

        const normalizedBody =
          body?.trim() ?? "";

        const createResult =
          await runGhWithCode(
            createArgs,
            normalizedBody,
            120_000,
          );

        if (createResult.code !== 0) {
          throw new Error(
            [
              "Pull request oluşturulamadı.",
              sanitizeGitNetworkOutput(
                createResult.stderr ||
                createResult.stdout,
              ) ||
                "GitHub CLI ayrıntılı hata döndürmedi.",
            ].join("\n"),
          );
        }

        pullRequestCreated = true;

        const viewResult =
          await runGhWithCode([
            "pr",
            "view",
            branch,
            "--repo",
            repoSlug,
            "--json",
            "number,url,title,state,isDraft,headRefName,headRefOid,baseRefName,maintainerCanModify",
          ]);

        if (viewResult.code !== 0) {
          throw new Error(
            "PR oluşturuldu ancak sonradan doğrulanamadı.",
          );
        }

        const pullRequest =
          parseJsonOutput(
            viewResult.stdout,
            "PR doğrulaması",
          );

        if (
          pullRequest.headRefName !== branch ||
          pullRequest.baseRefName !== "main"
        ) {
          throw new Error(
            [
              "PR oluşturuldu ancak branch bilgileri beklenen değerlerle uyuşmuyor.",
              `Head: ${pullRequest.headRefName}`,
              `Base: ${pullRequest.baseRefName}`,
            ].join("\n"),
          );
        }

        if (
          String(
            pullRequest.headRefOid ?? "",
          ).toLowerCase() !==
          expectedHead
        ) {
          throw new Error(
            [
              "PR oluşturuldu ancak GitHub üzerindeki head SHA beklenen commit değil.",
              `Beklenen: ${expectedHead}`,
              `GitHub:   ${pullRequest.headRefOid ?? "alınamadı"}`,
            ].join("\n"),
          );
        }

        return textResult(
          [
            `Pull request oluşturuldu: #${pullRequest.number}`,
            `Başlık: ${pullRequest.title}`,
            `Adres: ${pullRequest.url}`,
            `Depo: ${repoSlug}`,
            `Base: ${pullRequest.baseRefName}`,
            `Head: ${pullRequest.headRefName}`,
            `HEAD SHA: ${expectedHead}`,
            `Uzak SHA: ${remoteHead}`,
            `Durum: ${pullRequest.state}`,
            `Draft: ${pullRequest.isDraft ? "Evet" : "Hayır"}`,
            `Maintainer düzenlemesi: ${pullRequest.maintainerCanModify ? "Açık" : "Kapalı"}`,
            `Main'e göre commit sayısı: ${aheadCount}`,
            "Merge, close veya branch silme işlemi yapılmadı.",
          ].join("\n\n"),
        );
      } catch (error) {
        const message =
          sanitizeGitNetworkOutput(
            error instanceof Error
              ? error.message
              : String(error),
          );

        if (pullRequestCreated) {
          return textResult(
            [
              "Pull request GitHub üzerinde oluşturuldu.",
              "Ancak son doğrulama adımlarından biri tamamlanamadı.",
              message,
              "Aynı branch için yeniden create_pull_request çağırma; önce GitHub üzerindeki PR'ı kontrol et.",
            ].join("\n\n"),
          );
        }

        return errorResult(
          new Error(message),
        );
      }
    },
  );

  registerTextTool(
    "update_pull_request",
    {
      description:
        "Yalnızca main hedefli açık bir equinox/ pull request'in başlığını ve/veya açıklamasını beklenen HEAD SHA doğrulamasıyla günceller.",
      inputSchema: {
        pr_number: z
          .number()
          .int()
          .min(1),
        expected_head_sha: z
          .string()
          .regex(
            /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
          ),
        title: z
          .string()
          .min(5)
          .max(120)
          .optional(),
        body: z
          .string()
          .max(10_000)
          .optional(),
      },
      annotations: {
        title: "Pull request'i güncelle",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      pr_number,
      expected_head_sha,
      title,
      body,
    }) => {
      try {
        if (
          title === undefined &&
          body === undefined
        ) {
          throw new Error(
            "Başlık veya açıklamadan en az biri verilmelidir.",
          );
        }

        if (
          title !== undefined &&
          (
            title.trim() !== title ||
            title.includes("\n") ||
            title.includes("\r") ||
            title.includes("\0")
          )
        ) {
          throw new Error(
            "PR başlığı tek satır olmalı ve başında/sonunda boşluk bulunmamalı.",
          );
        }

        if (body?.includes("\0")) {
          throw new Error(
            "PR açıklaması NUL karakteri içeremez.",
          );
        }

        await assertGhAuthenticated();
        const repoSlug =
          await getGitHubRepoSlug();
        const expectedHead =
          expected_head_sha.toLowerCase();
        const before =
          await readPullRequestByNumber(
            repoSlug,
            pr_number,
          );

        assertSafeMutablePullRequest(
          before,
          expectedHead,
        );

        const args = [
          "pr",
          "edit",
          String(pr_number),
          "--repo",
          repoSlug,
        ];

        if (title !== undefined) {
          args.push(
            "--title",
            title,
          );
        }

        let input = "";

        if (body !== undefined) {
          args.push(
            "--body-file",
            "-",
          );
          input = body;
        }

        const result =
          await runGhWithCode(
            args,
            input,
          );

        if (result.code !== 0) {
          throw new Error(
            [
              "Pull request güncellenemedi.",
              sanitizeGitNetworkOutput(
                result.stderr ||
                result.stdout,
              ),
            ].join("\n"),
          );
        }

        const after =
          await readPullRequestByNumber(
            repoSlug,
            pr_number,
          );

        assertSafeMutablePullRequest(
          after,
          expectedHead,
        );

        if (
          title !== undefined &&
          after.title !== title
        ) {
          throw new Error(
            "PR güncellendi ancak başlık doğrulanamadı.",
          );
        }

        if (
          body !== undefined &&
          after.body !== body
        ) {
          throw new Error(
            "PR güncellendi ancak açıklama doğrulanamadı.",
          );
        }

        return textResult(
          [
            `PR #${after.number} güncellendi.`,
            `Başlık: ${after.title}`,
            `Adres: ${after.url}`,
            `Head: ${after.headRefName}`,
            `HEAD SHA: ${after.headRefOid}`,
            "Base branch değiştirilmedi; merge veya close yapılmadı.",
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
    "set_pull_request_draft",
    {
      description:
        "Beklenen HEAD SHA ile doğrulanan açık equinox/ pull request'i draft veya review'a hazır duruma getirir.",
      inputSchema: {
        pr_number: z
          .number()
          .int()
          .min(1),
        expected_head_sha: z
          .string()
          .regex(
            /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
          ),
        draft: z.boolean(),
      },
      annotations: {
        title: "PR draft durumunu değiştir",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      pr_number,
      expected_head_sha,
      draft,
    }) => {
      try {
        await assertGhAuthenticated();
        const repoSlug =
          await getGitHubRepoSlug();
        const expectedHead =
          expected_head_sha.toLowerCase();
        const before =
          await readPullRequestByNumber(
            repoSlug,
            pr_number,
          );

        assertSafeMutablePullRequest(
          before,
          expectedHead,
        );

        if (before.isDraft === draft) {
          return textResult(
            `PR #${pr_number} zaten ${draft ? "draft" : "review'a hazır"} durumda.`,
          );
        }

        const args = [
          "pr",
          "ready",
          String(pr_number),
          "--repo",
          repoSlug,
        ];

        if (draft) {
          args.push("--undo");
        }

        const result =
          await runGhWithCode(args);

        if (result.code !== 0) {
          throw new Error(
            [
              "PR draft durumu değiştirilemedi.",
              sanitizeGitNetworkOutput(
                result.stderr ||
                result.stdout,
              ),
            ].join("\n"),
          );
        }

        const after =
          await readPullRequestByNumber(
            repoSlug,
            pr_number,
          );

        assertSafeMutablePullRequest(
          after,
          expectedHead,
        );

        if (after.isDraft !== draft) {
          throw new Error(
            "PR draft durumu değişti ancak doğrulanamadı.",
          );
        }

        return textResult(
          [
            `PR #${pr_number} durumu güncellendi.`,
            `Draft: ${after.isDraft ? "Evet" : "Hayır"}`,
            `Adres: ${after.url}`,
            `HEAD SHA: ${after.headRefOid}`,
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
    "close_pull_request",
    {
      description:
        "Beklenen HEAD SHA ile doğrulanan, main hedefli açık equinox/ pull request'i kapatır. Branch silmez ve merge yapmaz.",
      inputSchema: {
        pr_number: z
          .number()
          .int()
          .min(1),
        expected_head_sha: z
          .string()
          .regex(
            /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/,
          ),
        comment: z
          .string()
          .max(2000)
          .optional(),
      },
      annotations: {
        title: "Pull request'i kapat",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      pr_number,
      expected_head_sha,
      comment,
    }) => {
      try {
        if (comment?.includes("\0")) {
          throw new Error(
            "Kapanış yorumu NUL karakteri içeremez.",
          );
        }

        await assertGhAuthenticated();
        const repoSlug =
          await getGitHubRepoSlug();
        const expectedHead =
          expected_head_sha.toLowerCase();
        const before =
          await readPullRequestByNumber(
            repoSlug,
            pr_number,
          );

        assertSafeMutablePullRequest(
          before,
          expectedHead,
        );

        const args = [
          "pr",
          "close",
          String(pr_number),
          "--repo",
          repoSlug,
        ];

        if (
          comment &&
          comment.trim()
        ) {
          args.push(
            "--comment",
            comment.trim(),
          );
        }

        const result =
          await runGhWithCode(args);

        if (result.code !== 0) {
          throw new Error(
            [
              "Pull request kapatılamadı.",
              sanitizeGitNetworkOutput(
                result.stderr ||
                result.stdout,
              ),
            ].join("\n"),
          );
        }

        const after =
          await readPullRequestByNumber(
            repoSlug,
            pr_number,
          );

        if (
          after.state !== "CLOSED" ||
          String(after.headRefOid ?? "").toLowerCase() !== expectedHead
        ) {
          throw new Error(
            "PR kapatıldı ancak son durum veya HEAD SHA doğrulanamadı.",
          );
        }

        return textResult(
          [
            `PR #${after.number} kapatıldı.`,
            `Adres: ${after.url}`,
            `Head: ${after.headRefName}`,
            `HEAD SHA: ${after.headRefOid}`,
            "Branch silinmedi ve merge yapılmadı.",
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
