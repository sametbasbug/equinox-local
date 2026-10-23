import { verifyTypeScriptRuntimeOutput } from "./verify-typescript-runtime.mjs";

const result = await verifyTypeScriptRuntimeOutput({
  projectFile: "tsconfig.tooling.json",
  sourceDirectory: "scripts",
  emittedPrefix: "scripts",
  writeOutput: process.argv[2] === "--build",
});
console.log(`${process.argv[2] === "--build" ? "Built" : "Verified"} ${result.checked} generated tooling JavaScript files match TypeScript source exactly.`);
