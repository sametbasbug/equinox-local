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

test("agent access denies normalized traversal into macOS credential and browser data without swallowing sibling workspaces", () => {
  const isProtected = createProtectedAgentPathChecker("/Users/Example", {platform:"darwin",arch:"arm64"});
  for (const denied of [
    "/Users/Example/.codex/skills/../auth.json",
    "/Users/Example/.openclaw/workspace/../credentials/provider.json",
    "/Users/Example/Library/Application Support/Google/Chrome/Default/../Default/Cookies",
    "/Users/Example/Library/Application Support/Equinox Local/../Equinox Local/state/secret",
    "/users/example/library/keychains/login.keychain-db",
  ]) assert.equal(isProtected(denied),true,"protected after normalization: "+denied);
  for (const allowed of [
    "/Users/Example/.codex/skills/AGENTS.md",
    "/Users/Example/.codex/auth.json-not-an-auth-root",
    "/Users/Example/Library/Keychains-Backup/readme.txt",
    "/Users/Example/Library/Application Support/Google/ChromeBackup/notes.txt",
    "/Users/Example/Documents/../Documents/notes.txt",
    "/Users/ExampleOther/.ssh/id_ed25519",
  ]) assert.equal(isProtected(allowed),false,"do not confuse root boundaries: "+allowed);
  assert.equal(isProtected("Library/Keychains/login.keychain-db"),false);
  assert.equal(isProtected(null),false);
});

test("Windows credential and Chromium roots resist mixed-case separators and dot-segment traversal", () => {
  const home = "C:\\Users\\Example";
  const protectedPath = createProtectedAgentPathChecker(home,{
    platform:"win32",arch:"arm64",env:{LOCALAPPDATA:"C:\\Users\\Example\\AppData\\Local"}
  });
  for(const candidate of [
    "c:/users/example/.OPENCLAW/workspace/../CREDENTIALS/provider.json",
    "C:\\Users\\Example\\.config\\gcloud\\..\\gcloud\\application_default_credentials.json",
    "C:/Users/Example/AppData/Local/Google/Chrome/User Data/Default/../Default/Login Data",
    "c:\\users\\EXAMPLE\\appdata\\LOCAL\\Microsoft\\Edge\\User Data\\Default\\Cookies",
    "C:\\Users\\Example\\.codex\\skills\\..\\auth.json",
  ]) assert.equal(protectedPath(candidate),true,"must protect "+candidate);
  for(const candidate of [
    "C:\\Users\\Example\\AppData\\Local\\Google\\Chrome\\User Data Backup\\notes.txt",
    "C:\\Users\\Example\\AppData\\Local\\BraveSoftware\\Brave-Browser-Backup\\README.md",
    "C:\\Users\\Example\\.codex\\auth.json.backup",
    "C:\\Users\\ExampleOther\\.ssh\\id_ed25519",
    "D:\\Elsewhere\\Documents\\some-file.txt",
  ]) assert.equal(protectedPath(candidate),false,"must retain legal workspace access "+candidate);
  assert.equal(protectedPath("\\Users\\Example\\.ssh\\id_ed25519"),false);
  assert.equal(protectedPath({path:"C:\\Users\\Example\\.ssh"}),false);
});

test("sensitive-name matcher blocks key and environment suffixes but does not block public keys or ordinary agent files", () => {
  for(const candidate of [".ENV", ".ENV.local",".ssh-token",".private_key",".agent-credentials",
    ".gcloud-secret","ID_RSA","ID_ED25519","CLIENT.PEM","client.PFX","client.P12","auth-profiles.json"
  ]) assert.equal(isSensitiveAgentName(candidate),true,candidate+" must be protected");
  for(const candidate of [".public-key",".PUBLIC_KEY",".project",".codex","workspace.md",
    "credentials-readme.txt","public.pem.txt","agent-credentials.md"
  ]) assert.equal(isSensitiveAgentName(candidate),false,candidate+" should remain ordinary");
});
