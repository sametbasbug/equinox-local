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
