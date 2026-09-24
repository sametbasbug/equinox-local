function formatDesktopStatus(status) {
  return [
    `Peekaboo: ${status.version}`,
    `Binary: ${status.binary}`,
    `Peekaboo MCP köprüsü: ${status.active ? "AKTİF" : "pasif"}`,
    `Equinox Local allowlist: ${status.allowedToolCount} araç`,
    `Araçlar: ${status.allowedTools.join(", ")}`,
    status.compatibility
      ? `Uyumluluk: ${status.compatibility.ok ? "OK" : "HATA"} | minimum=${status.compatibility.minimumVersion.major}.${status.compatibility.minimumVersion.minor}.${status.compatibility.minimumVersion.patch}${status.compatibility.warnings.length > 0 ? ` | uyarı=${status.compatibility.warnings.join(" | ")}` : ""}`
      : `Uyumluluk: doğrulanamadı${status.error ? ` | ${status.error}` : ""}`,
    `MCP yeniden bağlantı: ${status.reconnectCount} | son=${status.lastReconnectAt ? new Date(status.lastReconnectAt).toISOString() : "yok"} | beklenmeyen kapanma=${status.unexpectedCloseCount} | son kapanma=${status.lastUnexpectedCloseAt ? new Date(status.lastUnexpectedCloseAt).toISOString() : "yok"}${status.lastTransportError ? ` | son transport hatası=${status.lastTransportError}` : ""}`,
    status.permissions
      ? `İzinler:\n${status.permissions}`
      : `İzin durumu alınamadı: ${status.error ?? "bilinmeyen hata"}`,
    status.serverStatus ? `Peekaboo server durumu:\n${status.serverStatus}` : null,
  ].filter(Boolean).join("\n\n");
}

const DESKTOP_BRIDGE_OPERATIONS = Object.freeze({
  status: Object.freeze({
    name: "status",
    title: "macOS desktop bridge status",
    description: "Show Peekaboo version, compatibility, permissions, connection state and Equinox Local desktop allowlist without performing UI actions.",
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    inputSchema: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
  }),
  refresh: Object.freeze({
    name: "refresh",
    title: "Refresh desktop tool catalog",
    description: "Reload the bounded Peekaboo MCP tool catalog without restarting the bridge or changing foreground UI.",
    readOnly: false,
    destructive: false,
    idempotent: true,
    openWorld: false,
    inputSchema: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
  }),
  restart: Object.freeze({
    name: "restart",
    title: "Restart desktop bridge",
    description: "Restart only the Peekaboo MCP subprocess and reload its safe tool catalog. Does not restart Equinox Local or applications.",
    readOnly: false,
    destructive: false,
    idempotent: false,
    openWorld: false,
    inputSchema: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
  }),
});

function publicDesktopTool(tool) {
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
  peekabooBridge,
  withMutationLocks,
  normalizeChromeToolResult,
  extractTextContent,
  textResult,
  errorResult,
  assertMutationAllowed = () => {},
  turnBudgetController = null,
} = {}) {
  const desktopTextResult = (text) => ({
    ...textResult(text),
    structuredContent: { text },
  });

  async function listDesktopOperations() {
    const bridgeOperations = Object.values(DESKTOP_BRIDGE_OPERATIONS);
    if (!agentAccess.desktop) return bridgeOperations;
    const tools = await peekabooBridge.listTools(false);
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
        label: "macOS desktop",
        count: operations.length,
        operations: operations.map(({ inputSchema, ...summary }) => summary),
      };
    },
    async describe(operation) {
      if (Object.hasOwn(DESKTOP_BRIDGE_OPERATIONS, operation)) {
        return { domain: "desktop", ...DESKTOP_BRIDGE_OPERATIONS[operation] };
      }
      if (!agentAccess.desktop) {
        throw new Error("Desktop automation access is disabled in Control Center.");
      }
      const tools = await peekabooBridge.listTools(false);
      const tool = tools.find((candidate) => candidate.name === operation);
      if (!tool) throw new Error(`desktop capability kataloğunda operation bulunamadı: ${operation}`);
      return { domain: "desktop", ...publicDesktopTool(tool) };
    },
  });

  registerRawTool(
    "desktop_call",
    {
      description:
        "Background-safe macOS desktop operation çağırır. Önce capabilities({domain: \"desktop\"}) ile operation'ları ve capabilities({domain: \"desktop\", operation: \"...\"}) ile güncel şemayı keşfet. status/refresh/restart bridge operation'larıdır; diğer operation'lar güvenli Peekaboo allowlist'ine gider. Web içeriği için browser_call tercih edilir.",
      inputSchema: {
        operation: z.string().min(1).max(160).describe("Çağrılacak desktop operation adı"),
        arguments: z.record(z.string(), z.unknown()).default({}).describe("Seçilen operation'ın güncel giriş şemasına uyan argümanlar"),
      },
      outputSchema: { text: z.string() },
      annotations: {
        title: "macOS desktop operation çağır",
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
          result = desktopTextResult(formatDesktopStatus(await peekabooBridge.status()));
        } else if (!agentAccess.desktop) {
          throw new Error("Desktop automation access is disabled in Control Center.");
        } else if (operation === "refresh") {
          if (Object.keys(operationArguments ?? {}).length > 0) throw new Error("desktop refresh arguments kabul etmez.");
          assertMutationAllowed("desktop.refresh");
          const tools = await peekabooBridge.listTools(true);
          result = desktopTextResult(`Peekaboo tool catalog refreshed: ${tools.length} safe tools.`);
        } else if (operation === "restart") {
          if (Object.keys(operationArguments ?? {}).length > 0) throw new Error("desktop restart arguments kabul etmez.");
          assertMutationAllowed("desktop.restart");
          result = await withMutationLocks(["desktop"], async () => {
            await peekabooBridge.restart();
            const tools = await peekabooBridge.listTools(true);
            return desktopTextResult(`Peekaboo MCP bridge restarted: ${tools.length} safe tools available.`);
          });
        } else {
          assertMutationAllowed(`desktop.${operation}`);
          result = await withMutationLocks(["desktop"], async () => {
            const toolResult = await peekabooBridge.callTool(operation, operationArguments);
            const normalized = normalizeChromeToolResult(toolResult);
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
