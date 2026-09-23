#!/usr/bin/env python3
"""Compare signed server archives without extracting or executing their contents."""
import gzip
import hashlib
import io
import json
import sys
import tarfile
from pathlib import Path

MAX_EXPANDED = 512 * 1024 * 1024
MAX_MEMBERS = 10000
NPM_WRAPPERS = {'package.json', 'README.md', 'LICENSE', 'NOTICE', 'npm/cli.cjs'}
REQUIRED_RUNTIME = {'VERSION', 'agent_server.py', 'update_runner.py', 'install.sh', 'release-public-key.pem'}

class BoundedReader(io.RawIOBase):
    def __init__(self, source):
        self.source = source
        self.count = 0
    def read(self, size=-1):
        size = min(size if size >= 0 else MAX_EXPANDED + 1, MAX_EXPANDED - self.count + 1)
        data = self.source.read(size)
        self.count += len(data)
        if self.count > MAX_EXPANDED:
            raise ValueError('Server archive exceeds expanded size limit')
        return data


def inventory(filename, version, npm=False):
    root = 'package' if npm else f'agents-server-{version}'
    runtime, seen, wrappers, captures = {}, set(), set(), {}
    with gzip.open(filename, 'rb') as compressed:
        bounded = BoundedReader(compressed)
        with tarfile.open(fileobj=bounded, mode='r|') as archive:
            for count, member in enumerate(archive):
                if count >= MAX_MEMBERS:
                    raise ValueError('Too many server archive members')
                name = member.name.rstrip('/') if member.isdir() else member.name
                parts = name.split('/')
                if '\\' in name or any(part in {'', '.', '..'} for part in parts) or parts[0] != root or name in seen:
                    raise ValueError('Unsafe or duplicate server archive member')
                seen.add(name)
                relative = '/'.join(parts[1:])
                if not member.isdir() and not member.isfile():
                    raise ValueError('Server archive contains linked or special entries')
                if member.isdir():
                    if npm and relative and relative != 'server' and relative != 'npm' and not relative.startswith('server/'):
                        raise ValueError('Unexpected npm directory')
                    continue
                if not relative:
                    raise ValueError('Server archive root is not a directory')
                if npm and not relative.startswith('server/'):
                    if relative not in NPM_WRAPPERS:
                        raise ValueError('Unexpected npm wrapper file')
                    wrappers.add(relative)
                    continue
                runtime_name = relative.removeprefix('server/') if npm else relative
                if member.size < 0 or member.size > MAX_EXPANDED:
                    raise ValueError('Server runtime member exceeds size limit')
                source = archive.extractfile(member)
                digest, length, captured = hashlib.sha256(), 0, bytearray()
                while data := source.read(1024 * 1024):
                    length += len(data)
                    digest.update(data)
                    if runtime_name == 'VERSION':
                        if length > 128: raise ValueError('Server VERSION exceeds size limit')
                        captured.extend(data)
                if length != member.size:
                    raise ValueError('Server runtime member is truncated')
                runtime[runtime_name] = (length, digest.hexdigest(), member.mode & 0o111)
                if runtime_name == 'VERSION': captures[runtime_name] = bytes(captured)
    if not REQUIRED_RUNTIME <= set(runtime) or captures.get('VERSION', b'').decode().strip() != version:
        raise ValueError('Server runtime identity or required files are missing')
    if npm and wrappers != NPM_WRAPPERS:
        raise ValueError('Npm wrapper file set is incomplete')
    return runtime


def compare(npm_archive, legacy_archive, version):
    npm = inventory(npm_archive, version, npm=True)
    legacy = inventory(legacy_archive, version)
    if npm != legacy:
        missing = sorted(set(npm) - set(legacy))
        extra = sorted(set(legacy) - set(npm))
        changed = sorted(name for name in npm.keys() & legacy.keys() if npm[name] != legacy[name])
        raise ValueError(f'Standalone bridge runtime differs from signed npm payload (missing={missing}, extra={extra}, changed={changed})')
    return {'runtime_files': len(npm), 'version': version, 'identical': True}

if __name__ == '__main__':
    try:
        if len(sys.argv) != 4: raise ValueError('Usage: verify_server_runtime_parity.py NPM_ARCHIVE LEGACY_ARCHIVE VERSION')
        print(json.dumps(compare(*sys.argv[1:])))
    except (OSError, ValueError, tarfile.TarError, EOFError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
