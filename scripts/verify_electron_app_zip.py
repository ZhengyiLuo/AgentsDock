#!/usr/bin/env python3
"""Validate an Electron ZIP before native extraction; never extract or execute it."""
import json
import os
from pathlib import Path
import stat
import sys
import unicodedata
import zipfile

MAX_ARCHIVE = 2 * 1024 ** 3
MAX_EXPANDED = 4 * 1024 ** 3
MAX_MEMBERS = 100000
APP = "AgentsDock.app"


def need(condition, message):
    if not condition:
        raise ValueError(message)


def folded(parts):
    return tuple(unicodedata.normalize("NFD", part).casefold() for part in parts)


def text_safe(value):
    return value and "\\" not in value and not any(ord(char) < 32 or ord(char) == 127 for char in value)


def verify(filename):
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as stream:
        before = os.fstat(stream.fileno())
        need(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= MAX_ARCHIVE,
             "App ZIP must be a bounded regular file")
        with zipfile.ZipFile(stream) as archive:
            entries = archive.infolist()
            need(0 < len(entries) <= MAX_MEMBERS, "App ZIP has an invalid member count")
            nodes, explicit, links = {}, {}, {}
            expanded = 0
            for entry in entries:
                name = entry.filename[:-1] if entry.is_dir() else entry.filename
                parts = tuple(name.split("/"))
                need(text_safe(name) and parts[0] == APP and all(part not in {"", ".", ".."} for part in parts),
                     "App ZIP contains an unsafe or unexpected path")
                need(entry.orig_filename == entry.filename, "App ZIP contains a truncated path")
                mode = entry.external_attr >> 16
                kind = stat.S_IFMT(mode)
                need(not entry.flag_bits & 1 and entry.compress_type in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED},
                     "App ZIP contains encrypted or unsupported entries")
                need(not mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX), "App ZIP contains privileged permissions")
                if entry.is_dir():
                    need(kind in {0, stat.S_IFDIR} and entry.file_size == 0, "App ZIP contains an invalid directory")
                    node_kind = "directory"
                else:
                    need(kind in {0, stat.S_IFREG, stat.S_IFLNK} and len(parts) > 1,
                         "App ZIP contains a special file or non-directory app root")
                    node_kind = "link" if kind == stat.S_IFLNK else "file"
                key = folded(parts)
                need(key not in explicit, "App ZIP contains duplicate or case-aliased paths")
                explicit[key] = node_kind
                for index in range(1, len(parts) + 1):
                    prefix = parts[:index]
                    prefix_key = folded(prefix)
                    need(prefix_key not in nodes or nodes[prefix_key] == prefix,
                         "App ZIP contains case- or Unicode-aliased paths")
                    nodes[prefix_key] = prefix
                expanded += entry.file_size
                need(0 <= entry.file_size <= MAX_EXPANDED and expanded <= MAX_EXPANDED,
                     "App ZIP exceeds the expanded size limit")
                if node_kind == "link":
                    need(0 < entry.file_size <= 4096, "App ZIP contains an oversized symlink")
                    target = archive.read(entry).decode("utf-8")
                    need(text_safe(target) and not target.startswith("/"), "App ZIP symlink target is unsafe")
                    links[key] = target.split("/")
                else:
                    # Opening verifies that the local-header path matches the
                    # central directory examined above. Read bounded chunks to
                    # validate expansion and CRC before handing bytes to ditto.
                    count = 0
                    with archive.open(entry) as member:
                        while chunk := member.read(1024 * 1024):
                            count += len(chunk)
                            need(count <= entry.file_size, "App ZIP member exceeds its declared size")
                    need(count == entry.file_size, "App ZIP member is truncated")
            for key in explicit:
                for index in range(1, len(key)):
                    need(explicit.get(key[:index], "directory") == "directory",
                         "App ZIP writes through a symlink or non-directory ancestor")

            def resolve_link(key):
                current = list(nodes[key][:-1])
                pending = list(links[key])
                traversed = {key}
                while pending:
                    part = pending.pop(0)
                    if part in {"", "."}:
                        continue
                    if part == "..":
                        need(len(current) > 1, "App ZIP symlink escapes the app root")
                        current.pop()
                        continue
                    current.append(part)
                    current_key = folded(current)
                    if current_key in links:
                        need(current_key not in traversed and len(traversed) < 40,
                             "App ZIP contains cyclic or excessive symlink indirection")
                        traversed.add(current_key)
                        pending = links[current_key] + pending
                        current.pop()
                    elif pending:
                        need(explicit.get(current_key, "directory") == "directory",
                             "App ZIP symlink traverses a non-directory")
                need(folded(current) in nodes and current[0] == APP,
                     "App ZIP symlink target is missing or outside the app")

            for key in links:
                resolve_link(key)
        after = os.fstat(stream.fileno())
        need((before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
             (after.st_size, after.st_mtime_ns, after.st_ctime_ns), "App ZIP changed during validation")
    return {"safeAppZip": True, "members": len(entries), "symlinks": len(links), "expandedBytes": expanded}


if __name__ == "__main__":
    try:
        need(len(sys.argv) == 2, "Usage: verify_electron_app_zip.py APP_ZIP")
        print(json.dumps(verify(Path(sys.argv[1]))))
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile, UnicodeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
