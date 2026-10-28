import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import {collectManagedReleaseSourceFiles} from "../../scripts/release/package-managed-release.mjs";

const installer=new URL("../../scripts/install-equinox-local.ps1",import.meta.url);
const cli=new URL("../../src/equinox-local-first-install.js",import.meta.url);

test("the production signed Main Windows ZIP is installed by the SAME original PowerShell command",async()=>{
 const source=await fs.readFile(installer,"utf8");
 assert.match(source,/Invoke-VerifiedMainPreparation/u);
 assert.match(source,/--install-main-fresh/u);
 assert.match(source,/Clear-ExistingEquinoxExecutables/u);
 assert.doesNotMatch(source,/function Restore-ExecutableReplacement/u);
 assert.doesNotMatch(source,/--check-windows-signed-main|--activate-main|Read-BootstrapManifest/u);
 const js=await fs.readFile(cli,"utf8");
 assert.match(js,/--install-main-fresh/u);
 assert.match(js,/installFreshSignedMainRelease/u);
});

test("same bundled first-install helper rejects unsigned Windows Guardian preflight selector and extra command arguments without filesystem mutation",async t=>{
 const home=await fs.mkdtemp(path.join(os.tmpdir(),"eq-win-signed-check-"));
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const selector=path.join(home,"unsigned.json");
 await fs.writeFile(selector,JSON.stringify({sourceSha:"f".repeat(40),padding:"x".repeat(220)}),{mode:0o600});
 for(const args of [
  ["--check-windows-signed-main","--signed-pointer-file",selector],
  ["--check-windows-signed-main","--signed-pointer-file",selector,"--unsafe"],
  ["--check-windows-signed-main","--signed-pointer-file","relative.json"],
 ]){
  const response=spawnSync(process.execPath,[cli.pathname,...args],{
   encoding:"utf8",env:{HOME:home,PATH:"/usr/bin:/bin"},timeout:10000,
  });
  assert.equal(response.status,1);
  assert.equal(response.stdout,"");
  assert.match(response.stderr,/Windows signed native Main preflight denied/u);
 }
 await assert.rejects(fs.lstat(path.join(home,"AppData")),{code:"ENOENT"});
});


test("the original signed native release packages its Windows Guardian admission helper and the exact same external PowerShell installer",async()=>{
 const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),"../..");
 const files=await collectManagedReleaseSourceFiles(root);
 assert.ok(files.includes("src/equinox-local-signed-main-windows-admission.js"));
 assert.ok(files.includes("scripts/install-equinox-local.ps1"));
 assert.ok(files.includes("src/equinox-local-first-install.js"));
 assert.equal(files.filter(item=>item==="scripts/install-equinox-local.ps1").length,1);
});
