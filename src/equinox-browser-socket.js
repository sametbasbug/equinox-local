import fs from "node:fs/promises";
import path from "node:path";

export function equinoxBrowserSocketDirectory({ uid = process.getuid?.() } = {}) {
  if (!Number.isInteger(uid) || uid < 1) {
    throw new Error("Equinox Browser requires a non-root user id for its local socket.");
  }
  return path.join("/tmp", `equinox-local-${uid}`);
}

export function equinoxBrowserSocketPath(options = {}) {
  return path.join(equinoxBrowserSocketDirectory(options), "browser.sock");
}

export async function prepareEquinoxBrowserSocketDirectory({
  uid = process.getuid?.(),
  fsImpl = fs,
} = {}) {
  const directory = equinoxBrowserSocketDirectory({ uid });
  try {
    await fsImpl.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stat = await fsImpl.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Equinox Browser socket directory is not a normal directory.");
  }
  if (typeof stat.uid === "number" && stat.uid !== uid) {
    throw new Error("Equinox Browser socket directory is owned by a different user.");
  }
  if ((stat.mode & 0o077) !== 0) {
    await fsImpl.chmod(directory, 0o700);
    const secured = await fsImpl.lstat(directory);
    if ((secured.mode & 0o077) !== 0) {
      throw new Error("Equinox Browser socket directory permissions could not be secured.");
    }
  }
  return directory;
}
