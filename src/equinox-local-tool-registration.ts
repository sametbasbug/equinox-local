type ToolAnnotations = {
  readOnlyHint?: boolean;
  [key: string]: unknown;
};
type ToolConfig = {
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
  [key: string]: unknown;
};
type RegistrationOptions = {
  pauseGuard?: boolean;
  mcpExposed?: boolean;
  capability?: boolean;
  capabilityDomain?: string;
  projectAware?: boolean;
  projectSchema?: unknown;
  resolveContext?: (project: unknown) => Promise<unknown>;
  [key: string]: unknown;
};
type InvocationHandler = (...args: unknown[]) => unknown | Promise<unknown>;
type ReplayGuard = {
  run: (input: {
    toolName: string;
    input: unknown;
    extra: unknown;
    invoke: () => unknown | Promise<unknown>;
  }) => unknown | Promise<unknown>;
};
type RegistrarDependencies = {
  server: {registerTool: (name: string, config: ToolConfig, handler: InvocationHandler) => unknown};
  capabilityRegistry: {register: (capability: {
    name: string;
    config: ToolConfig;
    inputSchema: Record<string, unknown>;
    domain: string | undefined;
    invoke: (input: unknown) => unknown | Promise<unknown>;
  }) => unknown};
  runtimeRestartGuardError: (name: string) => unknown;
  errorResult: (error: unknown) => unknown;
  agentControl: {assertMutationAllowed: (name: string) => void};
  noteManagedAgentCommand: () => unknown | Promise<unknown>;
  mcpToolReplayGuard: ReplayGuard;
  getToolMutationScopes: (name: string, config: ToolConfig, options: RegistrationOptions, projectAware: boolean) => unknown;
  getMutationLockPlan: (scopes: unknown, context: unknown) => unknown;
  withMutationLockPlan: (plan: unknown, invoke: () => unknown | Promise<unknown>) => unknown | Promise<unknown>;
  projectContextStorage: {run: (context: unknown, invoke: () => unknown | Promise<unknown>) => unknown | Promise<unknown>};
  defaultProject: string;
  projectIdSchema: unknown;
  resolveProjectContext: (project: unknown) => Promise<unknown>;
  z: {string: () => unknown};
  extractTextContent: (result: unknown) => string;
};
type GuardedOptions = {
  name: string;
  config: ToolConfig;
  handler: InvocationHandler;
  options: RegistrationOptions;
  exposeToMcp: boolean;
  beforeHandler: (args: unknown[], handler: InvocationHandler) => unknown | Promise<unknown>;
  errorResult: RegistrarDependencies["errorResult"];
  runtimeRestartGuardError: RegistrarDependencies["runtimeRestartGuardError"];
  agentControl: RegistrarDependencies["agentControl"];
  noteManagedAgentCommand: RegistrarDependencies["noteManagedAgentCommand"];
};
type McpBoundaryOptions = {
  name: string;
  exposeToMcp: boolean;
  handler: InvocationHandler;
  mcpToolReplayGuard: ReplayGuard;
};
type RegisterBoundaryOptions = {
  name: string;
  config: ToolConfig;
  inputSchema: Record<string, unknown>;
  registeredConfig: ToolConfig;
  options: RegistrationOptions;
  wrappedHandler: InvocationHandler;
};

function createGuardedInvocation({
  name,
  config,
  handler,
  options,
  exposeToMcp,
  beforeHandler,
  errorResult,
  runtimeRestartGuardError,
  agentControl,
  noteManagedAgentCommand,
}: GuardedOptions): InvocationHandler {
  return async (...args: unknown[]) => {
    const restartGuardError = runtimeRestartGuardError(name);
    if (restartGuardError) {
      return errorResult(restartGuardError);
    }

    if (
      options.pauseGuard !== false &&
      config.annotations?.readOnlyHint !== true
    ) {
      try {
        agentControl.assertMutationAllowed(name);
      } catch (error) {
        return errorResult(error);
      }
    }

    if (exposeToMcp) {
      await noteManagedAgentCommand();
    }

    return beforeHandler(args, handler);
  };
}

function wrapAtMcpBoundary({
  name,
  exposeToMcp,
  handler,
  mcpToolReplayGuard,
}: McpBoundaryOptions): InvocationHandler {
  if (!exposeToMcp) return handler;

  return (...args: unknown[]) => mcpToolReplayGuard.run({
    toolName: name,
    input: args[0],
    extra: args[1],
    invoke: () => handler(...args),
  });
}

export function createEquinoxLocalToolRegistrar({
  server,
  capabilityRegistry,
  runtimeRestartGuardError,
  errorResult,
  agentControl,
  noteManagedAgentCommand,
  mcpToolReplayGuard,
  getToolMutationScopes,
  getMutationLockPlan,
  withMutationLockPlan,
  projectContextStorage,
  defaultProject,
  projectIdSchema,
  resolveProjectContext,
  z,
  extractTextContent,
}: RegistrarDependencies = {} as RegistrarDependencies) {
  let registeredToolCount = 0;

  const registerBoundary = ({
    name,
    config,
    inputSchema,
    registeredConfig,
    options,
    wrappedHandler,
  }: RegisterBoundaryOptions) => {
    const exposeToMcp = options.mcpExposed ?? false;
    const registerCapability = options.capability ?? true;
    const registration = exposeToMcp
      ? server.registerTool(name, registeredConfig, wrappedHandler)
      : null;

    if (exposeToMcp) {
      registeredToolCount += 1;
    }

    if (registerCapability) {
      capabilityRegistry.register({
        name,
        config: registeredConfig,
        inputSchema,
        domain: options.capabilityDomain,
        invoke: (input) => wrappedHandler(input),
      });
    }

    return registration;
  };

  function registerTextTool(name: string, config: ToolConfig, handler: InvocationHandler, options: RegistrationOptions = {}) {
    const projectAware = options.projectAware ?? true;
    const exposeToMcp = options.mcpExposed ?? false;
    const projectSchema = options.projectSchema ?? projectIdSchema;
    const resolveContext = options.resolveContext ?? resolveProjectContext;
    const inputSchema = projectAware
      ? {
          project: projectSchema,
          ...(config.inputSchema ?? {}),
        }
      : (config.inputSchema ?? {});
    const mutationScopes = getToolMutationScopes(
      name,
      config,
      options,
      projectAware,
    );
    const registeredConfig: ToolConfig = {
      ...config,
      inputSchema,
      outputSchema: config.outputSchema ?? { text: z.string() },
    };

    const guardedHandler = createGuardedInvocation({
      name,
      config: registeredConfig,
      handler,
      options,
      exposeToMcp,
      errorResult,
      runtimeRestartGuardError,
      agentControl,
      noteManagedAgentCommand,
      beforeHandler: async (args, targetHandler) => {
        const executeHandler = async (forwardedArgs: unknown[]) => {
          const result = await targetHandler(...forwardedArgs);
          if (!result || (result as {isError?: unknown}).isError || (result as {structuredContent?: unknown}).structuredContent) {
            return result;
          }
          return {
            ...(result as Record<string, unknown>),
            structuredContent: {
              text: extractTextContent(result),
            },
          };
        };

        if (!projectAware) {
          try {
            const lockPlan = getMutationLockPlan(mutationScopes, undefined);
            return await withMutationLockPlan(
              lockPlan,
              () => executeHandler(args),
            );
          } catch (error) {
            return errorResult(error);
          }
        }

        const [rawInput = {}, ...rest] = args;
        const input = rawInput && typeof rawInput === "object"
          ? rawInput as Record<string, unknown>
          : {};
        const {
          project = defaultProject,
          ...handlerInput
        } = input;

        try {
          const context = await resolveContext(project);
          const lockPlan = getMutationLockPlan(mutationScopes, context);
          return projectContextStorage.run(
            context,
            () => withMutationLockPlan(
              lockPlan,
              () => executeHandler([handlerInput, ...rest]),
            ),
          );
        } catch (error) {
          return errorResult(error);
        }
      },
    });
    const wrappedHandler = wrapAtMcpBoundary({
      name,
      exposeToMcp,
      handler: guardedHandler,
      mcpToolReplayGuard,
    });

    return registerBoundary({
      name,
      config,
      inputSchema,
      registeredConfig,
      options,
      wrappedHandler,
    });
  }

  function registerRawTool(name: string, config: ToolConfig, handler: InvocationHandler, options: RegistrationOptions = {}) {
    const exposeToMcp = options.mcpExposed ?? false;
    const inputSchema = config.inputSchema ?? {};
    const guardedHandler = createGuardedInvocation({
      name,
      config,
      handler,
      options,
      exposeToMcp,
      errorResult,
      runtimeRestartGuardError,
      agentControl,
      noteManagedAgentCommand,
      beforeHandler: async (args, targetHandler) => {
        try {
          return await targetHandler(...args);
        } catch (error) {
          return errorResult(error);
        }
      },
    });
    const wrappedHandler = wrapAtMcpBoundary({
      name,
      exposeToMcp,
      handler: guardedHandler,
      mcpToolReplayGuard,
    });

    return registerBoundary({
      name,
      config,
      inputSchema,
      registeredConfig: config,
      options,
      wrappedHandler,
    });
  }

  return Object.freeze({
    registerTextTool,
    registerRawTool,
    get registeredToolCount() {
      return registeredToolCount;
    },
  });
}
