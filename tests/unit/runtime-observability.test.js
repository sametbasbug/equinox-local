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

test("newest limited query stops before reading older segments", async () => {
  await withTempDir(async (root) => {
    let nowValue = 30_000_000;
    const store = createRuntimeObservability({ rootDir: root, now: () => nowValue });
    await store.initialize();
    await fs.writeFile(
      path.join(root, "events-0000000000001-old1.jsonl"),
      "{not-json}\n",
      { mode: 0o600 },
    );
    await store.record({
      component: "runtime",
      type: "runtime.latest",
      message: "latest",
    });

    const [latest] = await store.query({ limit: 1, newestFirst: true });
    assert.equal(latest.type, "runtime.latest");
    assert.equal((await store.storageStats()).malformedLines, 0);
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

test("observability reads stay stable while concurrent records rotate storage", async () => {
  await withTempDir(async (root) => {
    let nowValue = 20_000_000;
    let id = 0;
    const store = createRuntimeObservability({
      rootDir: root,
      now: () => nowValue++,
      randomId: () => `c${++id}`,
      maxSegmentBytes: 16 * 1024,
      maxSegments: 3,
    });
    await store.initialize();

    for (let index = 0; index < 40; index += 1) {
      await store.record({
        component: "race",
        type: "race.seed",
        message: `seed-${index}-${"x".repeat(600)}`,
      });
    }

    const operations = [];
    for (let index = 0; index < 80; index += 1) {
      operations.push(index % 3 === 0
        ? store.query({ limit: 50, newestFirst: true })
        : store.record({
            component: "race",
            type: "race.concurrent",
            message: `event-${index}-${"y".repeat(600)}`,
          }));
    }
    await Promise.all(operations);

    const events = await store.query({ limit: 500, newestFirst: false });
    for (let index = 1; index < events.length; index += 1) {
      assert.ok(events[index - 1].timestampMs <= events[index].timestampMs);
    }
    assert.ok((await store.storageStats()).segmentCount <= 3);
  });
});

test("malformed observability line count is not inflated by repeated queries", async () => {
  await withTempDir(async (root) => {
    const store = createRuntimeObservability({ rootDir: root });
    await store.initialize();
    await fs.appendFile(path.join(root, __test.CURRENT_FILE), "not-json\n", "utf8");

    await store.query({ limit: 10 });
    assert.equal((await store.storageStats()).malformedLines, 1);

    await store.query({ limit: 10 });
    assert.equal((await store.storageStats()).malformedLines, 1);
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

test("a failed user managed command remains in diagnostics but does not downgrade the runtime", async () => {
  await withTempDir(async (root) => {
    let nowValue = 9_000_000;
    const store = createRuntimeObservability({ rootDir: root, now: () => nowValue });
    await store.record({ component: "process", type: "process.crashed", severity: "error",
      status: "failed", correlationId: "proc-test", details: { exitCode: 25 },
      message: "Managed background process ended unexpectedly." });
    const events = await store.query({ limit: 5 });
    assert.equal(events.some((event) => event.type === "process.crashed"), true);
    const health = await store.health({ windowMs: 10_000 });
    assert.equal(health.state, "HEALTHY");
    assert.equal(health.reasons.length, 0);
    nowValue += 100;
    await store.record({ component: "runtime", type: "runtime.fault", severity: "error", status: "failed" });
    assert.equal((await store.health({ windowMs: 10_000 })).state, "DEGRADED");
  });
});

test("observability limits deep and wide synthetic private details before writing event JSON", async()=>{
  await withTempDir(async root=>{
    let timestamp=20_000_000;
    const store=createRuntimeObservability({rootDir:root,now:()=>timestamp,randomId:()=>"fixture"});
    const values=Object.fromEntries(Array.from({length:120},(_,i)=>["k"+i,"safe-"+i]));
    values.api_key="fixture-private-credential";
    const event=await store.record({
      component:"runtime",type:"runtime.audit",severity:"info",
      message:"Authorization: fixture-header password=synthetic-secret Bearer abc.def.ghi",
      details:{
        authorization:"fixture-authorization",safe:"fixture-visible",
        nested:{github_token:"fixture-token",levels:{a:{b:{c:{d:{e:{f:{g:"deep-secret"}}}}}}}},
        width:values,
        array:Array.from({length:110},()=>({value:"safe"})),
      },
    });
    assert.equal(event.details.authorization,"[REDACTED]");
    assert.equal(event.details.nested.github_token,"[REDACTED]");
    assert.equal(event.details.array.length,100);
    assert.equal(Object.keys(event.details.width).length,100);
    assert.equal(event.details.safe,"fixture-visible");
    const text=await fs.readFile(path.join(root,__test.CURRENT_FILE),"utf8");
    for(const secret of ["fixture-private-credential","fixture-authorization","fixture-token","synthetic-secret","abc.def.ghi"]){
      assert.equal(text.includes(secret),false,secret);
    }
    assert.equal((await fs.stat(path.join(root,__test.CURRENT_FILE))).mode&0o077,0);
    assert.equal((await fs.stat(root)).mode&0o077,0);
  });
});

test("observability refuses invalid config, event names, oversize events and query filters without admitting records",async()=>{
  await withTempDir(async root=>{
    for(const options of [
      {rootDir:"relative"},
      {rootDir:root,maxSegmentBytes:1},
      {rootDir:root,maxSegments:0},
      {rootDir:root,maxSegments:101},
    ])assert.throws(()=>createRuntimeObservability(options),Error);
    const store=createRuntimeObservability({rootDir:root,maxEventBytes:512,now:()=>1_500_000});
    for(const input of [
      {component:"Bad Component",type:"runtime.start"},
      {component:"runtime",type:"Bad Type"},
      {component:"runtime",type:"runtime.start",severity:"unknown"},
      {component:"runtime",type:"runtime.start",message:"x".repeat(20_000)},
    ])await assert.rejects(store.record(input),Error);
    assert.equal((await store.query()).length,0);
    for(const input of [
      {limit:0},{limit:501},{limit:1.5},{limit:"1"},{severity:"fatal"},
    ])await assert.rejects(store.query(input),Error);
    assert.equal((await store.storageStats()).currentBytes,0);
  });
});

test("observability newest-first query limit, filters and malformed current lines retain exact stable ordering",async()=>{
  await withTempDir(async root=>{
    let timestamp=30_000_000,nonce=0;
    const store=createRuntimeObservability({rootDir:root,now:()=>timestamp,randomId:()=>String(++nonce)});
    for(const [type,severity,component] of [
      ["alpha","info","runtime"],["beta","warn","chrome"],
      ["gamma","error","chrome"],["delta","info","runtime"],
    ]){
      await store.record({component,type:"runtime."+type,severity});
      timestamp+=100;
    }
    assert.deepEqual((await store.query({limit:2})).map(e=>e.type),["runtime.delta","runtime.gamma"]);
    assert.deepEqual((await store.query({limit:2,newestFirst:false})).map(e=>e.type),["runtime.alpha","runtime.beta"]);
    assert.deepEqual((await store.query({component:"chrome",severity:"warn",limit:5})).map(e=>e.type),["runtime.beta"]);
    assert.deepEqual((await store.query({sinceMs:30_000_150,untilMs:30_000_250,newestFirst:false})).map(e=>e.type),["runtime.gamma"]);
    await fs.appendFile(path.join(root,__test.CURRENT_FILE),"\n{not-json}\n", "utf8");
    assert.deepEqual((await store.query({limit:1})).map(e=>e.type),["runtime.delta"]);
    assert.equal((await store.storageStats()).malformedLines,1);
    await store.query({limit:1});
    assert.equal((await store.storageStats()).malformedLines,1);
  });
});

test("observability health keeps independent recovery circuits and ignores user process crashes",async()=>{
  await withTempDir(async root=>{
    let timestamp=40_000_000;
    const store=createRuntimeObservability({rootDir:root,now:()=>timestamp,randomId:()=>String(timestamp++)});
    await store.record({component:"process",type:"process.crashed",severity:"critical",status:"attention_required",correlationId:"fixture-process"});
    assert.equal((await store.health({windowMs:1000})).state,"HEALTHY");
    await store.record({component:"recovery-policy",type:"recovery-policy.circuit_open",severity:"critical",status:"attention_required",details:{circuitKey:"bridge|one"}});
    await store.record({component:"recovery-policy",type:"recovery-policy.recovered",severity:"info",status:"recovered",details:{circuitKey:"bridge|two"}});
    assert.equal((await store.health({windowMs:1000})).state,"ATTENTION REQUIRED");
    await store.record({component:"recovery-policy",type:"recovery-policy.recovered",severity:"info",status:"recovered",details:{circuitKey:"bridge|one"}});
    const health=await store.health({windowMs:1000});
    assert.equal(health.state,"HEALTHY");
    assert.equal(health.reasons.length,0);
    const metrics=await store.metrics({windowMs:1000});
    assert.equal(metrics.totalEvents,4);
    assert.equal(metrics.bySeverity.critical,2);
  });
});
