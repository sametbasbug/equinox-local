import fs from "node:fs/promises";
import path from "node:path";

import {
  createProtectedAgentPathChecker,
  isSensitiveAgentName,
} from "./equinox-local-agent-path-policy.js";
import { isPathInside } from "./worktree-utils.js";

export const MAX_IMAGE_VIEW_BYTES = 12 * 1024 * 1024;
export const MAX_IMAGE_VIEW_DIMENSION = 20_000;
export const MAX_IMAGE_VIEW_PIXELS = 100_000_000;

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

function assertSafePathParts(absolutePath) {
  const parts = path.normalize(absolutePath).split(path.sep).filter(Boolean);
  for (const part of parts) {
    if (part === ".git") throw new Error("Image path cannot traverse a .git directory.");
    if (isSensitiveAgentName(part)) {
      throw new Error(`Image path contains a protected sensitive name: ${part}`);
    }
  }
}

function inspectPng(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("PNG image is missing a valid IHDR header.");
  }
  return {
    mimeType: "image/png",
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function inspectJpeg(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    if (offset >= buffer.length) break;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) break;
      return {
        mimeType: "image/jpeg",
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    if (marker === 0xda) break;
    offset += segmentLength;
  }
  throw new Error("JPEG image dimensions could not be validated.");
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function inspectWebp(buffer) {
  if (
    buffer.length < 20 ||
    buffer.subarray(0, 4).toString("ascii") !== "RIFF" ||
    buffer.subarray(8, 12).toString("ascii") !== "WEBP"
  ) return null;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunk = buffer.subarray(offset, offset + 4).toString("ascii");
    const chunkLength = buffer.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkLength > buffer.length) break;

    if (chunk === "VP8X" && chunkLength >= 10) {
      return {
        mimeType: "image/webp",
        width: 1 + readUInt24LE(buffer, dataOffset + 4),
        height: 1 + readUInt24LE(buffer, dataOffset + 7),
      };
    }
    if (chunk === "VP8L" && chunkLength >= 5 && buffer[dataOffset] === 0x2f) {
      const b1 = buffer[dataOffset + 1];
      const b2 = buffer[dataOffset + 2];
      const b3 = buffer[dataOffset + 3];
      const b4 = buffer[dataOffset + 4];
      return {
        mimeType: "image/webp",
        width: 1 + b1 + ((b2 & 0x3f) << 8),
        height: 1 + (b2 >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10),
      };
    }
    if (
      chunk === "VP8 " && chunkLength >= 10 &&
      buffer[dataOffset + 3] === 0x9d &&
      buffer[dataOffset + 4] === 0x01 &&
      buffer[dataOffset + 5] === 0x2a
    ) {
      return {
        mimeType: "image/webp",
        width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff,
        height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
      };
    }

    offset = dataOffset + chunkLength + (chunkLength % 2);
  }
  throw new Error("WebP image dimensions could not be validated.");
}

export function inspectImageBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Image file is empty.");
  }
  const metadata = inspectPng(buffer) ?? inspectJpeg(buffer) ?? inspectWebp(buffer);
  if (!metadata) {
    throw new Error("Unsupported image format. image_view supports PNG, JPEG and WebP.");
  }
  const { width, height } = metadata;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error("Image dimensions are invalid.");
  }
  if (width > MAX_IMAGE_VIEW_DIMENSION || height > MAX_IMAGE_VIEW_DIMENSION) {
    throw new Error(`Image dimensions exceed the ${MAX_IMAGE_VIEW_DIMENSION}px safety limit.`);
  }
  if (width * height > MAX_IMAGE_VIEW_PIXELS) {
    throw new Error(`Image exceeds the ${MAX_IMAGE_VIEW_PIXELS} pixel safety budget.`);
  }
  return Object.freeze(metadata);
}

export async function resolveImageViewPath({
  filePath,
  fullFileAccess,
  fileRootIds,
  resolveFileRootContext,
  homeDir,
  fsImpl = fs,
}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new Error("image_view requires an absolute local image path.");
  }
  const candidate = path.normalize(filePath);
  assertSafePathParts(candidate);
  const isProtectedPath = createProtectedAgentPathChecker(homeDir);
  if (isProtectedPath(candidate)) {
    throw new Error("Image path is inside a protected credential or application-data area.");
  }

  const stats = await fsImpl.lstat(candidate);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("image_view requires a normal, non-symlink file.");
  }
  if (stats.size < 1 || stats.size > MAX_IMAGE_VIEW_BYTES) {
    throw new Error(`Image file must be between 1 byte and ${MAX_IMAGE_VIEW_BYTES / 1024 / 1024} MB.`);
  }

  const realCandidate = await fsImpl.realpath(candidate);
  assertSafePathParts(realCandidate);
  if (isProtectedPath(realCandidate)) {
    throw new Error("Image resolves into a protected credential or application-data area.");
  }

  if (!fullFileAccess) {
    const roots = [];
    for (const rootId of fileRootIds) {
      try {
        roots.push((await resolveFileRootContext(rootId)).rootRealPath);
      } catch {
        // Unavailable configured roots do not broaden access.
      }
    }
    if (!roots.some((root) => isPathInside(root, realCandidate))) {
      throw new Error("Image path is outside the configured Selected Agent Access roots.");
    }
  }

  return Object.freeze({ absolutePath: realCandidate, bytes: stats.size });
}

export function registerImageViewTools({
  registerRawTool,
  z,
  fullFileAccess,
  fileRootIds,
  resolveFileRootContext,
  homeDir,
  fsImpl = fs,
} = {}) {
  registerRawTool(
    "image_view",
    {
      description:
        "Reads one local PNG, JPEG or WebP image as real MCP image content so the model can visually inspect a path the user supplied. This is a bounded read-only visual primitive, not a generic file reader. Selected Agent Access stays inside configured roots; Full mode still blocks protected credential/application-data paths and symlinks.",
      inputSchema: {
        path: z.string().min(1).max(4096).describe("Absolute local path to a PNG, JPEG or WebP image"),
      },
      annotations: {
        title: "View local image",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: filePath }) => {
      const resolved = await resolveImageViewPath({
        filePath,
        fullFileAccess,
        fileRootIds,
        resolveFileRootContext,
        homeDir,
        fsImpl,
      });
      const buffer = await fsImpl.readFile(resolved.absolutePath);
      if (buffer.length !== resolved.bytes) {
        throw new Error("Image file changed while it was being read; retry with a stable file.");
      }
      const metadata = inspectImageBuffer(buffer);
      const text = [
        `Local image: ${path.basename(resolved.absolutePath)}`,
        `MIME: ${metadata.mimeType}`,
        `Dimensions: ${metadata.width}x${metadata.height}`,
        `Bytes: ${buffer.length}`,
      ].join("\n");
      return {
        content: [
          { type: "text", text },
          { type: "image", data: buffer.toString("base64"), mimeType: metadata.mimeType },
        ],
      };
    },
    {
      capabilityDomain: "files",
      mcpExposed: false,
    },
  );
}
