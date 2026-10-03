const DARWIN_HELPER_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

export function projectDarwinDetachedHelperEnvironment({
  installation,
  sourceEnv = process.env,
  includeDeveloperRuntimeConfig = false,
} = {}) {
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
    Object.entries(env).filter(([, value]) => typeof value === "string" && value.length > 0),
  );
}
