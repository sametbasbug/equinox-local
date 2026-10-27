import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { releaseAssetOriginForPath } from '../src/index.js';

const root = path.resolve('dist');
const required = [
  'index.html',
  'privacy/index.html',
  'security/index.html',
  'install/index.html',
  'reviewer/index.html',
  'reviewer/test/index.html',
  'reviewer/test/success/index.html',
  'contact/index.html',
  'tr/index.html',
  'tr/install/index.html',
  'tr/security/index.html',
  'tr/privacy/index.html',
  'tr/contact/index.html',
  'browser/index.html',
  'tr/browser/index.html',
  'downloads/equinox-local-reviewer-0.5.2.zip',
  '404.html',
  'assets/styles.css',
  'assets/equinox-browser.png',
  'robots.txt',
  'sitemap.xml',
];
for (const file of required) await fs.access(path.join(root, file));

const htmlFiles = required.filter((file) => file.endsWith('.html'));
for (const file of htmlFiles) {
  const text = await fs.readFile(path.join(root, file), 'utf8');
  if (!text.includes('https://local.sametbasbug.dev')) throw new Error(`${file}: canonical/local URL missing`);
  if (/https:\/\/(fonts|www\.google-analytics|googletagmanager|cdn\.jsdelivr|unpkg)\./u.test(text)) {
    throw new Error(`${file}: forbidden third-party runtime dependency`);
  }
  if (/<script\b/iu.test(text)) throw new Error(`${file}: production pages must remain JavaScript-free`);
}

const privacy = await fs.readFile(path.join(root, 'privacy/index.html'), 'utf8');
for (const phrase of ['Chrome Web Store User Data Policy', 'Limited Use', 'AI service']) {
  if (!privacy.includes(phrase)) throw new Error(`privacy policy missing: ${phrase}`);
}

const reviewer = await fs.readFile(path.join(root, 'reviewer/index.html'), 'utf8');
for (const phrase of [
  'equinox-local-reviewer-0.5.2.zip',
  '19e2585d413fa65b95f479f5137ce56c6fc6fd54a89e087cff937e174ec8a605',
  'No OpenAI or other AI-provider account',
]) {
  if (!reviewer.includes(phrase)) throw new Error(`reviewer guide missing: ${phrase}`);
}

const reviewerTest = await fs.readFile(path.join(root, 'reviewer/test/index.html'), 'utf8');
const reviewerSuccess = await fs.readFile(path.join(root, 'reviewer/test/success/index.html'), 'utf8');
if (!reviewerTest.includes('Continue reviewer test')) throw new Error('reviewer test target missing');
if (!reviewerSuccess.includes('Reviewer click passed')) throw new Error('reviewer success marker missing');
if (/<script\b/iu.test(reviewerTest) || /<script\b/iu.test(reviewerSuccess)) {
  throw new Error('reviewer test pages must remain JavaScript-free');
}

const brandIcon = await fs.readFile(path.join(root, 'assets/equinox-browser.png'));
const brandIconHash = crypto.createHash('sha256').update(brandIcon).digest('hex');
if (brandIconHash !== 'db9a756ac1a47adf1757a717464bd4875ec1eb40584a75614631f00273464137') {
  throw new Error(`brand icon drifted from Equinox Browser icon-128.png: ${brandIconHash}`);
}

const reviewerZip = await fs.readFile(path.join(root, 'downloads/equinox-local-reviewer-0.5.2.zip'));
const reviewerZipHash = crypto.createHash('sha256').update(reviewerZip).digest('hex');
if (reviewerZip.length !== 19514) throw new Error(`reviewer ZIP size mismatch: ${reviewerZip.length}`);
if (reviewerZipHash !== '19e2585d413fa65b95f479f5137ce56c6fc6fd54a89e087cff937e174ec8a605') {
  throw new Error(`reviewer ZIP hash mismatch: ${reviewerZipHash}`);
}

const validReleaseAssets = new Map([
  ['/downloads/updates/equinox-local-4.2.1-darwin-arm64.tar.gz', 'https://github.com/sametbasbug/equinox-local/releases/download/v4.2.1/equinox-local-4.2.1-darwin-arm64.tar.gz'],
  ['/downloads/updates/equinox-local-5.0.0-darwin-x64.tar.gz', 'https://github.com/sametbasbug/equinox-local/releases/download/v5.0.0/equinox-local-5.0.0-darwin-x64.tar.gz'],
  ['/downloads/updates/equinox-local-5.2.1-win32-x64.zip', 'https://github.com/sametbasbug/equinox-local/releases/download/v5.2.1/equinox-local-5.2.1-win32-x64.zip'],
  ['/downloads/updates/equinox-local-5.2.1-win32-arm64.zip', 'https://github.com/sametbasbug/equinox-local/releases/download/v5.2.1/equinox-local-5.2.1-win32-arm64.zip'],
]);
for (const [pathname, expected] of validReleaseAssets) {
  if (releaseAssetOriginForPath(pathname) !== expected) throw new Error(`release asset proxy mismatch: ${pathname}`);
}
for (const invalid of [
  '/downloads/updates/equinox-local-4.2-darwin-arm64.tar.gz',
  '/downloads/updates/equinox-local-4.2.1-darwin-amd64.tar.gz',
  '/downloads/updates/equinox-local-4.2.1-darwin-arm64.zip',
  '/downloads/updates/equinox-local-5.2.1-win32-x64.tar.gz',
  '/downloads/updates/equinox-local-5.2.1-win32-amd64.zip',
  '/downloads/updates/equinox-local-v4.2.1-darwin-arm64.tar.gz',
]) {
  if (releaseAssetOriginForPath(invalid) !== null) throw new Error(`unsafe release proxy path accepted: ${invalid}`);
}

const englishHome = await fs.readFile(path.join(root, 'index.html'), 'utf8');
const englishInstall = await fs.readFile(path.join(root, 'install/index.html'), 'utf8');
const turkishHome = await fs.readFile(path.join(root, 'tr/index.html'), 'utf8');
const turkishInstall = await fs.readFile(path.join(root, 'tr/install/index.html'), 'utf8');
for (const [label, html, phrases] of [
  ['English home', englishHome, ['macOS + Windows', 'Desktop automation is currently macOS-only', 'Your ChatGPT agent’s tools. On your computer.', 'Private to this computer']],
  ['Turkish home', turkishHome, ['macOS + Windows', 'Desktop otomasyonu şu anda yalnızca macOS’tadır', 'ChatGPT ajanınızın araçları. Bilgisayarınızda.', 'Bu bilgisayara özel']],
  ['English install', englishInstall, ['WINDOWS POWERSHELL', 'install-equinox-local.ps1', 'x64 + ARM64']],
  ['Turkish install', turkishInstall, ['WINDOWS POWERSHELL', 'install-equinox-local.ps1', 'x64 + ARM64']],
]) {
  for (const phrase of phrases) if (!html.includes(phrase)) throw new Error(`${label} missing Windows platform copy: ${phrase}`);
}
for (const stale of ['From web to Mac.', 'On your Mac.', 'Private to this Mac', 'EQUINOX LOCAL / macOS</span>', 'Your macOS user']) {
  if (englishHome.includes(stale)) throw new Error(`English home still contains stale Mac-only product copy: ${stale}`);
}
const macInstallerSource = 'https://github.com/sametbasbug/equinox-local/blob/main/scripts/install-equinox-local.sh';
const windowsInstallerSource = 'https://github.com/sametbasbug/equinox-local/blob/main/scripts/install-equinox-local.ps1';
for (const [label, html] of [['English install', englishInstall], ['Turkish install', turkishInstall]]) {
  if (!html.includes(`href=\"${macInstallerSource}\"`)) throw new Error(`${label} macOS inspect link must open the public installer source`);
  if (!html.includes(`href=\"${windowsInstallerSource}\"`)) throw new Error(`${label} Windows inspect link must open the public installer source`);
  if (html.includes('href=\"/downloads/updates/install-equinox-local.sh\"')) throw new Error(`${label} macOS inspect link must not trigger a direct installer download`);
}

const releaseVersions = [
  /Equinox Local (\d+\.\d+\.\d+) is live/u.exec(englishHome)?.[1],
  /Equinox Local (\d+\.\d+\.\d+)<\/span>/u.exec(englishInstall)?.[1],
  /Equinox Local (\d+\.\d+\.\d+) yayında/u.exec(turkishHome)?.[1],
  /Equinox Local (\d+\.\d+\.\d+)<\/span>/u.exec(turkishInstall)?.[1],
];
if (releaseVersions.some((value) => !value) || new Set(releaseVersions).size !== 1) {
  throw new Error(`public release copy is inconsistent: ${releaseVersions.join(', ')}`);
}

const release = JSON.parse(await fs.readFile('src/data/release.json', 'utf8'));
const updateRoot = path.join(root, 'downloads/updates');
const windowsInstallerPresent = await fs.access(path.join(updateRoot, 'install-equinox-local.ps1')).then(() => true, () => false);
const stableTargets = windowsInstallerPresent ? ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64'] : ['darwin-arm64', 'darwin-x64'];
for (const target of stableTargets) {
  const manifest = JSON.parse(await fs.readFile(path.join(updateRoot, `stable-${target}.json`), 'utf8'));
  if (manifest.version !== release.version || releaseVersions[0] !== release.version) throw new Error(`release copy and ${target} stable channel disagree`);
}

// Check the built result, including localization and fragment links, not just source templates.
for (const file of htmlFiles) {
  const html = await fs.readFile(path.join(root, file), 'utf8');
  const currentUrl = new URL(file.endsWith('index.html') ? file.slice(0, -10) : file, 'https://local.sametbasbug.dev/');
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/gu)) {
    const url = new URL(match[1].replaceAll('&amp;', '&'), currentUrl);
    if (url.origin !== currentUrl.origin) continue;
    const pathname = decodeURIComponent(url.pathname);
    const asset = path.join(root, pathname.endsWith('/') ? pathname + 'index.html' : pathname);
    await fs.access(asset).catch(() => { throw new Error(`${file}: missing local target ${match[1]}`); });
    if (url.hash && asset.endsWith('.html')) {
      const targetHtml = await fs.readFile(asset, 'utf8');
      const id = decodeURIComponent(url.hash.slice(1));
      if (!targetHtml.includes(`id="${id}"`)) throw new Error(`${file}: missing fragment ${match[1]}`);
    }
  }
}

// Pass-through downloads and Store review documents must be byte-for-byte unchanged by Astro.
async function assertCopied(relative) {
  const source = path.join('site', relative);
  const stat = await fs.stat(source);
  if (stat.isDirectory()) {
    for (const child of await fs.readdir(source)) await assertCopied(path.join(relative, child));
  } else {
    const before = await fs.readFile(source);
    const after = await fs.readFile(path.join(root, relative));
    if (!before.equals(after)) throw new Error(`pass-through asset changed: ${relative}`);
  }
}
await assertCopied('downloads');
await assertCopied('reviewer');

console.log('Site integrity checks passed.');
