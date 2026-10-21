import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSafeWorkflowEnvironment,
  sanitizeWorkflowOutput,
} from "../../src/workflow-security.js";

test("workflow child environment uses an explicit, bounded allowlist rather than inherited tokens or PATH", () => {
  const source = {
    HOME: "/Users/owned", USER: "owner", LOGNAME: "owner", SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8", SSH_AUTH_SOCK: "/owned/ssh-agent.sock",
    XDG_CONFIG_HOME: "/owned/config", XDG_CACHE_HOME: "/owned/cache",
    TMPDIR: "/owned/tmp", LC_ALL: "en_US.UTF-8",
    PATH: "/untrusted/node_modules/.bin", OPENAI_API_KEY: "private-openai",
    GITHUB_TOKEN: "private-github", NPM_TOKEN: "private-npm",
    GH_TOKEN: "private-gh", BASH_ENV: "/untrusted/source",
    NODE_OPTIONS: "--require /untrusted/loader.js", HOME_BYPASS: "/private",
  };
  const result = buildSafeWorkflowEnvironment(source);
  for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "LANG",
    "SSH_AUTH_SOCK", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "TMPDIR", "LC_ALL"]) {
    assert.equal(result[key], source[key]);
  }
  for (const key of ["OPENAI_API_KEY", "GITHUB_TOKEN", "NPM_TOKEN", "GH_TOKEN",
    "BASH_ENV", "NODE_OPTIONS", "HOME_BYPASS"]) {
    assert.equal(Object.hasOwn(result, key), false, key);
  }
  assert.equal(result.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
  assert.equal(result.GIT_TERMINAL_PROMPT, "0");
  assert.equal(result.GH_PROMPT_DISABLED, "1");
  assert.equal(result.CI, "1");
  assert.equal(Object.values(result).includes("private-openai"), false);
});

test("workflow environment rejects non-string and oversized allowlisted values", () => {
  const result = buildSafeWorkflowEnvironment({
    HOME: "x".repeat(10_000), USER: "y".repeat(10_001),
    LOGNAME: null, TMPDIR: 12, SHELL: { toString: () => "/leak" },
    LANG: "en_US.UTF-8", OPENAI_API_KEY: "private",
  });
  assert.equal(result.HOME.length, 10_000);
  for (const key of ["USER", "LOGNAME", "TMPDIR", "SHELL", "OPENAI_API_KEY"]) {
    assert.equal(Object.hasOwn(result, key), false);
  }
  assert.equal(result.LANG, "en_US.UTF-8");
  assert.equal(result.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
});

test("workflow output redacts GitHub/NPM tokens, Bearer credentials, HTTP userinfo and secret assignments", () => {
  const gh = "ghp_" + "A".repeat(30);
  const pat = "github_pat_" + "B".repeat(30);
  const npm = "npm_" + "C".repeat(30);
  const input = [
    "GitHub " + gh + " " + pat,
    "registry=" + npm,
    "Authorization: Bearer abcDEF987654",
    "request Bearer fakeToken_ABC123",
    "https://service-account:private-password@github.com/owner/repo",
    "my_API_KEY: private-api-value",
    "service.password = private-pass",
    "credential: private-credential",
    "ordinary_line=non-secret",
  ].join("\r\n");
  const cleaned = sanitizeWorkflowOutput(input);
  for (const secret of [gh, pat, npm, "abcDEF987654", "fakeToken_ABC123",
    "service-account", "private-password", "private-api-value", "private-pass",
    "private-credential"]) {
    assert.equal(cleaned.includes(secret), false, secret);
  }
  assert.match(cleaned, /\[REDACTED_GITHUB_TOKEN\]/u);
  assert.match(cleaned, /\[REDACTED_NPM_TOKEN\]/u);
  assert.match(cleaned, /Bearer \[REDACTED\]/u);
  assert.match(cleaned, /my_API_KEY=\[REDACTED\]/u);
  assert.match(cleaned, /ordinary_line=non-secret/u);
  assert.equal(cleaned.includes("\r"), false);
});

test("workflow output sanitizer preserves ordinary diagnostics and handles nullish input", () => {
  assert.equal(sanitizeWorkflowOutput(undefined), "");
  assert.equal(sanitizeWorkflowOutput(null), "");
  assert.equal(sanitizeWorkflowOutput("build ok\ncompile: completed"), "build ok\ncompile: completed");
  assert.equal(sanitizeWorkflowOutput(123), "123");
});
