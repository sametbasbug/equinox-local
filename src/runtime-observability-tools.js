function minutesToMs(value) {
  return value * 60 * 1000;
}

export function registerRuntimeObservabilityTools({
  registerTextTool,
  z,
  observability,
  getRuntimeSnapshot,
  processJsonResult,
  errorResult,
}) {
  if (typeof registerTextTool !== "function") {
    throw new Error("Observability araç kaydı için registerTextTool gerekli.");
  }
  if (!observability) {
    throw new Error("Observability runtime gerekli.");
  }

  registerTextTool(
    "runtime_events",
    {
      description:
        "Equinox Local kalıcı observability event kayıtlarını salt okunur sorgular. Credential değerleri event store'a yazılmadan önce redakte edilir; sonuçlar zaman, component, severity ve type ile daraltılabilir.",
      inputSchema: {
        since_minutes: z.number().int().min(1).max(10_080).default(60),
        limit: z.number().int().min(1).max(500).default(100),
        component: z.string().min(1).max(80).optional(),
        severity: z.enum(["info", "warn", "error", "critical"]).optional(),
        type: z.string().min(1).max(120).optional(),
        newest_first: z.boolean().default(true),
      },
      annotations: {
        title: "Runtime event geçmişi",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ since_minutes, limit, component, severity, type, newest_first }) => {
      try {
        const end = Date.now();
        const events = await observability.query({
          sinceMs: Math.max(0, end - minutesToMs(since_minutes)),
          untilMs: end,
          limit,
          component: component ?? null,
          severity: severity ?? null,
          type: type ?? null,
          newestFirst: newest_first,
        });
        return processJsonResult({
          ok: true,
          query: {
            sinceMinutes: since_minutes,
            limit,
            component: component ?? null,
            severity: severity ?? null,
            type: type ?? null,
            newestFirst: newest_first,
          },
          count: events.length,
          events,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "runtime_metrics",
    {
      description:
        "Equinox Local observability eventlerini seçilen zaman penceresinde severity, component, type ve status bazında toplar; bounded event-store disk kullanımını da raporlar.",
      inputSchema: {
        window_minutes: z.number().int().min(1).max(10_080).default(1_440),
      },
      annotations: {
        title: "Runtime observability metrikleri",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ window_minutes }) => {
      try {
        const metrics = await observability.metrics({
          windowMs: minutesToMs(window_minutes),
        });
        return processJsonResult({ ok: true, ...metrics });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "runtime_health",
    {
      description:
        "Equinox Local'in gözlemlenebilir sağlık durumunu HEALTHY, DEGRADED, RECOVERING veya ATTENTION REQUIRED olarak açık nedenlerle raporlar. Anlamsız sayısal sağlık skoru üretmez.",
      inputSchema: {
        window_minutes: z.number().int().min(1).max(1_440).default(15),
      },
      annotations: {
        title: "Runtime sağlık özeti",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ window_minutes }) => {
      try {
        const health = await observability.health({
          windowMs: minutesToMs(window_minutes),
        });
        const current = typeof getRuntimeSnapshot === "function"
          ? await getRuntimeSnapshot()
          : null;
        return processJsonResult({
          ok: true,
          ...health,
          current,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );
}
