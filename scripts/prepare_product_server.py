#!/usr/bin/env python3
"""Prepare both signed server distributions locally from one clean source pin.

This never publishes, contacts a registry, exports Git history, or operates a
service. The output must be a new directory outside the source checkout. Both
distributions are packaged once; a retry must use a new output directory.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile

# Importing the verifier must not create ignored bytecode in the source tree.
sys.dont_write_bytecode = True
from verify_server_runtime_parity import compare

VERSION = re.compile(r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-beta\.([1-9][0-9]*))?$")
KEY_ENV = "AGENTS_SERVER_RELEASE_PRIVATE_KEY_B64"
RECEIPT = "product-server-bundle.json"
ED25519_DER_PREFIX = bytes.fromhex("302a300506032b6570032100")


def environment(source_date_epoch: str | None = None) -> dict[str, str]:
    # Neither npm nor the source packagers receive signing/publication secrets.
    allowed = ("PATH", "HOME", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL")
    result = {key: os.environ[key] for key in allowed if key in os.environ}
    result.update(PYTHONDONTWRITEBYTECODE="1", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT="0")
    if source_date_epoch is not None:
        result["SOURCE_DATE_EPOCH"] = source_date_epoch
    return result


def run(arguments: list[str], *, cwd: Path, label: str, source_date_epoch: str | None = None) -> bytes:
    # Git records executable bits, not ambient owner/group read permissions.
    # A fixed child umask keeps snapshot/legacy modes independent of the caller.
    result = subprocess.run(arguments, cwd=cwd, env=environment(source_date_epoch), umask=0o022, stdin=subprocess.DEVNULL, capture_output=True, check=False)
    if result.returncode:
        # Do not relay subprocess diagnostics that might reveal key material.
        raise ValueError(f"{label} failed")
    return result.stdout


def git(root: Path, *arguments: str) -> str:
    return run(["git", "-C", str(root), *arguments], cwd=root, label=f"git {arguments[0]}").decode().strip()


def validate_source(root: Path, source_sha: str, version: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise ValueError("source SHA must be a full lowercase commit hash")
    if not VERSION.fullmatch(version):
        raise ValueError("version must be a stable or beta.N semantic version")
    if Path(git(root, "rev-parse", "--show-toplevel")).resolve() != root:
        raise ValueError("source must be the canonical monorepo checkout root")
    if git(root, "rev-parse", "HEAD") != source_sha:
        raise ValueError("source SHA must match the checked-out HEAD exactly")
    if git(root, "status", "--porcelain", "--untracked-files=all"):
        raise ValueError("release preparation requires a clean committed source checkout")
    if not (root / "server").is_dir() or (root / "server").is_symlink():
        raise ValueError("source must contain the canonical server directory")
    if read_regular(root / "server/VERSION", 128).decode().strip() != version:
        raise ValueError("requested version must match committed server/VERSION")


def read_regular(path: Path, limit: int) -> bytes:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(descriptor, "rb") as source:
        metadata = os.fstat(source.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
            raise ValueError("release inputs must be bounded regular files")
        data = source.read(limit + 1)
    if len(data) > limit:
        raise ValueError("release input exceeds its size limit")
    return data


def signing_material(signing_key: Path | None) -> bytes:
    encoded = os.environ.get(KEY_ENV, "")
    if signing_key is not None and encoded:
        raise ValueError(f"provide --signing-key or {KEY_ENV}, not both")
    if signing_key is not None:
        return read_regular(signing_key, 16384)
    if not encoded:
        raise ValueError(f"provide --signing-key or {KEY_ENV}")
    if len(encoded) > 32768:
        raise ValueError("encoded signing key exceeds its size limit")
    try:
        return base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise ValueError("signing key must be valid base64") from error


def verify_key(private_key: Path, public_key: Path, work: Path) -> None:
    derived = run(["openssl", "pkey", "-in", str(private_key), "-passin", "pass:", "-pubout", "-outform", "DER"], cwd=work, label="private signing key validation")
    expected = run(["openssl", "pkey", "-pubin", "-in", str(public_key), "-outform", "DER"], cwd=work, label="committed public key validation")
    if len(expected) != 44 or not expected.startswith(ED25519_DER_PREFIX) or derived != expected:
        raise ValueError("signing key must match the committed Ed25519 release trust root")


def validate_manifest(directory: Path, *, npm: bool, source_sha: str, version: str) -> dict:
    name = "agents-server-npm-manifest.json" if npm else "agents-server-manifest.json"
    manifest = json.loads(read_regular(directory / name, 8192))
    if not isinstance(manifest, dict):
        raise ValueError("packaged manifest must be a JSON object")
    beta = "-" in version
    if any(manifest.get(key) != value for key, value in {
        "schema": 2 if npm else 1, "version": version, "commit": source_sha,
        "track": "beta" if beta else "stable", "prerelease": beta,
    }.items()):
        raise ValueError("packaged manifest must retain the exact source, version, schema and track")
    archive_name = f"server-{version}.tgz" if npm else f"agents-server-{version}.tar.gz"
    url = (f"https://registry.npmjs.org/@agentsdock/server/-/{archive_name}" if npm else
           f"https://github.com/ZhengyiLuo/AgentsServer/releases/download/v{version}/{archive_name}")
    archive = read_regular(directory / archive_name, 200 * 1024 * 1024)
    if manifest.get("archive") != {"name": archive_name, "url": url, "sha256": hashlib.sha256(archive).hexdigest(), "size": len(archive)}:
        raise ValueError("packaged archive bytes or immutable download URL differ from the manifest")
    if npm and (manifest.get("distribution") != "npm" or manifest.get("npm") != {
        "name": "@agentsdock/server", "version": version,
        "integrity": "sha512-" + base64.b64encode(hashlib.sha512(archive).digest()).decode(),
    }):
        raise ValueError("packaged npm identity or integrity is invalid")
    return manifest


def modes(archive_path: Path, prefix: str) -> dict[str, int]:
    with tarfile.open(archive_path, "r:gz") as archive:
        return {member.name.removeprefix(prefix): member.mode & 0o7777
                for member in archive if member.isfile() and member.name.startswith(prefix)}


def sign(manifest: Path, private_key: Path, public_key: Path, work: Path) -> None:
    signature = manifest.with_suffix(".sig")
    run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(private_key), "-passin", "pass:", "-in", str(manifest), "-out", str(signature)], cwd=work, label="release descriptor signing")
    if len(read_regular(signature, 64)) != 64:
        raise ValueError("release signature must be an Ed25519 signature")
    run(["openssl", "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(public_key), "-in", str(manifest), "-sigfile", str(signature)], cwd=work, label="release signature verification")


def prepare(root: Path, output: Path, *, source_sha: str, version: str,
            signing_key: Path | None = None, minimum_server_api_contract: int = 8) -> dict:
    root, output = root.resolve(), output.absolute()
    validate_source(root, source_sha, version)
    if output.exists() or output.is_symlink():
        raise FileExistsError("release output already exists; use a new directory")
    output = output.resolve()
    if output == root or root in output.parents:
        raise ValueError("release output must be outside the source checkout")
    if type(minimum_server_api_contract) is not int or minimum_server_api_contract < 1:
        raise ValueError("minimum server API contract must be a positive integer")
    key_bytes = signing_material(signing_key)
    with tempfile.TemporaryDirectory(prefix="agentsdock-product-server-") as temporary:
        work = Path(temporary).resolve()
        private_key = work / "signing-key.pem"
        with private_key.open("xb") as destination:
            private_key.chmod(0o600)
            destination.write(key_bytes)
        del key_bytes
        source = work / "source"
        # A local shared clone reads Git objects only. It creates no worktree,
        # refs, commits, export state or files in the original checkout.
        run(["git", "clone", "--quiet", "--shared", "--no-checkout", "--local", "--", str(root), str(source)], cwd=work, label="committed local source snapshot")
        git(source, "checkout", "--quiet", "--detach", source_sha)
        validate_source(source, source_sha, version)
        epoch = git(source, "show", "-s", "--format=%ct", source_sha)
        if not re.fullmatch(r"(0|[1-9][0-9]*)", epoch) or int(epoch) > 0xFFFFFFFF:
            raise ValueError("committed source timestamp cannot be encoded reproducibly")
        public_key = source / "server/release-public-key.pem"
        read_regular(public_key, 4096)
        verify_key(private_key, public_key, work)
        bundle = work / "bundle"
        npm_output, legacy_output = bundle / "npm", bundle / "legacy"
        run([sys.executable, "-B", str(source / "server/scripts/package_npm_release.py"), "--output", str(npm_output), "--require-clean-source", "--minimum-server-api-contract", str(minimum_server_api_contract)], cwd=source, label="offline npm server packaging", source_date_epoch=epoch)
        run([sys.executable, "-B", str(source / "server/scripts/package_release.py"), "--output", str(legacy_output)], cwd=source, label="legacy server packaging", source_date_epoch=epoch)
        npm = validate_manifest(npm_output, npm=True, source_sha=source_sha, version=version)
        legacy = validate_manifest(legacy_output, npm=False, source_sha=source_sha, version=version)
        contract = re.search(r"(?m)^API_CONTRACT_VERSION = ([0-9]+)$", (source / "server/agent_server.py").read_text())
        if (contract is None or type(npm.get("api_contract_version")) is not int
                or npm["api_contract_version"] != int(contract.group(1))
                or legacy.get("api_contract_version") != npm["api_contract_version"]
                or npm.get("minimum_server_api_contract") != minimum_server_api_contract
                or minimum_server_api_contract > npm["api_contract_version"]):
            raise ValueError("both manifests must match the committed server API contract")
        npm_archive, legacy_archive = npm_output / npm["archive"]["name"], legacy_output / legacy["archive"]["name"]
        compare(npm_archive, legacy_archive, version)
        if modes(npm_archive, "package/server/") != modes(legacy_archive, f"agents-server-{version}/"):
            raise ValueError("server runtime file modes must match in both distributions")
        for directory, manifest_name in ((npm_output, "agents-server-npm-manifest.json"), (legacy_output, "agents-server-manifest.json")):
            sign(directory / manifest_name, private_key, public_key, work)
        expected = {
            f"npm/{npm['archive']['name']}", "npm/agents-server-npm-manifest.json", "npm/agents-server-npm-manifest.sig",
            f"legacy/{legacy['archive']['name']}", "legacy/agents-server-manifest.json", "legacy/agents-server-manifest.sig",
        }
        actual = {path.relative_to(bundle).as_posix() for path in bundle.rglob("*") if path.is_file()}
        if actual != expected:
            raise ValueError("server bundle must contain exactly the six release assets")
        artifacts = {}
        for name in sorted(expected):
            data = read_regular(bundle / name, 200 * 1024 * 1024)
            artifacts[name] = {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)}
        receipt = {
            "schema": 1, "version": version, "track": npm["track"], "sourceSha": source_sha,
            "npmManifestSha256": artifacts["npm/agents-server-npm-manifest.json"]["sha256"],
            "legacyManifestSha256": artifacts["legacy/agents-server-manifest.json"]["sha256"],
            "artifacts": artifacts,
        }
        validate_source(source, source_sha, version)
        validate_source(root, source_sha, version)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.mkdir()  # Exclusive reservation; never replace another candidate.
        for name in sorted(expected):
            target = output / name
            target.parent.mkdir(exist_ok=True)
            with target.open("xb") as destination:
                destination.write((bundle / name).read_bytes())
            target.chmod(0o644)
        # The receipt is written last. A failed copy cannot look like a sealed bundle.
        with (output / RECEIPT).open("x") as destination:
            destination.write(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--signing-key", type=Path)
    parser.add_argument("--minimum-server-api-contract", type=int, default=8)
    args = parser.parse_args()
    try:
        receipt = prepare(Path(__file__).resolve().parents[1], args.output,
                          source_sha=args.source_sha, version=args.version,
                          signing_key=args.signing_key,
                          minimum_server_api_contract=args.minimum_server_api_contract)
    except (ValueError, OSError, tarfile.TarError, EOFError) as error:
        parser.exit(1, f"Server bundle preparation rejected: {error}\n")
    print(json.dumps(receipt, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
