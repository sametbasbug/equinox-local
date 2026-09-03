const REPAIR_RECIPE_IDS = Object.freeze([
  "peekaboo_bridge_restart",
  "stale_preview_cleanup",
  "orphan_process_cleanup",
  "stale_workflow_recover",
]);

const REPAIR_OUTCOMES = Object.freeze([
  "RECOVERED",
  "FAILED",
  "NEEDS_INTERVENTION",
]);

export async function registerRepairTools({
  registerTextTool,
  z,
  repairEngine,
  processJsonResult,
  errorResult,
}) {
  registerTextTool(
    "repair_recipes",
    {
      description:
        "v4.0.2 sabit ve denetlenebilir self-healing tariflerini listeler. Arbitrary shell, Git/deploy/credential/project-file mutasyonu içermez; incident koduna göre uygulanabilir tarifler filtrelenebilir.",
      inputSchema: {
        incident_code: z.string().min(2).max(100).optional(),
      },
      annotations: {
        title: "Güvenli repair tariflerini listele",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ incident_code }) => {
      try {
        const all = repairEngine.recipes();
        return processJsonResult({
          recipes: incident_code
            ? all.filter((recipe) => recipe.incidentCodes.includes(incident_code))
            : all,
          activeRepairs: repairEngine.activeRepairCount,
          policy: {
            arbitraryCommand: false,
            deploymentMutation: false,
            gitMutation: false,
            credentialMutation: false,
            projectFileMutation: false,
            preconditionsRecheckedAtExecution: true,
          },
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "repair_issue",
    {
      description:
        "Tek bir diagnosis incident'ine yalnız seçilen sabit v4.0.2 recipe'yi uygular. Incident'i ve canlı sahiplik/health koşullarını eylem anında yeniden doğrular; koşul değişmişse mutasyon yapmaz.",
      inputSchema: {
        incident_id: z
          .string()
          .min(8)
          .max(180)
          .regex(/^inc-[a-z0-9-]+$/u),
        recipe_id: z.enum(REPAIR_RECIPE_IDS),
      },
      annotations: {
        title: "Incident için güvenli repair çalıştır",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ incident_id, recipe_id }) => {
      try {
        return processJsonResult({
          repair: await repairEngine.repairIssue({
            incidentId: incident_id,
            recipeId: recipe_id,
          }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    {
      projectAware: false,
      mutationScopes: ["global"],
    },
  );

  registerTextTool(
    "repair_history",
    {
      description:
        "Kalıcı v4.0.2 repair audit geçmişini salt okunur listeler; recipe, outcome veya incident ile daraltılabilir. Repair kayıtları credential ve serbest komut argümanı saklamaz.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(50),
        recipe_id: z.enum(REPAIR_RECIPE_IDS).optional(),
        outcome: z.enum(REPAIR_OUTCOMES).optional(),
        incident_id: z
          .string()
          .min(8)
          .max(180)
          .regex(/^inc-[a-z0-9-]+$/u)
          .optional(),
      },
      annotations: {
        title: "Repair geçmişini göster",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit, recipe_id, outcome, incident_id }) => {
      try {
        return processJsonResult({
          repairs: await repairEngine.history({
            limit,
            recipeId: recipe_id ?? null,
            outcome: outcome ?? null,
            incidentId: incident_id ?? null,
          }),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  return Object.freeze({ toolCount: 3 });
}

export const __test = Object.freeze({
  REPAIR_RECIPE_IDS,
  REPAIR_OUTCOMES,
});
