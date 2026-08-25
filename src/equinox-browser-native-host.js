#!/usr/bin/env node

import { createEquinoxBrowserNativeHostRuntime } from "./equinox-browser-native-host-runtime.js";
import { equinoxBrowserSocketPath } from "./equinox-browser-socket.js";

const SOCKET_PATH = equinoxBrowserSocketPath();
const origin = process.argv[2] || null;

const runtime = createEquinoxBrowserNativeHostRuntime({
  socketPath: SOCKET_PATH,
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
