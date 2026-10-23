import type * as zod from "zod";

type JanitorCategory = string;
type JanitorOutcome =
  | "CLEANED"
  | "SKIPPED_ALREADY_CLEAN"
  | "REFUSED_STALE_PREVIEW"
  | "PARTIAL"
  | "FAILED";

type Janitor = {
  categories: () => Array<{id: JanitorCategory}>;
  report: (input: {
    category: JanitorCategory | null;
    includeProtected: boolean;
    limit: number;
  }) => Promise<unknown>;
  status: () => unknown;
  history: (input: {
    limit: number;
    category: JanitorCategory | null;
    outcome: JanitorOutcome | null;
  }) => Promise<unknown>;
};
type JanitorReportInput = {
  category?: JanitorCategory | undefined;
  include_protected: boolean;
  limit: number;
};
type JanitorHistoryInput = {
  limit: number;
  category?: JanitorCategory | undefined;
  outcome?: JanitorOutcome | undefined;
};
type ToolDefinition = {
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};
type RegisterTextTool = {
  (name: "janitor_report", definition: ToolDefinition,
    handler: (input: JanitorReportInput) => Promise<unknown>,
    options: {projectAware: false}): unknown;
  (name: "janitor_status", definition: ToolDefinition,
    handler: () => Promise<unknown>,
    options: {projectAware: false}): unknown;
  (name: "janitor_history", definition: ToolDefinition,
    handler: (input: JanitorHistoryInput) => Promise<unknown>,
    options: {projectAware: false}): unknown;
};
type RegistrationOptions = {
  registerTextTool: RegisterTextTool;
  z: typeof zod;
  janitor: Janitor;
  processJsonResult: (value: unknown) => unknown;
  errorResult: (error: unknown) => unknown;
};

export async function registerRuntimeJanitorTools({
  registerTextTool,
  z,
  janitor,
  processJsonResult,
  errorResult,
}: RegistrationOptions) {
  const categoryIds = janitor.categories().map((item) => item.id);
  const categorySchema = z.enum(categoryIds as [string, ...string[]]);

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
