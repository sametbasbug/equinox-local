export async function registerDiagnosisTools({
  registerTextTool,
  z,
  diagnosisEngine,
  projectIdSchema,
  processJsonResult,
  errorResult,
}) {
  const componentSchema = z.enum([
    "runtime",
    "workflow",
    "process",
    "terminal",
    "release-gate",
    "deployment",
    "peekaboo",
    "chrome",
  ]);

  registerTextTool(
    "diagnose_issue",
    {
      description:
        "v4.0.1 diagnosis engine ile son runtime olaylarını korele eder; workflow/process, release preview portu, Chrome/Peekaboo bridge ve deployment arızaları için salt okunur root-cause adayları üretir. Repair veya restart yapmaz.",
      inputSchema: {
        window_minutes: z.number().int().min(1).max(10080).default(60),
        project_id: projectIdSchema.optional(),
        component: componentSchema.optional(),
        include_resolved: z.boolean().default(true),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: {
        title: "Runtime sorununu teşhis et",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ window_minutes, project_id, component, include_resolved, limit }) => {
      try {
        return processJsonResult(await diagnosisEngine.diagnose({
          windowMs: window_minutes * 60 * 1000,
          projectId: project_id ?? null,
          component: component ?? null,
          includeResolved: include_resolved,
          limit,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "incident_report",
    {
      description:
        "diagnose_issue tarafından döndürülen tek bir incident kimliği için bounded event timeline, canlı port/bridge durumu ve mevcutsa workflow/process kanıtlarını salt okunur raporlar. Herhangi bir repair veya mutation yapmaz.",
      inputSchema: {
        incident_id: z
          .string()
          .min(8)
          .max(180)
          .regex(/^inc-[a-z0-9-]+$/u),
        window_minutes: z.number().int().min(1).max(10080).default(1440),
      },
      annotations: {
        title: "Incident kanıt raporunu göster",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ incident_id, window_minutes }) => {
      try {
        return processJsonResult(await diagnosisEngine.incidentReport({
          incidentId: incident_id,
          windowMs: window_minutes * 60 * 1000,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  return Object.freeze({ toolCount: 2 });
}
