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
type ToolActivity = {
  id: number;
  operation: string;
  command: string | null;
  commandRedacted: boolean;
  resultSummary: {stdoutLines: number; stderrLines: number; truncated: boolean} | null;
  startedAt: string;
  finishedAt: string | null;
  state: "running" | "completed" | "failed" | "background";
  exitCode: number | null;
};
type ObserveInvocation = (name: string, input: unknown, invoke: () => unknown | Promise<unknown>) => Promise<unknown>;

// Record only known public command tokens, never arbitrary arguments, paths,
// scripts, or result bodies. A complex command should still communicate the
// actual operation where it can be identified without exposing its input.
const SAFE_COMMAND = /^(?:pwd|(?:GIT_OPTIONAL_LOCKS=0 )?git (?:status(?: --short| --branch| --short --branch| -sb)?|diff(?: --stat| --check| --cached --stat)?|log -1 --oneline|rev-parse HEAD)|npm run (?:build|typecheck|check|lint|(?:build|verify):typed-(?:runtime|desktop|browser|tooling)))$/u;
function safeCommandPreview(name: string, input: unknown): {command: string | null; commandRedacted: boolean} {
  const hidden = {command: null, commandRedacted: name === "terminal_exec"};
  if (name !== "terminal_exec" || !input || typeof input !== "object") return hidden;
  const command = (input as {command?: unknown}).command;
  if (typeof command !== "string") return hidden;
  const trimmed = command.trim();
  if (trimmed.length <= 500) {
    if (SAFE_COMMAND.test(trimmed)) return {command: trimmed, commandRedacted: false};
    const segments = trimmed.split(/\s*(?:&&|\|\||;|\r?\n)\s*/u);
    if (segments.length > 1 && segments.length <= 12 && segments.every(segment => SAFE_COMMAND.test(segment))) {
      return {command: trimmed, commandRedacted: false};
    }
  }
  // Recognize ordinary directory-qualified read-only commands without storing
  // any directory argument. These patterns accept only simple literal paths,
  // not interpolations, substitutions, arbitrary scripts or quoted bodies.
  // The redacted preview is never offered as a copyable full command.
  const literalPath = /^(?:'[^'\r\n$;|&<>\x60\\]+'|"[^"\r\n$;|&<>\x60\\]+"|[A-Za-z0-9_.:/\\~-]+)$/u;
  if (trimmed.length <= 1000) {
    const cd = /^cd[ \t]+(?:--[ \t]+)?(.+?)[ \t]*(&&|;|\r?\n)[ \t]*(.+)$/u.exec(trimmed);
    if (cd && literalPath.test(cd[1]!) && SAFE_COMMAND.test(cd[3]!)) {
      return {command: "cd …" + (cd[2] === "&&" ? " && " : cd[2] === ";" ? "; " : "\n") + cd[3], commandRedacted: true};
    }
    const gitAt = /^(GIT_OPTIONAL_LOCKS=0 )?git[ \t]+-C[ \t]+(.+?)[ \t]+(status(?: --short| --branch| --short --branch| -sb)?|diff(?: --stat| --check| --cached --stat)?|log -1 --oneline|rev-parse HEAD)$/u.exec(trimmed);
    if (gitAt && literalPath.test(gitAt[2]!)) {
      return {command: (gitAt[1] ? "GIT_OPTIONAL_LOCKS=0 " : "") + "git -C … " + gitAt[3], commandRedacted: true};
    }
  }
  // Fixed allowlists include real subcommands where identifiable. Never
  // parse arbitrary shell source or infer commands from quoted/script bodies.
  const git = /^(GIT_OPTIONAL_LOCKS=0 )?git[ \t]+(status|diff|log|show|fetch|pull|push|commit|add|restore|switch|branch|merge|rev-parse|worktree|ls-files|tag)(?:[ \t]|$)/u.exec(trimmed);
  if (git) return {command: (git[1] ? "GIT_OPTIONAL_LOCKS=0 " : "") + "git " + git[2] + " …", commandRedacted: true};
  const npm = /^npm[ \t]+(install|ci|update|outdated|audit|run|exec|pack|view|publish)(?:[ \t]|$)/u.exec(trimmed)?.[1];
  if (npm) return {command: "npm " + npm + " …", commandRedacted: true};
  const gh = /^gh[ \t]+(run|pr|issue|release|api|workflow)(?:[ \t]|$)/u.exec(trimmed)?.[1];
  if (gh) return {command: "gh " + gh + " …", commandRedacted: true};
  const family = /^(git|npm|npx|node|python3|python|rg|sed|awk|cat|head|tail|wc|sort|uniq|stat|date|printf|find|ls|curl|pwsh|powershell|bash|zsh|make|cmake|cargo|go|docker|gh)(?:[ \t]|$)/u.exec(trimmed)?.[1];
  return {command: family ? family + " …" : null, commandRedacted: true};
}

function countOutputLines(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) === 10) lines++;
  return value.endsWith("\n") ? lines - 1 : lines;
}

type GuardedOptions = {
  observeInvocation: ObserveInvocation;
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
  observeInvocation,
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

    return observeInvocation(name, args[0], () => beforeHandler(args, handler));
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
  let activitySequence = 0;
  const recentActivity: ToolActivity[] = [];
  const observeInvocation: ObserveInvocation = async (name, input, invoke) => {
    // Domain dispatchers and introspection are not separate work items.
    if (!/^[a-z][a-z0-9_]{0,79}$/u.test(name)
        || /^(?:capabilities|(?:runtime|browser|desktop|files|release|integrations)_call)$/u.test(name)) {
      return invoke();
    }
    const row: ToolActivity = {
      id: ++activitySequence, operation: name,
      ...safeCommandPreview(name, input), resultSummary: null, startedAt: new Date().toISOString(),
      finishedAt: null, state: "running", exitCode: null,
    };
    recentActivity.unshift(row);
    if (recentActivity.length > 80) {
      // A long-running command should not disappear just because many fast
      // operations completed after it. Keep the same hard memory bound.
      let oldestFinished = recentActivity.length - 1;
      while (oldestFinished > 0 && recentActivity[oldestFinished]?.state === "running") oldestFinished--;
      recentActivity.splice(oldestFinished > 0 ? oldestFinished : recentActivity.length - 1, 1);
    }
    try {
      const result = await invoke();
      row.state = result && (result as {isError?: unknown}).isError ? "failed" : "completed";
      if (name === "terminal_exec" && row.state !== "failed") {
        // Read only the outcome fields; discard the entire result immediately.
        try {
          const payload = JSON.parse(extractTextContent(result));
          if (Number.isInteger(payload?.exitCode)) row.exitCode = payload.exitCode;
          if (typeof payload?.stdout === "string" || typeof payload?.stderr === "string") {
            row.resultSummary = {stdoutLines: countOutputLines(payload.stdout), stderrLines: countOutputLines(payload.stderr),
              truncated: payload.stdoutTruncated === true || payload.stderrTruncated === true};
          }
          if (payload?.ok === false) row.state = "failed";
          else if (payload?.promoted === true && payload?.completed === false) row.state = "background";
        } catch { /* Non-JSON tool responses retain their MCP outcome. */ }
      }
      return result;
    } catch (error) {
      row.state = "failed";
      throw error;
    } finally {
      row.finishedAt = new Date().toISOString();
    }
  };

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
      observeInvocation,
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
      observeInvocation,
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
    getToolActivity: () => recentActivity.map(row => ({ ...row })),
    get registeredToolCount() {
      return registeredToolCount;
    },
  });
}
