import test from "node:test";
import assert from "node:assert/strict";
import * as z from "zod/v4";

import { registerAuthenticatedHttpTools } from "../../src/authenticated-http-tools.js";

function makeHarness(overrides = {}) {
  const registrations = new Map();
  registerAuthenticatedHttpTools({
    registerTextTool(name, config, handler, options = {}) {
      registrations.set(name, { config, handler, options });
    },
    z,
    textResult: (text) => ({ text }),
    errorResult: (error) => ({ error: error instanceof Error ? error.message : String(error) }),
    getProfiles: async () => ({
      agentProfileManagementEnabled: true,
      profiles: [
        {
          id: "moltbook",
          label: "Moltbook",
          origin: "https://example.com",
          basePath: "/api/v1",
          authType: "bearer",
          authHeader: "authorization",
          allowedMethods: ["GET", "POST"],
          allowedPathPrefixes: ["/posts"],
          allowedAgentHeaders: ["x-client-version"],
          timeoutMs: 10_000,
          ready: false,
          needsCredential: true,
        },
      ],
    }),
    upsertProfile: async ({ profile }) => ({ ...profile, ready: false, needsCredential: true }),
    deleteProfile: async ({ profileId, requireAgentManagement }) => ({
      deleted: true,
      profileId,
      requireAgentManagement,
    }),
    request: async (input) => ({ ok: true, status: 200, received: input }),
    ...overrides,
  });
  return registrations;
}

test("authenticated HTTP tools expose four integration operations with conservative mutation routing", () => {
  const registrations = makeHarness();
  assert.deepEqual([...registrations.keys()].sort(), [
    "authenticated_http_request",
    "http_profile_delete",
    "http_profile_upsert",
    "http_profiles",
  ]);

  const list = registrations.get("http_profiles");
  assert.equal(list.config.annotations.readOnlyHint, true);
  assert.deepEqual(list.options.mutationScopes, []);
  assert.equal(list.options.capabilityDomain, "integrations");

  for (const name of ["http_profile_upsert", "http_profile_delete", "authenticated_http_request"]) {
    const registration = registrations.get(name);
    assert.equal(registration.config.annotations.readOnlyHint, false);
    assert.equal(registration.config.annotations.destructiveHint, true);
    assert.deepEqual(registration.options.mutationScopes, ["global"]);
    assert.equal(registration.options.capabilityDomain, "integrations");
  }

  const request = registrations.get("authenticated_http_request");
  assert.equal(request.config.annotations.idempotentHint, false);
  assert.equal(request.config.annotations.openWorldHint, true);
});

test("agent profile upsert schema has no credential-bearing field", () => {
  const upsert = makeHarness().get("http_profile_upsert");
  assert.equal(Object.hasOwn(upsert.config.inputSchema, "credential"), false);
  assert.equal(Object.hasOwn(upsert.config.inputSchema, "secret"), false);
  assert.equal(Object.hasOwn(upsert.config.inputSchema, "token"), false);

  const bearer = {
    id: "moltbook",
    label: "Moltbook",
    origin: "https://example.com",
    base_path: "/api/v1",
    auth: { type: "bearer" },
    allowed_methods: ["GET"],
    allowed_path_prefixes: ["/posts"],
    allowed_agent_headers: [],
    timeout_ms: 10_000,
  };

  for (const [key, schema] of Object.entries(upsert.config.inputSchema)) {
    if (key === "id") assert.equal(schema.safeParse(bearer.id).success, true);
  }
});

test("http_profiles filters safe metadata without credential material", async () => {
  const list = makeHarness().get("http_profiles");
  const result = await list.handler({ profile_id: "moltbook" });
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.agentProfileManagementEnabled, true);
  assert.equal(parsed.profiles.length, 1);
  assert.equal(parsed.profiles[0].id, "moltbook");
  assert.equal(JSON.stringify(parsed).includes("credential"), false);
});

test("profile delete always requires agent-management authorization", async () => {
  let received;
  const registration = makeHarness({
    deleteProfile: async (input) => {
      received = input;
      return { deleted: true, profileId: input.profileId };
    },
  }).get("http_profile_delete");

  const result = await registration.handler({ profile_id: "moltbook" });
  assert.deepEqual(received, { profileId: "moltbook", requireAgentManagement: true });
  assert.equal(JSON.parse(result.text).deleted, true);
});

test("authenticated request maps intent-only arguments to the bounded request engine", async () => {
  let received;
  const registration = makeHarness({
    request: async (input) => {
      received = input;
      return { ok: true, status: 204, headers: {}, body: null, truncated: false, durationMs: 1, responseId: "http_resp_11111111111111111111111111111111" };
    },
  }).get("authenticated_http_request");

  const result = await registration.handler({
    profile_id: "moltbook",
    method: "POST",
    path: "/posts",
    query: { draft: true },
    headers: { "x-client-version": "1" },
    body: { title: "hello" },
    response_bindings: [{
      target_json_pointer: "/verification_code",
      response_id: "http_resp_22222222222222222222222222222222",
      source_json_pointer: "/verification/code",
    }],
    timeout_ms: 5000,
  });

  assert.deepEqual(received, {
    profileId: "moltbook",
    method: "POST",
    path: "/posts",
    query: { draft: true },
    headers: { "x-client-version": "1" },
    body: { title: "hello" },
    response_bindings: [{
      target_json_pointer: "/verification_code",
      response_id: "http_resp_22222222222222222222222222222222",
      source_json_pointer: "/verification/code",
    }],
    timeout_ms: 5000,
  });
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.status, 204);
  assert.equal(parsed.response_id, "http_resp_11111111111111111111111111111111");
  assert.equal(Object.hasOwn(parsed, "responseId"), false);
  assert.match(registration.config.description, /response_bindings/u);
  assert.ok(registration.config.inputSchema.response_bindings);
});
