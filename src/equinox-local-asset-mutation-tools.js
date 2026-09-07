export function registerAssetMutationTools({
  registerTextTool,
  z,
  inspectInboxAsset,
  fsImpl,
  pathImpl,
  processImpl,
  formatAssetBytes,
  assertNoGitOperationInProgress,
  getCurrentGitBranch,
  validateAssetDestination,
  assertAssetExtensionCompatible,
  getActiveProjectRoot,
  safeResolve,
  isInsideProject,
  assertPathNotIgnored,
  runGitWithCode,
  maxInboxAssetBytes,
  sha256Buffer,
  getActiveProjectId,
  getActiveProjectName,
  readBoundedNormalFile,
  allowedInboxAssetExtensions,
  detectAndValidateAsset,
  validateInboxAssetName,
  resolveAssetInboxRoot,
  displayPath,
  textResult,
  errorResult,
} = {}) {
  const fs = fsImpl;
  const path = pathImpl;
  const process = processImpl;
  const MAX_INBOX_ASSET_BYTES = maxInboxAssetBytes;
  const ALLOWED_INBOX_ASSET_EXTENSIONS = allowedInboxAssetExtensions;
  registerTextTool(
    "delete_inbox_asset",
    {
      description:
        "Equinox-Local-Inbox içindeki tek bir doğrulanmış web varlığını yalnızca beklenen SHA-256 özeti güncel içerikle eşleşirse siler. Proje dosyalarına dokunmaz.",
      inputSchema: {
        file: z
          .string()
          .min(1)
          .max(220)
          .describe("Inbox kökündeki doğrudan dosya adı"),
        expected_sha256: z
          .string()
          .regex(
            /^[a-fA-F0-9]{64}$/,
            "SHA-256 tam olarak 64 onaltılık karakter olmalı.",
          )
          .describe(
            "inspect_inbox_asset veya list_asset_inbox tarafından döndürülen özet",
          ),
      },
      annotations: {
        title: "Inbox varlığını sil",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ file, expected_sha256 }) => {
      try {
        const inspected = await inspectInboxAsset(file);
        const expected = expected_sha256.toLowerCase();

        if (inspected.sha256 !== expected) {
          throw new Error(
            [
              "Inbox varlığı SHA-256 uyuşmazlığı nedeniyle silinmedi.",
              `Beklenen: ${expected}`,
              `Mevcut:  ${inspected.sha256}`,
            ].join("\n"),
          );
        }

        const finalStats = await fsImpl.lstat(inspected.realPath);
        if (
          finalStats.isSymbolicLink() ||
          !finalStats.isFile() ||
          finalStats.dev !== inspected.stats.dev ||
          finalStats.ino !== inspected.stats.ino ||
          finalStats.size !== inspected.stats.size ||
          finalStats.mtimeMs !== inspected.stats.mtimeMs
        ) {
          throw new Error(
            "Inbox varlığı silme öncesinde değişti; işlem durduruldu.",
          );
        }

        await fsImpl.unlink(inspected.realPath);
        return textResult(
          [
            `Inbox varlığı silindi: ${inspected.fileName}`,
            `Tür: ${inspected.kind}`,
            `Boyut: ${formatAssetBytes(inspected.stats.size)}`,
            `Doğrulanan SHA-256: ${inspected.sha256}`,
            "Hiçbir proje dosyası değiştirilmedi.",
          ].join("\n\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
    { projectAware: false },
  );

  registerTextTool(
    "import_asset",
    {
      description:
        "Doğrulanmış bir web varlığını sabit Equinox-Local-Inbox klasöründen seçilen projedeki mevcut bir klasöre atomik olarak kopyalar. Varsayılan olarak üzerine yazmaz; mevcut dosya yalnızca SHA-256 doğrulamasıyla değiştirilebilir.",
      inputSchema: {
        inbox_file: z
          .string()
          .min(1)
          .max(220)
          .describe(
            "Inbox kökündeki doğrudan kaynak dosya adı",
          ),
        expected_sha256: z
          .string()
          .regex(
            /^[a-fA-F0-9]{64}$/,
            "Kaynak SHA-256 tam olarak 64 onaltılık karakter olmalı.",
          )
          .describe(
            "inspect_inbox_asset veya list_asset_inbox tarafından döndürülen kaynak özeti",
          ),
        destination: z
          .string()
          .min(1)
          .max(300)
          .describe(
            "Seçilen proje köküne göre hedef dosya yolu; üst klasör önceden mevcut olmalı",
          ),
        replace_existing: z
          .boolean()
          .default(false)
          .describe(
            "Mevcut temiz ve takipli hedef dosyayı değiştirmeye izin ver",
          ),
        expected_destination_sha256: z
          .string()
          .regex(
            /^[a-fA-F0-9]{64}$/,
            "Hedef SHA-256 tam olarak 64 onaltılık karakter olmalı.",
          )
          .optional()
          .describe(
            "replace_existing kullanılıyorsa mevcut hedef dosyanın SHA-256 özeti (ör. Terminal’de shasum -a 256 ile)",
          ),
      },
      annotations: {
        title: "Web varlığını projeye aktar",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      inbox_file,
      expected_sha256,
      destination,
      replace_existing,
      expected_destination_sha256,
    }) => {
      let temporaryPath;
      let replacementBackup;
      let writeCompleted = false;

      try {
        const expectedSourceHash =
          expected_sha256.toLowerCase();

        const source =
          await inspectInboxAsset(
            inbox_file,
          );

        if (
          source.sha256 !==
          expectedSourceHash
        ) {
          throw new Error(
            [
              "Kaynak SHA-256 uyuşmuyor; varlık aktarılmadı.",
              `Beklenen: ${expectedSourceHash}`,
              `Mevcut:  ${source.sha256}`,
            ].join("\n"),
          );
        }

        await assertNoGitOperationInProgress();

        const branch =
          await getCurrentGitBranch();

        if (
          !branch.startsWith(
            "equinox/",
          )
        ) {
          throw new Error(
            [
              "Web varlığı yalnızca equinox/ çalışma branch'inde içe aktarılabilir.",
              `Mevcut branch: ${branch}`,
            ].join("\n"),
          );
        }

        const target =
          validateAssetDestination(
            destination,
          );

        assertAssetExtensionCompatible(
          source.extension,
          target.extension,
        );

        const parentRelative =
          path.posix.dirname(
            target.normalized,
          );

        const parentPath =
          parentRelative === "."
            ? getActiveProjectRoot()
            : await safeResolve(
                parentRelative,
              );

        const parentStats =
          await fs.lstat(parentPath);

        if (
          parentStats.isSymbolicLink() ||
          !parentStats.isDirectory()
        ) {
          throw new Error(
            "Hedef üst yol normal bir klasör değil.",
          );
        }

        const destinationPath =
          path.join(
            parentPath,
            path.posix.basename(
              target.normalized,
            ),
          );

        if (!isInsideProject(destinationPath)) {
          throw new Error(
            "Hedef dosya proje dışına çıkıyor.",
          );
        }

        await assertPathNotIgnored(
          target.normalized,
        );

        let destinationExists = false;
        let destinationStats;

        try {
          destinationStats =
            await fs.lstat(
              destinationPath,
            );
          destinationExists = true;
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }

        if (
          destinationExists &&
          !replace_existing
        ) {
          throw new Error(
            "Hedef dosya zaten mevcut; replace_existing verilmediği için üzerine yazılmadı.",
          );
        }

        if (
          !destinationExists &&
          replace_existing
        ) {
          throw new Error(
            "replace_existing istendi ancak hedef dosya mevcut değil.",
          );
        }

        if (
          destinationExists
        ) {
          if (
            destinationStats.isSymbolicLink() ||
            !destinationStats.isFile()
          ) {
            throw new Error(
              "Mevcut hedef normal bir dosya değil; değiştirilemez.",
            );
          }

          if (
            !expected_destination_sha256
          ) {
            throw new Error(
              "Mevcut hedefi değiştirmek için expected_destination_sha256 zorunlu.",
            );
          }

          const targetStatus =
            await runGitWithCode([
              "status",
              "--porcelain=v1",
              "--no-renames",
              "--",
              target.normalized,
            ]);

          if (targetStatus.code !== 0) {
            throw new Error(
              `Hedef Git durumu alınamadı: ${targetStatus.stderr.trim()}`,
            );
          }

          if (targetStatus.stdout.trim()) {
            throw new Error(
              [
                "Hedef dosyada önceden Git değişikliği var; değiştirme durduruldu.",
                targetStatus.stdout.trim(),
              ].join("\n"),
            );
          }

          const tracked =
            await runGitWithCode([
              "ls-files",
              "--error-unmatch",
              "--",
              target.normalized,
            ]);

          if (tracked.code !== 0) {
            throw new Error(
              "Mevcut hedef Git tarafından takip edilmiyor; güvenlik nedeniyle değiştirilemez.",
            );
          }

          if (
            destinationStats.size >
            MAX_INBOX_ASSET_BYTES
          ) {
            throw new Error(
              "Mevcut hedef 10 MB doğrulama sınırını aşıyor.",
            );
          }

          const destinationBuffer =
            await fs.readFile(
              destinationPath,
            );

          const destinationHash =
            await sha256Buffer(
              destinationBuffer,
            );

          if (
            destinationHash !==
            expected_destination_sha256.toLowerCase()
          ) {
            throw new Error(
              [
                "Mevcut hedef SHA-256 uyuşmuyor; dosya değiştirilmedi.",
                `Beklenen: ${expected_destination_sha256.toLowerCase()}`,
                `Mevcut:  ${destinationHash}`,
              ].join("\n"),
            );
          }

          replacementBackup = {
            path: destinationPath,
            buffer: destinationBuffer,
            mode:
              destinationStats.mode &
              0o777,
            dev: destinationStats.dev,
            ino: destinationStats.ino,
            size: destinationStats.size,
            mtimeMs:
              destinationStats.mtimeMs,
          };
        } else if (
          expected_destination_sha256
        ) {
          throw new Error(
            "Hedef mevcut değilken expected_destination_sha256 verilmemeli.",
          );
        }

        temporaryPath =
          path.join(
            parentPath,
            `.equinox-asset-${process.pid}-${Date.now()}.tmp`,
          );

        const temporaryHandle =
          await fs.open(
            temporaryPath,
            "wx",
            0o644,
          );

        try {
          await temporaryHandle.writeFile(
            source.buffer,
          );
          await temporaryHandle.sync();
        } finally {
          await temporaryHandle.close();
        }

        if (destinationExists) {
          const finalDestinationStats =
            await fs.lstat(
              destinationPath,
            );

          if (
            finalDestinationStats.isSymbolicLink() ||
            !finalDestinationStats.isFile() ||
            finalDestinationStats.dev !==
              replacementBackup.dev ||
            finalDestinationStats.ino !==
              replacementBackup.ino ||
            finalDestinationStats.size !==
              replacementBackup.size ||
            finalDestinationStats.mtimeMs !==
              replacementBackup.mtimeMs
          ) {
            throw new Error(
              "Hedef dosya doğrulama sonrasında değişti; üzerine yazılmadı.",
            );
          }

          await fs.rename(
            temporaryPath,
            destinationPath,
          );
          temporaryPath = undefined;
          writeCompleted = true;
        } else {
          await fs.link(
            temporaryPath,
            destinationPath,
          );
          await fs.unlink(
            temporaryPath,
          );
          temporaryPath = undefined;
          writeCompleted = true;
        }

        const importedBuffer =
          await fs.readFile(
            destinationPath,
          );

        const importedHash =
          await sha256Buffer(
            importedBuffer,
          );

        if (
          importedHash !==
          source.sha256
        ) {
          throw new Error(
            "Aktarılan hedefin SHA-256 özeti kaynakla eşleşmiyor.",
          );
        }

        const status =
          await runGitWithCode([
            "status",
            "--short",
            "--",
            target.normalized,
          ]);

        if (status.code !== 0) {
          throw new Error(
            `Aktarım sonrası Git durumu alınamadı: ${status.stderr.trim()}`,
          );
        }

        writeCompleted = false;
        replacementBackup = undefined;

        return textResult(
          [
            `Web varlığı projeye aktarıldı: ${target.normalized}`,
            `Proje: ${getActiveProjectId()} (${getActiveProjectName()})`,
            `Branch: ${branch}`,
            `Kaynak: ${source.fileName}`,
            `Tür: ${source.kind} (${source.mime})`,
            `Boyut: ${formatAssetBytes(source.stats.size)}`,
            `Doğrulanan SHA-256: ${source.sha256}`,
            destinationExists
              ? "Mevcut temiz ve takipli hedef SHA doğrulamasıyla değiştirildi."
              : "Yeni dosya oluşturuldu; mevcut dosyanın üzerine yazılmadı.",
            status.stdout.trim()
              ? `Git durumu:\n${status.stdout.trim()}`
              : "Git durumu değişiklik göstermiyor.",
            `Inbox kaynağı korundu: ${source.inboxRoot}/${source.fileName}`,
            "Build otomatik çalıştırılmadı; gerekli proje build/test komutlarını Terminal üzerinden ayrıca doğrula.",
          ].join("\n\n"),
        );
      } catch (error) {
        if (
          writeCompleted &&
          replacementBackup
        ) {
          try {
            const rollbackTemporary =
              `${replacementBackup.path}.equinox-rollback-${process.pid}-${Date.now()}.tmp`;

            await fs.writeFile(
              rollbackTemporary,
              replacementBackup.buffer,
              {
                mode:
                  replacementBackup.mode,
              },
            );

            await fs.rename(
              rollbackTemporary,
              replacementBackup.path,
            );
          } catch (rollbackError) {
            return errorResult(
              new Error(
                [
                  error instanceof Error
                    ? error.message
                    : String(error),
                  "UYARI: Değiştirilen hedef otomatik olarak geri yüklenemedi.",
                  rollbackError instanceof Error
                    ? rollbackError.message
                    : String(rollbackError),
                ].join("\n"),
              ),
            );
          }
        } else if (writeCompleted) {
          await fs.rm(
            path.resolve(
              getActiveProjectRoot(),
              destination,
            ),
            { force: true },
          ).catch(() => {});
        }

        return errorResult(error);
      } finally {
        if (temporaryPath) {
          await fs.rm(
            temporaryPath,
            { force: true },
          ).catch(() => {});
        }
      }
    },
  );

  registerTextTool(
    "export_asset",
    {
      description:
        "Seçilen projedeki doğrulanmış bir PNG, JPG, WebP, AVIF, GIF, ICO, SVG, WOFF veya WOFF2 dosyasını SHA doğrulamasıyla Equinox-Local-Inbox köküne atomik biçimde kopyalar. Proje dosyasını değiştirmez.",
      inputSchema: {
        source_path: z
          .string()
          .min(1)
          .max(300),
        expected_sha256: z
          .string()
          .regex(
            /^[a-fA-F0-9]{64}$/,
            "Kaynak SHA-256 tam olarak 64 onaltılık karakter olmalı.",
          ),
        inbox_name: z
          .string()
          .min(1)
          .max(220)
          .optional(),
        replace_existing: z
          .boolean()
          .default(false),
        expected_inbox_sha256: z
          .string()
          .regex(
            /^[a-fA-F0-9]{64}$/,
          )
          .optional(),
      },
      annotations: {
        title: "Proje varlığını aktarım inbox'ına çıkar",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      source_path,
      expected_sha256,
      inbox_name,
      replace_existing,
      expected_inbox_sha256,
    }) => {
      let temporaryPath;
      let writeCompleted = false;
      let replacementBackup;
      let targetPath;

      try {
        const sourcePath =
          await safeResolve(
            source_path,
          );
        const rawSource =
          path.resolve(
            getActiveProjectRoot(),
            source_path,
          );
        const initialStats =
          await fs.lstat(rawSource);

        if (
          initialStats.isSymbolicLink() ||
          !initialStats.isFile()
        ) {
          throw new Error(
            "Dışa aktarılacak kaynak normal bir dosya olmalı.",
          );
        }

        const { data: sourceBuffer, stat: resolvedStats } = await readBoundedNormalFile(sourcePath, {
          maxBytes: MAX_INBOX_ASSET_BYTES,
          label: "Dışa aktarılacak web varlığı",
        });

        if (
          initialStats.dev !==
            resolvedStats.dev ||
          initialStats.ino !==
            resolvedStats.ino
        ) {
          throw new Error(
            "Kaynak dosya doğrulama sırasında değişti.",
          );
        }

        const sourceExtension =
          path.extname(
            source_path,
          ).toLowerCase();

        if (
          !ALLOWED_INBOX_ASSET_EXTENSIONS.has(
            sourceExtension,
          )
        ) {
          throw new Error(
            "Kaynak dosya desteklenen web varlığı türlerinden biri değil.",
          );
        }

        const detected =
          detectAndValidateAsset(
            sourceBuffer,
            sourceExtension,
          );
        const sourceHash =
          await sha256Buffer(
            sourceBuffer,
          );

        if (
          sourceHash !==
          expected_sha256.toLowerCase()
        ) {
          throw new Error(
            [
              "Kaynak SHA-256 uyuşmuyor; dışa aktarılmadı.",
              `Beklenen: ${expected_sha256.toLowerCase()}`,
              `Mevcut:  ${sourceHash}`,
            ].join("\n"),
          );
        }

        const finalStats =
          await fs.lstat(rawSource);

        if (
          finalStats.isSymbolicLink() ||
          !finalStats.isFile() ||
          finalStats.dev !==
            initialStats.dev ||
          finalStats.ino !==
            initialStats.ino ||
          finalStats.size !==
            initialStats.size ||
          finalStats.mtimeMs !==
            initialStats.mtimeMs
        ) {
          throw new Error(
            "Kaynak dosya okunurken değişti; dışa aktarım durduruldu.",
          );
        }

        const desiredName =
          inbox_name ||
          path.basename(
            source_path,
          );
        const validatedTarget =
          validateInboxAssetName(
            desiredName,
          );

        assertAssetExtensionCompatible(
          sourceExtension,
          validatedTarget.extension,
        );

        const inboxRoot =
          await resolveAssetInboxRoot();
        targetPath = path.join(
          inboxRoot,
          validatedTarget.fileName,
        );

        if (
          path.dirname(targetPath) !==
          inboxRoot
        ) {
          throw new Error(
            "Inbox hedefi aktarım klasörünün dışına çıkıyor.",
          );
        }

        let targetExists = false;

        try {
          await fs.lstat(targetPath);
          targetExists = true;
        } catch (error) {
          if (error?.code !== "ENOENT") {
            throw error;
          }
        }

        if (
          targetExists &&
          !replace_existing
        ) {
          throw new Error(
            "Inbox hedefi zaten mevcut; replace_existing verilmediği için üzerine yazılmadı.",
          );
        }

        if (
          !targetExists &&
          replace_existing
        ) {
          throw new Error(
            "replace_existing istendi ancak inbox hedefi mevcut değil.",
          );
        }

        if (targetExists) {
          if (!expected_inbox_sha256) {
            throw new Error(
              "Mevcut inbox hedefini değiştirmek için expected_inbox_sha256 zorunlu.",
            );
          }

          const existing =
            await inspectInboxAsset(
              validatedTarget.fileName,
            );

          if (
            existing.sha256 !==
            expected_inbox_sha256.toLowerCase()
          ) {
            throw new Error(
              "Mevcut inbox hedefinin SHA-256 özeti beklenen değerle uyuşmuyor.",
            );
          }

          replacementBackup = {
            buffer: existing.buffer,
            mode:
              existing.stats.mode &
              0o777,
          };
        } else if (
          expected_inbox_sha256
        ) {
          throw new Error(
            "Inbox hedefi mevcut değilken expected_inbox_sha256 verilmemeli.",
          );
        }

        temporaryPath = path.join(
          inboxRoot,
          `.equinox-export-${process.pid}-${Date.now()}.tmp`,
        );

        const temporaryHandle =
          await fs.open(
            temporaryPath,
            "wx",
            0o644,
          );

        try {
          await temporaryHandle.writeFile(
            sourceBuffer,
          );
          await temporaryHandle.sync();
        } finally {
          await temporaryHandle.close();
        }

        if (targetExists) {
          await fs.rename(
            temporaryPath,
            targetPath,
          );
          temporaryPath = undefined;
          writeCompleted = true;
        } else {
          await fs.link(
            temporaryPath,
            targetPath,
          );
          await fs.unlink(
            temporaryPath,
          );
          temporaryPath = undefined;
          writeCompleted = true;
        }

        const exported =
          await inspectInboxAsset(
            validatedTarget.fileName,
          );

        if (
          exported.sha256 !==
          sourceHash
        ) {
          throw new Error(
            "Inbox'a aktarılan dosyanın SHA-256 özeti kaynakla eşleşmiyor.",
          );
        }

        writeCompleted = false;
        replacementBackup = undefined;

        return textResult(
          [
            `Web varlığı inbox'a aktarıldı: ${validatedTarget.fileName}`,
            `Proje: ${getActiveProjectId()} (${getActiveProjectName()})`,
            `Kaynak: ${displayPath(sourcePath)}`,
            `Tür: ${detected.kind} (${detected.mime})`,
            `Boyut: ${formatAssetBytes(resolvedStats.size)}`,
            `Doğrulanan SHA-256: ${sourceHash}`,
            targetExists
              ? "Mevcut inbox hedefi SHA doğrulamasıyla değiştirildi."
              : "Yeni inbox dosyası oluşturuldu.",
            "Proje dosyası değiştirilmedi veya silinmedi.",
          ].join("\n\n"),
        );
      } catch (error) {
        if (
          writeCompleted &&
          targetPath
        ) {
          if (replacementBackup) {
            try {
              const rollbackPath =
                `${targetPath}.equinox-rollback-${process.pid}-${Date.now()}.tmp`;

              await fs.writeFile(
                rollbackPath,
                replacementBackup.buffer,
                {
                  mode:
                    replacementBackup.mode,
                },
              );
              await fs.rename(
                rollbackPath,
                targetPath,
              );
            } catch (rollbackError) {
              return errorResult(
                new Error(
                  [
                    error instanceof Error
                      ? error.message
                      : String(error),
                    "UYARI: Değiştirilen inbox hedefi otomatik geri yüklenemedi.",
                    rollbackError instanceof Error
                      ? rollbackError.message
                      : String(rollbackError),
                  ].join("\n"),
                ),
              );
            }
          } else {
            await fs.rm(
              targetPath,
              { force: true },
            ).catch(() => {});
          }
        }

        return errorResult(error);
      } finally {
        if (temporaryPath) {
          await fs.rm(
            temporaryPath,
            { force: true },
          ).catch(() => {});
        }
      }
    },
  );
}
