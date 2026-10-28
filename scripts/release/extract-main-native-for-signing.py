#!/usr/bin/env python3
"""Protected Main release: bounded native extraction without access to signing key."""
import os
import pathlib
import stat
import sys
import tarfile
import zipfile

MAX_ENTRIES = 20000
MAX_BYTES = 2 * 1024 * 1024 * 1024

def extract(archive, destination, target):
    if target not in ('darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'):
        raise ValueError('unsupported native archive target')
    if not os.path.isabs(archive) or not os.path.isabs(destination):
        raise ValueError('archive and destination must be absolute')
    dest = pathlib.Path(destination)
    if dest.exists() or dest.is_symlink():
        raise ValueError('private extraction destination must not exist')
    dest.mkdir(mode=0o700)
    names = set()
    seen_folds = set()
    entries = []
    total = 0
    def add(raw, isdir, size, mode):
        nonlocal total
        if not isinstance(raw, str) or len(raw) > 500 or '\\' in raw or '\x00' in raw:
            raise ValueError('native archive entry path is unsupported')
        name = raw[:-1] if raw.endswith('/') else raw
        parts = name.split('/')
        if (not parts or parts[0] != 'release' or any(part in ('', '.', '..') for part in parts)
            or name.startswith('/') or ':' in name):
            raise ValueError('native archive must contain relative release/ paths only')
        # Windows and macOS install on optionally case-insensitive filesystems.
        folded = name.casefold()
        if name in names or folded in seen_folds:
            raise ValueError('native archive entry or case-insensitive duplicate')
        names.add(name); seen_folds.add(folded)
        if len(entries) >= MAX_ENTRIES or size < 0 or size > MAX_BYTES - total:
            raise ValueError('native archive exceeds total entry/byte bounds')
        if not isdir:
            total += size
        entries.append((parts, isdir, size, mode))
        return parts
    def path_for(parts):
        result = dest.joinpath(*parts)
        if not result.is_relative_to(dest):
            raise ValueError('native archive escaped extraction root')
        return result
    if target.startswith('win32-'):
        if not zipfile.is_zipfile(archive):
            raise ValueError('Windows native release must be a valid ZIP')
        with zipfile.ZipFile(archive) as opened:
            infos = opened.infolist()
            if not infos or len(infos) > MAX_ENTRIES:
                raise ValueError('ZIP archive entry count invalid')
            for item in infos:
                mode = (item.external_attr >> 16) & 0xffff
                kind = stat.S_IFMT(mode)
                if kind not in (0, stat.S_IFDIR if item.is_dir() else stat.S_IFREG):
                    raise ValueError('ZIP contains unsupported link or special file')
                add(item.filename, item.is_dir(), item.file_size, mode & 0o777 if mode & 0o777 else 0o755 if item.is_dir() else 0o644)
            for parts, isdir, size, mode in entries:
                destfile = path_for(parts)
                if isdir:
                    destfile.mkdir(parents=True, exist_ok=True)
                else:
                    destfile.parent.mkdir(parents=True, exist_ok=True)
                    with opened.open('/'.join(parts)) as src, open(destfile, 'xb') as dst:
                        copy_bounded(src, dst, size)
                    os.chmod(destfile, mode)
    else:
        if not tarfile.is_tarfile(archive):
            raise ValueError('macOS native release must be a valid tar.gz')
        with tarfile.open(archive, 'r:gz') as opened:
            members = opened.getmembers()
            if not members or len(members) > MAX_ENTRIES:
                raise ValueError('tar archive entry count invalid')
            for item in members:
                if not (item.isfile() or item.isdir()):
                    raise ValueError('tar contains links or unsupported special files')
                add(item.name, item.isdir(), item.size if item.isfile() else 0, item.mode & 0o777)
            for (parts, isdir, size, mode), item in zip(entries, members):
                destfile = path_for(parts)
                if isdir:
                    destfile.mkdir(parents=True, exist_ok=True)
                else:
                    destfile.parent.mkdir(parents=True, exist_ok=True)
                    src = opened.extractfile(item)
                    if src is None:
                        raise ValueError('tar release member contents missing')
                    with src, open(destfile, 'xb') as dst:
                        copy_bounded(src, dst, size)
                    os.chmod(destfile, mode)
    # Restore POSIX directory permissions after populating their children:
    # parent directories must remain writable during extraction. File mode
    # is part of the signed native-tree fingerprint, not decorative metadata.
    for parts, isdir, _size, mode in reversed(entries):
        if isdir:
            os.chmod(path_for(parts), mode)
    if not (dest / 'release' / 'release.json').is_file():
        raise ValueError('extracted native release metadata missing')
    print(f'EXTRACTED_NATIVE_RELEASE entries={len(entries)} bytes={total}', flush=True)

def copy_bounded(src, dst, expected):
    total = 0
    while total < expected:
        chunk = src.read(min(1024 * 1024, expected - total))
        if not chunk:
            raise ValueError('native archive entry truncated')
        dst.write(chunk)
        total += len(chunk)
    if src.read(1):
        raise ValueError('native archive member exceeds declared bytes')

if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit('usage: main-snapshot-extract.py archive absolute-output-directory target')
    try:
        extract(sys.argv[1], sys.argv[2], sys.argv[3])
    except Exception as e:
        print(f'Private native archive extraction refused: {e}', file=sys.stderr)
        raise SystemExit(1)
