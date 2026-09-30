import assert from "node:assert/strict";
import test from "node:test";

import {
  createProtectedAgentPathChecker,
  isSensitiveAgentName,
} from "../../src/equinox-local-agent-path-policy.js";

test("secret-like names are blocked without treating ordinary hidden agent folders as secrets", () => {
  for (const name of [".codex", ".openclaw", ".claude", ".config", ".local", ".public-key"]) {
    assert.equal(isSensitiveAgentName(name), false, `${name} should remain accessible`);
  }

  for (const name of [
    ".env",
    ".env.local",
    ".npmrc",
    ".netrc",
    ".private-token",
    ".agent-secret",
    ".service-credentials",
    "auth-profiles.json",
    ".equinox-runtime-key",
    "id_ed25519",
    "client.pem",
  ]) {
    assert.equal(isSensitiveAgentName(name), true, `${name} should be protected`);
  }
});

test("agent workspace folders stay open while their credential subpaths remain protected", () => {
  const isProtected = createProtectedAgentPathChecker("/Users/example", { platform: "darwin" });

  for (const accessible of [
    "/Users/example/.codex/AGENTS.md",
    "/Users/example/.codex/skills/example/SKILL.md",
    "/Users/example/.openclaw/workspace/README.md",
    "/Users/example/.openclaw/agents/example.json",
    "/Users/example/.claude/CLAUDE.md",
    "/Users/example/.claude/projects/example.json",
  ]) {
    assert.equal(isProtected(accessible), false, `${accessible} should remain accessible`);
  }

  for (const protectedPath of [
    "/Users/example/.codex/auth.json",
    "/Users/example/.openclaw/credentials/provider.json",
    "/Users/example/.openclaw/service-env/provider.env",
    "/Users/example/.openclaw/identity/private.json",
    "/Users/example/.openclaw/devices/device.json",
    "/Users/example/.claude/.credentials.json",
    "/Users/example/.claude/session-env/session-id/environment",
    "/Users/example/.claude/shell-snapshots/session-id.sh",
    "/Users/example/Library/Keychains/login.keychain-db",
    "/Users/example/Library/Application Support/Google/Chrome/Default/Cookies",
  ]) {
    assert.equal(isProtected(protectedPath), true, `${protectedPath} should remain protected`);
  }
});

test("Windows protected roots use win32 semantics, platform paths and case-insensitive comparison", () => {
  const homeDir = "C:\\Users\\Türk User";
  const localAppData = "C:\\Users\\Türk User\\AppData\\Local";
  const isProtected = createProtectedAgentPathChecker(homeDir, {
    platform: "win32",
    arch: "x64",
    env: { LOCALAPPDATA: localAppData },
  });

  for (const accessible of [
    "C:\\Users\\Türk User\\.codex\\AGENTS.md",
    "C:\\Users\\Türk User\\.openclaw\\workspace\\README.md",
    "C:\\Users\\Türk User\\Documents\\photo.png",
  ]) {
    assert.equal(isProtected(accessible), false, `${accessible} should remain accessible`);
  }

  for (const protectedPath of [
    "C:\\Users\\Türk User\\.ssh\\id_ed25519",
    "C:\\Users\\Türk User\\.codex\\AUTH.JSON",
    "C:\\Users\\Türk User\\AppData\\Local\\Equinox Local\\state\\secrets\\telegram.json",
    "c:\\users\\türk user\\appdata\\local\\equinox local\\browser\\Default\\Cookies",
    "C:\\Users\\Türk User\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cookies",
    "C:\\Users\\Türk User\\AppData\\Local\\Chromium\\User Data\\Default\\Login Data",
    "C:\\Users\\Türk User\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cookies",
    "C:\\Users\\Türk User\\AppData\\Local\\BraveSoftware\\Brave-Browser\\User Data\\Default\\Login Data",
  ]) {
    assert.equal(isProtected(protectedPath), true, `${protectedPath} should be protected`);
  }

  assert.equal(isProtected("/Users/example/Library/Application Support/Equinox Local/config.json"), false);
});

test("Windows protected path checker fails closed when required LocalAppData is unavailable", () => {
  assert.throws(
    () => createProtectedAgentPathChecker("C:\\Users\\Example", { platform: "win32", arch: "x64", env: {} }),
    /LOCALAPPDATA must be an absolute path/u,
  );
});
