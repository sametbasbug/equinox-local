import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

async function pathState(filePath) {
  try {
    const stats = await fs.lstat(filePath);
    return { exists: true, stats };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, stats: null };
    }
    throw error;
  }
}

export async function hashFile(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

async function scanSourceTree({
  sourcePath,
  shouldRejectEntry,
  maxFiles,
  maxBytes,
}) {
  const entries = [];
  let totalBytes = 0;
  let fileCount = 0;

  const visit = async (absolutePath, relativePath) => {
    const stats = await fs.lstat(absolutePath);

    if (stats.isSymbolicLink()) {
      throw new Error(
        `Sembolik bağlantı proje aktarımında desteklenmiyor: ${relativePath || "."}`,
      );
    }

    const name = path.basename(absolutePath);

    if (relativePath && shouldRejectEntry?.(name, relativePath)) {
      throw new Error(
        `Aktarıma kapalı yol bulundu: ${relativePath}`,
      );
    }

    if (stats.isDirectory()) {
      entries.push({
        type: "directory",
        absolutePath,
        relativePath,
        mode: stats.mode & 0o777,
      });

      const children = await fs.readdir(absolutePath, {
        withFileTypes: true,
      });
      children.sort((a, b) => a.name.localeCompare(b.name));

      for (const child of children) {
        await visit(
          path.join(absolutePath, child.name),
          relativePath
            ? path.join(relativePath, child.name)
            : child.name,
        );
      }
      return;
    }

    if (!stats.isFile()) {
      throw new Error(
        `Yalnızca normal dosya ve klasörler aktarılabilir: ${relativePath || "."}`,
      );
    }

    fileCount += 1;
    totalBytes += stats.size;

    if (fileCount > maxFiles) {
      throw new Error(
        `Aktarım ${maxFiles} dosya sınırını aşıyor.`,
      );
    }

    if (totalBytes > maxBytes) {
      throw new Error(
        `Aktarım ${Math.round(maxBytes / 1024 / 1024)} MB sınırını aşıyor.`,
      );
    }

    entries.push({
      type: "file",
      absolutePath,
      relativePath,
      mode: stats.mode & 0o777,
      size: stats.size,
    });
  };

  await visit(sourcePath, "");

  return {
    entries,
    fileCount,
    totalBytes,
  };
}

async function copyScannedTree({
  sourcePath,
  destinationPath,
  scan,
}) {
  const sourceStats = await fs.lstat(sourcePath);

  if (sourceStats.isFile()) {
    await fs.copyFile(sourcePath, destinationPath);
    await fs.chmod(destinationPath, sourceStats.mode & 0o777);
    return;
  }

  await fs.mkdir(destinationPath, {
    recursive: false,
    mode: sourceStats.mode & 0o777,
  });

  for (const entry of scan.entries) {
    if (!entry.relativePath) {
      continue;
    }

    const target = path.join(
      destinationPath,
      entry.relativePath,
    );

    if (entry.type === "directory") {
      await fs.mkdir(target, {
        recursive: false,
        mode: entry.mode,
      });
    } else {
      await fs.copyFile(entry.absolutePath, target);
      await fs.chmod(target, entry.mode);
    }
  }
}

async function buildManifestDigest(destinationPath) {
  const stats = await fs.lstat(destinationPath);

  if (stats.isFile()) {
    return hashFile(destinationPath);
  }

  const hash = createHash("sha256");

  const visit = async (absolutePath, relativePath) => {
    const children = await fs.readdir(absolutePath, {
      withFileTypes: true,
    });
    children.sort((a, b) => a.name.localeCompare(b.name));

    for (const child of children) {
      const childAbsolute = path.join(absolutePath, child.name);
      const childRelative = relativePath
        ? path.join(relativePath, child.name)
        : child.name;

      if (child.isDirectory()) {
        hash.update(`D\0${childRelative}\0`);
        await visit(childAbsolute, childRelative);
      } else if (child.isFile()) {
        hash.update(`F\0${childRelative}\0`);
        hash.update(await fs.readFile(childAbsolute));
        hash.update("\0");
      }
    }
  };

  await visit(destinationPath, "");
  return hash.digest("hex");
}

export async function copyProjectPath({
  sourcePath,
  destinationPath,
  replaceExisting = false,
  expectedDestinationSha256,
  shouldRejectEntry,
  maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  const sourceStats = await fs.lstat(sourcePath);

  if (sourceStats.isSymbolicLink()) {
    throw new Error("Kaynak sembolik bağlantı olamaz.");
  }

  if (!sourceStats.isFile() && !sourceStats.isDirectory()) {
    throw new Error("Kaynak normal dosya veya klasör olmalı.");
  }

  const destinationState = await pathState(destinationPath);

  if (destinationState.exists) {
    if (!replaceExisting) {
      throw new Error("Hedef zaten mevcut; üzerine yazma açık değil.");
    }

    if (sourceStats.isDirectory()) {
      throw new Error(
        "Klasör aktarımında mevcut hedefin üzerine yazma desteklenmiyor.",
      );
    }

    if (
      destinationState.stats.isSymbolicLink() ||
      !destinationState.stats.isFile()
    ) {
      throw new Error("Mevcut hedef normal bir dosya değil.");
    }

    if (!expectedDestinationSha256) {
      throw new Error(
        "Mevcut hedefi değiştirmek için beklenen SHA-256 özeti gerekli.",
      );
    }

    const actualDestinationSha256 =
      await hashFile(destinationPath);

    if (
      actualDestinationSha256.toLowerCase() !==
      expectedDestinationSha256.toLowerCase()
    ) {
      throw new Error(
        [
          "Hedef dosya SHA-256 özeti değişti; aktarım yapılmadı.",
          `Beklenen: ${expectedDestinationSha256}`,
          `Mevcut:   ${actualDestinationSha256}`,
        ].join("\n"),
      );
    }
  }

  const scan = await scanSourceTree({
    sourcePath,
    shouldRejectEntry,
    maxFiles,
    maxBytes,
  });

  const parent = path.dirname(destinationPath);
  await fs.mkdir(parent, {
    recursive: true,
    mode: 0o755,
  });

  const temporaryPath = path.join(
    parent,
    `.${path.basename(destinationPath)}.${randomUUID()}.transfer`,
  );

  try {
    await copyScannedTree({
      sourcePath,
      destinationPath: temporaryPath,
      scan,
    });

    if (destinationState.exists) {
      await fs.rename(temporaryPath, destinationPath);
    } else {
      await fs.rename(temporaryPath, destinationPath);
    }
  } catch (error) {
    await fs.rm(temporaryPath, {
      recursive: true,
      force: true,
    }).catch(() => {});
    throw error;
  }

  return {
    sourceType: sourceStats.isDirectory()
      ? "directory"
      : "file",
    sourcePath,
    destinationPath,
    replaced: destinationState.exists,
    fileCount: scan.fileCount,
    totalBytes: scan.totalBytes,
    sha256: await buildManifestDigest(destinationPath),
  };
}

export const __test = Object.freeze({
  scanSourceTree,
  buildManifestDigest,
});
