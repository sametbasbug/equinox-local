#!/usr/bin/env node
// Real Windows installer acceptance: execute the production cleanup module
// from the exactly admitted managed source, not a test double.
import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , sourceRoot, programRoot] = process.argv;
if (process.platform !== "win32" ||
    !path.win32.isAbsolute(sourceRoot ?? "") ||
    !path.win32.isAbsolute(programRoot ?? "")) {
  throw new Error("Installed Windows registration cleanup requires absolute paths.");
}
const entry = path.win32.join(sourceRoot, "src", "equinox-local-uninstall-helper.js");
const { removeWindowsShellRegistration } = await import(pathToFileURL(entry).href);
await removeWindowsShellRegistration({ programRoot });
process.stdout.write("Owned Windows Installed Apps and Start Menu registration cleanup passed.\n");
