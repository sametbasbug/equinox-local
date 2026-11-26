import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyTypeScriptRuntimeOutput } from "./verify-typescript-runtime.mjs";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const classic=fs.readFileSync(path.join(root,"extension/chatgpt-commentary-visibility.js"),"utf8");
const start=classic.indexOf("(() => {");
const end=classic.lastIndexOf("})();");
assert.ok(start>=0&&end>start&&!classic.slice(end+5).trim(),"Unexpected public commentary script structure.");
const func=classic.slice(start+1,end+1);
const preload='"use strict";\n// Generated from the shared Browser commentary script; no Local IPC or APIs.\n'
  +'const {contextBridge}=require("electron");\n'
  +'if(process.isMainFrame&&location.origin==="https://chatgpt.com"){\n'
  +'  try{contextBridge.executeInMainWorld({func:'+func+'});}catch{/* provider remains usable */}\n}\n';
const target=path.join(root,"desktop/chatgpt-commentary-preload.cjs");
if(process.argv.includes("--build-commentary-preload")){
  fs.writeFileSync(target,preload);
}else{
  assert.equal(fs.readFileSync(target,"utf8"),preload,"Stale native public commentary preload.");
  const result = await verifyTypeScriptRuntimeOutput({
  projectFile: "tsconfig.desktop.json",
  sourceDirectory: "desktop",
});
console.log(`Verified ${result.checked} generated desktop JavaScript files match TypeScript source exactly.`);
}
