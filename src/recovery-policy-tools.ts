type RecoveryPolicyController = {
  status: () => Promise<unknown>;
};
type ToolDefinition = {
  description: string;
  inputSchema: Record<string, never>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};
type RegisterTextTool = (
  name: "recovery_status",
  definition: ToolDefinition,
  handler: () => Promise<unknown>,
  options: { projectAware: false },
) => unknown;
type RegistrationOptions = {
  registerTextTool: RegisterTextTool;
  recoveryPolicyController: RecoveryPolicyController;
  processJsonResult: (value: unknown) => unknown;
  errorResult: (error: unknown) => unknown;
};

export async function registerRecoveryPolicyTools({
  registerTextTool,
  recoveryPolicyController,
  processJsonResult,
  errorResult,
}: RegistrationOptions) {
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
