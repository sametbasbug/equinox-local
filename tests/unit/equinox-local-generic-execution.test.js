import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGenericExecutionEnvironment,
  isSensitiveGenericExecutionEnvName,
  repairWindowsPathext,
} from "../../src/equinox-local-generic-execution.js";


test("generic execution environment strips provider and secret-like variables", () => {
  const env = buildGenericExecutionEnvironment({
    runtimeEnv: {
      PATH: "/runtime/bin",
      HOME: "/Users/test",
      LANG: "en_US.UTF-8",
      SAFE_FLAG: "yes",
      OPENAI_API_KEY: "openai-secret",
      GH_TOKEN: "github-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      INTERNAL_PASSWORD: "password",
      SSH_AUTH_SOCK: "/tmp/ssh.sock",
    },
    extraEnv: {
      PATH: "/extra/bin",
      PORT: "3000",
      NPM_TOKEN: "npm-secret",
      CUSTOM_API_KEY: "custom-secret",
    },
    projectId: "local",
    projectRoot: "/tmp/project",
  });

  assert.equal(env.HOME, "/Users/test");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.SAFE_FLAG, "yes");
  assert.equal(env.PORT, "3000");
  assert.equal(env.SSH_AUTH_SOCK, "/tmp/ssh.sock");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.INTERNAL_PASSWORD, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.CUSTOM_API_KEY, undefined);
  assert.equal(env.EQUINOX_PROJECT_ID, "local");
  assert.equal(env.EQUINOX_PROJECT_ROOT, "/tmp/project");
  assert.equal(
    env.PATH,
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/extra/bin",
  );
});

test("generic execution secret-name classifier is provider-aware without blocking ordinary shell variables", () => {
  for (const name of [
    "OPENAI_BASE_URL",
    "ANTHROPIC_API_KEY",
    "GITHUB_TOKEN",
    "CF_API_TOKEN",
    "MY_CLIENT_SECRET",
    "DEPLOY_PASSWORD",
  ]) {
    assert.equal(isSensitiveGenericExecutionEnvName(name), true, name);
  }

  for (const name of ["HOME", "PATH", "LANG", "TERM_PROGRAM", "SSH_AUTH_SOCK", "PORT", "NODE_ENV"]) {
    assert.equal(isSensitiveGenericExecutionEnvName(name), false, name);
  }
});


test("generic execution preserves Windows PATH semantics without injecting macOS prefixes", () => {
  const env = buildGenericExecutionEnvironment({
    platform: "win32",
    arch: "x64",
    runtimeEnv: { PATH: "C:\\Windows\\System32;C:\\Tools", USERPROFILE: "C:\\Users\\Test" },
    extraEnv: { PATH: "C:\\Project\\bin;C:\\Windows\\System32" },
  });
  assert.equal(env.PATH, "C:\\Project\\bin;C:\\Windows\\System32;C:\\Tools");
  assert.equal(env.USERPROFILE, "C:\\Users\\Test");
  assert.equal(env.PATH.includes("/opt/homebrew"), false);
});

test("Windows repairs inherited PATHEXT truncated to .CPL and preserves explicit extensions", () => {
  assert.equal(repairWindowsPathext(".CPL"), ".COM;.EXE;.BAT;.CMD;.CPL");
  assert.equal(repairWindowsPathext(undefined), ".COM;.EXE;.BAT;.CMD");
  assert.equal(repairWindowsPathext(".com;.EXE;.Bat;.cMd;.CPL"), ".com;.EXE;.Bat;.cMd;.CPL");
  const env = buildGenericExecutionEnvironment({
    platform: "win32", arch: "x64",
    runtimeEnv: { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32", PATHEXT: ".CPL" },
  });
  assert.equal(env.PATHEXT, ".COM;.EXE;.BAT;.CMD;.CPL");
  const withOverride = buildGenericExecutionEnvironment({
    platform: "win32", arch: "arm64",
    runtimeEnv: { PATHEXT: ".COM;.EXE;.BAT;.CMD;.CPL" },
    extraEnv: { PaThExT: ".CPL" },
  });
  assert.equal(withOverride.PATHEXT, ".COM;.EXE;.BAT;.CMD;.CPL");
  assert.equal("PaThExT" in withOverride, false);
});

test("Windows managed PATH preserves WindowsApps with explicit project override", () => {
  const env = buildGenericExecutionEnvironment({
    platform: "win32", arch: "x64",
    runtimeEnv: { PATH: "C:\\Windows\\System32", LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" },
    extraEnv: { PATH: "C:\\Project\\bin" },
  });
  assert.equal(env.PATH, "C:\\Project\\bin;C:\\Windows\\System32;C:\\Users\\Test\\AppData\\Local\\Microsoft\\WindowsApps");
});
