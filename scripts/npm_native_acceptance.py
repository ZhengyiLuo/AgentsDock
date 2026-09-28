#!/usr/bin/env python3
"""Validate one signed npm fresh install on disposable hosted native runners.

This is neither product acceptance nor an updater/migration/provider-chat test.
It has no developer-host mode, publication, trust-routing or receipt fabrication.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import pwd
import re
import socket
import stat
import sys

import product_server_acceptance as native


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "ZhengyiLuo/AgentsDock"
MANIFEST = "agents-server-npm-manifest.json"
SIGNATURE = "agents-server-npm-manifest.sig"
UNTESTED = ["provider-chat", "logout-or-reboot", "desktop", "managed-update",
            "legacy-migration", "busy-or-queued-work", "rollback", "multiple-clients"]
PHASES = {"signed-input-verification", "clean-host", "package-stage", "install", "initial-health",
          "runtime-verification", "existing-refusal", "cache-retirement", "service-restart",
          "post-restart-verify", "complete"}


def reviewed_ref(value: str) -> bool:
    return (value == "main" or re.fullmatch(r"release/[A-Za-z0-9][A-Za-z0-9._/-]*", value) is not None) \
        and ".." not in value and "//" not in value and not value.endswith(("/", ".")) \
        and all(not part.endswith(".lock") for part in value.split("/"))


def guard(args: argparse.Namespace, *, environment: dict | None = None,
          uid: int | None = None, system: str | None = None, machine: str | None = None) -> Path:
    env = os.environ if environment is None else environment
    user = os.getuid() if uid is None else uid
    host = platform.system() if system is None else system
    architecture = platform.machine() if machine is None else machine
    native.need(re.fullmatch(r"[a-f0-9]{40}", args.source_sha) is not None
                and re.fullmatch(r"[a-f0-9]{64}", args.manifest_sha256) is not None
                and reviewed_ref(args.source_ref), "Exact reviewed npm source/ref/hash inputs are required.")
    native.need(env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted"
                and env.get("GITHUB_REPOSITORY") == REPOSITORY
                and env.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
                and env.get("GITHUB_JOB") == "npm-native"
                and env.get("GITHUB_WORKFLOW_REF") == f"{REPOSITORY}/.github/workflows/ci.yml@refs/heads/{args.source_ref}"
                and env.get("GITHUB_REF") == f"refs/heads/{args.source_ref}"
                and env.get("GITHUB_SHA") == args.source_sha
                and env.get("NPM_NATIVE_VALIDATION") == "true" and env.get("CANDIDATE_REPLAY") == "false"
                and re.fullmatch(r"[1-9]\d*", env.get("GITHUB_RUN_ID", "")) is not None
                and re.fullmatch(r"[1-9]\d*", env.get("GITHUB_RUN_ATTEMPT", "")) is not None,
                "Npm native validation requires the explicit exact-source hosted canonical CI dispatch.")
    native.need(user != 0 and ((host == "Linux" and env.get("RUNNER_OS") == "Linux")
                or (host == "Darwin" and env.get("RUNNER_OS") == "macOS" and architecture == "arm64")),
                "A non-root hosted Linux or Apple silicon macOS account is required.")
    native.need(all(not env.get(name) for name in native.SELECTORS), "Inherited installation selectors are forbidden.")
    home = Path(env.get("HOME", ""))
    temporary = Path(env.get("RUNNER_TEMP", ""))
    native.need(home.is_absolute() and temporary.is_absolute(), "The actual account and runner temporary roots are required.")
    if environment is None:
        native.need(home.resolve() == Path(pwd.getpwuid(user).pw_dir).resolve(), "Redirected account homes are forbidden.")
        native.owned_directory(home)
        native.owned_directory(temporary)
    for path in (args.assets, args.release, args.work, args.report):
        native.contained(path, temporary)
    native.need(args.assets.name == "npm" and args.work.name.startswith("agentsdock-npm-native-")
                and not args.work.exists() and not args.work.is_symlink()
                and not args.report.exists() and not args.report.is_symlink()
                and not args.report.is_relative_to(args.work)
                and not args.report.is_relative_to(args.assets), "Use new, separated bounded native work/report paths.")
    return home


def validate_draft(release: dict, descriptor: dict, args: argparse.Namespace) -> list[str]:
    version = descriptor.get("version", "")
    native.need(isinstance(version, str) and native.VERSION.fullmatch(version) is not None,
                "The signed candidate version is invalid.")
    track = "beta" if "-" in version else "stable"
    names = sorted([MANIFEST, SIGNATURE, f"server-{version}.tgz"])
    native.need(release.get("isDraft") is True and release.get("tagName") == f"npm-candidate-v{version}"
                and release.get("targetCommitish") == args.source_sha
                and isinstance(release.get("assets"), list)
                and all(isinstance(asset, dict) and isinstance(asset.get("name"), str) for asset in release["assets"])
                and sorted(asset["name"] for asset in release["assets"]) == names,
                "Expected the exact source-pinned three-file canonical npm draft.")
    expected = {"Candidate type": "npm-server-v1", "Source repository": REPOSITORY,
                "Source commit": args.source_sha, "Source ref": args.source_ref,
                "Update track": track, "Npm manifest SHA256": args.manifest_sha256}
    body = release.get("body")
    native.need(isinstance(body, str), "Npm draft identity is missing.")
    for key, value in expected.items():
        lines = [line for line in body.splitlines() if line.startswith(f"{key}:")]
        native.need(lines == [f"{key}: {value}"], "Npm draft source/hash identity differs.")
    return names


def inspect_candidate(args: argparse.Namespace) -> dict:
    native.owned_directory(args.assets)
    native.owned_directory(args.report.parent)
    native.need(native.command(["git", "-C", str(ROOT), "rev-parse", "HEAD"]).stdout.decode().strip() == args.source_sha,
                "The checked-out source differs from the signed source.")
    native.need(not native.command(["git", "-C", str(ROOT), "status", "--porcelain", "--untracked-files=normal"]).stdout.strip(),
                "Native validation requires a clean pinned source checkout.")
    manifest = native.read_regular(args.assets / MANIFEST, 8192)
    native.need(native.sha(manifest) == args.manifest_sha256, "The independently pinned descriptor hash differs.")
    descriptor = json.loads(manifest)
    native.need(isinstance(descriptor, dict) and descriptor.get("commit") == args.source_sha,
                "The descriptor must identify this exact native workflow source.")
    release = json.loads(native.read_regular(args.release, 1024 * 1024))
    native.need(isinstance(release, dict), "Expected bounded draft metadata.")
    names = validate_draft(release, descriptor, args)
    native.need(sorted(path.name for path in args.assets.iterdir()) == names,
                "The npm input directory must contain exactly three signed assets.")
    for name in names:
        info = (args.assets / name).lstat()
        limit = 64 if name.endswith(".sig") else 8192 if name.endswith(".json") else 200 * 1024 * 1024
        native.need(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1
                    and not info.st_mode & 0o022 and 0 < info.st_size <= limit,
                    "Npm assets must be bounded, owned, unlinked regular files.")
    # The production verifier checks Ed25519 signature, descriptor schema, exact
    # SHA-256/SHA-512 archive bytes, unsafe tar members, package identity/hooks,
    # and the source checkout's version. It never executes or repacks the tarball.
    native.command(["node", str(ROOT / "scripts/verify_npm_publication.mjs"), "inspect",
                    str(args.assets), args.source_sha, args.manifest_sha256, str(args.release)], timeout=90)
    return descriptor


def exercise(args: argparse.Namespace, descriptor: dict, home: Path, *, progress=lambda phase: None) -> dict:
    progress("clean-host")
    native.ensure_empty(home)
    args.work.mkdir(mode=0o700)
    env = native.child_environment(args.work)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    version = descriptor["version"]
    fixture = {"home": str(home), "workDirectory": str(args.work), "serverUrl": f"http://127.0.0.1:{port}",
               **{key: str(value) for key, value in native.paths(home).items()}}
    prefix = args.work / "npm-prefix"
    progress("package-stage")
    native.command(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline",
                    "--package-lock=false", "--prefix", str(prefix), str(args.assets / descriptor["archive"]["name"])],
                   env=env, timeout=180)
    cli = prefix / "node_modules/@agentsdock/server/npm/cli.cjs"
    native.need(native.command(["node", str(cli), "--version"], env=env).stdout.decode().strip() == version,
                "The installed npm CLI reports a different version.")
    progress("install")
    native.command(["node", str(cli), "install", "--bind", "127.0.0.1", "--port", str(port), "--non-interactive"],
                   env=env, timeout=1500)
    progress("initial-health")
    fixture["token"] = native.token_at(Path(fixture["configRoot"]))
    first = native.health(fixture, version)
    fixture["serverIdentity"] = first["server_identity"]
    bindings = {key: (info.st_dev, info.st_ino) for key, info in
                ((key, native.owned_directory(path)) for key, path in native.paths(home).items())}
    progress("runtime-verification")
    native.registered_services(fixture)
    compared = native.verify_installed_runtime(fixture, args.assets.parent, version)
    progress("existing-refusal")
    refused = native.command(["node", str(cli), "install", "--non-interactive"], env=env, allowed=(1,))
    native.need(b"existing" in refused.stderr.lower(), "Repeated fresh installation did not explicitly refuse existing state.")
    unchanged = native.health(fixture, version)
    native.need(unchanged["server_instance_id"] == first["server_instance_id"]
                and native.token_at(Path(fixture["configRoot"])) == fixture["token"],
                "Refused installation changed the live process or access token.")
    progress("cache-retirement")
    prefix.rename(args.work / "npm-prefix-retired")
    cache = args.work / "npm-cache"
    if cache.exists():
        native.owned_directory(cache)
        cache.rename(args.work / "npm-cache-retired")
    progress("service-restart")
    native.service(fixture, "restart")
    progress("post-restart-verify")
    restarted = native.health(fixture, version)
    native.need(restarted["server_instance_id"] != first["server_instance_id"]
                and native.token_at(Path(fixture["configRoot"])) == fixture["token"],
                "Native restart did not replace the process while preserving identity and access token.")
    for key, path in native.paths(home).items():
        info = native.owned_directory(path)
        native.need((info.st_dev, info.st_ino) == bindings[key], "Native restart replaced an installation/state root.")
    native.need(native.verify_installed_runtime(fixture, args.assets.parent, version) == compared,
                "The exact runtime inventory changed after native restart.")
    return {"exactNpmPackageInstalled": True, "authenticatedNativeHealth": True,
            "nativeServiceInstalled": True, "exactRuntimeFilesCompared": compared,
            "existingInstallRefusedWithoutRestart": True, "permanentVersionedRuntime": True,
            "stagingAndNpmCacheIndependentAfterNativeRestart": True,
            "identityAndTokenPreservedAfterNativeRestart": True}


def report(args: argparse.Namespace, descriptor: dict | None, *, phase: str,
           observations: dict | None = None) -> dict:
    native.need(phase in PHASES, "Only a fixed public phase may be reported.")
    return {"schema": 1, "kind": "agentsdock-npm-native-validation", "scope": "npm-native-fresh-install",
            "productPublicationEligible": False, "sourceSha": args.source_sha, "sourceRef": args.source_ref,
            "manifestSha256": args.manifest_sha256, "version": descriptor["version"] if descriptor else None,
            "archiveSha256": descriptor["archive"]["sha256"] if descriptor else None,
            "repository": REPOSITORY, "runId": os.environ["GITHUB_RUN_ID"],
            "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"], "platform": platform.system(),
            "phase": phase, "status": "passed" if observations is not None else "failed",
            "observations": observations or {}, "notTested": UNTESTED}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("assets", "release", "work", "report"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    for name in ("source-sha", "source-ref", "manifest-sha256"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    # Invalid host/path guards deliberately do not create an arbitrary report.
    home = guard(args)
    descriptor = None
    phase = "signed-input-verification"

    def progress(value: str) -> None:
        nonlocal phase
        native.need(value in PHASES, "Unexpected native validation phase.")
        phase = value

    try:
        descriptor = inspect_candidate(args)
        observations = exercise(args, descriptor, home, progress=progress)
        native.write_private(args.report, report(args, descriptor, phase="complete", observations=observations))
    except Exception:
        native.write_private(args.report, report(args, descriptor, phase=phase))
        raise RuntimeError(f"Npm native validation failed during {phase}; private output withheld.") from None
    print("Signed npm fresh-install/native-restart checks passed; product, migration, provider and reboot acceptance are not claimed.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Even filesystem and command exceptions can contain private paths.
        print("Npm native validation failed; inspect only the bounded scoped report if present.", file=sys.stderr)
        sys.exit(1)
