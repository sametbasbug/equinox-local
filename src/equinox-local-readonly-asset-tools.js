export function registerReadonlyAssetTools({
  registerTextTool,
  z,
  resolveAssetInboxRoot,
  fsImpl,
  inspectInboxAsset,
  formatAssetBytes,
  textResult,
  errorResult,
} = {}) {
  registerTextTool(
    "list_asset_inbox",
    {
      description:
        "Mac'teki sabit Equinox-Local-Inbox klasöründe bulunan desteklenen web varlıklarını tür, boyut ve SHA-256 özetiyle listeler. Proje dosyalarına dokunmaz.",
      inputSchema: {
        max_results: z.number().int().min(1).max(100).default(50),
      },
      annotations: {
        title: "Aktarım inbox'ını listele",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ max_results }) => {
      try {
        const inboxRoot = await resolveAssetInboxRoot();
        const entries = await fsImpl.readdir(inboxRoot, { withFileTypes: true });
        const candidates = entries
          .filter(
            (entry) =>
              entry.isFile() &&
              !entry.isSymbolicLink() &&
              !entry.name.startsWith("."),
          )
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, max_results);
        const rows = [];

        for (const entry of candidates) {
          try {
            const inspected = await inspectInboxAsset(entry.name);
            rows.push(
              [
                inspected.fileName,
                inspected.kind,
                formatAssetBytes(inspected.stats.size),
                inspected.sha256,
              ].join(" | "),
            );
          } catch (error) {
            rows.push(
              `${entry.name} | REDDEDİLDİ | ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }

        return textResult(
          [
            `Inbox: ${inboxRoot}`,
            "İzinler: yalnızca mevcut kullanıcı yazabilir",
            rows.length > 0
              ? rows.join("\n")
              : "Desteklenen aktarım dosyası bulunamadı.",
            entries.length > candidates.length
              ? "Liste sonuç sınırı veya desteklenmeyen/gizli öğeler nedeniyle tüm girişleri göstermeyebilir."
              : "Kaynak dosyalar listelenirken değiştirilmedi.",
          ].join("\n\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "inspect_inbox_asset",
    {
      description:
        "Equinox-Local-Inbox içindeki tek bir web varlığının dosya imzasını, MIME türünü, boyutunu ve SHA-256 özetini doğrular.",
      inputSchema: {
        file: z
          .string()
          .min(1)
          .max(220)
          .describe("Inbox kökündeki doğrudan dosya adı"),
      },
      annotations: {
        title: "Inbox varlığını doğrula",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ file }) => {
      try {
        const inspected = await inspectInboxAsset(file);
        return textResult(
          [
            `Dosya: ${inspected.fileName}`,
            `Tür: ${inspected.kind}`,
            `MIME: ${inspected.mime}`,
            `Boyut: ${formatAssetBytes(inspected.stats.size)} (${inspected.stats.size} bayt)`,
            `SHA-256: ${inspected.sha256}`,
            inspected.extension === ".svg"
              ? "SVG aktif kod ve dış kaynak kontrollerinden geçti."
              : "Dosya uzantısı ile ikili imzası eşleşiyor.",
            "Dosyada değişiklik yapılmadı.",
          ].join("\n\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );
}
