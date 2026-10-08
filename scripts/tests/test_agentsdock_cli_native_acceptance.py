"""Read-only guard/receipt tests. Never create native services or spoof a host."""
from argparse import Namespace
import importlib.util
import io
import json
import os
from pathlib import Path
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
