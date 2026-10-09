"""Read-only guard/receipt tests. Never create native services or spoof a host."""
from argparse import Namespace
import importlib.util
import io
import json
import os
from pathlib import Path
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
