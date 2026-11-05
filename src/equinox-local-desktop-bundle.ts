// Bundle-only policy. Generic signed-release/native-store readers must still reject links.
import { constants, createReadStream, type Stats } from 'node:fs';
import { lstat, realpath, readdir, readlink, mkdir, mkdtemp, open, rm, rename, link, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { create, list, extract, Header, type ReadEntry } from 'tar';

const ROOT = 'Equinox Local.app';
const COMPRESSED = 256 * 1024 * 1024;
const EXPANDED = 1024 * 1024 * 1024;
const ENTRIES = 20000;
const ENTRY_BYTES = 512 * 1024 * 1024;
const PATH_BYTES = 4096;
const META_BYTES = 64 * 1024;
type Identity = { sha256: string; bytes: number };
type Entry = { type: 'File' | 'Directory' | 'SymbolicLink'; size: number; mode: number; link: string };
type Tree = Map<string, Entry>;
function fail(message: string): never { throw new Error(`Desktop bundle: ${message}`); }

class Limit extends Transform {
  bytes = 0;
  readonly hash = createHash('sha256');
  constructor(readonly maximum: number) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maximum) { done(new Error('Desktop bundle: byte limit exceeded')); return; }
    this.hash.update(chunk);
    done(null, chunk);
  }
}
// Refuse nested compression before tar's automatic compression detection.
class RawTar extends Transform {
  private prefix = Buffer.alloc(0);
  private checked = false;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    if (this.checked) { done(null, chunk); return; }
    this.prefix = Buffer.concat([this.prefix, chunk]);
    if (this.prefix.length < 512) { done(); return; }
    try {
      const header = new Header(this.prefix.subarray(0, 512));
      if (!header.cksumValid || header.nullBlock) fail('expected raw tar after gzip');
      this.checked = true; done(null, this.prefix); this.prefix = Buffer.alloc(0);
    } catch (error) { done(error as Error); }
  }
  override _flush(done: TransformCallback): void {
    done(this.checked ? undefined : new Error('Desktop bundle: truncated tar header'));
  }
}
function platform(): void {
  if (process.platform !== 'darwin' || !process.getuid) fail('macOS only');
}
function literal(value: string): void {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\x00-\x1f\x7f\\]/u.test(value)) fail('noncanonical absolute location');
}
type Namespace = Array<{ location: string; stat: Stats }>;
const runFile = promisify(execFile);
// POSIX mode checks alone do not account for macOS ACL grants. Deny-only
// ACLs (including the usual home-directory delete denial) cannot grant access.
async function noAclGrants(location: string): Promise<void> {
  const { stdout } = await runFile('/bin/ls', ['-lde', location], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024, env: { ...process.env, LC_ALL: 'C' } });
  const lines = stdout.trimEnd().split('\n');
  if (!/^d[rwxstST-]{9}[+@ ]/u.test(lines[0] ?? '')) fail('unrecognized directory ACL listing');
  const hasAcl = /^\S*\+/u.test(lines[0] ?? '');
  if (hasAcl && lines.length === 1) fail('unreadable directory ACL');
  for (const line of lines.slice(1)) {
    if (!/^\s*\d+: (?:user|group):\S+ deny [a-z_,]+$/u.test(line)) fail('directory ACL grants or unrecognized ACL');
  }
}
async function namespace(value: string): Promise<Namespace> {
  literal(value);
  if (Buffer.byteLength(value) > PATH_BYTES || value.split('/').length > 128) fail('ancestor namespace limit');
  const locations = [path.parse(value).root];
  for (const component of value.slice(1).split('/').filter(Boolean)) locations.push(path.join(locations[locations.length - 1]!, component));
  const result: Namespace = [];
  for (const location of locations) {
    const stat = await lstat(location);
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== process.getuid!())) fail('untrusted ancestor ownership/type');
    // In a sticky directory only the trusted directory/child owners (or root)
    // can replace the next component. Every child is independently trusted.
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) fail('replaceable ancestor namespace');
    await noAclGrants(location);
    const after = await lstat(location);
    if (!same(stat, after) || stat.mode !== after.mode) fail('ancestor changed during validation');
    result.push({ location, stat });
  }
  if (await realpath(value) !== value) fail('noncanonical ancestor namespace');
  return result;
}
async function recheckNamespace(expected: Namespace): Promise<void> {
  const current = await namespace(expected[expected.length - 1]!.location);
  if (current.length !== expected.length || current.some((item, index) => !same(item.stat, expected[index]!.stat) || item.stat.mode !== expected[index]!.stat.mode)) fail('ancestor namespace changed');
}
async function owned(value: string, directory: boolean): Promise<Stats> {
  await namespace(path.dirname(value));
  literal(value);
  const stat = await lstat(value);
  if (stat.uid !== process.getuid!() || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || await realpath(value) !== value) fail('input must be canonical, normal and owned');
  if ((stat.mode & 0o7022) !== 0 || (!directory && stat.nlink !== 1)) fail('unsafe input mode or hardlink');
  if (directory) await noAclGrants(value);
  return stat;
}
async function fresh(value: string): Promise<void> {
  literal(value);
  if (value === path.parse(value).root) fail('invalid output');
  await owned(path.dirname(value), true);
  try { await lstat(value); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  fail('output already exists');
}
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid; }
async function removeOwned(value: string, stat: Stats, recursive: boolean): Promise<void> {
  const parents = await namespace(path.dirname(value));
  const current = await lstat(value);
  if (!same(stat, current) || current.uid !== process.getuid!() || current.isSymbolicLink() || current.isDirectory() !== stat.isDirectory() || (current.mode & 0o7022) !== 0) fail('cleanup ownership changed');
  if (current.isDirectory()) await noAclGrants(value);
  await recheckNamespace(parents);
  if (!same(current, await lstat(value))) fail('cleanup inode changed');
  await rm(value, { recursive });
}
function entryPath(value: string, directory: boolean): string {
  const p = directory && value.endsWith('/') ? value.slice(0, -1) : value;
  if (!p || Buffer.byteLength(p) > PATH_BYTES || /[\x00-\x1f\x7f\\:]/u.test(p) || p.normalize('NFC') !== p || p.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/u.test(s)) || p.split('/').length > 64 || (p !== ROOT && !p.startsWith(`${ROOT}/`))) fail('invalid entry path');
  return p;
}
function add(tree: Tree, folds: Set<string>, name: string, entry: Entry): void {
  const p = entryPath(name, entry.type === 'Directory');
  const fold = p.normalize('NFD').toLowerCase();
  if (tree.size >= ENTRIES || tree.has(p) || folds.has(fold)) fail('duplicate/casefold collision or entry limit');
  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > ENTRY_BYTES || (entry.type !== 'File' && entry.size !== 0) || !Number.isInteger(entry.mode) || (entry.mode & ~0o777) !== 0) fail('invalid entry size/mode');
  if (entry.type !== 'SymbolicLink' && ((entry.mode & 0o022) !== 0 || (entry.type === 'Directory' ? (entry.mode & 0o700) !== 0o700 : (entry.mode & 0o400) === 0))) fail('unsafe archive permissions');
  if (entry.type === 'SymbolicLink') {
    if (!entry.link || Buffer.byteLength(entry.link) > PATH_BYTES || entry.link.startsWith('/') || /[\x00-\x1f\x7f\\:]/u.test(entry.link) || entry.link.normalize('NFC') !== entry.link || entry.link.split('/').some(s => !s || s === '.' || /[. ]$/u.test(s) && s !== '..')) fail('invalid relative link');
  } else if (entry.link) fail('unexpected link target');
  tree.set(p, entry); folds.add(fold);
}
function validate(tree: Tree): void {
  if (tree.get(ROOT)?.type !== 'Directory') fail('missing fixed root');
  for (const p of tree.keys()) {
    for (let parent = path.posix.dirname(p); parent !== '.'; parent = path.posix.dirname(parent)) {
      if (tree.get(parent)?.type !== 'Directory') fail('missing directory or non-directory physical ancestor');
    }
  }
  // Resolve component by component: lexical normalization before link expansion is unsafe.
  const resolveLink = (p: string): string => {
    let pending = p.split('/');
    const resolved: string[] = [];
    let hops = 0;
    while (pending.length) {
      const part = pending.shift()!;
      if (part === '..') { if (resolved.length <= 1) fail('link escapes bundle'); resolved.pop(); continue; }
      resolved.push(part);
      const key = resolved.join('/');
      const e = tree.get(key);
      if (!e) fail('dangling link');
      if (e.type === 'SymbolicLink') {
        if (++hops > 64) fail('link cycle/depth');
        resolved.pop(); pending = [...e.link.split('/'), ...pending];
      } else if (pending.length && e.type !== 'Directory') fail('link traverses file');
    }
    return resolved.join('/');
  };
  const edges = new Map<string, string[]>();
  for (const [p, e] of tree) {
    if (e.type === 'Directory') edges.set(p, []);
  }
  for (const [p, e] of tree) {
    const target = e.type === 'SymbolicLink' ? resolveLink(p) : p;
    if (tree.get(target)?.type === 'Directory' && p !== ROOT) edges.get(path.posix.dirname(p))!.push(target);
  }
  const active = new Set<string>(); const visited = new Set<string>();
  const visit = (p: string): void => {
    if (active.has(p)) fail('directory/link cycle');
    if (visited.has(p)) return;
    active.add(p); for (const child of edges.get(p) ?? []) visit(child);
    active.delete(p); visited.add(p);
  };
  visit(ROOT);
  for (const name of ['Contents/MacOS/applet', 'Contents/Info.plist', 'Contents/Resources/app.asar']) {
    const e = tree.get(`${ROOT}/${name}`);
    if (e?.type !== 'File' || e.size === 0 || (name.startsWith('Contents/MacOS/') && (e.mode & 0o111) === 0)) fail(`missing required physical file ${name}`);
  }
}
async function physical(bundle: string): Promise<Tree> {
  await owned(bundle, true);
  const tree: Tree = new Map(); const folds = new Set<string>(); let total = 0;
  const walk = async (p: string, relative: string): Promise<void> => {
    const s = await lstat(p);
    if (s.uid !== process.getuid!() || (s.mode & (s.isSymbolicLink() ? 0o7000 : 0o7022)) !== 0) fail('unsafe physical ownership/mode');
    const type = s.isSymbolicLink() ? 'SymbolicLink' : s.isDirectory() ? 'Directory' : s.isFile() ? 'File' : fail('unsupported physical type');
    if (type === 'File' && s.nlink !== 1) fail('physical hardlink');
    const e: Entry = { type, size: type === 'File' ? s.size : 0, mode: s.mode & 0o7777, link: type === 'SymbolicLink' ? await readlink(p) : '' };
    // Symlink permission bits are not applied by extraction on macOS.
    if (type === 'SymbolicLink') e.mode = 0o777;
    add(tree, folds, relative, e); total += e.size;
    if (total > EXPANDED) fail('physical size limit');
    if (type === 'Directory') {
      await noAclGrants(p);
      for (const child of (await readdir(p)).sort()) await walk(path.join(p, child), `${relative}/${child}`);
      if (!same(s, await lstat(p))) fail('physical directory changed');
    }
  };
  await walk(bundle, ROOT); validate(tree); return tree;
}
const parserOptions = { strict: true, preservePaths: false, maxMetaEntrySize: META_BYTES, maxDepth: 64 } as const;
function fromRead(e: ReadEntry): Entry {
  if (e.type !== 'File' && e.type !== 'Directory' && e.type !== 'SymbolicLink') fail('unsupported archive entry type');
  return { type: e.type, size: e.size, mode: e.mode ?? -1, link: e.linkpath ?? '' };
}
async function readArchive(archive: string, destination?: string): Promise<Tree> {
  const tree: Tree = new Map(); const folds = new Set<string>();
  const parser = destination === undefined ? list(parserOptions) : extract({ ...parserOptions, cwd: destination, preserveOwner: false, chmod: true, noMtime: true });
  // Event handlers must not throw out of stream callbacks: abort via the parser.
  let records = 0;
  const count = (): void => { if (++records > ENTRIES) parser.abort(new Error('Desktop bundle: metadata/entry count limit')); };
  parser.on('meta', count);
  parser.on('entry', (e: ReadEntry) => {
    count();
    try { add(tree, folds, e.path, fromRead(e)); } catch (error) { parser.abort(error as Error); }
  });
  parser.on('ignoredEntry', () => parser.abort(new Error('Desktop bundle: ignored archive entry')));
  await pipeline(createReadStream(archive), new Limit(COMPRESSED), createGunzip(), new Limit(EXPANDED), new RawTar(), parser);
  validate(tree); return tree;
}
function equalTrees(a: Tree, b: Tree): void {
  if (a.size !== b.size) fail('expanded tree differs');
  for (const [p, e] of a) {
    const other = b.get(p);
    if (!other || e.type !== other.type || e.size !== other.size || e.link !== other.link || (e.type !== 'SymbolicLink' && e.mode !== other.mode)) fail('expanded entry differs');
  }
}
async function privateStage(parent: string): Promise<{ location: string; stat: Stats }> {
  const parents = await namespace(parent);
  const location = await mkdtemp(path.join(parent, '.equinox-bundle-'));
  return captureDirectory(location, parents);
}
async function captureDirectory(location: string, parents: Namespace): Promise<{ location: string; stat: Stats }> {
  // Without an observed owned inode cleanup must not guess what mkdir created.
  const stat = await lstat(location);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o7022) !== 0) fail('created directory ownership changed');
  try {
    await recheckNamespace(parents);
    if (!same(stat, await owned(location, true))) fail('created directory changed');
    return { location, stat };
  } catch (error) {
    try { await removeOwned(location, stat, true); }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Desktop bundle directory cleanup failed'); }
    throw error;
  }
}
async function authenticate(source: string, target: string, identity?: Identity): Promise<Identity> {
  const initial = await owned(source, false);
  if (initial.size <= 0 || initial.size > COMPRESSED) fail('compressed size limit');
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let reader: ReturnType<typeof createReadStream> | undefined;
  try {
    if (!same(initial, await input.stat())) fail('archive input changed');
    const limit = new Limit(COMPRESSED);
    const output = await open(target, 'wx', 0o600);
    let writer: ReturnType<typeof output.createWriteStream> | undefined;
    try {
      reader = input.createReadStream({ autoClose: false });
      writer = output.createWriteStream({ autoClose: false });
      await pipeline(reader, limit, writer);
    } finally { writer?.destroy(); await output.close(); }
    const result = { sha256: limit.hash.digest('hex'), bytes: limit.bytes };
    const final = await input.stat();
    if (final.size !== initial.size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs || result.bytes !== initial.size || identity && (result.bytes !== identity.bytes || result.sha256 !== identity.sha256)) fail('archive identity mismatch');
    return result;
  } finally { reader?.destroy(); await input.close(); }
}

/** Seal a complete owned macOS Electron app as one regular gzip/tar artifact. */
export async function sealDesktopBundle(bundlePath: string, archivePath: string): Promise<Identity> {
  platform(); literal(bundlePath);
  if (path.basename(bundlePath) !== ROOT) fail('incorrect bundle name');
  await fresh(archivePath);
  const archiveParents = await namespace(path.dirname(archivePath));
  const bundleNamespace = await namespace(bundlePath);
  if (archivePath.startsWith(`${bundlePath}/`)) fail('archive inside bundle');
  const before = await physical(bundlePath);
  const stage = await privateStage(path.dirname(archivePath));
  let published: Stats | undefined;
  try {
    const stageNamespace = await namespace(stage.location);
    await recheckNamespace(bundleNamespace);
    const packed = path.join(stage.location, 'bundle.tar.gz');
    const output = await open(packed, 'wx', 0o600);
    let writer: ReturnType<typeof output.createWriteStream> | undefined;
    try {
      writer = output.createWriteStream({ autoClose: false });
      await pipeline(create({ cwd: path.dirname(bundlePath), strict: true, follow: false, noDirRecurse: true, noMtime: true }, [...before.keys()]), new Limit(EXPANDED), createGzip(), new Limit(COMPRESSED), writer);
    } finally { writer?.destroy(); await output.close(); }
    await recheckNamespace(bundleNamespace);
    equalTrees(before, await physical(bundlePath));
    equalTrees(before, await readArchive(packed));
    const result = await authenticate(packed, path.join(stage.location, 'authenticated.tar.gz'));
    // link is an atomic no-replace publication, unlike rename on POSIX.
    const packedStat = await lstat(packed);
    await recheckNamespace(stageNamespace);
    await recheckNamespace(archiveParents);
    await link(packed, archivePath); published = packedStat;
    await recheckNamespace(archiveParents);
    if (!same(packedStat, await lstat(archivePath))) fail('published archive changed');
    await unlink(packed);
    await removeOwned(stage.location, stage.stat, true);
    return result;
  } catch (error) {
    const failures: unknown[] = [error];
    if (published) {
      try { await removeOwned(archivePath, published, false); } catch (cleanup) { failures.push(cleanup); }
    }
    try { await removeOwned(stage.location, stage.stat, true); } catch (cleanup) { failures.push(cleanup); }
    if (failures.length > 1) throw new AggregateError(failures, 'Desktop bundle cleanup failed');
    throw error;
  }
}

/** Authenticate before parsing; destinationRoot must be new and is privately owned. */
export async function extractDesktopBundle(archivePath: string, destinationRoot: string, identity: Identity): Promise<string> {
  platform();
  if (!identity || typeof identity.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(identity.sha256) || !Number.isSafeInteger(identity.bytes) || identity.bytes <= 0 || identity.bytes > COMPRESSED) fail('invalid literal archive identity');
  await owned(archivePath, false); await fresh(destinationRoot);
  const archiveParents = await namespace(path.dirname(archivePath));
  const destinationParents = await namespace(path.dirname(destinationRoot));
  await mkdir(destinationRoot, { mode: 0o700 });
  const { stat: rootStat } = await captureDirectory(destinationRoot, destinationParents);
  try {
    const stage = await privateStage(destinationRoot);
    const stageNamespace = await namespace(stage.location);
    const authenticated = path.join(stage.location, 'authenticated.tar.gz');
    await recheckNamespace(archiveParents);
    await authenticate(archivePath, authenticated, identity);
    await recheckNamespace(archiveParents);
    await recheckNamespace(stageNamespace);
    const expected = await readArchive(authenticated);
    const expanded = path.join(stage.location, 'expanded');
    await mkdir(expanded, { mode: 0o700 });
    equalTrees(expected, await readArchive(authenticated, expanded));
    // Restore authenticated file AND directory modes independently of umask.
    // No pathname chmod: only verified, no-follow owned handles in our stage.
    // Deepest-first also retains access while restoring directory permissions.
    await recheckNamespace(stageNamespace);
    for (const [relative, entry] of [...expected].sort(([a], [b]) => b.split('/').length - a.split('/').length)) {
      if (entry.type === 'SymbolicLink') continue;
      const location = path.join(expanded, relative);
      const initial = await lstat(location);
      const handle = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW | (entry.type === 'Directory' ? constants.O_DIRECTORY : 0));
      try {
        const stat = await handle.stat();
        if (!same(initial, stat) || stat.uid !== process.getuid!() || (entry.type === 'Directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || (stat.mode & 0o7022) !== 0) fail('expanded entry ownership/type changed');
        await handle.chmod(entry.mode);
        const final = await handle.stat();
        if (!same(stat, await lstat(location)) || !same(stat, final) || (entry.type === 'File' && final.nlink !== 1) || (final.mode & 0o7777) !== entry.mode) fail('expanded entry changed during mode restoration');
      } finally { await handle.close(); }
    }
    await recheckNamespace(stageNamespace);
    const bundle = path.join(expanded, ROOT);
    equalTrees(expected, await physical(bundle));
    const result = path.join(destinationRoot, ROOT);
    const expandedNamespace = await namespace(path.dirname(bundle));
    const bundleStat = await owned(bundle, true);
    await recheckNamespace(stageNamespace);
    await recheckNamespace(destinationParents);
    if (!same(rootStat, await lstat(destinationRoot))) fail('destination root changed');
    await recheckNamespace(expandedNamespace);
    await rename(bundle, result);
    await recheckNamespace(stageNamespace);
    if (!same(bundleStat, await lstat(result))) fail('published bundle changed');
    await removeOwned(stage.location, stage.stat, true);
    return result;
  } catch (error) {
    try { await removeOwned(destinationRoot, rootStat, true); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Desktop bundle cleanup failed'); }
    throw error;
  }
}
