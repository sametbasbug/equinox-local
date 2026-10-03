import assert from "node:assert/strict";
import test from "node:test";

import { projectDarwinDetachedHelperEnvironment } from "../../src/equinox-local-darwin-helper-environment.js";

const installation = {
  installRoot: "/Users/example/Library/Application Support/Equinox Local",
  releaseDir: "/Users/example/Library/Application Support/Equinox Local/releases/5.2.1",
};

const sourceEnv = {
  HOME: "/Users/example",
  USER: "example",
  LOGNAME: "example",
  TMPDIR: "/tmp/example",
  PATH: "/untrusted/path",
  EQUINOX_LOCAL_DEV_RUNTIME_CONFIG: "/private/dev-runtime.conf",
  OPENAI_API_KEY: "must-not-leak",
  GITHUB_TOKEN: "must-not-leak",
  PWD: "/private/worktree",
};

test("Darwin detached-helper projection keeps fixed paths and only approved inherited values", () => {
  assert.deepEqual(projectDarwinDetachedHelperEnvironment({ installation, sourceEnv }), {
    HOME: "/Users/example",
    USER: "example",
    LOGNAME: "example",
    TMPDIR: "/tmp/example",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    EQUINOX_LOCAL_INSTALL_ROOT: installation.installRoot,
    EQUINOX_LOCAL_RELEASE_DIR: installation.releaseDir,
  });
});

test("Darwin source restart may project only its developer runtime config in addition", () => {
  assert.deepEqual(projectDarwinDetachedHelperEnvironment({
    sourceEnv,
    includeDeveloperRuntimeConfig: true,
  }), {
    HOME: "/Users/example",
    USER: "example",
    LOGNAME: "example",
    TMPDIR: "/tmp/example",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    EQUINOX_LOCAL_DEV_RUNTIME_CONFIG: "/private/dev-runtime.conf",
  });
});

test("Darwin detached-helper projection omits absent, empty and non-string values", () => {
  assert.deepEqual(projectDarwinDetachedHelperEnvironment({
    installation: { installRoot: "", releaseDir: 17 },
    sourceEnv: { HOME: "", USER: 42, LOGNAME: null, TMPDIR: undefined },
  }), {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  });
});
