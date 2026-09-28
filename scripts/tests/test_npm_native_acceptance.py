"""Npm-only native lane unit checks. Never installs software or starts services."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "npm_native_acceptance.py"
sys.path.insert(0, str(SCRIPT.parent))
try:
    SPEC = importlib.util.spec_from_file_location("npm_native_acceptance", SCRIPT)
    MOD = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(MOD)
finally:
    sys.path.pop(0)


class NpmNativeAcceptanceTests(unittest.TestCase):
    def arguments(self, root):
        return argparse.Namespace(assets=root / "inputs/npm", release=root / "inputs/release.json",
                                  work=root / "agentsdock-npm-native-linux", report=root / "public/report.json",
                                  source_sha="a" * 40, source_ref="release/npm-1.0.7", manifest_sha256="b" * 64)

    def environment(self, root):
        return {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
                "GITHUB_REPOSITORY": "ZhengyiLuo/AgentsDock", "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_JOB": "npm-native",
                "GITHUB_WORKFLOW_REF": "ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/release/npm-1.0.7",
                "GITHUB_REF": "refs/heads/release/npm-1.0.7", "GITHUB_SHA": "a" * 40,
                "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1", "RUNNER_OS": "Linux",
                "NPM_NATIVE_VALIDATION": "true", "CANDIDATE_REPLAY": "false",
                "RUNNER_TEMP": str(root), "HOME": str(root / "account")}

    def descriptor(self, args):
        return {"version": "1.0.7", "commit": args.source_sha,
                "archive": {"name": "server-1.0.7.tgz", "sha256": "c" * 64}}

    def draft(self, args):
        body = {"Candidate type": "npm-server-v1", "Source repository": "ZhengyiLuo/AgentsDock",
                "Source commit": args.source_sha, "Source ref": args.source_ref, "Update track": "stable",
                "Npm manifest SHA256": args.manifest_sha256}
        return {"tagName": "npm-candidate-v1.0.7", "isDraft": True, "targetCommitish": args.source_sha,
                "assets": [{"name": name} for name in [MOD.MANIFEST, MOD.SIGNATURE, "server-1.0.7.tgz"]],
                "body": "\n".join(f"{key}: {value}" for key, value in body.items())}

    def test_host_guard_requires_explicit_exact_source_and_unredirected_native_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            args, env = self.arguments(root), self.environment(root)
            self.assertEqual(MOD.guard(args, environment=env, uid=501, system="Linux"), root / "account")
            self.assertEqual(MOD.guard(args, environment={**env, "RUNNER_OS": "macOS"}, uid=501,
                                       system="Darwin", machine="arm64"), root / "account")
            changes = {"GITHUB_ACTIONS": "false", "RUNNER_ENVIRONMENT": "self-hosted",
                       "GITHUB_REPOSITORY": "other/AgentsDock", "GITHUB_EVENT_NAME": "pull_request", "GITHUB_JOB": "candidate-native",
                       "GITHUB_WORKFLOW_REF": "ZhengyiLuo/AgentsDock/.github/workflows/product-release-acceptance.yml@refs/heads/main",
                       "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": "d" * 40,
                       "GITHUB_RUN_ID": "0", "GITHUB_RUN_ATTEMPT": "", "RUNNER_OS": "macOS",
                       "NPM_NATIVE_VALIDATION": "false", "CANDIDATE_REPLAY": "true", "HOME": ".", "RUNNER_TEMP": "."}
            for name, value in changes.items():
                with self.subTest(name=name), self.assertRaises(RuntimeError):
                    MOD.guard(args, environment={**env, name: value}, uid=501, system="Linux")
            for selector in MOD.native.SELECTORS:
                with self.subTest(selector=selector), self.assertRaises(RuntimeError):
                    MOD.guard(args, environment={**env, selector: "/other"}, uid=501, system="Linux")
            for uid, system in [(0, "Linux"), (501, "Windows"), (501, "Darwin")]:
                with self.assertRaises(RuntimeError):
                    MOD.guard(args, environment=env, uid=uid, system=system, machine="x86_64")
            for ref in ["feature/test", "release/x/../y", "release/x.lock", "release/x//y", "release/x."]:
                with self.subTest(ref=ref):
                    self.assertFalse(MOD.reviewed_ref(ref))
            self.assertTrue(MOD.reviewed_ref("main"))

    def test_guard_refuses_existing_linked_and_broad_paths_without_writes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            args, env = self.arguments(root), self.environment(root)
            args.work.mkdir()
            with self.assertRaises(RuntimeError):
                MOD.guard(args, environment=env, uid=501, system="Linux")
            args.work.rmdir()
            for key, value in [("work", root), ("report", root / "../report"), ("assets", root / "inputs/other")]:
                changed = copy.copy(args)
                setattr(changed, key, value)
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    MOD.guard(changed, environment=env, uid=501, system="Linux")
            (root / "inputs").symlink_to(root)
            with self.assertRaises(RuntimeError):
                MOD.guard(args, environment=env, uid=501, system="Linux")

    def test_actual_draft_identity_rejects_missing_extra_duplicate_and_moved_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = self.arguments(Path(temporary))
            descriptor, draft = self.descriptor(args), self.draft(args)
            self.assertEqual(len(MOD.validate_draft(draft, descriptor, args)), 3)
            changes = [{"isDraft": False}, {"tagName": "v1.0.7"}, {"targetCommitish": "main"},
                       {"assets": draft["assets"][:2]}, {"assets": draft["assets"] + [{"name": "extra"}]},
                       {"assets": [draft["assets"][0]] * 3}, {"assets": [None]}, {"body": None},
                       {"body": draft["body"] + "\nSource commit: " + args.source_sha},
                       {"body": draft["body"].replace(args.source_ref, "release/other")},
                       {"body": draft["body"].replace(args.manifest_sha256, "d" * 64)}]
            for change in changes:
                with self.subTest(change=change), self.assertRaises(RuntimeError):
                    MOD.validate_draft({**draft, **change}, descriptor, args)

    def test_inspection_runs_production_signature_verifier_before_any_native_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            args = self.arguments(root)
            args.assets.mkdir(parents=True)
            args.report.parent.mkdir()
            descriptor = self.descriptor(args)
            manifest = json.dumps(descriptor).encode()
            args.manifest_sha256 = MOD.native.sha(manifest)
            (args.assets / MOD.MANIFEST).write_bytes(manifest)
            (args.assets / MOD.SIGNATURE).write_bytes(b"s" * 64)
            (args.assets / "server-1.0.7.tgz").write_bytes(b"fixture; not a real archive")
            args.release.write_text(json.dumps(self.draft(args)))
            calls = []

            def command(argv, **kwargs):
                calls.append(argv)
                if argv[0] == "git":
                    return subprocess.CompletedProcess(argv, 0, args.source_sha.encode() if argv[-1] == "HEAD" else b"", b"")
                raise RuntimeError("Invalid fixture signature")

            with patch.object(MOD.native, "command", side_effect=command), \
                    patch.object(MOD.native, "ensure_empty") as empty, self.assertRaises(RuntimeError):
                MOD.inspect_candidate(args)
            empty.assert_not_called()
            self.assertEqual(calls[-1][0], "node")
            self.assertTrue(calls[-1][1].endswith("verify_npm_publication.mjs"))
            self.assertEqual(calls[-1][2:], ["inspect", str(args.assets), args.source_sha,
                                            args.manifest_sha256, str(args.release)])
            # Even a regular-looking extra asset fails before cryptographic inspection.
            (args.assets / "extra").write_bytes(b"extra")
            calls.clear()
            with patch.object(MOD.native, "command", side_effect=command), self.assertRaises(RuntimeError):
                MOD.inspect_candidate(args)
            self.assertTrue(all(call[0] == "git" for call in calls))

    def test_native_exercise_orders_real_cli_refusal_cache_retirement_and_restart(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            args, descriptor = self.arguments(root), self.descriptor(self.arguments(root))
            home = root / "account"
            for path in MOD.native.paths(home).values():
                path.mkdir(parents=True)
            calls, install_count, phases = [], 0, []

            def command(argv, **kwargs):
                nonlocal install_count
                calls.append(argv)
                if argv[0] == "npm":
                    (args.work / "npm-prefix").mkdir()
                    (args.work / "npm-cache").mkdir()
                    return subprocess.CompletedProcess(argv, 0, b"", b"")
                if argv[-1] == "--version":
                    return subprocess.CompletedProcess(argv, 0, b"1.0.7\n", b"")
                install_count += 1
                if install_count == 2:
                    self.assertEqual(kwargs["allowed"], (1,))
                    return subprocess.CompletedProcess(argv, 1, b"", b"Existing installation")
                return subprocess.CompletedProcess(argv, 0, b"", b"")

            def restart(fixture, action):
                self.assertEqual(action, "restart")
                self.assertTrue((args.work / "npm-prefix-retired").is_dir())
                self.assertTrue((args.work / "npm-cache-retired").is_dir())
                self.assertFalse((args.work / "npm-prefix").exists())

            with patch.object(MOD.native, "ensure_empty") as empty, \
                    patch.object(MOD.native, "command", side_effect=command), \
                    patch.object(MOD.native, "token_at", return_value="private-fixture-token"), \
                    patch.object(MOD.native, "health", side_effect=[
                        {"server_identity": "fixture", "server_instance_id": "first"},
                        {"server_identity": "fixture", "server_instance_id": "first"},
                        {"server_identity": "fixture", "server_instance_id": "restarted"}]), \
                    patch.object(MOD.native, "registered_services"), \
                    patch.object(MOD.native, "verify_installed_runtime", return_value=42) as runtime, \
                    patch.object(MOD.native, "service", side_effect=restart):
                observations = MOD.exercise(args, descriptor, home, progress=phases.append)
            empty.assert_called_once_with(home)
            self.assertEqual(runtime.call_count, 2)
            self.assertEqual(observations["exactRuntimeFilesCompared"], 42)
            self.assertIn("--offline", calls[0])
            self.assertIn("--ignore-scripts", calls[0])
            self.assertEqual(install_count, 2)
            self.assertEqual(phases, ["clean-host", "package-stage", "install", "initial-health",
                                      "runtime-verification", "existing-refusal", "cache-retirement",
                                      "service-restart", "post-restart-verify"])
            self.assertNotIn("private-fixture-token", json.dumps(observations))

    def test_report_is_run_bound_scoped_and_truthful_without_private_fixture_values(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            args = self.arguments(root)
            with patch.dict(os.environ, self.environment(root), clear=True):
                report = MOD.report(args, self.descriptor(args), phase="complete", observations={"nativeServiceInstalled": True})
            self.assertEqual(report["kind"], "agentsdock-npm-native-validation")
            self.assertFalse(report["productPublicationEligible"])
            self.assertEqual((report["runId"], report["runAttempt"]), ("123", "1"))
            self.assertEqual(report["sourceSha"], args.source_sha)
            self.assertEqual(report["manifestSha256"], args.manifest_sha256)
            self.assertEqual(report["archiveSha256"], "c" * 64)
            self.assertEqual(report["status"], "passed")
            self.assertIn("provider-chat", report["notTested"])
            self.assertIn("legacy-migration", report["notTested"])
            self.assertIn("logout-or-reboot", report["notTested"])
            self.assertNotIn(str(root), json.dumps(report))
            self.assertLess(len(json.dumps(report)), 8192)
            with patch.dict(os.environ, self.environment(root), clear=True):
                failed = MOD.report(args, self.descriptor(args), phase="service-restart")
                self.assertEqual(failed["status"], "failed")
                self.assertEqual(failed["phase"], "service-restart")
                self.assertEqual(failed["observations"], {})
                with self.assertRaises(RuntimeError):
                    MOD.report(args, None, phase="private exception or path")


if __name__ == "__main__":
    unittest.main()
