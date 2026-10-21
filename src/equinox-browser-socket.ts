import fs from "node:fs/promises";
import path from "node:path";

type SocketOptions = {
  uid?: number | undefined;
  namespace?: unknown;
};
type IpcOptions = SocketOptions & {
  platform?: string;
};
type SocketFileSystem = Pick<typeof fs, "mkdir" | "lstat" | "chmod">;
type PrepareSocketOptions = SocketOptions & {
  fsImpl?: SocketFileSystem;
};

function normalizeSocketNamespace(namespace: unknown): string | null {
  if (namespace == null || namespace === "") return null;
  const value = String(namespace);
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/u.test(value)) {
    throw new Error("Equinox Browser socket namespace is invalid.");
  }
  return value;
}

export function equinoxBrowserSocketDirectory({ uid = process.getuid?.(), namespace = null }: SocketOptions = {}): string {
  if (typeof uid !== "number" || !Number.isInteger(uid) || uid < 1) {
    throw new Error("Equinox Browser requires a non-root user id for its local socket.");
  }
  const normalizedNamespace = normalizeSocketNamespace(namespace);
  return path.join("/tmp", normalizedNamespace ? `equinox-local-${uid}-${normalizedNamespace}` : `equinox-local-${uid}`);
}

export function equinoxBrowserSocketPath(options: SocketOptions = {}): string {
  return path.join(equinoxBrowserSocketDirectory(options), "browser.sock");
}

export function equinoxBrowserIpcEndpoint({
  platform = process.platform,
  uid = process.getuid?.(),
  namespace = null,
}: IpcOptions = {}) {
  const normalizedNamespace = normalizeSocketNamespace(namespace);
  if (platform === "darwin") {
    return Object.freeze({
      kind: "unix",
      endpoint: equinoxBrowserSocketPath({ uid, namespace: normalizedNamespace }),
      implemented: true,
    });
  }
  if (platform === "win32") {
    const suffix = normalizedNamespace ? `-${normalizedNamespace}` : "";
    return Object.freeze({
      kind: "named-pipe",
      endpoint: `\\\\.\\pipe\\equinox-local-browser${suffix}`,
      implemented: true,
    });
  }
  throw new Error(`Equinox Browser IPC is unsupported on ${platform}.`);
}

export async function prepareEquinoxBrowserSocketDirectory({
  uid = process.getuid?.(),
  namespace = null,
  fsImpl = fs,
}: PrepareSocketOptions = {}): Promise<string> {
  const directory = equinoxBrowserSocketDirectory({ uid, namespace });
  try {
    await fsImpl.mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code !== "EEXIST") throw error;
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
