import type * as zod from "zod/v4";

type DesktopStatus = {
  engine?: string;
  version: string;
  binary: string;
  active: boolean;
  allowedToolCount: number;
  allowedTools: string[];
  compatibility?: {
    ok?: boolean;
    minimumVersion?: {major: number; minor: number; patch: number};
    warnings: string[];
  } | null;
  error?: string | null;
  reconnectCount?: number;
  lastReconnectAt?: string | null;
  unexpectedCloseCount?: number;
  lastUnexpectedCloseAt?: string | null;
  lastTransportError?: string | null;
  permissions?: string | null;
  serverStatus?: string | null;
};
type DesktopTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};
type DesktopOperation = {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
  inputSchema: Record<string, unknown>;
};
type DesktopBridge = {
  label?: string;
  status: () => Promise<DesktopStatus>;
  listTools: (refresh: boolean) => Promise<DesktopTool[]>;
  restart: () => Promise<unknown>;
  callTool: (operation: string, args: Record<string, unknown>) => Promise<unknown>;
};
type DesktopInput = {operation: string; arguments?: Record<string, unknown>};
type DesktopMcpContent = {type: string; text?: string; [key: string]: unknown};
type DesktopMcpResult = {content?: DesktopMcpContent[]; [key: string]: unknown};
type PreparedInvocation = {
  input: DesktopInput;
  firstNotice: boolean;
  waitClamped: boolean;
};
type TurnBudget = {
  prepareInvocation?: (toolName: string, input: DesktopInput) => Promise<PreparedInvocation>;
  decorateResult?: (result: unknown, prepared: PreparedInvocation) => unknown;
};
type ToolConfig = {
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
type RegisterDesktopOptions = {
  registerRawTool: (
    name: "desktop_call",
    config: ToolConfig,
    handler: (input: DesktopInput) => Promise<unknown>,
    options: {mcpExposed: true; capability: false; pauseGuard: false},
  ) => unknown;
  z: typeof zod;
  agentAccess: {desktop: boolean};
  desktopBridge?: DesktopBridge | null;
  peekabooBridge?: DesktopBridge | null;
  desktopLabel?: string | null;
  withMutationLocks: (scopes: ["desktop"], callback: () => Promise<unknown>) => Promise<unknown>;
  normalizeChromeToolResult: (result: unknown) => DesktopMcpResult;
  extractTextContent: (result: DesktopMcpResult) => string;
  textResult: (text: string) => Record<string, unknown>;
  errorResult: (error: unknown) => unknown;
  assertMutationAllowed?: (operation: string) => void;
  turnBudgetController?: TurnBudget | null;
};

function formatDesktopStatus(status: DesktopStatus) {
  if (status?.engine === "winapp") {
    return [
      `Microsoft winapp: ${status.version}`,
      `Binary: ${status.binary}`,
      `Windows desktop engine: ${status.active ? "AKTİF" : "pasif"}`,
      `Equinox Local allowlist: ${status.allowedToolCount} araç`,
      `Araçlar: ${status.allowedTools.join(", ")}`,
      status.compatibility?.warnings?.length ? `Not: ${status.compatibility.warnings.join(" | ")}` : null,
    ].filter(Boolean).join("\n\n");
  }
  return [
    `Peekaboo: ${status.version}`,
    `Binary: ${status.binary}`,
    `Peekaboo MCP köprüsü: ${status.active ? "AKTİF" : "pasif"}`,
    `Equinox Local allowlist: ${status.allowedToolCount} araç`,
    `Araçlar: ${status.allowedTools.join(", ")}`,
    status.compatibility
      ? `Uyumluluk: ${status.compatibility.ok ? "OK" : "HATA"} | minimum=${status.compatibility.minimumVersion!.major}.${status.compatibility.minimumVersion!.minor}.${status.compatibility.minimumVersion!.patch}${status.compatibility.warnings.length > 0 ? ` | uyarı=${status.compatibility.warnings.join(" | ")}` : ""}`
      : `Uyumluluk: doğrulanamadı${status.error ? ` | ${status.error}` : ""}`,
    `MCP yeniden bağlantı: ${status.reconnectCount} | son=${status.lastReconnectAt ? new Date(status.lastReconnectAt).toISOString() : "yok"} | beklenmeyen kapanma=${status.unexpectedCloseCount} | son kapanma=${status.lastUnexpectedCloseAt ? new Date(status.lastUnexpectedCloseAt).toISOString() : "yok"}${status.lastTransportError ? ` | son transport hatası=${status.lastTransportError}` : ""}`,
    status.permissions
      ? `İzinler:\n${status.permissions}`
      : `İzin durumu alınamadı: ${status.error ?? "bilinmeyen hata"}`,
    status.serverStatus ? `Peekaboo server durumu:\n${status.serverStatus}` : null,
  ].filter(Boolean).join("\n\n");
}

const DESKTOP_BRIDGE_OPERATIONS: Readonly<Record<"status" | "refresh" | "restart", DesktopOperation>> = Object.freeze({
  status: Object.freeze({
    name: "status",
    title: "Desktop engine status",
    description: "Show the platform desktop engine version, compatibility and Equinox Local allowlist without performing UI actions.",
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    inputSchema: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
  }),
  refresh: Object.freeze({
    name: "refresh",
    title: "Refresh desktop tool catalog",
    description: "Reload the bounded platform desktop tool catalog without changing foreground UI.",
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: false,
    inputSchema: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
  }),
  restart: Object.freeze({
    name: "restart",
    title: "Restart desktop bridge",
    description: "Restart or refresh only the platform desktop engine and reload its bounded tool catalog. Does not restart Equinox Local or applications.",
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: false,
    inputSchema: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
  }),
});

function publicDesktopTool(tool: DesktopTool): DesktopOperation {
  return {
    name: tool.name,
    title: tool.name,
    description: tool.description ?? "",
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: false,
    inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: false },
  };
}

export function registerDesktopGatewayTools({
  registerRawTool,
  z,
  agentAccess,
  desktopBridge = null,
  peekabooBridge = null,
  desktopLabel = null,
  withMutationLocks,
  normalizeChromeToolResult,
  extractTextContent,
  textResult,
  errorResult,
  assertMutationAllowed = () => {},
  turnBudgetController = null,
}: RegisterDesktopOptions) {
  const bridge = (desktopBridge ?? peekabooBridge)!;
  if (!bridge) throw new Error("Desktop bridge is required.");
  const resolvedDesktopLabel = desktopLabel ?? bridge.label ?? "Desktop";
  const desktopTextResult = (text: string) => ({
    ...textResult(text),
    structuredContent: { text },
  });

  async function listDesktopOperations() {
    const bridgeOperations = Object.values(DESKTOP_BRIDGE_OPERATIONS);
    if (!agentAccess.desktop) return bridgeOperations;
    const tools = await bridge.listTools(false);
    return [...bridgeOperations, ...tools.map(publicDesktopTool)];
  }

  const discovery = Object.freeze({
    async summary() {
      const operations = await listDesktopOperations();
      return { count: operations.length };
    },
    async catalog() {
      const operations = await listDesktopOperations();
      return {
        domain: "desktop",
        label: resolvedDesktopLabel,
        count: operations.length,
        operations: operations.map(({ inputSchema, ...summary }) => summary),
      };
    },
    async describe(operation: string) {
      if (Object.hasOwn(DESKTOP_BRIDGE_OPERATIONS, operation)) {
        return { domain: "desktop", ...DESKTOP_BRIDGE_OPERATIONS[operation as keyof typeof DESKTOP_BRIDGE_OPERATIONS] };
      }
      if (!agentAccess.desktop) {
        throw new Error("Desktop automation access is disabled in Control Center.");
      }
      const tools = await bridge.listTools(false);
      const tool = tools.find((candidate) => candidate.name === operation);
      if (!tool) throw new Error(`desktop capability kataloğunda operation bulunamadı: ${operation}`);
      return { domain: "desktop", ...publicDesktopTool(tool) };
    },
  });

  registerRawTool(
    "desktop_call",
    {
      description:
        "Platform desktop operation çağırır. Önce capabilities({domain: \"desktop\"}) ile operation'ları ve capabilities({domain: \"desktop\", operation: \"...\"}) ile güncel şemayı keşfet. macOS Peekaboo, Windows ise pinned Microsoft winapp UI subset kullanır. Web içeriği için browser_call tercih edilir.",
      inputSchema: {
        operation: z.string().min(1).max(160).describe("Çağrılacak desktop operation adı"),
        arguments: z.record(z.string(), z.unknown()).default({}).describe("Seçilen operation'ın güncel giriş şemasına uyan argümanlar"),
      },
      // Native desktop captures can return MCP image blocks. A text-only
      // outputSchema makes clients favor structuredContent and omit media.
      annotations: {
        title: "Desktop operation çağır",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const prepared = turnBudgetController?.prepareInvocation
        ? await turnBudgetController.prepareInvocation("desktop_call", input)
        : { input, firstNotice: false, waitClamped: false };
      const { operation, arguments: operationArguments } = prepared.input;
      let result;
      try {
        if (operation === "status") {
          if (Object.keys(operationArguments ?? {}).length > 0) throw new Error("desktop status arguments kabul etmez.");
          result = desktopTextResult(formatDesktopStatus(await bridge.status()));
        } else if (!agentAccess.desktop) {
          throw new Error("Desktop automation access is disabled in Control Center.");
        } else if (operation === "refresh") {
          if (Object.keys(operationArguments ?? {}).length > 0) throw new Error("desktop refresh arguments kabul etmez.");
          assertMutationAllowed("desktop.refresh");
          const tools = await bridge.listTools(true);
          result = desktopTextResult(`${resolvedDesktopLabel} tool catalog refreshed: ${tools.length} bounded tools.`);
        } else if (operation === "restart") {
          if (Object.keys(operationArguments ?? {}).length > 0) throw new Error("desktop restart arguments kabul etmez.");
          assertMutationAllowed("desktop.restart");
          result = await withMutationLocks(["desktop"], async () => {
            await bridge.restart();
            const tools = await bridge.listTools(true);
            return desktopTextResult(`${resolvedDesktopLabel} engine refreshed: ${tools.length} bounded tools available.`);
          });
        } else {
          assertMutationAllowed(`desktop.${operation}`);
          result = await withMutationLocks(["desktop"], async () => {
            const toolResult = await bridge.callTool(operation, operationArguments as Record<string, unknown>);
            const normalized = normalizeChromeToolResult(toolResult);
            // Preserve native image blocks as the canonical MCP response.
            // A parallel text-only structuredContent caused the actual
            // connected app to surface only the screenshot's filePath.
            if (normalized.content?.some((part) => part.type === "image")) return normalized;
            return {
              ...normalized,
              structuredContent: { text: extractTextContent(normalized) },
            };
          });
        }
      } catch (error) {
        result = errorResult(error);
      }
      return turnBudgetController?.decorateResult
        ? turnBudgetController.decorateResult(result, prepared)
        : result;
    },
    { mcpExposed: true, capability: false, pauseGuard: false },
  );

  return discovery;
}

export const __test = Object.freeze({ formatDesktopStatus, DESKTOP_BRIDGE_OPERATIONS });
