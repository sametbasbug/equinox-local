import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('read-only Windows tunnel diagnostics never disclose secrets, profiles, raw logs or argv', () => {
  const source = readFileSync(new URL('../../scripts/diagnostics/inspect-windows-tunnel.ps1', import.meta.url), 'utf8');
  assert.match(source, /Get-NetTCPConnection/u);
  assert.match(source, /Get-Process/u);
  assert.match(source, /LastShellPhase/u);
  assert.match(source, /RuntimeKeyFileExists/u);
  assert.match(source, /RecentGateExitCount/u);
  assert.match(source, /RuntimeKeyAcl = Test-PrivateStateAcl/u);
  assert.match(source, /TunnelProfileAcl = Test-PrivateStateAcl/u);
  assert.match(source, /TunnelClientExeExists/u);
  assert.match(source, /TunnelProfileYamlPresent/u);
  assert.match(source, /-Action verify -Target \$Target -Type \$Type/u);
  assert.doesNotMatch(source, /Get-Content\s+.*(?:transport\.json|runtime-key|tunnel-profile)/iu);
  assert.doesNotMatch(source, /\$line\s*\|\s*(?:Write-|Out-)/iu);
  assert.doesNotMatch(source, /\$line\s*$\{|\bCommandLine\b|Get-ItemProperty.*NativeMessaging/u);
  assert.doesNotMatch(source, /(?:Remove-Item|Set-Item|New-Item|Set-Content|Out-File|Start-Process|Stop-Process|Restart-Service|Invoke-RestMethod|Invoke-WebRequest)/u);
});

test('setup no longer offers redundant Tunnel ID copy and distinguishes reconnect failure', () => {
  const html = readFileSync(new URL('../../src/equinox-control-center.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../../src/equinox-control-center.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /id="copy-setup-tunnel-id"|id="setup-tunnel-copy-value"/u);
  assert.doesNotMatch(js, /\$\("copy-setup-tunnel-id"\)|\$\("setup-tunnel-copy-value"\)/u);
  assert.match(js, /previousServerPid !== nextPid/u);
  assert.match(js, /not through the tunnel/u);
  assert.match(js, /local Control Center did not respond after restart/u);
});


test('actual Windows installer acceptance must exercise real bundled tunnel-client offline init', () => {
  const installer = readFileSync(new URL('./windows-installer-real-package-smoke.ps1', import.meta.url), 'utf8');
  const smoke = readFileSync(new URL('./windows-tunnel-offline-init-smoke.mjs', import.meta.url), 'utf8');
  assert.match(installer, /windows-tunnel-offline-init-smoke\.mjs/u);
  assert.match(smoke, /windowsTunnelInitArguments/u);
  assert.match(smoke, /tunnel-client\.exe/u);
  assert.match(smoke, /tunnel_00000000000000000000000000000000/u);
  assert.doesNotMatch(smoke, /\brun\b.*--profile.*--profile-dir/u);
});
