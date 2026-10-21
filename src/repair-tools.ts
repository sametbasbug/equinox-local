import { REPAIR_RECIPE_IDS } from "./repair-engine.js";
import type * as zod from "zod";

const REPAIR_OUTCOMES = Object.freeze([
  "RECOVERED",
  "FAILED",
  "NEEDS_INTERVENTION",
]);

type RepairOutcome = "RECOVERED" | "FAILED" | "NEEDS_INTERVENTION";
type RepairIssueInput = {
  incident_id: string;
  recipe_id: string;
};
type RepairHistoryInput = {
  limit: number;
  recipe_id?: string | undefined;
  outcome?: RepairOutcome | undefined;
  incident_id?: string | undefined;
};
type RepairEngine = {
  repairIssue: (input: { incidentId: string; recipeId: string }) => Promise<unknown>;
  history: (input: {
    limit: number;
    recipeId: string | null;
    outcome: RepairOutcome | null;
    incidentId: string | null;
  }) => Promise<unknown>;
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
  (name: "repair_issue", definition: ToolDefinition,
    handler: (input: RepairIssueInput) => Promise<unknown>,
    options: { projectAware: false; mutationScopes: ["global"] }): unknown;
  (name: "repair_history", definition: ToolDefinition,
    handler: (input: RepairHistoryInput) => Promise<unknown>,
    options: { projectAware: false }): unknown;
};
type RegistrationOptions = {
  registerTextTool: RegisterTextTool;
  z: typeof zod;
  repairEngine: RepairEngine;
  processJsonResult: (data: unknown) => unknown;
  errorResult: (error: unknown) => unknown;
};

export async function registerRepairTools({
  registerTextTool,
  z,
  repairEngine,
  processJsonResult,
  errorResult,
}: RegistrationOptions) {
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
        recipe_id: z.enum(REPAIR_RECIPE_IDS as [string, ...string[]]),
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
        recipe_id: z.enum(REPAIR_RECIPE_IDS as [string, ...string[]]).optional(),
        outcome: z.enum(REPAIR_OUTCOMES as [RepairOutcome, ...RepairOutcome[]]).optional(),
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

  return Object.freeze({ toolCount: 2 });
}

export const __test = Object.freeze({
  REPAIR_RECIPE_IDS,
  REPAIR_OUTCOMES,
});
