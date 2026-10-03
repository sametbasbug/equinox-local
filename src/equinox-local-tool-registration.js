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
}) {
  return async (...args) => {
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
}) {
  if (!exposeToMcp) return handler;

  return (...args) => mcpToolReplayGuard.run({
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
} = {}) {
  let registeredToolCount = 0;

  const registerBoundary = ({
    name,
    config,
    inputSchema,
    registeredConfig,
    options,
    wrappedHandler,
  }) => {
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

  function registerTextTool(name, config, handler, options = {}) {
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
    const registeredConfig = {
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
        const executeHandler = async (forwardedArgs) => {
          const result = await targetHandler(...forwardedArgs);
          if (!result || result.isError || result.structuredContent) {
            return result;
          }
          return {
            ...result,
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
          ? rawInput
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

  function registerRawTool(name, config, handler, options = {}) {
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
