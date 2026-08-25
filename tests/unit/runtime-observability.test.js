import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  __test,
  createRuntimeObservability,
} from "../../src/runtime-observability.js";

async function withTempDir(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "equinox-observability-"));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("observability records, queries and aggregates bounded events", async () => {
  await withTempDir(async (root) => {
    let nowValue = 1_780_000_000_000;
    let id = 0;
    const store = createRuntimeObservability({
      rootDir: root,
      now: () => nowValue,
      randomId: () => `id${++id}`,
    });
    await store.initialize();

    await store.record({
      component: "runtime",
      type: "runtime.start",
      status: "healthy",
      message: "started",
    });
    nowValue += 1_000;
    await store.record({
      component: "peekaboo",
      type: "peekaboo.disconnect",
      severity: "warn",
      message: "connection closed",
    });

    const events = await store.query({ limit: 10, newestFirst: false });
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "runtime.start");
    assert.equal(events[1].component, "peekaboo");

    const metrics = await store.metrics({ windowMs: 60_000 });
    assert.equal(metrics.totalEvents, 2);
    assert.equal(metrics.bySeverity.info, 1);
    assert.equal(metrics.bySeverity.warn, 1);
    assert.equal(metrics.byComponent.peekaboo, 1);

    const health = await store.health({ windowMs: 60_000 });
    assert.equal(health.state, "DEGRADED");
    assert.equal(health.reasons[0].component, "peekaboo");
  });
});

test("latest recovery event clears degraded component state", async () => {
  await withTempDir(async (root) => {
    let nowValue = 2_000_000;
    const store = createRuntimeObservability({ rootDir: root, now: () => nowValue });
    await store.record({
      component: "chrome",
      type: "chrome.error",
      severity: "error",
      status: "failed",
      message: "transport closed",
    });
    nowValue += 100;
    await store.record({
      component: "chrome",
      type: "chrome.recovered",
      severity: "info",
      status: "recovered",
      message: "bridge restored",
    });

    const health = await store.health({ windowMs: 10_000 });
    assert.equal(health.state, "HEALTHY");
    assert.equal(health.reasons.length, 0);
  });
});

test("secret-like details and bearer strings are redacted before persistence", async () => {
  await withTempDir(async (root) => {
    const store = createRuntimeObservability({ rootDir: root });
    await store.record({
      component: "deployment",
      type: "deployment.failure",
      severity: "error",
      message: "Authorization: Bearer abc.def.ghi token=super-secret",
      details: {
        authorization: "Bearer should-never-persist",
        nested: {
          api_key: "secret-key",
          safe: "hello",
        },
      },
    });

    const [event] = await store.query({ limit: 1 });
    assert.equal(event.details.authorization, "[REDACTED]");
    assert.equal(event.details.nested.api_key, "[REDACTED]");
    assert.equal(event.details.nested.safe, "hello");
    assert.doesNotMatch(event.message, /abc\.def\.ghi|super-secret/u);
  });
});

test("event storage rotates and prunes old segments", async () => {
  await withTempDir(async (root) => {
    let nowValue = 10_000_000;
    let id = 0;
    const store = createRuntimeObservability({
      rootDir: root,
      now: () => nowValue++,
      randomId: () => `r${++id}`,
      maxSegmentBytes: 16 * 1024,
      maxSegments: 2,
    });

    for (let index = 0; index < 120; index += 1) {
      await store.record({
        component: "test",
        type: "test.event",
        message: `event-${index}-${"x".repeat(500)}`,
      });
    }

    const stats = await store.storageStats();
    assert.ok(stats.segmentCount <= 2);
    assert.ok(stats.currentBytes <= 16 * 1024 + __test.DEFAULT_MAX_EVENT_BYTES);

    const entries = await fs.readdir(root);
    assert.equal(entries.includes(__test.CURRENT_FILE), true);
    assert.ok(entries.filter((name) => __test.SEGMENT_PATTERN.test(name)).length <= 2);
  });
});

test("attention and recovering states are explicit, never numeric scores", async () => {
  await withTempDir(async (root) => {
    let nowValue = 5_000_000;
    const store = createRuntimeObservability({ rootDir: root, now: () => nowValue });

    await store.record({
      component: "self-healing",
      type: "repair.started",
      severity: "warn",
      status: "recovering",
    });
    assert.equal((await store.health({ windowMs: 10_000 })).state, "RECOVERING");

    nowValue += 100;
    await store.record({
      component: "self-healing",
      type: "repair.circuit_open",
      severity: "critical",
      status: "attention_required",
    });
    assert.equal((await store.health({ windowMs: 10_000 })).state, "ATTENTION REQUIRED");
  });
});

test("independent health concerns cannot mask each other on the same component", async () => {
  await withTempDir(async (root) => {
    let nowValue = 8_000_000;
    const store = createRuntimeObservability({ rootDir: root, now: () => nowValue });
    await store.record({
      component: "peekaboo",
      type: "peekaboo.permission_loss",
      severity: "warn",
      status: "degraded",
      message: "Accessibility lost",
    });
    nowValue += 100;
    await store.record({
      component: "peekaboo",
      type: "peekaboo.compatibility_ok",
      severity: "info",
      status: "healthy",
      message: "schema compatible",
    });

    const health = await store.health({ windowMs: 10_000 });
    assert.equal(health.state, "DEGRADED");
    assert.equal(health.reasons.some((item) => item.type === "peekaboo.permission_loss"), true);
  });
});

test("repair health is isolated per incident id", async () => {
  await withTempDir(async (root) => {
    let nowValue = 8_500_000;
    const store = createRuntimeObservability({ rootDir: root, now: () => nowValue });
    await store.record({
      component: "repair",
      type: "repair.needs_intervention",
      severity: "warn",
      status: "attention_required",
      details: { incidentId: "inc-a" },
    });
    nowValue += 100;
    await store.record({
      component: "repair",
      type: "repair.recovered",
      severity: "info",
      status: "recovered",
      details: { incidentId: "inc-b" },
    });

    let health = await store.health({ windowMs: 10_000 });
    assert.equal(health.state, "ATTENTION REQUIRED");

    nowValue += 100;
    await store.record({
      component: "repair",
      type: "repair.recovered",
      severity: "info",
      status: "recovered",
      details: { incidentId: "inc-a" },
    });

    health = await store.health({ windowMs: 10_000 });
    assert.equal(health.state, "HEALTHY");
  });
});

test("automatic recovery health is isolated per circuit key", async () => {
  await withTempDir(async (root) => {
    let nowValue = 8_750_000;
    const store = createRuntimeObservability({ rootDir: root, now: () => nowValue });
    await store.record({
      component: "recovery-policy",
      type: "recovery-policy.circuit_open",
      severity: "critical",
      status: "attention_required",
      details: {
        circuitKey: "peekaboo_transport_recover|peekaboo",
        policyId: "peekaboo_transport_recover",
      },
    });
    nowValue += 100;
    await store.record({
      component: "recovery-policy",
      type: "recovery-policy.recovered",
      severity: "info",
      status: "recovered",
      details: {
        circuitKey: "chrome_transport_recover|chrome",
        policyId: "chrome_transport_recover",
      },
    });

    let health = await store.health({ windowMs: 10_000 });
    assert.equal(health.state, "ATTENTION REQUIRED");

    nowValue += 100;
    await store.record({
      component: "recovery-policy",
      type: "recovery-policy.recovered",
      severity: "info",
      status: "recovered",
      details: {
        circuitKey: "peekaboo_transport_recover|peekaboo",
        policyId: "peekaboo_transport_recover",
      },
    });
    health = await store.health({ windowMs: 10_000 });
    assert.equal(health.state, "HEALTHY");
  });
});

test("metrics aggregate the full bounded store rather than the public 500-event query cap", async () => {
  await withTempDir(async (root) => {
    let nowValue = 9_000_000;
    const store = createRuntimeObservability({
      rootDir: root,
      now: () => nowValue++,
      maxSegmentBytes: 512 * 1024,
      maxSegments: 12,
    });
    for (let index = 0; index < 650; index += 1) {
      await store.record({
        component: "test",
        type: "test.metric",
        severity: "info",
      });
    }
    const metrics = await store.metrics({ windowMs: 10_000 });
    assert.equal(metrics.totalEvents, 650);
    assert.equal(metrics.byType["test.metric"], 650);
  });
});

test("invalid event names and excessive query limits are rejected", async () => {
  await withTempDir(async (root) => {
    const store = createRuntimeObservability({ rootDir: root });
    await assert.rejects(
      () => store.record({ component: "Bad Component", type: "runtime.start" }),
      /component adı geçersiz/u,
    );
    await assert.rejects(
      () => store.query({ limit: 501 }),
      /limit 1-500/u,
    );
  });
});
