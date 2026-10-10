"""Read-only guard/receipt tests. Never create native services or spoof a host."""
from argparse import Namespace
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import tarfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "agentsdock_cli_native_acceptance.py"
spec = importlib.util.spec_from_file_location("cli_native", SCRIPT)
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


class NativeCliGuardTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cli-native-unit-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.args = Namespace(source_sha="a" * 40, source_ref="release/1.0.10-beta.5",
                              manifest_sha256="b" * 64, cli_receipt_sha256="c" * 64,
                              runtime=self.root / "inputs/npm", cli=self.root / "inputs/cli",
                              work=self.root / "agentsdock-cli-native-unit",
                              report=self.root / "public/report.json")
        self.env = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
                    "GITHUB_REPOSITORY": native.REPOSITORY, "GITHUB_EVENT_NAME": "workflow_dispatch",
                    "GITHUB_JOB": "cli-native", "CLI_NATIVE_ACCEPTANCE": "true",
                    "GITHUB_SHA": self.args.source_sha, "GITHUB_REF": "refs/heads/" + self.args.source_ref,
                    "GITHUB_WORKFLOW_REF": f"{native.REPOSITORY}/.github/workflows/{native.WORKFLOW}@refs/heads/{self.args.source_ref}",
                    "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1", "RUNNER_OS": "macOS",
                    "HOME": str(self.home), "RUNNER_TEMP": str(self.root)}

    def guarded(self, **changes):
        # This tests only a pure host guard with explicit dependency injection.
        # It never enters exercise(), changes environment, or starts services.
        return native.guard(self.args, environment={**self.env, **changes}, uid=1000, system="Darwin", machine="arm64")

    def test_exact_hosted_dispatch_guard_and_non_mutating_checks(self):
        self.assertEqual(self.guarded(), self.home)
        self.assertFalse(self.args.work.exists())
        self.assertFalse(self.args.report.exists())
        for key, value in (("GITHUB_ACTIONS", "false"), ("RUNNER_ENVIRONMENT", "self-hosted"),
                           ("GITHUB_REPOSITORY", "someone/other"), ("GITHUB_EVENT_NAME", "push"),
                           ("GITHUB_JOB", "other"), ("CLI_NATIVE_ACCEPTANCE", "false"),
                           ("GITHUB_SHA", "d" * 40), ("GITHUB_REF", "refs/heads/main"),
                           ("GITHUB_WORKFLOW_REF", "other"), ("GITHUB_RUN_ID", ""),
                           ("GITHUB_RUN_ATTEMPT", "0"), ("HOME", "relative"), ("RUNNER_TEMP", "")):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.guarded(**{key: value})

    def diagnostic_pins(self):
        self.args.source_sha, self.args.source_ref = native.DIAGNOSTIC_PRODUCT, native.DIAGNOSTIC_SOURCE_REF
        self.args.manifest_sha256, self.args.cli_receipt_sha256 = native.DIAGNOSTIC_MANIFEST, native.DIAGNOSTIC_CLI_RECEIPT
        self.args.workflow_sha, self.args.harness_ref = "d" * 40, native.DIAGNOSTIC_HARNESS_REF
        self.env.update(GITHUB_SHA=self.args.workflow_sha, GITHUB_REF="refs/heads/" + self.args.harness_ref,
                        GITHUB_WORKFLOW_SHA=self.args.workflow_sha,
                        GITHUB_WORKFLOW_REF=f"{native.REPOSITORY}/.github/workflows/{native.WORKFLOW}@refs/heads/{self.args.harness_ref}")

    def test_diagnostic_pins_are_separate_exact_and_do_not_relax_host_guard(self):
        self.diagnostic_pins()
        self.assertEqual(self.guarded(), self.home)
        self.assertEqual(native.release_pins(self.args), ("d" * 40, native.DIAGNOSTIC_HARNESS_REF, True))
        for field, value in (("workflow_sha", ""), ("harness_ref", ""), ("workflow_sha", "invalid"),
                             ("workflow_sha", native.DIAGNOSTIC_PRODUCT), ("harness_ref", "release/other"),
                             ("source_sha", "a" * 40), ("source_ref", "main"),
                             ("manifest_sha256", "b" * 64), ("cli_receipt_sha256", "c" * 64)):
            old = getattr(self.args, field)
            setattr(self.args, field, value)
            with self.subTest(field=field, value=value), self.assertRaises(RuntimeError):
                self.guarded()
            setattr(self.args, field, old)
        for key in ("GITHUB_SHA", "GITHUB_REF", "GITHUB_WORKFLOW_REF", "GITHUB_WORKFLOW_SHA", "RUNNER_ENVIRONMENT"):
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.guarded(**{key: "wrong"})
        self.assertFalse(self.args.work.exists())
        self.assertFalse(self.args.report.exists())

    @staticmethod
    def raw_diff(path="scripts/agentsdock_cli_native_acceptance.py", *, old_mode="100644", new_mode="100644", status="M"):
        return f":{old_mode} {new_mode} {'1' * 40} {'2' * 40} {status}\0{path}\0".encode()

    def test_raw_harness_diff_only_allows_existing_regular_same_mode_files(self):
        native.validate_harness_diff(b"".join(self.raw_diff(path) for path in sorted(native.HARNESS_FILES)))
        for path in ("server/VERSION", "server/npm/cli.cjs", "scripts/verify_agentsdock_cli_publication.mjs",
                     ".github/workflows/server-npm-publish.yml", "scripts/../server/VERSION"):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                native.validate_harness_diff(self.raw_diff(path))
        for changes in ({"new_mode": "100755"}, {"old_mode": "120000", "new_mode": "120000"},
                        {"status": "A"}, {"status": "D"}, {"status": "R100"}, {"old_mode": "000000"}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                native.validate_harness_diff(self.raw_diff(**changes))
        for malformed in (self.raw_diff()[:-1], b"\0", b"unexpected\0file\0", self.raw_diff() + b"extra\0"):
            with self.subTest(malformed=malformed), self.assertRaises(RuntimeError):
                native.validate_harness_diff(malformed)

    def checkout_double(self, *, head=None, status=b"", ancestor=True, diff=None, product_ref=None):
        # Git-only inert responses, not a native guard bypass or real checkout.
        def command(argv, **kwargs):
            self.assertEqual(argv[:4], ["git", "--no-replace-objects", "-C", str(native.ROOT)])
            operation = argv[4:]
            if operation == ["rev-parse", "HEAD"]:
                output = (head if head is not None else self.env["GITHUB_SHA"]).encode()
            elif operation == ["status", "--porcelain", "--untracked-files=normal"]:
                output = status
            elif operation == ["merge-base", "--is-ancestor", self.args.source_sha, self.args.workflow_sha]:
                if not ancestor:
                    raise RuntimeError("Synthetic nonancestor")
                output = b""
            elif operation == ["diff", "--raw", "--no-renames", "-z", self.args.source_sha, self.args.workflow_sha, "--"]:
                output = self.raw_diff() if diff is None else diff
            elif operation == ["rev-parse", "refs/remotes/origin/cli-reviewed-product"]:
                output = (product_ref if product_ref is not None else self.args.source_sha).encode()
            else:
                self.fail(f"Unexpected Git-only operation: {operation}")
            return subprocess.CompletedProcess(argv, 0, output, b"")
        return command

    def test_reviewed_checkout_requires_exact_clean_descendant_and_frozen_product_ref(self):
        self.diagnostic_pins()
        with patch.dict(os.environ, self.env, clear=True), patch.object(native, "command", side_effect=self.checkout_double()):
            self.assertEqual(native.verify_harness_source(self.args), self.args.workflow_sha)
        for values in ({"head": "e" * 40}, {"status": b" M scripts/agentsdock_cli_native_acceptance.py"},
                       {"status": b"?? unexpected-file"}, {"ancestor": False}, {"diff": b""},
                       {"diff": self.raw_diff("server/VERSION")}, {"product_ref": "f" * 40}):
            with self.subTest(values=values), patch.dict(os.environ, self.env, clear=True), \
                    patch.object(native, "command", side_effect=self.checkout_double(**values)), self.assertRaises(RuntimeError):
                native.verify_harness_source(self.args)

    def test_original_exact_source_mode_requires_no_diagnostic_ref_or_new_inputs(self):
        self.assertEqual(native.release_pins(self.args), (self.args.source_sha, self.args.source_ref, False))
        with patch.dict(os.environ, self.env, clear=True), patch.object(native, "command", side_effect=self.checkout_double()) as commands:
            self.assertEqual(native.verify_harness_source(self.args), self.args.source_sha)
        self.assertEqual(commands.call_count, 2)

    def test_diagnostic_report_cannot_masquerade_as_original_acceptance(self):
        self.diagnostic_pins()
        with patch.dict(os.environ, self.env, clear=True):
            for passed in (False, True):
                report = native.make_report(self.args, {"version": "1.0.10-beta.6"}, {}, "named-lifecycle", passed,
                                            "named-stop-native-state")
                self.assertEqual(report["kind"], "agentsdock-cli-native-diagnostic")
                self.assertEqual(report["scope"], "paired-npm-cli-native-diagnostic")
                self.assertTrue(report["diagnosticOnly"])
                self.assertFalse(report["productPublicationEligible"])
                self.assertFalse(report["fullAcceptance"])
                self.assertEqual(report["sourceSha"], native.DIAGNOSTIC_PRODUCT)
                self.assertEqual(report["sourceRef"], native.DIAGNOSTIC_SOURCE_REF)
                self.assertEqual(report["harnessSha"], self.args.workflow_sha)
                self.assertEqual(report["harnessRef"], self.args.harness_ref)
                self.assertEqual(report["failedCheck"], None if passed else "named-stop-native-state")

    def test_named_checks_are_action_specific_closed_labels(self):
        expected = {f"named-{action}-{check}" for action in ("stop", "start", "restart")
                    for check in ("command", "default-health", "default-instance-unchanged")}
        expected |= {"named-stop-native-state"}
        expected |= {f"named-{action}-{check}" for action in ("start", "restart")
                     for check in ("authenticated-health", "fresh-process-instance")}
        expected |= {"named-stop-owned-process", "named-stop-owned-convergence", "named-chain-owned-process",
                     "named-chain-stop-command", "named-chain-start-command", "named-chain-fresh-stable-health",
                     "named-chain-default-unaffected"}
        self.assertEqual({check for check in native.PUBLIC_CHECKS if check.startswith("named-")}, expected)

    def test_after_failure_stop_samples_are_read_only_bounded_and_never_acceptance(self):
        observations = {}
        with patch.object(native, "service_files", return_value=[Path("/inert/named.plist")]), \
                patch.object(native, "service_state", side_effect=["active", "inactive", "absent"]) as states, \
                patch.object(native.time, "sleep") as sleep:
            native.diagnose_named_stop(self.home, observations)
        self.assertEqual(states.call_count, 3)
        self.assertEqual([call.args for call in sleep.call_args_list], [(1,), (2,)])
        self.assertEqual(observations, {"diagnosticNamedStopAfterFailure": [
            {"minimumDelaySeconds": 0, "registered": True, "assertionActive": True},
            {"minimumDelaySeconds": 1, "registered": True, "assertionActive": False},
            {"minimumDelaySeconds": 3, "registered": False, "assertionActive": False}]})
        with patch.object(native, "service_files", side_effect=RuntimeError("private-token /private-path")), \
                patch.object(native.time, "sleep"):
            native.diagnose_named_stop(self.home, observations)
        self.assertTrue(all(sample["registered"] is None and sample["assertionActive"] is None
                            for sample in observations["diagnosticNamedStopAfterFailure"]))
        self.assertNotIn("private", json.dumps(observations))

    def test_late_stop_convergence_never_changes_original_failure_or_checks(self):
        observations = {}
        # Exact-source mode keeps its original immediate assertion, no sampling.
        with patch.object(native, "service_files", return_value=[Path("/inert/named.plist")]), \
                patch.object(native, "service_state", return_value="active"), \
                patch.object(native, "diagnose_named_stop") as diagnose:
            with self.assertRaisesRegex(RuntimeError, "Named service remained active"):
                native.require_named_stopped(self.args, self.home, observations)
            diagnose.assert_not_called()
        self.diagnostic_pins()
        # Diagnostic samples show convergence but the original failure survives.
        with patch.object(native, "service_files", return_value=[Path("/inert/named.plist")]), \
                patch.object(native, "service_state", side_effect=["active", "active", "absent", "absent"]), \
                patch.object(native.time, "sleep"):
            with self.assertRaisesRegex(RuntimeError, "Named service remained active"):
                native.require_named_stopped(self.args, self.home, observations)
        self.assertFalse(observations["diagnosticNamedStopAfterFailure"][-1]["registered"])
        with patch.dict(os.environ, self.env, clear=True):
            report = native.make_report(self.args, None, observations, "named-lifecycle", False, "named-stop-native-state")
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["failedCheck"], "named-stop-native-state")
        self.assertFalse(report["fullAcceptance"])
        self.assertFalse(report["productPublicationEligible"])

    def test_named_native_snapshot_binds_exact_owned_plist_arguments_and_pid(self):
        with patch.object(native.platform, "system", return_value="Darwin"):
            item = native.service_files(self.home, "cli-native")[0]
        item.parent.mkdir(parents=True)
        runtime = native.roots(self.home, "cli-native")["runtime"]
        args = [str(runtime / "current/.venv/bin/python"), str(runtime / "current/agent_server.py"), "serve", "--port", "7860"]
        raw = plistlib.dumps({"Label": item.stem, "ProgramArguments": args})
        item.write_bytes(raw)
        item.chmod(0o600)
        output = f"path = {item}\nprogram = {args[0]}\narguments = {{\n" + "\n".join(args) + "\n}\npid = 401\n"
        with patch.object(native.platform, "system", return_value="Darwin"), \
                patch.object(native, "command", return_value=subprocess.CompletedProcess([], 0, output.encode(), b"")) as command:
            state = native.named_native_snapshot(self.home, raw)
            self.assertEqual(state, {"file": raw, "registered": True, "active": True, "pid": 401})
            self.assertEqual(command.call_args.args[0][:2], ["/bin/launchctl", "print"])
        for text, expected in ((output + "pid = 402\n", raw), (output + "program = /other\n", raw),
                               (output.replace(str(item), "/foreign.plist"), raw),
                               (output.replace("--port", "--different"), raw), (output, b"different file")):
            with patch.object(native.platform, "system", return_value="Darwin"), \
                    patch.object(native, "command", return_value=subprocess.CompletedProcess([], 0, text.encode(), b"")), \
                    self.assertRaises(RuntimeError):
                native.named_native_snapshot(self.home, expected)
        for error, allowed in ((b"Could not find service", True), (b"permission denied", False)):
            with patch.object(native.platform, "system", return_value="Darwin"), \
                    patch.object(native, "command", return_value=subprocess.CompletedProcess([], 113, b"", error)):
                if allowed:
                    state = native.named_native_snapshot(self.home, raw)
                    self.assertEqual((state["registered"], state["pid"]), (False, 0))
                else:
                    with self.assertRaises(RuntimeError):
                        native.named_native_snapshot(self.home, raw)

    def test_named_linux_snapshot_requires_exact_loaded_unit_without_overrides(self):
        with patch.object(native.platform, "system", return_value="Linux"):
            item = native.service_files(self.home, "cli-native")[0]
        item.parent.mkdir(parents=True)
        item.write_bytes(b"owned synthetic unit")
        item.chmod(0o600)
        output = f"FragmentPath={item}\nDropInPaths=\nNeedDaemonReload=no\nLoadState=loaded\nActiveState=active\nMainPID=401\n"
        for text, allowed in ((output, True), (output.replace("active\n", "inactive\n").replace("401", "0"), True),
                              (output.replace("NeedDaemonReload=no", "NeedDaemonReload=yes"), False),
                              (output.replace("DropInPaths=", "DropInPaths=/foreign"), False),
                              (output + "MainPID=402\n", False)):
            with patch.object(native.platform, "system", return_value="Linux"), \
                    patch.object(native, "command", return_value=subprocess.CompletedProcess([], 0, text.encode(), b"")):
                if allowed:
                    self.assertTrue(native.named_native_snapshot(self.home)["registered"])
                else:
                    with self.assertRaises(RuntimeError):
                        native.named_native_snapshot(self.home)

    def test_named_stop_observer_requires_both_registration_and_previous_pid_gone(self):
        previous = {"file": b"owned", "registered": True, "active": True, "pid": 401}
        absent = {"file": b"owned", "registered": False, "active": False, "pid": 0}
        with patch.object(native.platform, "system", return_value="Darwin"), \
                patch.object(native, "named_native_snapshot", side_effect=[previous, absent]), \
                patch.object(native, "process_present", side_effect=[True, False]), patch.object(native.time, "sleep") as sleep:
            native.observe_named_stop(self.home, previous)
            self.assertEqual([call.args for call in sleep.call_args_list], [(0.1,)])
        for current, present in ((previous, False), (absent, True), ({**previous, "pid": 402}, False)):
            with patch.object(native.platform, "system", return_value="Darwin"), \
                    patch.object(native, "named_native_snapshot", return_value=current), \
                    patch.object(native, "process_present", return_value=present), self.assertRaises(RuntimeError):
                native.observe_named_stop(self.home, previous, timeout=0)

    def test_restart_observer_requires_new_owned_pid_old_pid_gone_and_stable_new_health(self):
        old = {"file": b"owned", "registered": True, "active": True, "pid": 401}
        new = {**old, "pid": 402}
        stale = {"server_identity": "identity", "server_instance_id": "old"}
        fresh = {**stale, "server_instance_id": "new"}
        with patch.object(native, "named_native_snapshot", return_value=new), \
                patch.object(native, "process_present", side_effect=lambda pid: pid == 402), \
                patch.object(native, "health", return_value=fresh) as health, patch.object(native.time, "sleep"):
            self.assertEqual(native.observe_named_restart(self.home, old, stale, 7860, "private", "1.0.10-beta.6"), fresh)
            self.assertEqual(health.call_count, 2)
        for current, present, value in ((old, False, fresh), (new, True, fresh), (new, False, stale),
                                        ({**new, "active": False}, False, fresh)):
            with patch.object(native, "named_native_snapshot", return_value=current), \
                    patch.object(native, "process_present", return_value=present), \
                    patch.object(native, "health", return_value=value), self.assertRaises(RuntimeError):
                native.observe_named_restart(self.home, old, stale, 7860, "private", "1.0.10-beta.6", timeout=0)

    def test_immediate_chain_has_no_observer_between_stop_and_start_and_cannot_compensate(self):
        old = {"file": b"owned", "registered": True, "active": True, "pid": 401}
        previous = {"server_identity": "named", "server_instance_id": "old"}
        fresh = {**previous, "server_instance_id": "new"}
        default = {"server_identity": "default", "server_instance_id": "unchanged"}
        for failure in (False, True):
            events, observations = [], {}
            def command(argv, **kwargs):
                events.append(argv[1])
                return subprocess.CompletedProcess(argv, 0, b"", b"")
            def observe(*args, **kwargs):
                events.append("observe")
                if failure:
                    raise RuntimeError("Synthetic no-op start never reached a fresh process")
                return fresh
            with patch.object(native, "named_native_snapshot", side_effect=lambda *a: events.append("capture") or old), \
                    patch.object(native, "command", side_effect=command), \
                    patch.object(native, "observe_named_restart", side_effect=observe), \
                    patch.object(native, "health", side_effect=lambda *a, **k: events.append("default-health") or default), \
                    patch.object(native.time, "sleep") as sleep:
                def run():
                    return native.exercise_immediate_named_chain(self.home, "agentsdock", {}, "1.0.10-beta.6", 7860,
                                                                "private", previous, "private", default, observations, lambda *a: None)
                if failure:
                    with self.assertRaises(RuntimeError):
                        run()
                    self.assertEqual(events, ["capture", "stop", "start", "observe"])
                    self.assertFalse(observations)
                else:
                    self.assertEqual(run(), fresh)
                    self.assertEqual(events, ["capture", "stop", "start", "observe", "default-health"])
                    self.assertTrue(observations["diagnosticImmediateNamedStopStartFreshOwnedProcessAndDefaultUnaffected"])
                sleep.assert_not_called()

    def test_process_presence_uses_only_ps_and_rejects_ambiguous_output(self):
        for stdout, expected in ((b"  401\n", True), (b"", False), (b"402\n", None)):
            with patch.object(native, "command", return_value=subprocess.CompletedProcess([], 0, stdout, b"")) as command:
                if expected is None:
                    with self.assertRaises(RuntimeError):
                        native.process_present(401)
                else:
                    self.assertEqual(native.process_present(401), expected)
                self.assertEqual(command.call_args.args[0], ["/bin/ps", "-p", "401", "-o", "pid="])

    def test_platform_root_custom_selector_and_bad_pin_rejected(self):
        for values in ({"uid": 0}, {"machine": "x86_64"}, {"system": "Windows"}):
            with self.assertRaises(RuntimeError):
                native.guard(self.args, environment=self.env, **{"uid": 1000, "system": "Darwin", "machine": "arm64", **values})
        for key in native.SELECTORS:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                self.guarded(**{key: "/custom"})
        for key in ("source_sha", "manifest_sha256", "cli_receipt_sha256"):
            original = getattr(self.args, key)
            setattr(self.args, key, "missing")
            with self.assertRaises(RuntimeError):
                self.guarded()
            setattr(self.args, key, original)
        for value in ("feature/other", "release/../escape", "release/a.lock", "release/a//b", "release/a."):
            self.args.source_ref = value
            with self.assertRaises(RuntimeError):
                self.guarded()

    def test_linux_literal_default_xdg_only_is_allowed_without_mutating_environment(self):
        env = {**self.env, "RUNNER_OS": "Linux", "XDG_CONFIG_HOME": str(self.home / ".config")}
        self.assertEqual(native.guard(self.args, environment=env, uid=1000, system="Linux", machine="x86_64"), self.home)
        self.assertIn("XDG_CONFIG_HOME", env)
        env["XDG_CONFIG_HOME"] = "$HOME/.config"
        with self.assertRaises(RuntimeError):
            native.guard(self.args, environment=env, uid=1000, system="Linux", machine="x86_64")

    def test_paths_must_be_new_separate_bounded_and_unlinked(self):
        for field, value in (("work", self.root / "unexpected"), ("work", self.root / "inputs/npm/agentsdock-cli-native-new"),
                             ("report", self.args.work / "report.json"), ("report", self.args.cli / "report.json"),
                             ("cli", self.args.runtime), ("runtime", self.root.parent / "outside")):
            old = getattr(self.args, field)
            setattr(self.args, field, value)
            with self.subTest(field=field, value=value), self.assertRaises(RuntimeError):
                self.guarded()
            setattr(self.args, field, old)
        self.args.work.mkdir()
        with self.assertRaises(RuntimeError):
            self.guarded()
        self.args.work.rmdir()
        self.args.work.symlink_to(self.home, target_is_directory=True)
        with self.assertRaises(RuntimeError):
            self.guarded()

    def test_child_environment_omits_auth_ci_hooks_and_custom_roots(self):
        self.args.work.mkdir()
        environment = {**self.env, "PATH": "/trusted/bin", "NODE_AUTH_TOKEN": "secret", "NPM_TOKEN": "secret",
                       "GH_TOKEN": "secret", "CI": "true", "BASH_ENV": "/bad", "NODE_OPTIONS": "--bad",
                       "AGENTSDOCK_AGENT_TOKEN": "secret", "npm_config_registry": "https://wrong.invalid"}
        with patch.dict(os.environ, environment, clear=True):
            child = native.child_environment(self.args.work)
        self.assertEqual(child["HOME"], str(self.home))
        for key in ("GH_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN", "CI", "GITHUB_ACTIONS", "BASH_ENV", "NODE_OPTIONS", "npm_config_registry"):
            self.assertNotIn(key, child)
        self.assertNotIn("secret", json.dumps(child))
        self.assertEqual((self.args.work / "user.npmrc").read_bytes(), b"")
        self.assertEqual((self.args.work / "global.npmrc").read_bytes(), b"")

    def test_failed_scoped_report_retains_partial_checks_without_full_acceptance(self):
        with patch.dict(os.environ, self.env, clear=True):
            report = native.make_report(self.args, {"version": "1.0.10-beta.5"},
                                        {"automaticFirstGlobalSetup": True, "defaultLifecycleAccepted": False},
                                        "default-lifecycle", False)
        self.assertEqual(report["status"], "failed")
        self.assertFalse(report["fullAcceptance"])
        self.assertFalse(report["productPublicationEligible"])
        self.assertEqual(report["runAttempt"], "1")
        self.assertFalse(report["observations"]["defaultLifecycleAccepted"])
        self.assertIn("logout-or-reboot", report["notTested"])
        self.assertIn("default-removal", report["notTested"])
        self.assertNotIn(str(self.home), json.dumps(report))

    def test_default_removal_report_requires_completed_exact_and_unrelated_state_observations(self):
        exact = "defaultRemovalRequiresConfirmationAndPreservesSyntheticState"
        unrelated = "defaultRemovalLeavesNamedSyntheticStateUntouched"
        for observations in ({}, {exact: True}, {unrelated: True}, {exact: True, unrelated: False},
                             {exact: True, unrelated: True}):
            with patch.dict(os.environ, self.env, clear=True):
                report = native.make_report(self.args, {"version": "1.0.10-beta.5"}, observations,
                                            "default-removal", False)
            self.assertEqual("default-removal" not in report["notTested"],
                             observations.get(exact) is True and observations.get(unrelated) is True)
            self.assertFalse(report["fullAcceptance"])
            self.assertFalse(report["productPublicationEligible"])
            for boundary in ("populated-native-history", "busy-or-queued-work", "logout-or-reboot", "history-purge"):
                self.assertIn(boundary, report["notTested"])

    def test_failure_checks_are_closed_set_identifiers_not_private_diagnostics(self):
        with patch.dict(os.environ, self.env, clear=True):
            for check in native.PUBLIC_CHECKS:
                report = native.make_report(self.args, {"version": "1.0.10-beta.5"}, {},
                                            "default-health", False, check)
                self.assertEqual(report["failedCheck"], check)
                self.assertFalse(report["fullAcceptance"])
                self.assertFalse(report["productPublicationEligible"])
                self.assertNotIn(str(self.home), json.dumps(report))
            passed = native.make_report(self.args, {"version": "1.0.10-beta.5"}, {},
                                        "complete", True, "service-path-independence")
            self.assertIsNone(passed["failedCheck"])
            for value in ("token=private-token", str(self.home), "arbitrary exception output"):
                with self.assertRaisesRegex(RuntimeError, "Unknown public report check"):
                    native.make_report(self.args, None, {}, "default-health", False, value)

    def test_main_failure_report_keeps_only_selected_check_and_not_exception_text(self):
        # Replace the entire native exercise and host guard with inert doubles;
        # this tests report finalization only, never native operations.
        self.args.report.parent.mkdir(mode=0o700)

        def fail(_args, _home, _descriptor, _receipt, _observations, progress):
            progress("default-health", "service-path-independence")
            raise RuntimeError("private-token and private-path must not escape")

        with patch.dict(os.environ, self.env, clear=True), \
                patch("argparse.ArgumentParser.parse_args", return_value=self.args), \
                patch.object(native, "guard", return_value=self.home), \
                patch.object(native, "inspect_inputs", return_value=({"version": "1.0.10-beta.5"}, {})), \
                patch.object(native, "exercise", side_effect=fail):
            with self.assertRaises(RuntimeError):
                native.main()
        text = self.args.report.read_text()
        report = json.loads(text)
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["failedCheck"], "service-path-independence")
        self.assertFalse(report["fullAcceptance"])
        self.assertFalse(report["productPublicationEligible"])
        for private in ("private-token", "private-path", str(self.home)):
            self.assertNotIn(private, text)

    def default_removal_fixture(self, change=None):
        # Inert commands/native-state observations and disposable files only.
        # Never invokes exercise(), starts a service, or spoofs a hosted runner.
        paths = native.roots(self.home)
        for path in paths.values():
            path.mkdir(mode=0o700, parents=True)
        token = "unit-secret-token-never-log-0123456789"
        envfile = paths["config"] / "env"
        envfile.write_text(f"AGENTSDOCK_AGENT_TOKEN={token}\n")
        envfile.chmod(0o600)
        retained = paths["state"] / "existing-synthetic-history.txt"
        retained.write_bytes(b"synthetic history, not native provider history")
        unrelated = self.root / "unrelated.txt"
        unrelated.write_bytes(b"leave unrelated paths untouched")
        files = [self.home / "native/worker", self.home / "native/gateway"]
        for item in files:
            item.parent.mkdir(mode=0o700, exist_ok=True)
            item.write_bytes(b"exact native registration")
        last = {name: {"pid": pid, "instance_id": f"synthetic-{name}", "version": "1.0.10-beta.5", "protocol": 1}
                for name, pid in (("gateway", 401), ("execution_service", 402))}
        calls, observations = [], {}

        def command(argv, **kwargs):
            calls.append(argv[1:])
            if argv[1:] == ["stop", "default"]:
                return subprocess.CompletedProcess(argv, 0, b"stopped", b"")
            if argv[1:] == ["remove", "default"]:
                if change == "cancel-token":
                    envfile.write_text("AGENTSDOCK_AGENT_TOKEN=different-token-01234567890123456789\n")
                if change == "cancel-state":
                    (paths["state"] / "cli-native-default-synthetic-preservation.txt").write_bytes(b"changed")
                if change == "cancel-registration":
                    files[0].write_bytes(b"changed registration")
                return subprocess.CompletedProcess(argv, 1, b"", b"Not confirmed; nothing was uninstalled.")
            self.assertEqual(argv[1:], ["remove", "default", "--yes"])
            for name in ("runtime", "config"):
                if change != "retained-" + name:
                    shutil.rmtree(paths[name])
            for item in files:
                if change != "retained-registration":
                    item.unlink()
            if change == "removed-state":
                shutil.rmtree(paths["state"])
            if change == "changed-state":
                (paths["state"] / "cli-native-default-synthetic-preservation.txt").write_bytes(b"changed")
            return subprocess.CompletedProcess(argv, 0, token.encode() if change == "token-output" else b"Successful!", b"")

        def run():
            with patch.object(native, "service_files", return_value=files), \
                    patch.object(native, "command", side_effect=command), \
                    patch.object(native, "stopped_default") as stopped, \
                    patch.object(native, "verify_runtime", return_value=123):
                native.exercise_default_removal(self.home, "/fixture/agentsdock", {}, "1.0.10-beta.5",
                                               last, self.root / "runtime.tgz", 123, observations)
                self.assertEqual(stopped.call_count, 3)
                self.assertEqual(stopped.call_args.kwargs, {"removed": True})
                self.assertEqual(stopped.call_args.args[1], [401, 402])
            return calls, observations
        return run, paths, retained, unrelated, calls, observations

    def test_default_stop_cancel_then_remove_deletes_runtime_and_token_but_retains_synthetic_history(self):
        run, paths, retained, unrelated, _, _ = self.default_removal_fixture()
        calls, observations = run()
        self.assertEqual(calls, [["stop", "default"], ["remove", "default"], ["remove", "default", "--yes"]])
        self.assertFalse(paths["runtime"].exists())
        self.assertFalse(paths["config"].exists())
        self.assertEqual(retained.read_bytes(), b"synthetic history, not native provider history")
        self.assertEqual(unrelated.read_bytes(), b"leave unrelated paths untouched")
        self.assertTrue(observations["defaultStoppedRemovalCancellationPreservesRuntimeConfigTokenAndSyntheticState"])
        self.assertTrue(observations["defaultRemovalRequiresConfirmationAndPreservesSyntheticState"])
        self.assertNotIn("unit-secret", json.dumps(observations))

    def test_cancelled_default_removal_changes_fail_before_confirmed_removal(self):
        for change in ("cancel-token", "cancel-state", "cancel-registration"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                original = self.home
                self.home = Path(temporary) / "home"
                try:
                    run, _, _, _, calls, observations = self.default_removal_fixture(change)
                    with self.assertRaises((RuntimeError, OSError)):
                        run()
                    self.assertNotIn(["remove", "default", "--yes"], calls)
                    self.assertNotIn("defaultRemovalRequiresConfirmationAndPreservesSyntheticState", observations)
                finally:
                    self.home = original

    def test_confirmed_default_removal_requires_exact_deletion_retention_and_private_output(self):
        for change in ("retained-runtime", "retained-config", "retained-registration", "removed-state", "changed-state", "token-output"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                original = self.home
                self.home = Path(temporary) / "home"
                try:
                    run, _, _, _, _, observations = self.default_removal_fixture(change)
                    with self.assertRaises((RuntimeError, OSError)):
                        run()
                    self.assertNotIn("defaultRemovalRequiresConfirmationAndPreservesSyntheticState", observations)
                finally:
                    self.home = original

    def test_default_stop_proof_requires_both_services_and_both_former_processes_absent(self):
        files = [Path("/fixture/worker"), Path("/fixture/gateway")]
        for removed, states, process, accepted in (
            (False, ["inactive", "absent"], b"", True),
            (False, ["inactive", "active"], b"", False),
            (False, ["absent", "absent"], b"402", False),
            (True, ["absent", "absent"], b"", True),
            (True, ["inactive", "absent"], b"", False),
        ):
            with self.subTest(removed=removed, states=states, process=process), \
                    patch.object(native, "service_state", side_effect=states), \
                    patch.object(native, "command", return_value=subprocess.CompletedProcess([], 0, process, b"")) as command:
                if accepted:
                    native.stopped_default(files, [401, 402], removed=removed, timeout=0)
                else:
                    with self.assertRaises(RuntimeError):
                        native.stopped_default(files, [401, 402], removed=removed, timeout=0)
                self.assertEqual(command.call_count, 2)
                self.assertEqual([call.args[0] for call in command.call_args_list],
                                 [["/bin/ps", "-p", str(pid), "-o", "pid="] for pid in [401, 402]])

    def test_script_refuses_developer_host_without_writing_report(self):
        args = [sys.executable, str(SCRIPT)]
        for key, value in vars(self.args).items():
            args.extend(["--" + key.replace("_", "-"), str(value)])
        environment = {"PATH": os.environ["PATH"], "HOME": str(self.home), "PYTHONDONTWRITEBYTECODE": "1"}
        result = subprocess.run(args, env=environment, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("private output withheld", result.stderr)
        self.assertFalse(self.args.report.exists())
        self.assertFalse(self.args.work.exists())

    def test_workflow_remains_manual_native_only_and_uploads_only_redacted_receipt(self):
        workflow = (SCRIPT.parents[1] / ".github/workflows" / native.WORKFLOW).read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("runner: macos-15", workflow)
        self.assertIn("runner: ubuntu-24.04", workflow)
        self.assertIn("test \"$GITHUB_SHA\" = \"$SOURCE_SHA\"", workflow)
        self.assertIn("--workflow-sha \"$WORKFLOW_SHA\" --harness-ref \"$HARNESS_REF\"", workflow)
        self.assertIn("refs/heads/$SOURCE_REF:refs/remotes/origin/cli-reviewed-product", workflow)
        self.assertLess(workflow.index("verify_harness_source(Namespace("), workflow.index("uv python install 3.13"))
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("astral-sh/setup-uv@d0cc045d04ccac9d8b7881df0226f9e82c39688e", workflow)
        self.assertIn("--pattern agentsdock-cli-receipt.json", workflow)
        self.assertIn("--pattern agents-server-npm-manifest.sig", workflow)
        self.assertNotIn("npm publish", workflow)
        self.assertNotIn("id-token: write", workflow)
        self.assertNotIn("self-hosted", workflow)
        self.assertEqual(workflow.count("path:"), 1)
        self.assertIn("path: ${{ runner.temp }}/cli-native-public/report-${{ matrix.platform }}.json", workflow)

    def test_runtime_inspection_forbids_second_lifecycle_hook_and_dependency_resolution(self):
        archive = self.root / "runtime.tgz"
        version = "1.0.10-beta.5"
        for additions in ({}, {"scripts": {"postinstall": "unreviewed"}},
                          {"dependencies": {"unreviewed": "latest"}}, {"optionalDependencies": {}},
                          {"version": "1.0.9"}, {"private": True}):
            with tarfile.open(archive, "w:gz") as output:
                for name, data in {"package/package.json": json.dumps({"name": "@agentsdock/server", "version": version, **additions}).encode(),
                                   "package/server/VERSION": version.encode()}.items():
                    item = tarfile.TarInfo(name)
                    item.size = len(data)
                    output.addfile(item, io.BytesIO(data))
            if additions:
                with self.subTest(additions=additions), self.assertRaises(RuntimeError):
                    native.inspect_runtime_archive(archive, version)
            else:
                native.inspect_runtime_archive(archive, version)


if __name__ == "__main__":
    unittest.main()
