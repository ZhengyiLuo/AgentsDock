#!/usr/bin/env python3
"""Dedicated real stable-server negative journey on a disposable hosted Mac.

The candidate and incumbent are independently authenticated identities. This
does not relax or invoke the positive migration's strictly-older validation.
"""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import sys

import product_server_acceptance as native

ROOT = Path(__file__).resolve().parents[1]
STABLE = {"version": "1.0.8", "sourceSha": "8a965007408c6ab9672d746366b9fc0bd58feff6",
          "manifestSha256": "64881777ab0ebf8ad029ec1f4f1212e1699f9ee7a1d62420ae32e5f3dcfe7198",
          "signatureSha256": "e224f89215b2b0d047a49aa0264ff803ef96c3ea71a6a39985b68eef67b6f18d",
          "archiveSha256": "c9846ca863312478f64979cc579feea521902dc23c15f0f30ca5eebdb544808f",
          "archiveBytes": 3721335}


@contextmanager
def stable_installation_policy():
    """Exact official 1.0.8 installer mode rule; shared positive policy stays intact."""
    original = native.installed_runtime_mode

    def mode(member, installer):
        if member.name == "package/server/instances.sh" and member.mode & 0o7777 == 0o644:
            native.need(installer.splitlines().count(b'chmod 755 "$STAGE_DIR/instances.sh"') == 1,
                        "Signed stable installer does not establish the instance entrypoint mode.")
            return 0o755
        return original(member, installer)

    native.installed_runtime_mode = mode
    try:
        yield
    finally:
        native.installed_runtime_mode = original


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("operation", choices=("bootstrap", "verify"))
    for name in ("receipt", "server-directory", "desktop-directory", "stable-directory", "work", "fixture", "evidence"):
        result.add_argument(f"--{name}", type=Path, required=True)
    result.add_argument("--receipt-sha256", required=True)
    return result


def inspect_inputs(args):
    raw = native.read_regular(args.receipt, 32768)
    native.need(re.fullmatch(r"[a-f0-9]{64}", args.receipt_sha256) is not None
                and native.sha(raw) == args.receipt_sha256, "Candidate receipt changed.")
    receipt = json.loads(raw)
    home = native.guard(receipt, args.work, candidate=True)
    native.need(receipt.get("version") == "1.0.8-beta.1", "Negative journey requires the exact same-base beta.")
    native.validate_candidate_checkout(args, receipt)
    temporary = Path(os.environ["RUNNER_TEMP"])
    for path in (args.receipt, args.server_directory, args.desktop_directory, args.stable_directory):
        native.contained(path, temporary)
    for path in (args.fixture, args.evidence):
        native.contained(path, args.work)
    native.command(["node", str(ROOT / "scripts/product-candidate-receipt.mjs"), "inspect", str(args.receipt),
                    args.receipt_sha256, str(args.server_directory), str(args.desktop_directory)], timeout=90)
    verify_stable(args.stable_directory)
    return receipt, home


def verify_stable(directory):
    checked = native.command(["node", str(ROOT / "scripts/product_no_downgrade_desktop.mjs"),
                              "verify-stable", str(directory)], timeout=90)
    native.need(json.loads(checked.stdout) == STABLE, "Independent official stable verification did not match.")


def component_identity(value):
    native.need(value.get("ok") is True and value.get("server_version") == "1.0.8"
                and isinstance(value.get("server_instance_id"), str) and len(value["server_instance_id"]) >= 8,
                "Native stable health is incomplete.")
    result = {"serverInstanceId": value["server_instance_id"]}
    for name, key in (("gateway", "gateway"), ("execution_service", "execution")):
        component = value.get(name)
        native.need(isinstance(component, dict) and component.get("protocol") == 1
                    and component.get("version") == "1.0.8" and type(component.get("pid")) is int
                    and component["pid"] > 1 and isinstance(component.get("instance_id"), str)
                    and len(component["instance_id"]) >= 8 and component.get("maintenance_held") is not True,
                    "Both genuine stable native components must be active.")
        result[key] = {"pid": component["pid"], "instanceId": component["instance_id"]}
    native.need(result["gateway"]["pid"] != result["execution"]["pid"], "Native components must be separate processes.")
    return result


def native_identity(fixture):
    """Cross-check actual launchd PIDs and executable ownership, not just JSON."""
    identity = component_identity(native.health(fixture, "1.0.8"))
    registrations = native.registered_services(fixture)
    native.need({item.stem for item in registrations} == {"com.agentsdock.gateway", "com.agentsdock.server"}
                and len(registrations) == 2, "Both native launchd registrations are required.")
    release = Path(fixture["installRoot"]) / "releases/1.0.8"
    native.need((Path(fixture["installRoot"]) / "current").resolve() == release, "Stable runtime link changed.")
    hashes = {}
    for item in registrations:
        key = "gateway" if item.stem == "com.agentsdock.gateway" else "execution"
        result = native.command(["/bin/launchctl", "print", f"gui/{os.getuid()}/{item.stem}"])
        pids = re.findall(rb"^\s*pid = ([0-9]+)\s*$", result.stdout, re.MULTILINE)
        native.need(len(pids) == 1 and int(pids[0]) == identity[key]["pid"], "Launchd/component process identity differs.")
        process = native.command(["/bin/ps", "-p", str(identity[key]["pid"]), "-o", "uid=", "-o", "command="]).stdout.decode().strip()
        owner, command = process.split(None, 1)
        arguments = plistlib.loads(native.read_regular(item))["ProgramArguments"]
        observed = shlex.split(command)
        role = "gateway" if key == "gateway" else "worker"
        native.need(len(arguments) >= 3 and arguments[2] == role
                    and Path(arguments[1]).resolve() == release / "execution_service.py"
                    and owner == str(os.getuid()) and len(observed) == len(arguments)
                    and Path(observed[0]).is_absolute() and Path(observed[0]).resolve() == Path(arguments[0]).resolve()
                    and observed[1:] == arguments[1:],
                    "Native component is not the owned stable installed runtime.")
        hashes[key] = native.sha(native.read_regular(item))
    return {"components": identity, "registrations": hashes,
            "currentLink": str((Path(fixture["installRoot"]) / "current").resolve())}


def assert_fixture(fixture, args, receipt, home):
    native.need(fixture.get("schema") == 1 and fixture.get("kind") == "native-stable-no-downgrade-fixture"
                and fixture.get("runId") == os.environ["GITHUB_RUN_ID"]
                and fixture.get("runAttempt") == os.environ["GITHUB_RUN_ATTEMPT"]
                and fixture.get("harnessSourceSha") == os.environ["GITHUB_SHA"]
                and fixture.get("candidateSourceSha") == receipt["sourceSha"]
                and fixture.get("candidateVersion") == receipt["version"]
                and fixture.get("candidateReceiptSha256") == args.receipt_sha256
                and fixture.get("stableIdentity") == STABLE and fixture.get("home") == str(home)
                and fixture.get("workDirectory") == str(args.work / "installation"),
                "Stable fixture belongs to another artifact, account or run.")
    for key, expected in native.paths(home).items():
        native.need(fixture.get(key) == str(expected), "Stable fixture root differs from the disposable account defaults.")
        info = native.owned_directory(expected)
        native.need(fixture.get("rootBindings", {}).get(key) == [info.st_dev, info.st_ino], "Stable fixture root ownership changed.")


def bootstrap(args, receipt, home):
    native.ensure_empty(home)
    args.work.mkdir(mode=0o700)
    bundle = args.work / "stable-bundle"
    (bundle / "npm").mkdir(parents=True, mode=0o700)
    for name in ("agents-server-npm-manifest.json", "agents-server-npm-manifest.sig", "server-1.0.8.tgz"):
        target = bundle / "npm" / name
        # Verified immutable official bytes, copied only into new owned staging.
        with target.open("xb") as output:
            output.write(native.read_regular(args.stable_directory / name, 200 * 1024 * 1024))
        target.chmod(0o600)
    verify_stable(bundle / "npm")
    install_args = argparse.Namespace(work=args.work / "installation", bundle=bundle, fixture=args.fixture,
        receipt_sha256=STABLE["manifestSha256"], kind="fresh", legacy_root_mode="0755", candidate=True)
    # This is a distinct verified stable identity, never a rewritten beta receipt.
    with stable_installation_policy():
        fixture, observations = native.bootstrap(install_args,
            {"sourceSha": STABLE["sourceSha"], "version": STABLE["version"]}, home)
    for key in ("sourceSha", "releaseReceiptSha256", "targetVersion", "candidate"):
        fixture.pop(key, None)
    fixture.update(kind="native-stable-no-downgrade-fixture", stableIdentity=STABLE,
        candidateSourceSha=receipt["sourceSha"], candidateVersion=receipt["version"], candidateReceiptSha256=args.receipt_sha256)
    fixture["nativeIdentity"] = native_identity(fixture)
    fixture["componentIdentity"] = fixture["nativeIdentity"]["components"]
    native.require_no_pending_journals(Path(fixture["installRoot"]))
    native.write_private(args.fixture, fixture, replace=True)
    return {"realStableNpmInstall": True, "bothLaunchdComponentsVerified": True,
            "exactRuntimeFilesCompared": observations["exactRuntimeFilesCompared"],
            "stagingIndependentAfterNativeRestart": True, "persistedSessionCreatedThroughAPI": True,
            "providerWorkObserved": False}


def verify(args, receipt, home):
    native.owned_directory(args.work)
    fixture = json.loads(native.read_regular(args.fixture, private=True))
    assert_fixture(fixture, args, receipt, home)
    verify_stable(args.work / "stable-bundle/npm")
    native.need(native_identity(fixture) == fixture["nativeIdentity"], "Stable native PIDs, instances, service registration or runtime link changed.")
    native.need(fixture["snapshot"] == native.state_snapshot(fixture), "Stable persisted identity, sessions or history changed.")
    with stable_installation_policy():
        count = native.verify_installed_runtime(fixture, args.work / "stable-bundle", "1.0.8")
    native.require_no_pending_journals(Path(fixture["installRoot"]))
    return {"bothNativePidsAndInstancesUnchanged": True, "serviceRegistrationsAndCurrentLinkUnchanged": True,
            "persistentStateUnchanged": True, "exactStableRuntimeFilesCompared": count, "noActivationJournals": True}


def main():
    args = parser().parse_args()
    receipt, home = inspect_inputs(args)
    observations = bootstrap(args, receipt, home) if args.operation == "bootstrap" else verify(args, receipt, home)
    report = {"schema": 1, "kind": "candidate-no-downgrade-observations", "publicationEligible": False,
              "releaseAcceptance": False, "sourceSha": receipt["sourceSha"], "harnessSourceSha": os.environ["GITHUB_SHA"],
              "releaseReceiptSha256": args.receipt_sha256, "version": receipt["version"], "stableIdentity": STABLE,
              "runId": os.environ["GITHUB_RUN_ID"], "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"],
              "platform": "darwin", "native": True, "operation": args.operation, "observed": True,
              "observations": observations}
    native.write_private(args.evidence, report)
    print(json.dumps({"observed": True, "evidenceSha256": native.sha(native.read_regular(args.evidence))}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Native no-downgrade service acceptance failed; private details withheld.", file=sys.stderr)
        raise SystemExit(1) from None
