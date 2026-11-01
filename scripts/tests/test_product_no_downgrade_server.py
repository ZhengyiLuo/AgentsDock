"""Guard and identity regressions only: no native install, service or keychain writes."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))
SPEC = importlib.util.spec_from_file_location("product_no_downgrade_server", SCRIPTS / "product_no_downgrade_server.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


def health():
    return {"ok": True, "server_version": "1.0.8", "server_instance_id": "server-instance",
            "gateway": {"protocol": 1, "version": "1.0.8", "pid": 1234, "instance_id": "gateway-instance"},
            "execution_service": {"protocol": 1, "version": "1.0.8", "pid": 1235, "instance_id": "execution-instance"}}


class NoDowngradeTests(unittest.TestCase):
    def test_same_base_beta_two_supported_without_changing_independent_stable_pins(self):
        stable = copy.deepcopy(MOD.STABLE)
        for version in ("1.0.8-beta.1", "1.0.8-beta.2", "1.0.8-beta.12"):
            MOD.assert_same_base_beta_version(version)
        for version in ("1.0.9-beta.2", "1.0.7-beta.2", "1.0.8", "1.0.8-rc.2", "1.0.8-beta.0",
                        "1.0.8-beta.02", "1.0.8-beta.2.extra", "1.0.8-beta.2+local", "1.0.8-beta.2\n", None, 2):
            with self.subTest(version=version), self.assertRaises(RuntimeError):
                MOD.assert_same_base_beta_version(version)
        self.assertEqual(MOD.STABLE, stable)

    def test_receipt_beta_two_reaches_validation_but_other_base_is_rejected_before_native_operations(self):
        for version in ("1.0.8-beta.2", "1.0.9-beta.2"):
            raw = json.dumps({"version": version, "sourceSha": "b" * 40}).encode()
            args = argparse.Namespace(receipt=Path("/candidate.json"), receipt_sha256=MOD.native.sha(raw),
                                      work=Path("/owned/work"))
            with patch.object(MOD.native, "read_regular", return_value=raw), \
                    patch.object(MOD.native, "guard", return_value=Path("/owned")), \
                    patch.object(MOD.native, "validate_candidate_checkout", side_effect=RuntimeError("checkout boundary")) as checkout, \
                    patch.object(MOD.native, "command") as command, patch.object(MOD, "verify_stable") as stable:
                with self.assertRaises(RuntimeError):
                    MOD.inspect_inputs(args)
                self.assertEqual(checkout.call_count, int(version == "1.0.8-beta.2"))
                command.assert_not_called()
                stable.assert_not_called()

    def test_exact_components_not_health_version_alone(self):
        expected = MOD.component_identity(health())
        self.assertEqual(expected["gateway"]["pid"], 1234)
        self.assertEqual(expected["execution"]["pid"], 1235)
        for component in ("gateway", "execution_service"):
            for changes in ({"version": "1.0.8-beta.1"}, {"pid": True}, {"pid": 1}, {"instance_id": ""},
                            {"protocol": 2}, {"maintenance_held": True}):
                value = health()
                value[component].update(changes)
                with self.subTest(component=component, changes=changes), self.assertRaises(RuntimeError):
                    MOD.component_identity(value)
        value = health()
        value["execution_service"]["pid"] = 1234
        with self.assertRaises(RuntimeError):
            MOD.component_identity(value)

    def test_stable_verifier_is_separate_and_exact_not_receipt_rewritten(self):
        result = subprocess.CompletedProcess([], 0, json.dumps(MOD.STABLE).encode())
        with patch.object(MOD.native, "command", return_value=result) as command:
            MOD.verify_stable(Path("/owned/stable"))
        self.assertEqual(command.call_args.args[0][2:], ["verify-stable", "/owned/stable"])
        for key, value in (("sourceSha", "b" * 40), ("version", "1.0.8-beta.1"), ("archiveSha256", "a" * 64)):
            result.stdout = json.dumps({**MOD.STABLE, key: value}).encode()
            with patch.object(MOD.native, "command", return_value=result), self.assertRaises(RuntimeError):
                MOD.verify_stable(Path("/owned/stable"))

    def test_host_guard_and_checkout_rejection_precede_all_native_operations(self):
        receipt = {"version": "1.0.8-beta.1", "sourceSha": "b" * 40}
        raw = json.dumps(receipt).encode()
        args = argparse.Namespace(receipt=Path("/candidate.json"), receipt_sha256=MOD.native.sha(raw), work=Path("/owned/work"))
        for boundary in ("guard", "validate_candidate_checkout"):
            with patch.object(MOD.native, "read_regular", return_value=raw), \
                    patch.object(MOD.native, "guard", return_value=Path("/owned")) as guard, \
                    patch.object(MOD.native, "validate_candidate_checkout") as checkout, \
                    patch.object(MOD.native, "command") as command, patch.object(MOD, "verify_stable") as stable:
                (guard if boundary == "guard" else checkout).side_effect = RuntimeError("blocked")
                with self.assertRaises(RuntimeError):
                    MOD.inspect_inputs(args)
                command.assert_not_called()
                stable.assert_not_called()

    def test_stable_install_mode_policy_is_exact_signed_scoped_and_restored(self):
        member = tarfile.TarInfo("package/server/instances.sh")
        member.mode = 0o644
        rule = b'chmod 755 "$STAGE_DIR/instances.sh"'
        original = MOD.native.installed_runtime_mode
        with MOD.stable_installation_policy():
            self.assertEqual(MOD.native.installed_runtime_mode(member, rule), 0o755)
            for installer in (b"", rule + b"\n" + rule, b"# " + rule):
                with self.assertRaises(RuntimeError):
                    MOD.native.installed_runtime_mode(member, installer)
            member.name = "package/server/unrelated.sh"
            self.assertEqual(MOD.native.installed_runtime_mode(member, rule), 0o644)
            member.name = "package/server/instances.sh"
            member.mode = 0o666
            with self.assertRaises(RuntimeError):
                MOD.native.installed_runtime_mode(member, rule)
        self.assertIs(MOD.native.installed_runtime_mode, original)
        with self.assertRaises(ValueError):
            with MOD.stable_installation_policy():
                raise ValueError("test restoration on error")
        self.assertIs(MOD.native.installed_runtime_mode, original)

    def test_native_identity_requires_matching_launchd_ps_and_registered_stable_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            release = root / "releases/1.0.8"
            (release / ".venv/bin").mkdir(parents=True)
            (release / ".venv/bin/python").write_bytes(b"unit-test-not-executable")
            (release / "execution_service.py").write_bytes(b"unit-test-not-executable")
            (root / "current").symlink_to(release, target_is_directory=True)
            files, commands = [], {}
            for label, role, pid in (("com.agentsdock.gateway", "gateway", 1234), ("com.agentsdock.server", "worker", 1235)):
                runtime = root / "current" if role == "gateway" else release
                args = [str(runtime / ".venv/bin/python"), str(runtime / "execution_service.py"), role, "--port", "18000"]
                item = root / f"{label}.plist"
                item.write_bytes(plistlib.dumps({"ProgramArguments": args}))
                files.append(item)
                commands[pid] = f"{os.getuid()} " + " ".join(args)

            def command(args):
                if args[0] == "/bin/launchctl":
                    pid = 1234 if args[-1].endswith(".gateway") else 1235
                    return subprocess.CompletedProcess(args, 0, f"\tpid = {pid}\n".encode())
                return subprocess.CompletedProcess(args, 0, commands[int(args[2])].encode())

            fixture = {"installRoot": str(root)}
            with patch.object(MOD.native, "health", return_value=health()), \
                    patch.object(MOD.native, "registered_services", return_value=files), \
                    patch.object(MOD.native, "command", side_effect=command):
                before = MOD.native_identity(fixture)
                self.assertEqual(before["currentLink"], str(release))
                self.assertEqual(set(before["registrations"]), {"gateway", "execution"})
                for mutation in (lambda value: value.replace(" worker ", " gateway "),
                                 lambda value: value.replace("/execution_service.py", "/unrelated.py"),
                                 lambda value: value.replace(str(os.getuid()) + " ", "999999 ", 1)):
                    original = commands[1235]
                    commands[1235] = mutation(original)
                    with self.assertRaises(RuntimeError):
                        MOD.native_identity(fixture)
                    commands[1235] = original
                changed = health()
                changed["gateway"]["pid"] = 4321
                with patch.object(MOD.native, "health", return_value=changed), self.assertRaises(RuntimeError):
                    MOD.native_identity(fixture)

    def test_bootstrap_authenticates_copied_stable_bytes_before_real_native_entrypoint(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stable = root / "stable"
            stable.mkdir()
            for name in ("agents-server-npm-manifest.json", "agents-server-npm-manifest.sig", "server-1.0.8.tgz"):
                (stable / name).write_bytes(b"unit-fixture-only")
            args = argparse.Namespace(work=root / "owned", fixture=root / "fixture.json", stable_directory=stable,
                                      receipt_sha256="c" * 64)
            receipt = {"sourceSha": "b" * 40, "version": "1.0.8-beta.1"}
            saved = copy.deepcopy(receipt)
            events = []
            fixture = {"installRoot": str(root / "installation"), "sourceSha": MOD.STABLE["sourceSha"],
                       "releaseReceiptSha256": MOD.STABLE["manifestSha256"], "targetVersion": "1.0.8", "candidate": True}

            def installer(install_args, stable_identity, home):
                events.append("install")
                self.assertEqual(stable_identity, {"sourceSha": MOD.STABLE["sourceSha"], "version": "1.0.8"})
                self.assertEqual(install_args.kind, "fresh")
                self.assertEqual(install_args.bundle, args.work / "stable-bundle")
                return fixture, {"exactRuntimeFilesCompared": 123}

            with patch.object(MOD.native, "ensure_empty"), patch.object(MOD, "verify_stable", side_effect=lambda path: events.append("verify-copied")), \
                    patch.object(MOD.native, "bootstrap", side_effect=installer), \
                    patch.object(MOD, "native_identity", return_value={"components": MOD.component_identity(health())}), \
                    patch.object(MOD.native, "require_no_pending_journals"), patch.object(MOD.native, "write_private"):
                observations = MOD.bootstrap(args, receipt, root / "account")
            self.assertEqual(events, ["verify-copied", "install"])
            self.assertEqual(receipt, saved)
            self.assertEqual(fixture["candidateSourceSha"], receipt["sourceSha"])
            self.assertEqual(fixture["stableIdentity"], MOD.STABLE)
            self.assertNotIn("sourceSha", fixture)
            self.assertEqual(observations["exactRuntimeFilesCompared"], 123)

    def test_verify_requires_exact_state_equality_not_merely_preserved_history_prefix(self):
        fixture = {"nativeIdentity": {"components": "unit"}, "snapshot": {"sessions": {"saved": {"events": []}}}, "installRoot": "/owned/install"}
        args = argparse.Namespace(work=Path("/owned/work"), fixture=Path("/owned/private.json"))
        with patch.object(MOD.native, "owned_directory"), patch.object(MOD.native, "read_regular", return_value=json.dumps(fixture).encode()), \
                patch.object(MOD, "assert_fixture"), patch.object(MOD, "verify_stable"), \
                patch.object(MOD, "native_identity", return_value=fixture["nativeIdentity"]), \
                patch.object(MOD.native, "state_snapshot", return_value=fixture["snapshot"]) as snapshot, \
                patch.object(MOD.native, "verify_installed_runtime", return_value=123) as runtime, \
                patch.object(MOD.native, "require_no_pending_journals"):
            self.assertTrue(MOD.verify(args, {}, Path("/account"))["persistentStateUnchanged"])
            runtime.assert_called_once_with(fixture, args.work / "stable-bundle", "1.0.8")
            snapshot.return_value = {"sessions": {"saved": {"events": []}, "new": {"events": []}}}
            with self.assertRaises(RuntimeError):
                MOD.verify(args, {}, Path("/account"))

    def test_private_fixture_run_identity_rejected_before_owned_root_checks(self):
        args = argparse.Namespace(work=Path("/owned/work"), receipt_sha256="c" * 64)
        receipt = {"sourceSha": "b" * 40, "version": "1.0.8-beta.1"}
        env = {"GITHUB_SHA": "d" * 40, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}
        fixture = {"schema": 1, "kind": "native-stable-no-downgrade-fixture", "runId": "123", "runAttempt": "1",
                   "harnessSourceSha": env["GITHUB_SHA"], "candidateSourceSha": receipt["sourceSha"], "candidateVersion": receipt["version"],
                   "candidateReceiptSha256": args.receipt_sha256, "stableIdentity": MOD.STABLE,
                   "home": "/account", "workDirectory": "/owned/work/installation"}
        for changes in ({"runId": "124"}, {"runAttempt": "2"}, {"candidateSourceSha": MOD.STABLE["sourceSha"]},
                        {"harnessSourceSha": receipt["sourceSha"]}, {"home": "/other"}, {"workDirectory": "/"},
                        {"stableIdentity": {**MOD.STABLE, "version": receipt["version"]}}):
            with patch.dict(os.environ, env), patch.object(MOD.native, "owned_directory") as owned, self.assertRaises(RuntimeError):
                MOD.assert_fixture({**fixture, **changes}, args, receipt, Path("/account"))
            owned.assert_not_called()


if __name__ == "__main__":
    unittest.main()
