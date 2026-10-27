import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
 NODE_DISTRIBUTIONS,EQUINOX_LOCAL_NODE_VERSION,
} from '../../src/equinox-local-runtime-versions.js';

const macURL=new URL('../../scripts/install-equinox-local.sh',import.meta.url);
const windowsURL=new URL('../../scripts/install-equinox-local.ps1',import.meta.url);
const verifierURL=new URL('../../scripts/install-main-verify.mjs',import.meta.url);
const publicVerifierURL=new URL('../../website/site/downloads/updates/install-main-verify.mjs',import.meta.url);

test('one byte-identical standalone verifier is SHA pinned by BOTH OS installers before any execution',async()=>{
 const [mac,windows,verifier,website]=await Promise.all([
  fs.readFile(macURL,'utf8'),fs.readFile(windowsURL,'utf8'),
  fs.readFile(verifierURL),fs.readFile(publicVerifierURL),
 ]);
 assert.deepEqual(website,verifier,'the public website serves precisely the verified product JavaScript');
 const sha=createHash('sha256').update(verifier).digest('hex');
 assert.ok(verifier.length>500&&verifier.length<65536);
 for(const source of [mac,windows]){
  assert.ok(source.includes('https://local.sametbasbug.dev/downloads/updates/install-main-verify.mjs'));
  assert.ok(source.includes(sha),'no stale/replaced bootstrap verifier may run');
  assert.ok(source.includes(String(verifier.length)));
 }
 assert.match(mac,/MAIN_VERIFY_BYTES/u);
 assert.match(mac,/MAIN_VERIFY_SHA256/u);
 assert.match(mac,/shasum -a 256 "\$verifier"/u);
 assert.ok(mac.indexOf('MAIN_VERIFY_SHA256"')<mac.indexOf('"$node" "$verifier"'));
 assert.match(windows,/Get-Sha256 \$source\) -cne \$MainVerifySha256/u);
 assert.ok(windows.indexOf('Get-Sha256 $source')<windows.indexOf('Invoke-PinnedMainNode $node @($source'));
});

test('all four fresh-user Node archives are independently pinned to existing release-toolchain contracts',async()=>{
 const [mac,windows]=await Promise.all([fs.readFile(macURL,'utf8'),fs.readFile(windowsURL,'utf8')]);
 for(const source of [mac,windows]){
  assert.ok(source.includes(EQUINOX_LOCAL_NODE_VERSION));
  assert.ok(!/Get-Command\s+node|command -v node|Invoke-Expression|eval\s/u.test(source));
 }
 for(const [target,contract] of Object.entries(NODE_DISTRIBUTIONS)){
  const installer=target.startsWith('darwin-')?mac:windows;
  assert.ok(installer.includes(contract.sha256),target+' expected exact pinned public Node digest');
  assert.ok(installer.includes(String(contract.bytes)),target+' expected exact pinned Node archive size');
 }
 assert.match(mac,/--max-filesize "\$MAIN_NODE_ARCHIVE_BYTES"/u);
 assert.match(mac,/shasum -a 256 "\$node_archive"/u);
 assert.ok(mac.indexOf('MAIN_NODE_ARCHIVE_SHA256"')<mac.indexOf('"$node" "$verifier"'));
 assert.match(windows,/Assert-NormalFile \$nodeZip \$nodeBytes \$nodeBytes/u);
 assert.match(windows,/Get-Sha256 \$nodeZip\) -cne \$nodeSha/u);
 assert.ok(windows.indexOf('Get-Sha256 $nodeZip')<windows.indexOf('Invoke-PinnedMainNode $node @($source'));
 assert.match(windows,/System32\\tar\.exe/u);
 assert.doesNotMatch(windows,/Expand-Archive/u);
});

test('prepare-only CLI stops before old Stable activation and preserves default rollback until unified Main installer is ready',async()=>{
 const [mac,windows]=await Promise.all([fs.readFile(macURL,'utf8'),fs.readFile(windowsURL,'utf8')]);
 assert.match(mac,/--prepare-main\) PREPARE_MAIN=1/u);
 assert.match(mac,/if \[ "\$PREPARE_MAIN" -eq 1 \]; then\s+prepare_verified_main\s+exit 0\s+fi/u);
 assert.ok(mac.indexOf('prepare_verified_main\n  exit 0')<mac.indexOf('info "checking the stable'));
 assert.match(windows,/\[switch\]\$PrepareMain = \$false/u);
 assert.match(windows,/RuntimeInformation\]::ProcessArchitecture/u);
 assert.match(windows,/RuntimeInformation\]::OSArchitecture/u);
 assert.match(windows,/if \(\$PrepareMain\) \{ Invoke-VerifiedMainPreparation \$tempRoot; return \}/u);
 assert.ok(windows.indexOf('if ($PrepareMain)')<windows.indexOf('Save-BoundedHttpsFile "$UpdateBase/bootstrap-'));
 assert.match(mac,/MAIN_ARGS=\(--enroll-existing-main\)/u);
 assert.match(windows,/Restore-ExecutableReplacement \$transaction/u);
 assert.match(windows,/Restore-OldEquinoxChromeHost \$nativeHostSuspension/u);
});


test('the same verified Main SHA and version enter the existing native release inspector on both OSes before activation',async()=>{
 const [mac,windows,inspectionSource]=await Promise.all([
  fs.readFile(macURL,'utf8'),fs.readFile(windowsURL,'utf8'),
  fs.readFile(new URL('../../src/equinox-local-first-install.js',import.meta.url),'utf8'),
 ]);
 assert.match(inspectionSource,/expectedMainSourceSha/u);
 assert.match(inspectionSource,/expectedMainVersion/u);
 assert.match(inspectionSource,/--inspect-signed-main/u);
 assert.match(mac,/tar -xzf "\$archive" -C "\$extracted" --no-same-owner/u);
 assert.match(mac,/--inspect-signed-main/u);
 assert.ok(mac.indexOf('MAIN_VERIFY_SHA256"')<mac.indexOf('tar -xzf "$archive"'));
 assert.ok(mac.indexOf('tar -xzf "$archive"')<mac.indexOf('"$node" "$inspector"'));
 assert.match(mac,/--source-sha "\$signed_sha"/u);
 assert.match(mac,/--version "\$signed_version"/u);
 assert.match(windows,/--inspect-signed-main/u);
 assert.match(windows,/\$nativeTar '-xf' \$verifiedArchive '-C' \$mainExtracted/u);
 assert.ok(windows.indexOf('Get-Sha256 $verifiedArchive')<windows.indexOf("$nativeTar '-xf' $verifiedArchive"));
 assert.ok(windows.indexOf("$nativeTar '-xf' $verifiedArchive")<windows.indexOf('Invoke-PinnedMainNode $node @($inspector'));
 assert.match(windows,/\$matched\.sourceSha -cne \$parsed\.sourceSha/u);
 assert.match(windows,/\$matched\.version -cne \$parsed\.version/u);
 assert.match(windows,/\$matched\.target -cne \$Target/u);
});

test('Windows prepare-only mode bypasses Stable-only ZIP helper and owned install-directory mutations',async()=>{
 const ps=await fs.readFile(windowsURL,'utf8');
 const start=ps.indexOf('function Invoke-EquinoxLocalInstall');
 const stableOnly=ps.indexOf('if (-not $PrepareMain) {',start);
 const zipPin=ps.indexOf("installer ZIP helper pin is not materialized",start);
 const directoryCreate=ps.indexOf('Assert-NormalDirectory $installRoot $true',start);
 const admission=ps.indexOf('if ($PrepareMain) { Invoke-VerifiedMainPreparation $tempRoot; return }',start);
 assert.ok(start>0&&stableOnly>start&&zipPin>stableOnly);
 assert.ok(ps.indexOf('if (-not $PrepareMain) {',zipPin)<directoryCreate);
 assert.ok(directoryCreate<admission);
 assert.match(ps,/if \(\$PrepareMain\) \{ Invoke-VerifiedMainPreparation \$tempRoot; return \}/u);
});


test('all Node bootstrap/inspector invocations are isolated from user-provided Node loader overrides',async()=>{
 const [mac,windows]=await Promise.all([fs.readFile(macURL,'utf8'),fs.readFile(windowsURL,'utf8')]);
 const macNodeInvokes=mac.split('"$node"').length-1;
 assert.ok(macNodeInvokes>=3);
 assert.match(mac,/signed_fields="\$\(printf.*\/usr\/bin\/env -i HOME=/u);
 assert.match(mac,/\/usr\/bin\/env -i HOME="\$HOME_DIR" PATH="\/usr\/bin:\/bin:\/usr\/sbin:\/sbin" "\$node" "\$inspector"/u);
 assert.match(windows,/function Invoke-PinnedMainNode/u);
 assert.match(windows,/\$blocked = @\('NODE_OPTIONS','NODE_PATH'/u);
 assert.match(windows,/\[Environment\]::SetEnvironmentVariable\(\$name,\$null,'Process'\)/u);
 assert.match(windows,/finally \{\s+foreach \(\$name in \$blocked\)/u);
 assert.match(windows,/Invoke-PinnedMainNode \$node @\(\$source/u);
 assert.match(windows,/Invoke-PinnedMainNode \$node @\(\$inspector/u);
 assert.doesNotMatch(windows,/\$receipt = @\(& \$node/u);
});


test('both OS bootstrap paths preserve the signed pointer for a second independent production-root verification',async()=>{
 const [mac,windows,helper]=await Promise.all([
   fs.readFile(macURL,'utf8'),fs.readFile(windowsURL,'utf8'),fs.readFile(verifierURL,'utf8'),
 ]);
 assert.match(helper,/--pointer-output/u);
 assert.match(helper,/fs\.open\(pointerDestination,'wx',0o600\)/u);
 assert.match(mac,/--pointer-output "\$TEMP_ROOT\/main-signed-pointer\.json"/u);
 assert.match(mac,/--signed-pointer-file "\$TEMP_ROOT\/main-signed-pointer\.json"/u);
 assert.match(windows,/--pointer-output', \(Join-Path \$PrivateTemp 'main-signed-pointer\.json'\)/u);
 assert.match(windows,/--signed-pointer-file', \(Join-Path \$PrivateTemp 'main-signed-pointer\.json'\)/u);
 assert.match(windows,/\$matched\.runtimeContractSha256 -cne \$parsed\.runtimeContractSha256/u);
 assert.match(windows,/\$matched\.artifactSha256 -cne \$parsed\.artifactSha256/u);
});
