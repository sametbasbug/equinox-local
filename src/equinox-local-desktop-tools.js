export function registerDesktopGatewayTools({
  registerTextTool,
  registerRawTool,
  z,
  agentAccess,
  peekabooBridge,
  allowedTools,
  withMutationLocks,
  normalizeChromeToolResult,
  extractTextContent,
  textResult,
  errorResult,
  assertMutationAllowed = () => {},
} = {}) {
  registerTextTool(
    "desktop_status",
    {
      description:
        "Peekaboo tabanlı macOS masaüstü köprüsünün sürümünü, izin durumunu ve Equinox Local güvenli araç yüzeyini gösterir. UI eylemi gerçekleştirmez.",
      inputSchema: {},
      annotations: {
        title: "macOS masaüstü köprüsü durumu",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const status = await peekabooBridge.status();
        return textResult(
          [
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
            status.serverStatus
              ? `Peekaboo server durumu:\n${status.serverStatus}`
              : null,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
    {
      projectAware: false,
      mcpExposed: true,
      capability: false,
    },
  );

  registerTextTool(
    "desktop_tools",
    {
      description:
        "Equinox Local tarafından izin verilen Peekaboo macOS araçlarını ve JSON giriş şemalarını listeler. AI agent/analyze, ikinci browser yüzeyi, clipboard, dialog, paste ve ham dosya yakalama araçları bilinçli olarak dışarıda bırakılır.",
      inputSchema: {
        tool_name: z
          .string()
          .min(1)
          .max(160)
          .optional()
          .describe("İsteğe bağlı güvenli Peekaboo araç adı"),
        refresh: z
          .boolean()
          .default(false)
          .describe("Peekaboo MCP araç kataloğunu yeniden yükle"),
        restart: z
          .boolean()
          .default(false)
          .describe("Peekaboo MCP alt sürecini kapatıp yeniden başlat"),
      },
      annotations: {
        title: "macOS masaüstü araç kataloğu",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ tool_name, refresh, restart }) => {
      try {
        if (!agentAccess.desktop) {
          throw new Error("Desktop automation access is disabled in Control Center.");
        }

        if (restart) {
          assertMutationAllowed("desktop_tools.restart");
          await peekabooBridge.restart();
        }

        const tools = await peekabooBridge.listTools(refresh || restart);
        if (tool_name) {
          const tool = tools.find((candidate) => candidate.name === tool_name);
          if (!tool) {
            throw new Error(
              `Peekaboo aracı güvenli masaüstü kataloğunda bulunamadı: ${tool_name}`,
            );
          }
          return textResult(JSON.stringify(tool, null, 2));
        }

        return textResult(
          [
            `Equinox Local Peekaboo araç sayısı: ${tools.length}`,
            `Alt sunucu allowlist'i: ${allowedTools.join(", ")}`,
            ...tools.map((tool) =>
              [
                tool.name,
                tool.description ?? "",
                JSON.stringify(tool.inputSchema ?? {}),
              ].join("\n"),
            ),
          ].join("\n\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
    {
      projectAware: false,
      mcpExposed: true,
      capability: false,
    },
  );

  registerRawTool(
    "desktop_call",
    {
      description:
        "Peekaboo'nun Equinox Local allowlist'indeki tek bir macOS aracını çağırır. Önce desktop_tools ile şemayı incele. Koordinat tıklama/drag, körlemesine typing, global hotkey, force quit, AI araçları, clipboard/dialog/paste ve sistem menu-extra eylemleri güvenlik katmanında engellenir.",
      inputSchema: {
        tool_name: z
          .string()
          .min(1)
          .max(160)
          .describe("Çağrılacak güvenli Peekaboo araç adı"),
        arguments: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Peekaboo alt aracının JSON giriş şemasına uyan argümanlar"),
      },
      outputSchema: {
        text: z.string(),
      },
      annotations: {
        title: "macOS masaüstü aracını çağır",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ tool_name, arguments: toolArguments }) => {
      try {
        if (!agentAccess.desktop) {
          throw new Error("Desktop automation access is disabled in Control Center.");
        }

        return await withMutationLocks(["desktop"], async () => {
          const result = await peekabooBridge.callTool(tool_name, toolArguments);
          const normalized = normalizeChromeToolResult(result);
          return {
            ...normalized,
            structuredContent: {
              text: extractTextContent(normalized),
            },
          };
        });
      } catch (error) {
        return errorResult(error);
      }
    },
    {
      mcpExposed: true,
      capability: false,
    },
  );
}
