export async function registerRecoveryPolicyTools({
  registerTextTool,
  z,
  recoveryPolicyController,
  processJsonResult,
  errorResult,
}) {
  const policyIds = recoveryPolicyController.policies().map((policy) => policy.id);
  const policySchema = z.enum(policyIds);

  registerTextTool(
    "recovery_policies",
    {
      description:
        "v4.0.3 sabit automatic low-risk recovery politikalarını, tetikleyici event tiplerini, incident kodlarını, recipe zincirlerini ve güvenlik sınırlarını salt okunur listeler.",
      inputSchema: {},
      annotations: {
        title: "Automatic recovery politikalarını göster",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return processJsonResult({
          policies: recoveryPolicyController.policies(),
          policy: {
            arbitraryCommand: false,
            deploymentMutation: false,
            gitMutation: false,
            credentialMutation: false,
            projectFileMutation: false,
            failedWorkflowAutoResume: false,
            chromeConnectionFailedAutoRetry: false,
          },
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "recovery_status",
    {
      description:
        "v4.0.3 automatic recovery controller durumunu, aktif işleri ve kalıcı circuit-breaker subject durumlarını salt okunur gösterir.",
      inputSchema: {},
      annotations: {
        title: "Automatic recovery durumunu göster",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        return processJsonResult(await recoveryPolicyController.status());
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "recovery_history",
    {
      description:
        "v4.0.3 automatic recovery karar ve circuit event geçmişini observability store üzerinden salt okunur listeler; policy veya event type ile daraltılabilir.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(100),
        policy_id: policySchema.optional(),
        event_type: z
          .string()
          .min(2)
          .max(120)
          .regex(/^[a-z0-9][a-z0-9._-]{1,119}$/u)
          .optional(),
      },
      annotations: {
        title: "Automatic recovery geçmişini göster",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit, policy_id, event_type }) => {
      try {
        return processJsonResult({
          events: await recoveryPolicyController.history({
            limit,
            policyId: policy_id ?? null,
            type: event_type ?? null,
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
