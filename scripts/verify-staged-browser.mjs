import assert from 'node:assert/strict';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
// Validate the migrated worker without touching the Chrome-loaded classic JS.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(path.join(os.tmpdir(), 'equinox-staged-worker-'));
const shippingWorkerPath = path.join(root, 'extension', 'service-worker.js');
const shippingWorkerBefore = readFileSync(shippingWorkerPath);
function run(args, env = process.env) {
    const result = spawnSync(process.execPath, args, {
        cwd: root, env, stdio: 'inherit', timeout: 180_000,
    });
    if (result.error || result.status !== 0) {
        throw new Error(`Staged Browser gate failed (${result.status}): ${result.error?.message ?? args.join(' ')}`);
    }
}
try {
    run([
        path.join(root, 'node_modules/typescript/lib/tsc.js'),
        '--project', path.join(root, 'tsconfig.worker-migration.json'),
        '--rootDir', path.join(root, 'migration/browser'),
        '--outDir', scratch, '--noEmit', 'false', '--pretty', 'false',
    ]);
    assert.deepEqual(readdirSync(scratch), ['service-worker.js']);
    // Rehearse only the already-declared Chrome Web Store file allowlist in
    // scratch; never edit a real Chrome profile or extension installation.
    const packageScript = readFileSync(path.join(root, 'scripts/package-browser-extension.sh'), 'utf8');
    const marker = `cat > "$TMP_LIST" <<'FILES'\n`;
    const start = packageScript.indexOf(marker);
    const end = packageScript.indexOf('\nFILES', start + marker.length);
    assert.ok(start >= 0 && end > start, 'Missing real Browser packaging allowlist');
    const allowed = packageScript.slice(start + marker.length, end).split('\n');
    assert.equal(new Set(allowed).size, allowed.length, 'Duplicate Browser package file');
    assert.ok(allowed.includes('service-worker.js'), 'Missing staged Browser worker in package list');
    const unpacked = path.join(scratch, 'unpacked');
    mkdirSync(unpacked);
    for (const file of allowed) {
        assert.match(file, /^[a-z0-9][a-z0-9/.-]*$/u, 'Unsafe Browser package path');
        assert.equal(file.includes('..'), false, 'Browser package path escapes its root');
        const source = file === 'service-worker.js'
            ? path.join(scratch, file) : path.join(root, 'extension', file);
        const meta = lstatSync(source);
        assert.ok(meta.isFile() && !meta.isSymbolicLink(), `Unsafe Browser package input: ${file}`);
        mkdirSync(path.dirname(path.join(unpacked, file)), { recursive: true });
        copyFileSync(source, path.join(unpacked, file));
    }
    const manifest = JSON.parse(readFileSync(path.join(unpacked, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background?.service_worker, 'service-worker.js');
    assert.equal(Object.hasOwn(manifest.background, 'type'), false, 'Worker must remain classic-script MV3');
    const referenced = [manifest.background.service_worker, manifest.action?.default_popup,
        ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}),
        ...(manifest.content_scripts || []).flatMap((script) => script.js || [])];
    for (const file of referenced)
        assert.ok(typeof file === "string" && allowed.includes(file), `MV3 asset is not packaged: ${file}`);
    const popup = readFileSync(path.join(unpacked, 'popup.html'), 'utf8');
    assert.match(popup, /<script src="popup\.js"><\/script>/u);
    assert.match(popup, /<link rel="stylesheet" href="popup\.css">/u);
    for (const file of ['service-worker.js', 'bookmarks.js', 'chatgpt-continuation-state.js', 'popup.js']) {
        new Script(readFileSync(path.join(unpacked, file), 'utf8'), { filename: file });
    }
    const worker = readFileSync(path.join(unpacked, 'service-worker.js'), 'utf8');
    assert.ok(worker.split("\n").slice(0, 12).includes('importScripts("bookmarks.js");'), "Staged worker must load its packaged classic bookmark dependency before running");
    assert.deepEqual(readdirSync(unpacked).sort(), ['bookmarks.js', 'chatgpt-continuation-state.js',
        'icons', 'manifest.json', 'popup.css', 'popup.html', 'popup.js', 'service-worker.js']);
    console.log(`Staged MV3 package preflight passed (${allowed.length} files); no Chrome profile was opened.`);
    run([
        '--test',
        ...['service-worker-frame', 'service-worker-tabs', 'service-worker-lifecycle', 'service-worker-auto-continue', 'chatgpt-web-dom-contract', 'manifest']
            .map((name) => path.join(root, 'tests/browser', `${name}.test.js`)),
    ], { ...process.env, EQUINOX_STAGED_BROWSER_WORKER: path.join(scratch, 'service-worker.js') });
    assert.deepEqual(readFileSync(shippingWorkerPath), shippingWorkerBefore, 'Staged TS7 Browser validation must never rewrite the shipping classic worker');
    console.log('Staged TS7 Browser passed VM, ChatGPT DOM and manifest tests; shipping worker byte-exact unchanged.');
}
finally {
    rmSync(scratch, { recursive: true, force: true });
}
