interface DarwinHelperInstallation {
  readonly installRoot?: unknown;
  readonly releaseDir?: unknown;
}

interface DarwinHelperEnvironmentOptions {
  readonly installation?: DarwinHelperInstallation;
  readonly sourceEnv?: Readonly<Record<string, unknown>>;
  readonly includeDeveloperRuntimeConfig?: boolean;
}

const DARWIN_HELPER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export function projectDarwinDetachedHelperEnvironment({
  installation,
  sourceEnv = process.env,
  includeDeveloperRuntimeConfig = false,
}: DarwinHelperEnvironmentOptions = {}): Record<string, string> {
  const env = {
    HOME: sourceEnv.HOME,
    USER: sourceEnv.USER,
    LOGNAME: sourceEnv.LOGNAME,
    TMPDIR: sourceEnv.TMPDIR,
    PATH: DARWIN_HELPER_PATH,
    EQUINOX_LOCAL_INSTALL_ROOT: installation?.installRoot,
    EQUINOX_LOCAL_RELEASE_DIR: installation?.releaseDir,
    EQUINOX_LOCAL_DEV_RUNTIME_CONFIG: includeDeveloperRuntimeConfig
      ? sourceEnv.EQUINOX_LOCAL_DEV_RUNTIME_CONFIG
      : undefined,
  };
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
}
