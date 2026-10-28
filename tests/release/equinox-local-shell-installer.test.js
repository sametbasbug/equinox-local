import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const mac=path.join(root,"scripts","install-equinox-local.sh");
const win=path.join(root,"scripts","install-equinox-local.ps1");

test("ONE macOS shell command always verifies latest production Main then reinstalls owned executables",async()=>{
 const s=await fs.readFile(mac,"utf8");
 assert.match(s,/^#!\/bin\/bash\nset -euo pipefail/u);
 assert.match(s,/--proto '=https' --tlsv1\.2/u);
 assert.match(s,/MAIN_VERIFY_SHA256="[a-f0-9]{64}"/u);
 assert.match(s,/MAIN_VERIFY_URL="https:\/\/local\.sametbasbug\.dev\/downloads\/updates\/install-main-verify\.mjs"/u);
 assert.match(s,/prepare_verified_main\ninfo "replacing product executables/u);
 assert.match(s,/for entry in current releases runtime main-update; do/u);
 assert.match(s,/--install-main-fresh/u);
 assert.match(s,/--signed-pointer-file "\$MAIN_POINTER" --archive "\$MAIN_ARCHIVE"/u);
 assert.ok(s.indexOf("prepare_verified_main\ninfo")<s.indexOf("/bin/rm -rf \"$old\""));
 assert.doesNotMatch(s,/bootstrap-\$TARGET\.txt|unexpected bootstrap channel|\bCHANNEL="stable"|--activate-main|--repair-main|--recover-main/u);
 for(const userEntry of ["config.json","workspace","secrets","downloads","logs","tunnel-profile"]){
   assert.doesNotMatch(s,new RegExp(`\\$INSTALL_ROOT/\\$\\{?${userEntry}`,'u'));
 }
 assert.match(s,/trap cleanup EXIT/u);
 assert.match(s,/do not run this installer with sudo or as root/u);
 assert.doesNotMatch(s,/curl[^\n]*\|[^\n]*(?:sh|bash)/u);
});

test("macOS and Windows installers support their actual native Main architectures",async()=>{
 const [m,w]=await Promise.all([fs.readFile(mac,"utf8"),fs.readFile(win,"utf8")]);
 assert.match(m,/arm64\) TARGET="darwin-arm64"/u);
 assert.match(m,/x86_64\) TARGET="darwin-x64"/u);
 assert.match(w,/'AMD64' \{ return 'win32-x64' \}/u);
 assert.match(w,/'ARM64' \{ return 'win32-arm64' \}/u);
 assert.match(w,/native 64-bit Windows PowerShell is required/u);
});

test("ONE PowerShell command checks signed latest Main before reusing product-only executable replacement",async()=>{
 const w=await fs.readFile(win,"utf8");
 assert.match(w,/param\(\[switch\]\$Help\)/u);
 assert.match(w,/function Invoke-VerifiedMainPreparation/u);
 assert.match(w,/\$freshReceipt = @\(Invoke-VerifiedMainPreparation \$tempRoot\)/u);
 assert.match(w,/\$oldExecutables = Begin-ExecutableReplacement \$installRoot/u);
 assert.match(w,/\$freshResult = @\(Invoke-PinnedMainNode \$mainNode/u);
 assert.match(w,/--install-main-fresh/u);
 assert.match(w,/\$installed\.sourceSha -cne \$main\.sourceSha/u);
 assert.match(w,/Complete-ExecutableReplacement \$oldExecutables/u);
 assert.match(w,/function Suspend-OldEquinoxChromeHost/u);
 assert.match(w,/function Stop-ExistingEquinoxExecutables/u);
 assert.ok(w.indexOf("$freshReceipt = @(") < w.indexOf("$oldExecutables = Begin-ExecutableReplacement"));
 assert.doesNotMatch(w,/Read-BootstrapManifest|bootstrap-\$Target\.txt|Invoke-CleanNode|Assert-ExistingStableUpgradeRoute/u);
 assert.doesNotMatch(w,/Start-Process[^\n]*-Verb\s+RunAs|Expand-Archive/u);
});

test("both original scripts are shipped in the same public signed Main release",async()=>{
 const pkg=await fs.readFile(path.join(root,"scripts","release","package-managed-release.mjs"),"utf8");
 assert.match(pkg,/"scripts\/install-equinox-local\.sh"/u);
 assert.match(pkg,/"scripts\/install-equinox-local\.ps1"/u);
});
