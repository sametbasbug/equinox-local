import fs from "node:fs/promises";

function fileType(stat) {
  if (stat.isFile()) return "file";
  if (stat.isDirectory()) return "directory";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

function unixMode(mode) {
  return (mode & 0o777).toString(8).padStart(3, "0");
}

export async function inspectPrivateStatePath(target, {
  platform = process.platform,
  type,
  mode,
  fsImpl = fs,
  verifyWindowsAcl = null,
} = {}) {
  try {
    const stat = await fsImpl.lstat(target);
    const actualType = fileType(stat);
    if (actualType === "symlink") {
      return Object.freeze({ exists: true, safe: false, type: actualType, mode: null, security: platform === "win32" ? "windows-acl" : "posix", reason: "symlink" });
    }
    const typeSafe = actualType === type;
    if (platform === "darwin") {
      const actualMode = unixMode(stat.mode);
      return Object.freeze({
        exists: true,
        safe: typeSafe && (mode === undefined || actualMode === mode),
        type: actualType,
        mode: actualMode,
        security: "posix",
        reason: typeSafe && (mode === undefined || actualMode === mode) ? null : "type-or-mode",
      });
    }
    if (platform === "win32") {
      if (!typeSafe) {
        return Object.freeze({ exists: true, safe: false, type: actualType, mode: null, security: "windows-acl", reason: "type" });
      }
      if (typeof verifyWindowsAcl !== "function") {
        return Object.freeze({ exists: true, safe: false, type: actualType, mode: null, security: "windows-acl", reason: "acl-unverified" });
      }
      const verification = await verifyWindowsAcl({ target, type: actualType });
      const safe = verification === true || verification?.safe === true;
      return Object.freeze({
        exists: true,
        safe,
        type: actualType,
        mode: null,
        security: "windows-acl",
        reason: safe ? null : verification?.reason || "acl-unverified",
      });
    }
    return Object.freeze({ exists: true, safe: false, type: actualType, mode: null, security: "unsupported", reason: "unsupported-platform" });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({ exists: false, safe: false, type: null, mode: null, security: platform === "win32" ? "windows-acl" : "posix", reason: "missing" });
    }
    return Object.freeze({ exists: false, safe: false, type: null, mode: null, security: platform === "win32" ? "windows-acl" : "posix", reason: "inspection-failed" });
  }
}
