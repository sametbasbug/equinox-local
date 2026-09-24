import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTHENTICATED_HTTP_LIMITS,
  authenticatedHttpRequest,
  defaultAuthenticatedHttpStorePath,
  deleteAuthenticatedHttpProfile,
  getAuthenticatedHttpProfiles,
  normalizeAuthenticatedHttpOrigin,
  normalizeAuthenticatedHttpPath,
  setAuthenticatedHttpAgentManagement,
  setAuthenticatedHttpProfileCredential,
  upsertAuthenticatedHttpProfileFromAgent,
  upsertAuthenticatedHttpProfileFromControlCenter,
  validateAuthenticatedHttpProfileInput,
} from "../../src/authenticated-http-integration.js";
import {
  createAuthenticatedHttpResponseReferenceStore,
} from "../../src/authenticated-http-response-references.js";

const SECRET = "super-secret-api-token-123";

function baseProfile(overrides = {}) {
  return {
    id: "moltbook",
    label: "Moltbook",
    origin: "https://www.moltbook.com",
    basePath: "/api/v1",
    auth: { type: "bearer" },
    allowedMethods: ["GET", "POST"],
    allowedPathPrefixes: ["/posts", "/search"],
    allowedAgentHeaders: ["Accept", "Idempotency-Key"],
    timeoutMs: 10_000,
    ...overrides,
  };
}

async function withTempStore(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-auth-http-"));
  const storePath = path.join(root, "secrets", "authenticated-http.json");
  try {
    await run({ root, storePath });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function readyProfile(storePath, overrides = {}) {
  await upsertAuthenticatedHttpProfileFromAgent({ profile: baseProfile(overrides), storePath });
  return await setAuthenticatedHttpProfileCredential({ profileId: overrides.id ?? "moltbook", credential: SECRET, storePath });
}

test("default store is empty, safe and enables agent profile management", async () => {
  assert.equal(
    defaultAuthenticatedHttpStorePath("/Users/example"),
    "/Users/example/Library/Application Support/Equinox Local/secrets/authenticated-http.json",
  );
  await withTempStore(async ({ storePath }) => {
    assert.deepEqual(await getAuthenticatedHttpProfiles({ storePath }), {
      agentProfileManagementEnabled: true,
      profiles: [],
    });
  });
});

test("profile validation separates exact HTTPS origin from canonical API paths", () => {
  assert.equal(normalizeAuthenticatedHttpOrigin("https://Example.com:443"), "https://example.com");
  assert.equal(normalizeAuthenticatedHttpPath("/api/v1/"), "/api/v1");
  assert.throws(() => normalizeAuthenticatedHttpOrigin("http://example.com"), /require HTTPS/u);
  assert.throws(() => normalizeAuthenticatedHttpOrigin("https://example.com/api/v1"), /use basePath/u);
  assert.throws(() => normalizeAuthenticatedHttpPath("//evil.example/x"), /exactly one slash/u);
  assert.throws(() => normalizeAuthenticatedHttpPath("/a/%2e%2e/b"), /dot traversal/u);
  assert.throws(() => normalizeAuthenticatedHttpPath("/a/%2F/b"), /encoded separators/u);
  assert.throws(() => normalizeAuthenticatedHttpPath("/a/%252e%252e/b"), /nested percent encoding/u);
});

test("agent profile structure cannot contain a credential or reserved agent headers", () => {
  assert.throws(
    () => validateAuthenticatedHttpProfileInput({ ...baseProfile(), credential: SECRET }),
    /unsupported field: credential/u,
  );
  assert.throws(
    () => validateAuthenticatedHttpProfileInput(baseProfile({ allowedAgentHeaders: ["Authorization"] })),
    /reserved/u,
  );
  assert.throws(
    () => validateAuthenticatedHttpProfileInput(baseProfile({ allowedAgentHeaders: ["X-Forwarded-Host"] })),
    /reserved/u,
  );
});

test("agent-created profiles persist as private 0600 records and need a human credential", async () => {
  await withTempStore(async ({ storePath }) => {
    const created = await upsertAuthenticatedHttpProfileFromAgent({ profile: baseProfile(), storePath });
    assert.equal(created.ready, false);
    assert.equal(created.needsCredential, true);
    assert.equal(Object.hasOwn(created, "credential"), false);

    const handle = await fs.open(storePath, "r");
    try {
      const stat = await handle.stat();
      assert.equal(stat.mode & 0o777, 0o600);
      const raw = JSON.parse(await handle.readFile("utf8"));
      assert.equal(raw.agentProfileManagementEnabled, true);
      assert.equal(Object.hasOwn(raw.profiles[0], "credential"), false);
    } finally {
      await handle.close();
    }
  });
});

test("human credential write makes a profile ready without exposing the secret in metadata", async () => {
  await withTempStore(async ({ storePath }) => {
    await upsertAuthenticatedHttpProfileFromAgent({ profile: baseProfile(), storePath });
    const ready = await setAuthenticatedHttpProfileCredential({ profileId: "moltbook", credential: SECRET, storePath });
    assert.equal(ready.ready, true);
    assert.equal(ready.needsCredential, false);
    assert.equal(Object.hasOwn(ready, "credential"), false);

    const listed = await getAuthenticatedHttpProfiles({ storePath });
    assert.equal(listed.profiles[0].ready, true);
    assert.equal(JSON.stringify(listed).includes(SECRET), false);
  });
});

test("agent edits preserve credentials only inside the same credential trust identity", async () => {
  await withTempStore(async ({ storePath }) => {
    await readyProfile(storePath);

    const sameTrust = await upsertAuthenticatedHttpProfileFromAgent({
      profile: baseProfile({ label: "Moltbook API", allowedMethods: ["GET"] }),
      storePath,
    });
    assert.equal(sameTrust.ready, true);

    const changedOrigin = await upsertAuthenticatedHttpProfileFromAgent({
      profile: baseProfile({ origin: "https://api.example.com" }),
      storePath,
    });
    assert.equal(changedOrigin.ready, false);
    assert.equal(changedOrigin.needsCredential, true);

    await setAuthenticatedHttpProfileCredential({ profileId: "moltbook", credential: SECRET, storePath });
    const changedAuth = await upsertAuthenticatedHttpProfileFromAgent({
      profile: baseProfile({ auth: { type: "secret_header", headerName: "X-Api-Key" } }),
      storePath,
    });
    assert.equal(changedAuth.ready, false);
  });
});

test("management toggle defaults on, blocks agent mutations when off, and leaves ready profiles usable", async () => {
  await withTempStore(async ({ storePath }) => {
    await readyProfile(storePath);
    assert.deepEqual(await setAuthenticatedHttpAgentManagement({ enabled: false, storePath }), {
      agentProfileManagementEnabled: false,
    });
    await assert.rejects(
      upsertAuthenticatedHttpProfileFromAgent({ profile: baseProfile({ label: "blocked" }), storePath }),
      /management is disabled/u,
    );
    await assert.rejects(
      deleteAuthenticatedHttpProfile({ profileId: "moltbook", requireAgentManagement: true, storePath }),
      /management is disabled/u,
    );

    const calls = [];
    const result = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "GET",
      path: "/posts",
      storePath,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
  });
});

test("request engine keeps auth local, joins basePath correctly and enforces profile-scoped headers", async () => {
  await withTempStore(async ({ storePath }) => {
    await readyProfile(storePath);
    const calls = [];
    const result = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "POST",
      path: "/posts",
      query: { page: 2, draft: false },
      headers: { Accept: "application/json", "Idempotency-Key": "abc-123" },
      body: { title: "Hello" },
      timeoutMs: 5_000,
      storePath,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response('{"created":true}', {
          status: 201,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "9",
            "x-private-debug": "hidden",
          },
        });
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://www.moltbook.com/api/v1/posts?page=2&draft=false");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].init.credentials, "omit");
    assert.equal(calls[0].init.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(calls[0].init.headers.accept, "application/json");
    assert.equal(calls[0].init.headers["idempotency-key"], "abc-123");
    assert.equal(calls[0].init.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(calls[0].init.body, '{"title":"Hello"}');
    assert.deepEqual(result.body, { created: true });
    assert.equal(result.status, 201);
    assert.equal(result.headers["x-ratelimit-remaining"], "9");
    assert.equal(Object.hasOwn(result.headers, "x-private-debug"), false);
    assert.equal(JSON.stringify(result).includes(SECRET), false);
  });
});

test("path authorization uses segment boundaries and rejects traversal/full-url tricks", async () => {
  await withTempStore(async ({ storePath }) => {
    await readyProfile(storePath, { allowedMethods: ["GET"], allowedPathPrefixes: ["/posts"] });
    const okFetch = async () => new Response("ok", { status: 200 });
    await authenticatedHttpRequest({ profileId: "moltbook", method: "GET", path: "/posts/123", storePath, fetchImpl: okFetch });
    await assert.rejects(
      authenticatedHttpRequest({ profileId: "moltbook", method: "GET", path: "/posts-evil", storePath, fetchImpl: okFetch }),
      /not allowed/u,
    );
    await assert.rejects(
      authenticatedHttpRequest({ profileId: "moltbook", method: "GET", path: "https://evil.example/x", storePath, fetchImpl: okFetch }),
      /exactly one slash/u,
    );
    await assert.rejects(
      authenticatedHttpRequest({ profileId: "moltbook", method: "GET", path: "/posts/%2e%2e/admin", storePath, fetchImpl: okFetch }),
      /dot traversal/u,
    );
    await assert.rejects(
      authenticatedHttpRequest({ profileId: "moltbook", method: "GET", path: "/posts%2Fadmin", storePath, fetchImpl: okFetch }),
      /encoded separators/u,
    );
  });
});

test("request headers must be explicitly allowed and reserved transport/auth headers cannot be smuggled", async () => {
  await withTempStore(async ({ storePath }) => {
    await readyProfile(storePath);
    const fetchImpl = async () => new Response("ok", { status: 200 });
    await assert.rejects(
      authenticatedHttpRequest({
        profileId: "moltbook",
        method: "GET",
        path: "/posts",
        headers: { "X-Unlisted": "nope" },
        storePath,
        fetchImpl,
      }),
      /not allowed/u,
    );
    await assert.rejects(
      authenticatedHttpRequest({
        profileId: "moltbook",
        method: "GET",
        path: "/posts",
        headers: { Authorization: "Bearer attacker" },
        storePath,
        fetchImpl,
      }),
      /reserved/u,
    );
  });
});

test("secret_header auth injects only the stored credential after agent header validation", async () => {
  await withTempStore(async ({ storePath }) => {
    await upsertAuthenticatedHttpProfileFromControlCenter({
      profile: baseProfile({
        id: "custom",
        auth: { type: "secret_header", headerName: "X-Api-Key" },
        allowedMethods: ["POST"],
        allowedPathPrefixes: ["/posts"],
        allowedAgentHeaders: ["X-Api-Key", "Accept"],
      }),
      credential: SECRET,
      storePath,
    });
    const calls = [];
    await authenticatedHttpRequest({
      profileId: "custom",
      method: "POST",
      path: "/posts",
      headers: { "X-Api-Key": "attacker-value", Accept: "application/json" },
      body: "hello",
      storePath,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response("ok", { status: 200 });
      },
    });
    assert.equal(calls[0].init.headers["x-api-key"], SECRET);
    assert.equal(calls[0].init.headers.accept, "application/json");
  });
});

test("response JSON, text and safe headers redact the exact credential before model-visible output", async () => {
  await withTempStore(async ({ storePath }) => {
    await readyProfile(storePath);
    const responseStore = createAuthenticatedHttpResponseReferenceStore();
    const jsonResult = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "GET",
      path: "/posts",
      storePath,
      responseStore,
      fetchImpl: async () => new Response(JSON.stringify({ echoed: SECRET, nested: [`prefix-${SECRET}-suffix`], [SECRET]: "key-echo" }), {
        status: 200,
        headers: { "content-type": "application/json", etag: SECRET },
      }),
    });
    assert.deepEqual(jsonResult.body, {
      echoed: "[REDACTED]",
      nested: ["prefix-[REDACTED]-suffix"],
      "[REDACTED]": "key-echo",
    });
    assert.equal(jsonResult.headers.etag, "[REDACTED]");
    assert.equal(JSON.stringify(jsonResult).includes(SECRET), false);
    assert.ok(jsonResult.responseId);
    assert.equal(responseStore.resolve({
      responseId: jsonResult.responseId,
      profileId: "moltbook",
      trustIdentity: "https://www.moltbook.com\nbearer\nauthorization",
      jsonPointer: "/echoed",
    }), "[REDACTED]");

    const textResult = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "GET",
      path: "/posts",
      storePath,
      fetchImpl: async () => new Response(`server echoed ${SECRET}`, { status: 500, headers: { "content-type": "text/plain" } }),
    });
    assert.equal(textResult.ok, false);
    assert.equal(textResult.body, "server echoed [REDACTED]");
  });
});

test("response bodies are truncated at the hard bound instead of streaming unbounded content", async () => {
  await withTempStore(async ({ storePath }) => {
    await readyProfile(storePath);
    const oversized = "x".repeat(AUTHENTICATED_HTTP_LIMITS.maxResponseBodyBytes + 64);
    const result = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "GET",
      path: "/posts",
      storePath,
      fetchImpl: async () => new Response(oversized, { status: 200, headers: { "content-type": "text/plain" } }),
    });
    assert.equal(result.truncated, true);
    assert.equal(Buffer.byteLength(result.body, "utf8"), AUTHENTICATED_HTTP_LIMITS.maxResponseBodyBytes);
  });
});

test("control-center upsert preserves same-trust credentials and clears them on trust changes without requiring agent management", async () => {
  await withTempStore(async ({ storePath }) => {
    await upsertAuthenticatedHttpProfileFromControlCenter({ profile: baseProfile(), credential: SECRET, storePath });
    await setAuthenticatedHttpAgentManagement({ enabled: false, storePath });
    const same = await upsertAuthenticatedHttpProfileFromControlCenter({ profile: baseProfile({ label: "Renamed" }), storePath });
    assert.equal(same.ready, true);
    const changed = await upsertAuthenticatedHttpProfileFromControlCenter({
      profile: baseProfile({ origin: "https://api.example.com" }),
      storePath,
    });
    assert.equal(changed.ready, false);
  });
});

test("profile deletion removes credential-bearing records and agent deletion honors management toggle", async () => {
  await withTempStore(async ({ storePath }) => {
    await readyProfile(storePath);
    assert.deepEqual(await deleteAuthenticatedHttpProfile({ profileId: "moltbook", requireAgentManagement: true, storePath }), {
      deleted: true,
      profileId: "moltbook",
    });
    assert.deepEqual((await getAuthenticatedHttpProfiles({ storePath })).profiles, []);
  });
});


test("authenticated HTTP response references preserve internal opaque JSON while public output stays sanitized", async () => {
  await withTempStore(async ({ storePath }) => {
    await readyProfile(storePath, { allowedMethods: ["POST"], allowedPathPrefixes: ["/posts", "/verify"] });
    const responseStore = createAuthenticatedHttpResponseReferenceStore();
    const opaque = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890";
    const calls = [];

    const created = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "POST",
      path: "/posts",
      body: { title: "hello" },
      storePath,
      responseStore,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          post: {
            verification: {
              verification_code: opaque,
            },
          },
        }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.match(created.responseId, /^http_resp_[a-f0-9]{32}$/u);
    assert.equal(created.body.post.verification.verification_code, "[REDACTED_GITHUB_TOKEN]");

    const verified = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "POST",
      path: "/verify",
      body: {
        verification_code: {
          $equinox_response_ref: {
            response_id: created.responseId,
            json_pointer: "/post/verification/verification_code",
          },
        },
        answer: "16.00",
      },
      storePath,
      responseStore,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init });
        const sent = JSON.parse(init.body);
        assert.equal(sent.verification_code, opaque);
        assert.equal(sent.answer, "16.00");
        return new Response(JSON.stringify({ success: true, echoed: opaque }), {
          status: 200,
          headers: { "content-type": "application/json", etag: opaque },
        });
      },
    });

    assert.equal(calls.length, 2);
    assert.equal(verified.body.success, true);
    assert.equal(JSON.stringify(verified).includes(opaque), false);
    assert.equal(verified.headers.etag.includes(opaque), false);
  });
});

test("resolved opaque strings are transiently redacted even when generic sanitizer would not catch them", async () => {
  await withTempStore(async ({ storePath }) => {
    await readyProfile(storePath, { allowedMethods: ["POST"], allowedPathPrefixes: ["/posts", "/verify"] });
    const responseStore = createAuthenticatedHttpResponseReferenceStore();
    const opaque = "opaque-verification-code-123456";

    const created = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "POST",
      path: "/posts",
      storePath,
      responseStore,
      fetchImpl: async () => new Response(JSON.stringify({ code: opaque }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    });
    assert.equal(created.body.code, opaque);

    const verified = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "POST",
      path: "/verify",
      body: {
        code: {
          $equinox_response_ref: {
            response_id: created.responseId,
            json_pointer: "/code",
          },
        },
      },
      storePath,
      responseStore,
      fetchImpl: async (url, init) => {
        assert.equal(JSON.parse(init.body).code, opaque);
        return new Response(JSON.stringify({ echoed: opaque }), {
          status: 200,
          headers: { "content-type": "application/json", etag: opaque },
        });
      },
    });

    assert.deepEqual(verified.body, { echoed: "[REDACTED]" });
    assert.equal(verified.headers.etag, "[REDACTED]");
  });
});

test("response references bind to profile trust identity and are purged on trust changes or deletion", async () => {
  await withTempStore(async ({ storePath }) => {
    const responseStore = createAuthenticatedHttpResponseReferenceStore();
    await readyProfile(storePath, { allowedMethods: ["POST"], allowedPathPrefixes: ["/posts", "/verify"] });

    const created = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "POST",
      path: "/posts",
      storePath,
      responseStore,
      fetchImpl: async () => new Response(JSON.stringify({ code: "opaque" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    });
    assert.equal(responseStore.snapshot().entries, 1);

    await upsertAuthenticatedHttpProfileFromAgent({
      profile: baseProfile({
        origin: "https://api.example.com",
        allowedMethods: ["POST"],
        allowedPathPrefixes: ["/verify"],
      }),
      storePath,
      responseStore,
    });
    assert.equal(responseStore.snapshot().entries, 0);

    await setAuthenticatedHttpProfileCredential({ profileId: "moltbook", credential: SECRET, storePath });
    await assert.rejects(
      authenticatedHttpRequest({
        profileId: "moltbook",
        method: "POST",
        path: "/verify",
        body: {
          code: {
            $equinox_response_ref: {
              response_id: created.responseId,
              json_pointer: "/code",
            },
          },
        },
        storePath,
        responseStore,
        fetchImpl: async () => {
          throw new Error("network must not run");
        },
      }),
      /unknown or expired/u,
    );

    const newCreated = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "POST",
      path: "/verify",
      body: { code: "seed" },
      storePath,
      responseStore,
      fetchImpl: async () => new Response(JSON.stringify({ code: "new-opaque" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    assert.ok(newCreated.responseId);
    assert.equal(responseStore.snapshot().entries, 1);

    await deleteAuthenticatedHttpProfile({ profileId: "moltbook", storePath, responseStore });
    assert.equal(responseStore.snapshot().entries, 0);
  });
});

test("text, invalid JSON and truncated responses never receive response references", async () => {
  await withTempStore(async ({ storePath }) => {
    await readyProfile(storePath, { allowedMethods: ["GET"], allowedPathPrefixes: ["/posts"] });
    const responseStore = createAuthenticatedHttpResponseReferenceStore();

    const text = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "GET",
      path: "/posts",
      storePath,
      responseStore,
      fetchImpl: async () => new Response("plain", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    });
    assert.equal(Object.hasOwn(text, "responseId"), false);

    const invalidJson = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "GET",
      path: "/posts",
      storePath,
      responseStore,
      fetchImpl: async () => new Response("{not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    assert.equal(Object.hasOwn(invalidJson, "responseId"), false);

    const oversized = JSON.stringify({ value: "x".repeat(AUTHENTICATED_HTTP_LIMITS.maxResponseBodyBytes) });
    const truncated = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "GET",
      path: "/posts",
      storePath,
      responseStore,
      fetchImpl: async () => new Response(oversized, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    assert.equal(truncated.truncated, true);
    assert.equal(Object.hasOwn(truncated, "responseId"), false);
    assert.equal(responseStore.snapshot().entries, 0);
  });
});

test("resolved response references are counted in the normal serialized request body limit", async () => {
  await withTempStore(async ({ storePath }) => {
    await readyProfile(storePath, { allowedMethods: ["POST"], allowedPathPrefixes: ["/posts", "/verify"] });
    const responseStore = createAuthenticatedHttpResponseReferenceStore();
    const tooLarge = "x".repeat(AUTHENTICATED_HTTP_LIMITS.maxRequestBodyBytes);

    const created = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "POST",
      path: "/posts",
      storePath,
      responseStore,
      fetchImpl: async () => new Response(JSON.stringify({ code: tooLarge }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    });

    await assert.rejects(
      authenticatedHttpRequest({
        profileId: "moltbook",
        method: "POST",
        path: "/verify",
        body: {
          code: {
            $equinox_response_ref: {
              response_id: created.responseId,
              json_pointer: "/code",
            },
          },
        },
        storePath,
        responseStore,
        fetchImpl: async () => {
          throw new Error("network must not run");
        },
      }),
      /body is too large/u,
    );
  });
});


test("body-external response bindings assemble the request before fetch and redact downstream echoes", async () => {
  await withTempStore(async ({ storePath }) => {
    await readyProfile(storePath, { allowedMethods: ["POST"], allowedPathPrefixes: ["/posts", "/verify"] });
    const responseStore = createAuthenticatedHttpResponseReferenceStore();
    const opaque = "opaque-binding-value-123";
    const created = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "POST",
      path: "/posts",
      storePath,
      responseStore,
      fetchImpl: async () => new Response(JSON.stringify({ post: { verification: { verification_code: opaque } } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    });

    const verified = await authenticatedHttpRequest({
      profileId: "moltbook",
      method: "POST",
      path: "/verify",
      body: { answer: "46.00" },
      response_bindings: [{
        target_json_pointer: "/verification_code",
        response_id: created.responseId,
        source_json_pointer: "/post/verification/verification_code",
      }],
      storePath,
      responseStore,
      fetchImpl: async (url, init) => {
        assert.deepEqual(JSON.parse(init.body), { answer: "46.00", verification_code: opaque });
        return new Response(JSON.stringify({ echoed: opaque }), {
          status: 200,
          headers: { "content-type": "application/json", etag: opaque },
        });
      },
    });

    assert.deepEqual(verified.body, { echoed: "[REDACTED]" });
    assert.equal(verified.headers.etag, "[REDACTED]");
  });
});
