"""Npm-only native lane unit checks. Never installs software or starts services."""
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
from types import SimpleNamespace
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
    def test_installed_instance_entrypoint_requires_exact_signed_chmod_rule(self):
        member = tarfile.TarInfo("package/server/instances.sh")
        member.mode = 0o644
        rule = b'chmod 755 "$STAGE_DIR/instances.sh"\n'
        self.assertEqual(MOD.native.installed_runtime_mode(member, rule), 0o755)
        for installer in [b"", b'chmod 777 "$STAGE_DIR/instances.sh"\n',
                          b'chmod 755 "$STAGE_DIR/other.sh"\n', rule + rule]:
            with self.subTest(installer=installer), self.assertRaises(RuntimeError):
                MOD.native.installed_runtime_mode(member, installer)
        member.mode = 0o755
        self.assertEqual(MOD.native.installed_runtime_mode(member, b""), 0o755)
        member.mode = 0o777
        with self.assertRaises(RuntimeError):
            MOD.native.installed_runtime_mode(member, rule)
        member.name = "package/server/unrelated.py"
        member.mode = 0o644
        self.assertEqual(MOD.native.installed_runtime_mode(member, rule), 0o644)

    def setUp(self):
        # Every service/installer boundary in this suite must be an explicit fake.
        blocking = patch.object(MOD.native, "bounded_run", side_effect=AssertionError("Unexpected real native command"))
        blocking.start()
        self.addCleanup(blocking.stop)

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
                       "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": "not-a-commit",
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

            with patch.dict(os.environ, self.environment(root), clear=True), \
                    patch.object(MOD.native, "command", side_effect=command), \
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
            with patch.dict(os.environ, self.environment(root), clear=True), \
                    patch.object(MOD.native, "command", side_effect=command), self.assertRaises(RuntimeError):
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

            def command(stage, argv, **kwargs):
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

            def restart(fixture, diagnostics=None):
                self.assertTrue((args.work / "npm-prefix-retired").is_dir())
                self.assertTrue((args.work / "npm-cache-retired").is_dir())
                self.assertFalse((args.work / "npm-prefix").exists())

            with patch.object(MOD.native, "ensure_empty") as empty, \
                    patch.object(MOD, "command", side_effect=command), \
                    patch.object(MOD.native, "token_at", return_value="private-fixture-token"), \
                    patch.object(MOD.native, "health", side_effect=[
                        {"server_identity": "fixture", "server_instance_id": "first"},
                        {"server_identity": "fixture", "server_instance_id": "first"},
                        {"server_identity": "fixture", "server_instance_id": "restarted"}]), \
                    patch.object(MOD.native, "registered_services"), \
                    patch.object(MOD.native, "verify_installed_runtime", return_value=42) as runtime, \
                    patch.object(MOD, "restart_services", side_effect=restart):
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
            with patch.dict(os.environ, {**self.environment(root), "GITHUB_SHA": "d" * 40}, clear=True):
                report = MOD.report(args, self.descriptor(args), phase="complete", observations={"nativeServiceInstalled": True})
            self.assertEqual(report["kind"], "agentsdock-npm-native-validation")
            self.assertFalse(report["productPublicationEligible"])
            self.assertEqual((report["runId"], report["runAttempt"]), ("123", "1"))
            self.assertEqual(report["sourceSha"], args.source_sha)
            self.assertEqual(report["harnessSha"], "d" * 40)
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

    def test_guard_diagnostics_expose_only_fixed_booleans_and_do_not_relax_selectors(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            args, env = self.arguments(root), self.environment(root)
            env.update(XDG_CONFIG_HOME=str(root / "account/.config"), PRIVATE_TOKEN="never-print-this")
            result = MOD.guard_diagnostics(args, environment=env)
            self.assertTrue(result["selectorsPresent"]["XDG_CONFIG_HOME"])
            self.assertTrue(result["checks"]["xdgConfigMatchesDefault"])
            self.assertFalse(result["checks"]["xdgConfigLiteralDefault"])
            self.assertEqual(set(result["selectorsPresent"]), set(MOD.native.SELECTORS))
            for field in ("checks", "selectorsPresent", "home", "temporary"):
                self.assertTrue(all(type(value) is bool for value in result[field].values()))
            self.assertNotIn(str(root), json.dumps(result))
            self.assertNotIn("never-print-this", json.dumps(result))
            self.assertNotIn("PRIVATE_TOKEN", json.dumps(result))
            before = dict(env)
            # The fixture account must not depend on a macOS-specific UID
            # existing in the host passwd database (Linux runners use another).
            with patch.object(MOD.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=str(root / "actual-account"))), \
                    self.assertRaises(RuntimeError):
                MOD.guard(args, environment=env, uid=501, system="Linux")
            self.assertEqual(env, before)

    def test_only_observed_real_account_linux_xdg_default_is_removed_after_all_guards(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            args, env = self.arguments(root), self.environment(root)
            env.update(XDG_CONFIG_HOME=str(root / "account/.config"), UNRELATED_VALUE="preserved")
            before = dict(env)
            with patch.object(MOD.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=str(root / "account"))):
                self.assertEqual(MOD.guard(args, environment=env, uid=501, system="Linux"), root / "account")
            self.assertEqual(env, {key: value for key, value in before.items() if key != "XDG_CONFIG_HOME"})
            self.assertTrue(args.default_xdg_normalized)
            # An unset selector remains unset; no other environment normalization.
            args = self.arguments(root)
            before = dict(env)
            MOD.guard(args, environment=env, uid=501, system="Linux")
            self.assertEqual(env, before)
            self.assertFalse(args.default_xdg_normalized)

    def test_rejected_xdg_other_selectors_and_host_path_failures_leave_environment_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            base = {**self.environment(root), "XDG_CONFIG_HOME": str(root / "account/.config")}
            cases = [{"environment": {"XDG_CONFIG_HOME": "/custom/config"}},
                     {"environment": {"XDG_CONFIG_HOME": "$HOME/.config"}},
                     {"environment": {"XDG_CONFIG_HOME": str(root / "account/.config/") + "/"}},
                     {"environment": {"RUNNER_OS": "macOS"}, "system": "Darwin"},
                     {"uid": 0}, {"environment": {"RUNNER_ENVIRONMENT": "self-hosted"}},
                     {"badpath": True}, {"wronghome": True}]
            cases += [{"environment": {name: "/custom"}} for name in MOD.native.SELECTORS if name != "XDG_CONFIG_HOME"]
            for case in cases:
                args = self.arguments(root)
                if case.get("badpath"):
                    args.work = root
                env = {**base, **case.get("environment", {})}
                before = dict(env)
                account = root / ("different-account" if case.get("wronghome") else "account")
                with self.subTest(case=case), \
                        patch.object(MOD.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=str(account))), \
                        self.assertRaises(RuntimeError):
                    MOD.guard(args, environment=env, uid=case.get("uid", 501),
                              system=case.get("system", "Linux"), machine="arm64")
                self.assertEqual(env, before)

    def test_harness_allowlist_rejects_runtime_key_verifier_unrelated_files_and_modes(self):
        def raw(path, old="100644", new="100644", status="M"):
            return f":{old} {new} aaaaaaa bbbbbbb {status}\0{path}\0".encode()
        MOD.validate_harness_diff(b"")
        for path in MOD.HARNESS_FILES:
            MOD.validate_harness_diff(raw(path))
        for path in ["server/VERSION", "server/agent_server.py", "server/release-public-key.pem",
                     "server/package.json", "electron/package.json", "scripts/verify_npm_publication.mjs",
                     "scripts/product_server_acceptance.py", ".github/workflows/server-npm-publish.yml",
                     "scripts/unrelated_harness.py", "docs/DEV_LOG.md/other"]:
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                MOD.validate_harness_diff(raw(path))
        for old, new, status in [("100644", "120000", "T"), ("100644", "100755", "M"),
                                 ("120000", "120000", "M"), ("160000", "160000", "M"),
                                 ("000000", "100644", "A"), ("100644", "000000", "D")]:
            with self.subTest(mode=(old, new, status)), self.assertRaises(RuntimeError):
                MOD.validate_harness_diff(raw("scripts/npm_native_acceptance.py", old, new, status))
        with self.assertRaises(RuntimeError):
            MOD.validate_harness_diff(raw("docs/DEV_LOG.md")[:-1])

    def test_separate_harness_sha_must_be_actual_clean_checkout_and_descend_from_frozen_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            args = self.arguments(Path(temporary))
            harness = "d" * 40
            calls = []

            def execute(argv, **kwargs):
                calls.append(argv)
                if argv[-1] == "HEAD":
                    return subprocess.CompletedProcess(argv, 0, harness.encode(), b"")
                return subprocess.CompletedProcess(argv, 0, b"", b"")

            with patch.dict(os.environ, {"GITHUB_SHA": harness}), patch.object(MOD.native, "command", side_effect=execute):
                self.assertEqual(MOD.verify_harness_source(args), harness)
            self.assertIn(["git", "-C", str(MOD.ROOT), "merge-base", "--is-ancestor", args.source_sha, harness], calls)
            self.assertIn(["git", "-C", str(MOD.ROOT), "diff", "--raw", "--no-renames", "-z", args.source_sha, harness, "--"], calls)
            with patch.dict(os.environ, {"GITHUB_SHA": harness}), \
                    patch.object(MOD.native, "command", side_effect=[
                        subprocess.CompletedProcess([], 0, harness.encode(), b""),
                        subprocess.CompletedProcess([], 0, b"", b""), RuntimeError("not an ancestor")]) as execute, \
                    self.assertRaises(RuntimeError):
                MOD.verify_harness_source(args)
            self.assertEqual(execute.call_count, 3)

    def test_real_disposable_git_provenance_binds_checkout_ancestry_exact_paths_and_modes(self):
        cases = ["equal", "allowed", "runtime", "key", "verifier", "shared-helper", "unrelated-file",
                 "added-allowed", "deleted-allowed", "renamed-allowed", "symlink", "executable-mode",
                 "unrelated-ancestry", "dirty", "spoofed-workflow-sha"]
        with tempfile.TemporaryDirectory() as temporary:
            for index, case in enumerate(cases):
                with self.subTest(case=case):
                    root = Path(temporary) / f"repo-{index}"
                    root.mkdir()

                    def git(*arguments):
                        return subprocess.run(["git", "-C", str(root), *arguments], check=True,
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10).stdout

                    def commit():
                        git("add", "-A")
                        git("-c", "user.name=Native unit fixture", "-c", "user.email=native-unit@example.invalid",
                            "commit", "--quiet", "--allow-empty", "-m", "Disposable provenance fixture")
                        return git("rev-parse", "HEAD").decode().strip()

                    git("init", "--quiet")
                    git("config", "core.filemode", "true")
                    paths = MOD.HARNESS_FILES | {"server/agent_server.py", "server/release-public-key.pem",
                                                "scripts/verify_npm_publication.mjs", "scripts/product_server_acceptance.py"}
                    for name in paths:
                        if case == "added-allowed" and name == "docs/DEV_LOG.md":
                            continue
                        path = root / name
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_text("source fixture\n")
                    args = self.arguments(root)
                    args.source_sha = commit()
                    harness = args.source_sha
                    changes = {"allowed": "docs/DEV_LOG.md", "runtime": "server/agent_server.py",
                               "key": "server/release-public-key.pem", "verifier": "scripts/verify_npm_publication.mjs",
                               "shared-helper": "scripts/product_server_acceptance.py", "unrelated-file": "scripts/unrelated.py",
                               "added-allowed": "docs/DEV_LOG.md"}
                    if case in changes:
                        changed = root / changes[case]
                        changed.parent.mkdir(parents=True, exist_ok=True)
                        changed.write_text("changed fixture\n")
                    elif case == "deleted-allowed":
                        (root / "docs/DEV_LOG.md").unlink()
                    elif case == "renamed-allowed":
                        (root / "docs/DEV_LOG.md").rename(root / "docs/RENAMED.md")
                    elif case == "symlink":
                        path = root / "scripts/npm_native_acceptance.py"
                        path.unlink()
                        path.symlink_to("product_server_acceptance.py")
                    elif case == "executable-mode":
                        (root / "scripts/npm_native_acceptance.py").chmod(0o755)
                    elif case == "unrelated-ancestry":
                        git("checkout", "--orphan", "unrelated", "--quiet")
                        (root / "docs/DEV_LOG.md").write_text("Unrelated root commit\n")
                    if case not in {"equal", "dirty"}:
                        harness = commit()
                    if case == "dirty":
                        (root / "docs/DEV_LOG.md").write_text("uncommitted fixture\n")
                    workflow = args.source_sha if case == "spoofed-workflow-sha" else harness

                    def execute(argv, **kwargs):
                        self.assertEqual(argv[:3], ["git", "-C", str(root)])
                        result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
                        if result.returncode:
                            raise RuntimeError("Rejected disposable git provenance")
                        return result

                    with patch.object(MOD, "ROOT", root), patch.dict(os.environ, {"GITHUB_SHA": workflow}), \
                            patch.object(MOD.native, "command", side_effect=execute):
                        if case in {"equal", "allowed"}:
                            self.assertEqual(MOD.verify_harness_source(args), harness)
                        else:
                            with self.assertRaises(RuntimeError):
                                MOD.verify_harness_source(args)

    def test_command_diagnostics_contain_only_fixed_stage_exit_and_outcome(self):
        diagnostics = {}
        result = subprocess.CompletedProcess([], 5, b"private-token", b"/private/profile")
        with patch.object(MOD.native, "bounded_run", return_value=result), self.assertRaises(RuntimeError):
            MOD.command("launchd-bootstrap", ["/private/command"], diagnostics=diagnostics)
        self.assertEqual(diagnostics, {"commandStage": "launchd-bootstrap", "outcome": "failed", "exitStatus": 5})
        self.assertNotIn("private", json.dumps(diagnostics))
        for stage, outcome, status in [("private-path", "failed", 1), ("cli-install", "private-token", 1),
                                       ("cli-install", "failed", "private-output")]:
            with self.assertRaises(RuntimeError):
                MOD.diagnostic({}, stage, outcome, status)

    def test_launchd_queries_require_exact_target_and_proven_absence(self):
        for code, output, expected in [(0, b"", "loaded"), (113, b"Could not find service", "absent"),
                                       (3, b"No such process", "absent"), (5, b"unknown failure", None)]:
            with patch.object(MOD, "command", return_value=subprocess.CompletedProcess([], code, b"", output)):
                if expected:
                    self.assertEqual(MOD.launchd_query_state(f"gui/{os.getuid()}/com.agentsdock.server"), expected)
                else:
                    with self.assertRaises(RuntimeError):
                        MOD.launchd_query_state(f"gui/{os.getuid()}/com.agentsdock.server")
        with patch.object(MOD, "command") as command, self.assertRaises(RuntimeError):
            MOD.launchd_query_state(f"gui/{os.getuid()}/unrelated.service")
        command.assert_not_called()

    def test_launchd_bootout_waits_for_absence_and_rejects_still_loaded_error(self):
        item = Path("/owned/com.agentsdock.server.plist")
        with patch.object(MOD, "launchd_registration"), \
                patch.object(MOD, "launchd_state", side_effect=["loaded", "loaded", "absent"]) as state, \
                patch.object(MOD, "command", return_value=subprocess.CompletedProcess([], 0, b"", b"")), \
                patch.object(MOD.time, "sleep"):
            MOD.stop_launchd(item, "a" * 64)
        self.assertEqual(state.call_count, 3)
        with patch.object(MOD, "launchd_registration"), patch.object(MOD, "launchd_state", return_value="loaded"), \
                patch.object(MOD, "command", return_value=subprocess.CompletedProcess([], 5, b"", b"private")), \
                self.assertRaises(RuntimeError):
            MOD.stop_launchd(item, "a" * 64)

    def test_launchd_bootstrap_retries_only_known_transient_and_proves_registration(self):
        item = Path("/owned/com.agentsdock.server.plist")
        transient = subprocess.CompletedProcess([], 5, b"", b"Bootstrap failed: 5: Input/output error")
        success = subprocess.CompletedProcess([], 0, b"", b"")
        with patch.object(MOD, "launchd_registration"), patch.object(MOD, "wait_launchd_absent") as absent, \
                patch.object(MOD, "command", side_effect=[transient, success]) as command, \
                patch.object(MOD, "launchd_state", return_value="loaded"), patch.object(MOD.time, "sleep"):
            MOD.start_launchd(item, "a" * 64)
        self.assertEqual(command.call_count, 2)
        self.assertEqual(absent.call_count, 2)
        for failure in [subprocess.CompletedProcess([], 5, b"", b"unknown failure"), transient]:
            with patch.object(MOD, "launchd_registration"), patch.object(MOD, "wait_launchd_absent"), \
                    patch.object(MOD, "command", return_value=failure) as command, \
                    patch.object(MOD.time, "sleep"), self.assertRaises(RuntimeError):
                MOD.start_launchd(item, "a" * 64)
            self.assertLessEqual(command.call_count, 3)
        with patch.object(MOD, "launchd_registration"), patch.object(MOD, "wait_launchd_absent"), \
                patch.object(MOD, "command", return_value=success), patch.object(MOD, "launchd_state", return_value="absent"), \
                self.assertRaises(RuntimeError):
            MOD.start_launchd(item, "a" * 64)

    def test_launchd_wait_is_bounded_and_changed_or_wrong_label_never_bootstraps(self):
        with patch.object(MOD.time, "monotonic", side_effect=[0, 0.1, 0.3]), patch.object(MOD.time, "sleep"), \
                patch.object(MOD, "launchd_state", return_value="loaded"), self.assertRaises(RuntimeError):
            MOD.wait_launchd_absent(Path("/owned/com.agentsdock.server.plist"), "a" * 64, timeout=0.25)
        with tempfile.TemporaryDirectory() as temporary:
            item = Path(temporary) / "com.agentsdock.server.plist"
            original = plistlib.dumps({"Label": "com.agentsdock.server"})
            item.write_bytes(original)
            expected = MOD.native.sha(original)
            MOD.launchd_registration(item, expected)
            for payload, expected_hash in [(plistlib.dumps({"Label": "other.service"}), None),
                                           (plistlib.dumps({"Label": "com.agentsdock.server", "changed": True}), expected)]:
                item.write_bytes(payload)
                with patch.object(MOD, "command") as command, self.assertRaises(RuntimeError):
                    MOD.start_launchd(item, expected_hash or MOD.native.sha(payload))
                command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
