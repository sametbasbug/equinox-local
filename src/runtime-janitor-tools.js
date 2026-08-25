export async function registerRuntimeJanitorTools({
  registerTextTool,
  z,
  janitor,
  processJsonResult,
  errorResult,
}) {
  const categoryIds = janitor.categories().map((item) => item.id);
  const categorySchema = z.enum(categoryIds);

  registerTextTool(
    "janitor_report",
    {
      description:
        "v4.0.4 autonomous runtime janitor için salt-okunur dry-run raporu üretir. Sabit retention politikalarına göre reclaimable byte/item miktarını, korunan runtime artifact kategorilerini ve mevcut plan fingerprint'ini gösterir; temizlik Equinox Local iç bakım döngüsü tarafından yapılır.",
      inputSchema: {
        category: categorySchema.optional(),
        include_protected: z.boolean().default(false),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: {
        title: "Runtime janitor dry-run raporu",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ category, include_protected, limit }) => {
      try {
        return processJsonResult(await janitor.report({
          category: category ?? null,
          includeProtected: include_protected,
          limit,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "janitor_status",
    {
      description:
        "v4.0.4 autonomous runtime janitor bakım döngüsünün etkinlik durumunu, 6 saatlik cadence bilgisini, sonraki çalışma zamanını ve son bakım özetini salt okunur gösterir.",
      inputSchema: {},
      annotations: {
        title: "Runtime janitor durumu",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return processJsonResult(janitor.status());
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "janitor_history",
    {
      description:
        "v4.0.4 runtime janitor cleanup audit geçmişini salt okunur listeler; kategori ve outcome ile daraltılabilir.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(50),
        category: categorySchema.optional(),
        outcome: z.enum([
          "CLEANED",
          "SKIPPED_ALREADY_CLEAN",
          "REFUSED_STALE_PREVIEW",
          "PARTIAL",
          "FAILED",
        ]).optional(),
      },
      annotations: {
        title: "Janitor audit geçmişi",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit, category, outcome }) => {
      try {
        return processJsonResult({
          history: await janitor.history({
            limit,
            category: category ?? null,
            outcome: outcome ?? null,
          }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );
}
