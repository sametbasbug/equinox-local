export async function registerRecoveryPolicyTools({
  registerTextTool,
  recoveryPolicyController,
  processJsonResult,
  errorResult,
}) {
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

  return Object.freeze({ toolCount: 1 });
}
