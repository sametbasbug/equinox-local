#!/usr/bin/env node

import { createEquinoxBrowserNativeHostRuntime } from "./equinox-browser-native-host-runtime.js";
import { equinoxBrowserIpcEndpoint } from "./equinox-browser-socket.js";

const BRIDGE_ENDPOINT = equinoxBrowserIpcEndpoint({
  namespace: process.env.EQUINOX_LOCAL_BROWSER_SOCKET_NAMESPACE || null,
});
const origin = process.argv[2] || null;

const runtime = createEquinoxBrowserNativeHostRuntime({
  bridgeEndpoint: BRIDGE_ENDPOINT,
  origin,
  onFatal: ({ code }) => {
    process.exitCode = code;
  },
});

runtime.start();

process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => {
  runtime.close();
  process.exit(0);
});
