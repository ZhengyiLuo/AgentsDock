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
import plistlib
import pwd
import re
import socket
import stat
import sys
import time

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
HARNESS_FILES = frozenset({".github/workflows/ci.yml", "scripts/npm_native_acceptance.py",
                          "scripts/tests/npm_native_workflow.test.mjs",
                          "scripts/tests/test_npm_native_acceptance.py", "docs/DEV_LOG.md"})
COMMAND_STAGES = frozenset({"npm-stage", "cli-version", "cli-install", "existing-refusal",
                            "launchd-query", "launchd-bootout", "launchd-bootstrap",
                            "launchd-registration", "launchd-removal-wait",
                            "systemd-stop", "systemd-start"})
COMMAND_OUTCOMES = frozenset({"started", "returned", "verified", "failed", "execution-failed", "timed-out"})


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
                and re.fullmatch(r"[a-f0-9]{40}", env.get("GITHUB_SHA", "")) is not None
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


def guard_diagnostics(args: argparse.Namespace, *, environment: dict | None = None) -> dict:
    """Read-only fixed booleans, safe even when host/path guards subsequently fail."""
    env = os.environ if environment is None else environment
    home, temporary = Path(env.get("HOME", "")), Path(env.get("RUNNER_TEMP", ""))

    def directory(path: Path) -> dict:
        result = {"absolute": path.is_absolute(), "directory": False, "owned": False,
                  "safeMode": False, "unlinked": False}
        try:
            info = path.lstat()
            result.update(directory=stat.S_ISDIR(info.st_mode), owned=info.st_uid == os.getuid(),
                          safeMode=not bool(info.st_mode & 0o022), unlinked=not path.is_symlink())
        except (OSError, ValueError):
            pass
        return result

    actual_home = False
    try:
        actual_home = home.is_absolute() and home.resolve() == Path(pwd.getpwuid(os.getuid()).pw_dir).resolve()
    except (OSError, KeyError, ValueError):
        pass
    return {"kind": "npm-native-guard-diagnostics", "schema": 1,
            "checks": {"hosted": env.get("GITHUB_ACTIONS") == "true" and env.get("RUNNER_ENVIRONMENT") == "github-hosted",
                       "canonical": env.get("GITHUB_REPOSITORY") == REPOSITORY,
                       "manual": env.get("GITHUB_EVENT_NAME") == "workflow_dispatch",
                       "nativeJob": env.get("GITHUB_JOB") == "npm-native", "nonRoot": os.getuid() != 0,
                       "realHome": actual_home, "workAbsent": not args.work.exists() and not args.work.is_symlink(),
                       "reportAbsent": not args.report.exists() and not args.report.is_symlink(),
                       "xdgConfigMatchesDefault": bool(env.get("XDG_CONFIG_HOME")) and env.get("XDG_CONFIG_HOME") == str(home / ".config"),
                       "xdgConfigLiteralDefault": env.get("XDG_CONFIG_HOME") == "$HOME/.config"},
            "selectorsPresent": {name: bool(env.get(name)) for name in native.SELECTORS},
            "home": directory(home), "temporary": directory(temporary)}


def validate_harness_diff(raw: bytes) -> None:
    """Only same-mode regular existing harness/doc files may differ from source."""
    fields = raw.split(b"\0")
    native.need(fields[-1] == b"" and (len(fields) - 1) % 2 == 0, "Malformed source/harness diff.")
    for index in range(0, len(fields) - 1, 2):
        header, path = fields[index].decode("ascii"), fields[index + 1].decode("utf8")
        match = re.fullmatch(r":(100644|100755) (100644|100755) [a-f0-9]+ [a-f0-9]+ M", header)
        native.need(match is not None and match[1] == match[2] and path in HARNESS_FILES,
                    "Harness differs outside the exact regular-file correction allowlist.")


def verify_harness_source(args: argparse.Namespace) -> str:
    harness = os.environ.get("GITHUB_SHA", "")
    native.need(re.fullmatch(r"[a-f0-9]{40}", harness) is not None, "An exact workflow harness SHA is required.")
    native.need(native.command(["git", "-C", str(ROOT), "rev-parse", "HEAD"]).stdout.decode().strip() == harness,
                "The checked-out harness differs from the workflow SHA.")
    native.need(not native.command(["git", "-C", str(ROOT), "status", "--porcelain", "--untracked-files=normal"]).stdout.strip(),
                "Native validation requires a clean reviewed harness checkout.")
    native.command(["git", "-C", str(ROOT), "merge-base", "--is-ancestor", args.source_sha, harness])
    raw = native.command(["git", "-C", str(ROOT), "diff", "--raw", "--no-renames", "-z", args.source_sha, harness, "--"]).stdout
    validate_harness_diff(raw)
    return harness


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
    verify_harness_source(args)
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


def diagnostic(diagnostics: dict | None, stage: str, outcome: str, status: int | None = None) -> None:
    native.need(stage in COMMAND_STAGES and outcome in COMMAND_OUTCOMES
                and (status is None or type(status) is int and -255 <= status <= 255), "Unsafe native diagnostic.")
    if diagnostics is not None:
        diagnostics.clear()
        diagnostics.update(commandStage=stage, outcome=outcome, exitStatus=status)


def command(stage: str, argv: list[str], *, diagnostics: dict | None = None,
            timeout: float = 60, env: dict | None = None, allowed=(0,)):
    diagnostic(diagnostics, stage, "started")
    try:
        result = native.bounded_run(argv, timeout=timeout, env=env)
    except Exception:
        diagnostic(diagnostics, stage, "execution-failed")
        raise RuntimeError("Bounded native command failed; private output withheld.") from None
    diagnostic(diagnostics, stage, "returned" if result.returncode in allowed else "failed", result.returncode)
    native.need(result.returncode in allowed, "Native command returned a rejected status; private output withheld.")
    return result


# These launchd guards mirror the reviewed product harness correction (59e42eb),
# but remain npm-local: no change to the frozen shared product acceptance gate.
def launchd_registration(item: Path, expected_sha: str, diagnostics=None) -> None:
    diagnostic(diagnostics, "launchd-registration", "started")
    info = item.lstat()
    raw = native.read_regular(item)
    native.need(info.st_uid == os.getuid() and not info.st_mode & 0o022
                and native.sha(raw) == expected_sha,
                "Owned launchd registration changed during native validation.")
    native.need(item.stem in {"com.agentsdock.server", "com.agentsdock.gateway"}
                and plistlib.loads(raw).get("Label") == item.stem,
                "Native launchd registration has a different service label.")
    diagnostic(diagnostics, "launchd-registration", "verified")


def launchd_query_state(target: str, *, diagnostics=None, timeout: float = 10) -> str:
    native.need(target in {f"gui/{os.getuid()}/com.agentsdock.server", f"gui/{os.getuid()}/com.agentsdock.gateway"},
                "Launchd observation requires the exact owned native fixture.")
    result = command("launchd-query", ["/bin/launchctl", "print", target],
                     diagnostics=diagnostics, timeout=timeout, allowed=(0, 3, 5, 113))
    if result.returncode == 0:
        return "loaded"
    output = result.stdout + result.stderr
    native.need(any(label in output.lower() for label in (b"could not find service", b"service not found", b"no such process")),
                "Native launchd service absence was not proven; private output withheld.")
    return "absent"


def launchd_state(item: Path, expected_sha: str, *, diagnostics=None, timeout: float = 10) -> str:
    launchd_registration(item, expected_sha, diagnostics)
    return launchd_query_state(f"gui/{os.getuid()}/{item.stem}", diagnostics=diagnostics, timeout=timeout)


def wait_launchd_absent(item: Path, expected_sha: str, *, diagnostics=None, timeout: float = 185) -> None:
    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            diagnostic(diagnostics, "launchd-removal-wait", "timed-out")
            raise RuntimeError("Native launchd removal timed out; no bootstrap was attempted.")
        if launchd_state(item, expected_sha, diagnostics=diagnostics, timeout=min(10, remaining)) == "absent":
            return
        time.sleep(min(0.1, remaining))


def stop_launchd(item: Path, expected_sha: str, diagnostics=None) -> None:
    if launchd_state(item, expected_sha, diagnostics=diagnostics) == "absent":
        return
    launchd_registration(item, expected_sha, diagnostics)
    result = command("launchd-bootout", ["/bin/launchctl", "bootout", f"gui/{os.getuid()}/{item.stem}"],
                     diagnostics=diagnostics, timeout=240, allowed=(0, 5, 113))
    if result.returncode != 0:
        native.need(launchd_state(item, expected_sha, diagnostics=diagnostics) == "absent",
                    "Native bootout failed and the owned service remained loaded.")
    wait_launchd_absent(item, expected_sha, diagnostics=diagnostics)


def start_launchd(item: Path, expected_sha: str, diagnostics=None) -> None:
    wait_launchd_absent(item, expected_sha, diagnostics=diagnostics)
    for attempt in range(3):
        launchd_registration(item, expected_sha, diagnostics)
        result = command("launchd-bootstrap", ["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", str(item)],
                         diagnostics=diagnostics, timeout=60, allowed=(0, 5, 37))
        if result.returncode == 0:
            native.need(launchd_state(item, expected_sha, diagnostics=diagnostics) == "loaded",
                        "Native bootstrap succeeded without registering the owned service.")
            return
        output = result.stdout + result.stderr
        transient = (b"Operation already in progress" in output or
                     (result.returncode == 5 and b"Bootstrap failed: 5: Input/output error" in output))
        native.need(transient and attempt < 2, "Native bootstrap retry unavailable or exhausted; private output withheld.")
        wait_launchd_absent(item, expected_sha, diagnostics=diagnostics)
        time.sleep(0.1)


def restart_services(fixture: dict, diagnostics=None) -> None:
    files = native.registered_services(fixture)
    bindings = {item: native.sha(native.read_regular(item)) for item in files}
    for item in reversed(files):
        if platform.system() == "Darwin":
            stop_launchd(item, bindings[item], diagnostics)
        else:
            command("systemd-stop", ["systemctl", "--user", "stop", item.name], diagnostics=diagnostics, timeout=240)
    for item in files:
        if platform.system() == "Darwin":
            start_launchd(item, bindings[item], diagnostics)
        else:
            command("systemd-start", ["systemctl", "--user", "start", item.name], diagnostics=diagnostics, timeout=60)


def exercise(args: argparse.Namespace, descriptor: dict, home: Path, *, progress=lambda phase: None,
             diagnostics: dict | None = None) -> dict:
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
    command("npm-stage", ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--offline",
                    "--package-lock=false", "--prefix", str(prefix), str(args.assets / descriptor["archive"]["name"])],
                   diagnostics=diagnostics, env=env, timeout=180)
    cli = prefix / "node_modules/@agentsdock/server/npm/cli.cjs"
    native.need(command("cli-version", ["node", str(cli), "--version"], diagnostics=diagnostics, env=env).stdout.decode().strip() == version,
                "The installed npm CLI reports a different version.")
    progress("install")
    command("cli-install", ["node", str(cli), "install", "--bind", "127.0.0.1", "--port", str(port), "--non-interactive"],
                   diagnostics=diagnostics, env=env, timeout=1500)
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
    refused = command("existing-refusal", ["node", str(cli), "install", "--non-interactive"],
                      diagnostics=diagnostics, env=env, allowed=(1,))
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
    restart_services(fixture, diagnostics)
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
           observations: dict | None = None, diagnostics: dict | None = None) -> dict:
    native.need(phase in PHASES, "Only a fixed public phase may be reported.")
    safe_diagnostics = {}
    if diagnostics:
        diagnostic(safe_diagnostics, diagnostics.get("commandStage"), diagnostics.get("outcome"), diagnostics.get("exitStatus"))
    return {"schema": 1, "kind": "agentsdock-npm-native-validation", "scope": "npm-native-fresh-install",
            "productPublicationEligible": False, "sourceSha": args.source_sha, "sourceRef": args.source_ref,
            "harnessSha": os.environ["GITHUB_SHA"],
            "manifestSha256": args.manifest_sha256, "version": descriptor["version"] if descriptor else None,
            "archiveSha256": descriptor["archive"]["sha256"] if descriptor else None,
            "repository": REPOSITORY, "runId": os.environ["GITHUB_RUN_ID"],
            "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"], "platform": platform.system(),
            "phase": phase, "status": "passed" if observations is not None else "failed",
            "observations": observations or {}, "notTested": UNTESTED, "diagnostics": safe_diagnostics}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("assets", "release", "work", "report"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    for name in ("source-sha", "source-ref", "manifest-sha256"):
        parser.add_argument(f"--{name}", required=True)
    args = parser.parse_args()
    # No environment values, paths, UIDs, raw exceptions or command output are
    # printed. These fixed booleans explain a pre-report guard refusal safely.
    print(json.dumps(guard_diagnostics(args), sort_keys=True), flush=True)
    # Invalid host/path guards deliberately do not create an arbitrary report.
    home = guard(args)
    descriptor = None
    phase = "signed-input-verification"
    diagnostics = {}

    def progress(value: str) -> None:
        nonlocal phase
        native.need(value in PHASES, "Unexpected native validation phase.")
        phase = value

    try:
        descriptor = inspect_candidate(args)
        observations = exercise(args, descriptor, home, progress=progress, diagnostics=diagnostics)
        native.write_private(args.report, report(args, descriptor, phase="complete", observations=observations, diagnostics=diagnostics))
    except Exception:
        native.write_private(args.report, report(args, descriptor, phase=phase, diagnostics=diagnostics))
        raise RuntimeError(f"Npm native validation failed during {phase}; private output withheld.") from None
    print("Signed npm fresh-install/native-restart checks passed; product, migration, provider and reboot acceptance are not claimed.")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Even filesystem and command exceptions can contain private paths.
        print("Npm native validation failed; inspect only the bounded scoped report if present.", file=sys.stderr)
        sys.exit(1)
