#!/usr/bin/env python3
"""Extract only the reviewed test-candidate transport. No install or execution.

Both hashes must come from independent workflow inputs. The inner signed bundle
and native app are verified by their dedicated verifiers after this extraction.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import zipfile


def need(condition, message):
    if not condition:
        raise ValueError(message)


def file_hash(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        need(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= maximum, "Expected bounded regular candidate input")
        digest = hashlib.sha256()
        count = 0
        while chunk := stream.read(1024 * 1024):
            count += len(chunk)
            need(count <= maximum, "Candidate input grew beyond limit")
            digest.update(chunk)
        need(count == info.st_size, "Candidate input size changed")
        return digest.hexdigest()


def extract(receipt, receipt_hash, archive, archive_hash, output):
    need(re.fullmatch(r"[a-f0-9]{64}", receipt_hash) and re.fullmatch(r"[a-f0-9]{64}", archive_hash), "Invalid independent candidate hashes")
    need(file_hash(receipt, 32768) == receipt_hash, "Candidate receipt hash differs")
    value = json.loads(Path(receipt).read_bytes())
    need(value.get("schema") == 1 and value.get("kind") == "agentsdock-macos-candidate"
         and value.get("scope") == "darwin-app-server" and value.get("publicationEligible") is False,
         "Not a non-publishing candidate receipt")
    version = value.get("version", "")
    track = "stable" if version == "1.0.9" else "beta"
    need((version == "1.0.9" or re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.[1-9]\d*", version))
         and value.get("track") == track, "Invalid reviewed candidate version or track")
    desktop = {f"AgentsDock-{version}-mac-universal.zip", f"AgentsDock-{version}-mac-universal.zip.blockmap",
               f"AgentsDock-{version}-mac-universal.dmg", f"{'beta' if track == 'beta' else 'latest'}-mac.yml", "agents-server-npm-manifest.json",
               "agents-server-npm-manifest.sig", "SHA256SUMS"}
    need(set(value.get("desktopAssets", {})) == desktop, "Unexpected desktop inventory")
    allowed = {f"desktop/{name}" for name in desktop} | {
        "server/product-server-bundle.json", "server/npm/agents-server-npm-manifest.json",
        "server/npm/agents-server-npm-manifest.sig", f"server/npm/server-{version}.tgz",
        "server/legacy/agents-server-manifest.json", "server/legacy/agents-server-manifest.sig",
        f"server/legacy/agents-server-{version}.tar.gz", "server-import.json", "signer-artifact.zip"}
    directories = {"desktop/", "server/", "server/npm/", "server/legacy/"}
    need(file_hash(archive, 4 * 1024**3) == archive_hash, "Candidate transport hash differs")
    output = Path(output).absolute()
    need(output == output.resolve() and output.parent.is_dir() and not output.exists(), "Extraction requires a new non-symlink directory")
    with zipfile.ZipFile(archive) as zipped:
        members = {}
        seen = set()
        total = 0
        for entry in zipped.infolist():
            need(entry.filename not in seen, "Duplicate candidate archive member")
            seen.add(entry.filename)
            mode = stat.S_IFMT(entry.external_attr >> 16)
            need(not entry.flag_bits & 1, "Encrypted candidate archive is unsupported")
            if entry.is_dir():
                need(entry.filename in directories and mode in {0, stat.S_IFDIR} and entry.file_size == 0, "Unsafe archive directory")
                continue
            need(entry.filename in allowed and mode in {0, stat.S_IFREG}, "Unexpected or non-regular candidate archive member")
            need(0 < entry.file_size < 2 * 1024**3, "Candidate archive member exceeds size bound")
            total += entry.file_size
            need(total <= 4 * 1024**3, "Candidate archive exceeds expanded size bound")
            members[entry.filename] = entry
        need(set(members) == allowed, "Candidate archive inventory is incomplete")
        output.mkdir(mode=0o700)
        for name, entry in members.items():
            target = output / name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with zipped.open(entry) as source, target.open("xb") as destination:
                shutil.copyfileobj(source, destination, 1024 * 1024)
            target.chmod(0o600)
            need(target.stat().st_size == entry.file_size, "Expanded candidate member size differs")
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ("receipt", "receipt_hash", "archive", "archive_hash", "output"):
        parser.add_argument(argument)
    args = parser.parse_args()
    extract(args.receipt, args.receipt_hash, args.archive, args.archive_hash, args.output)
    print("Candidate transport extracted; signatures and native contents still require verification.")
