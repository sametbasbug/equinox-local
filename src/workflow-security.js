const SECRET_KEY_PATTERN =
  /(?:token|secret|password|passwd|credential|authorization|auth|private[_-]?key|api[_-]?key)/iu;

export function buildSafeWorkflowEnvironment(baseEnvironment = process.env) {
  const safe = {};
  for (const key of [
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "SHELL",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "SSH_AUTH_SOCK",
  ]) {
    const value = baseEnvironment[key];
    if (typeof value === "string" && value.length <= 10_000) safe[key] = value;
  }

  return {
    ...safe,
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
    CI: "1",
    NO_COLOR: "1",
    CLICOLOR: "0",
    GIT_TERMINAL_PROMPT: "0",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_COLOR: "false",
  };
}

export function sanitizeWorkflowOutput(rawValue) {
  let value = String(rawValue ?? "");
  for (const [pattern, replacement] of [
    [/\b(?:gh[opusr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu, "[REDACTED_GITHUB_TOKEN]"],
    [/\bnpm_[A-Za-z0-9]{20,}\b/gu, "[REDACTED_NPM_TOKEN]"],
    [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*\b/giu, "Bearer [REDACTED]"],
    [/(Authorization\s*[:=]\s*)([^\s,;]+)/giu, "$1[REDACTED]"],
    [/(?:https?:\/\/)([^\s/@:]+):([^\s/@]+)@/giu, "https://[REDACTED]@"],
  ]) {
    value = value.replace(pattern, replacement);
  }

  return value
    .split(/\r?\n/u)
    .map((line) => {
      const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*[:=]\s*(.+)$/u);
      return match && SECRET_KEY_PATTERN.test(match[1])
        ? `${match[1]}=[REDACTED]`
        : line;
    })
    .join("\n");
}
