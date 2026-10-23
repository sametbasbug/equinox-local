import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { equinoxBrowserIpcEndpoint } from "../../src/equinox-browser-socket.js";

const ENTRY_SOURCE = await fs.readFile(new URL("../../src/equinox-browser-native-host.js", import.meta.url), "utf8");
let fixtureSerial = 0;

async function bootHost({
  namespace,
  origin,
  endpointImpl = equinoxBrowserIpcEndpoint,
  startupError = null,
} = {}) {
  const calls = [];
  const inputListeners = new Map();
  const processListeners = new Map();
  let factoryOptions = null;
  const processFake = {
    env: namespace === undefined ? {} : { EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE: namespace },
    argv: ["/owned/node", "/owned/native-host.js", origin],
    stdin: {
      on: (name, callback) => {
        calls.push(["stdin.on", name]);
        inputListeners.set(name, callback);
      },
    },
    on: (name, callback) => {
      calls.push(["process.on", name]);
      processListeners.set(name, callback);
    },
    exitCode: undefined,
    exit: (code) => { calls.push(["process.exit", code]); },
  };
  const injected = {
    process: processFake,
    equinoxBrowserIpcEndpoint: (options) => {
      calls.push(["endpoint", options]);
      return endpointImpl(options);
    },
    createEquinoxBrowserNativeHostRuntime: (options) => {
      factoryOptions = options;
      calls.push(["runtimeFactory", {bridgeEndpoint: options.bridgeEndpoint, origin: options.origin}]);
      return {
        start() {
          calls.push(["start"]);
          if (startupError) throw startupError;
        },
        close() { calls.push(["close"]); },
      };
    },
  };

  const markedImports = ENTRY_SOURCE
    .replace(/^#![^\n]*\n/u, "")
    .replace(/^import \{ createEquinoxBrowserNativeHostRuntime \} from "\.\/equinox-browser-native-host-runtime\.js";$/mu, "")
    .replace(/^import \{ equinoxBrowserIpcEndpoint \} from "\.\/equinox-browser-socket\.js";$/mu, "");
  assert.notEqual(markedImports, ENTRY_SOURCE, "entrypoint imports must be found before injecting a fake runtime");
  assert.doesNotMatch(markedImports, /^import\s/u, "real runtime imports must never be executed by this fixture");
  const injectedSource = [
    "const { process, equinoxBrowserIpcEndpoint, createEquinoxBrowserNativeHostRuntime } = globalThis.__equinoxNativeHostEntryFixture;",
    markedImports,
    `// unique mocked import ${++fixtureSerial}`,
  ].join("\n");
  globalThis.__equinoxNativeHostEntryFixture = injected;
  let thrown = null;
  try {
    await import("data:text/javascript;base64," + Buffer.from(injectedSource).toString("base64"));
  } catch (error) {
    thrown = error;
  } finally {
    delete globalThis.__equinoxNativeHostEntryFixture;
  }
  return {calls, factoryOptions, processFake, inputListeners, processListeners, thrown};
}

test("native-host startup uses only the explicit browser socket namespace and originating extension argument", async () => {
  const {calls, factoryOptions, inputListeners, processListeners, thrown} = await bootHost({
    namespace:"bounded-session",origin:"chrome-extension://fixture-id/",
  });
  assert.equal(thrown,null);
  assert.deepEqual(calls,[
    ["endpoint",{namespace:"bounded-session"}],
    ["runtimeFactory",{
      bridgeEndpoint: equinoxBrowserIpcEndpoint({namespace:"bounded-session"}),
      origin:"chrome-extension://fixture-id/",
    }],
    ["start"],
    ["stdin.on","end"],
    ["process.on","SIGTERM"],
  ]);
  assert.equal(typeof factoryOptions.onFatal,"function");
  assert.deepEqual([...inputListeners.keys()],["end"]);
  assert.deepEqual([...processListeners.keys()],["SIGTERM"]);
});

test("native-host default startup preserves null origin and namespace without inventing another browser route", async () => {
  for (const namespace of [undefined, "", null]) {
    const loaded = await bootHost({namespace,origin:undefined});
    assert.equal(loaded.thrown,null);
    assert.deepEqual(loaded.calls[0],["endpoint",{namespace:null}]);
    assert.equal(loaded.factoryOptions.origin,null);
    assert.deepEqual(loaded.factoryOptions.bridgeEndpoint,equinoxBrowserIpcEndpoint({namespace:null}));
  }
});

test("native-host fatal event writes the provided exit code, but never calls process.exit before teardown", async () => {
  const loaded = await bootHost({namespace:"test"});
  assert.equal(loaded.thrown,null);
  loaded.factoryOptions.onFatal({code:2,reason:"mock bridge failure"});
  assert.equal(loaded.processFake.exitCode,2);
  assert.equal(loaded.calls.some(([name])=>name==="process.exit"),false);
  loaded.factoryOptions.onFatal({code:7});
  assert.equal(loaded.processFake.exitCode,7);
  assert.equal(loaded.calls.filter(([name])=>name==="runtimeFactory").length,1);
});

test("native-host stdin EOF exits once and SIGTERM closes its own bridge before exiting", async () => {
  const eof = await bootHost({namespace:"test"});
  eof.inputListeners.get("end")();
  assert.deepEqual(eof.calls.slice(-1),[["process.exit",0]]);
  assert.equal(eof.calls.some(([name])=>name==="close"),false,"EOF does not invoke the bridge-close handler");
  const terminated = await bootHost({namespace:"test"});
  terminated.processListeners.get("SIGTERM")();
  assert.deepEqual(terminated.calls.slice(-2),[["close"],["process.exit",0]]);
});

test("native-host invalid namespace or startup refusal fails before installing shutdown callbacks or creating alternate transport", async () => {
  const blocked = await bootHost({
    namespace:"../not-owned",
  });
  assert.match(blocked.thrown?.message??"",/namespace is invalid/u);
  assert.deepEqual(blocked.calls.map(([name])=>name),["endpoint"]);
  assert.equal(blocked.factoryOptions,null);
  assert.equal(blocked.inputListeners.size,0);
  assert.equal(blocked.processListeners.size,0);

  const startFailure=Error("controlled native runtime startup refusal");
  const start=await bootHost({namespace:"valid",startupError:startFailure});
  assert.equal(start.thrown,startFailure);
  assert.deepEqual(start.calls.map(([name])=>name),["endpoint","runtimeFactory","start"]);
  assert.equal(start.inputListeners.size,0);
  assert.equal(start.processListeners.size,0);
});
