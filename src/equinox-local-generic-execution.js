const GENERIC_PATH_PREFIX = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_MAX_OUTPUT_CHARS = 40_000;
const FORCE_KILL_DELAY_MS = 250;
const CLEANUP_VERIFY_DELAY_MS = 100;
const CLEANUP_CLOSE_WAIT_MS = 250;

const SENSITIVE_PROVIDER_PREFIX = /^(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|GITHUB|GH|NPM|CLOUDFLARE|CF|AWS|AZURE|VERCEL|NETLIFY|HUGGINGFACE|HF)_/iu;
const SENSITIVE_NAME_FRAGMENT = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_?KEY|ACCESS_?KEY|CLIENT_?SECRET|CREDENTIALS?|AUTH_?TOKEN)(?:_|$)/iu;

export function isSensitiveGenericExecutionEnvName(name) {
  if (typeof name !== "string" || !name) return false;
  return SENSITIVE_PROVIDER_PREFIX.test(name) || SENSITIVE_NAME_FRAGMENT.test(name);
}

export function buildGenericExecutionEnvironment({
  runtimeEnv = {},
  extraEnv = {},
  projectId = null,
  projectRoot = null,
} = {}) {
  const env = {};

  const mergeSafe = (source) => {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (typeof value !== "string" || isSensitiveGenericExecutionEnvName(name)) {
        continue;
      }
      env[name] = value;
    }
  };

  mergeSafe(runtimeEnv);
  mergeSafe(extraEnv);

  const inheritedPath = typeof extraEnv?.PATH === "string"
    ? extraEnv.PATH
    : typeof runtimeEnv?.PATH === "string"
      ? runtimeEnv.PATH
      : "";
  env.PATH = inheritedPath
    ? `${GENERIC_PATH_PREFIX}:${inheritedPath}`
    : GENERIC_PATH_PREFIX;

  if (typeof projectId === "string" && projectId) {
    env.EQUINOX_PROJECT_ID = projectId;
  }
  if (typeof projectRoot === "string" && projectRoot) {
    env.EQUINOX_PROJECT_ROOT = projectRoot;
  }

  return env;
}
