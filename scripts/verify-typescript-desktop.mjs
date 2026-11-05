import { verifyTypeScriptRuntimeOutput } from "./verify-typescript-runtime.mjs";
const result = await verifyTypeScriptRuntimeOutput({
    projectFile: "tsconfig.desktop.json",
    sourceDirectory: "desktop",
});
console.log(`Verified ${result.checked} generated desktop JavaScript files match TypeScript source exactly.`);
