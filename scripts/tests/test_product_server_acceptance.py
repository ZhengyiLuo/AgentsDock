"""Unit-test native harness safety/claims, never start host services."""
import copy
import argparse
import ast
from contextlib import ExitStack
import importlib.util
import io
import http.server
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("product_server_acceptance", Path(__file__).resolve().parents[1] / "product_server_acceptance.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class NativeServerAcceptanceUnitTests(unittest.TestCase):
    @staticmethod
    def npm_baseline_identity(profile):
        return {"version": MOD.NPM_BASELINE_VERSIONS[profile], "track": "stable" if profile == "stable108" else "beta",
                "sourceSha": "b" * 40, "manifestSha256": "c" * 64, "signatureSha256": "d" * 64,
                "archiveSha256": "e" * 64, "archiveBytes": 123}

    def test_npm_baseline_cli_arguments_and_scope_fail_before_installation(self):
        common = ["bootstrap", "--receipt", "/receipt", "--bundle", "/bundle", "--work", "/work",
                  "--fixture", "/fixture", "--evidence", "/evidence", "--receipt-sha256", "f" * 64]
        args = MOD.parser().parse_args([*common, "--candidate", "--kind", "npm-baseline",
                                       "--baseline-profile", "stable108", "--baseline-npm-directory", "/runner/baseline"])
        receipt = {"version": "1.0.9"}
        with patch.object(MOD.sys, "platform", "darwin"), patch.dict(os.environ, {"RUNNER_TEMP": "/runner"}):
            MOD.validate_baseline_arguments(args, receipt)
            cases = [{"candidate": False}, {"candidate_server_linux": True}, {"kind": "fresh"}, {"kind": "legacy"},
                     {"baseline_profile": None}, {"baseline_profile": "beta"}, {"baseline_npm_directory": None},
                     {"baseline_npm_directory": Path("/outside")}, {"baseline_archive": Path("/legacy.tgz")},
                     {"staging_failure_fixture": True}, {"legacy_root_mode": "0777"}, {"operation": "verify"}]
            for change in cases:
                with self.subTest(change=change), patch.object(MOD, "ensure_empty") as empty, \
                        patch.object(MOD, "command") as command, self.assertRaises(RuntimeError):
                    MOD.bootstrap(argparse.Namespace(**{**vars(args), **change}), receipt, Path("/account"))
                empty.assert_not_called()
                command.assert_not_called()
            for version in ("1.0.8", "1.0.9-beta.1", "1.0.10"):
                with self.assertRaises(RuntimeError): MOD.validate_baseline_arguments(args, {"version": version})
            with patch.object(MOD.sys, "platform", "linux"), self.assertRaises(RuntimeError):
                MOD.validate_baseline_arguments(args, receipt)
            with patch.object(MOD, "verify_npm_baseline", side_effect=RuntimeError("Unverified baseline")), \
                    patch.object(MOD, "ensure_empty") as empty, patch.object(MOD, "command") as command, \
                    self.assertRaisesRegex(RuntimeError, "Unverified baseline"):
                MOD.bootstrap(args, receipt, Path("/account"))
            empty.assert_not_called()
            command.assert_not_called()
            loaded = argparse.Namespace(**{**vars(args), "operation": "verify", "baseline_profile": None,
                                           "baseline_npm_directory": None})
            MOD.validate_baseline_arguments(loaded, receipt)

    def test_npm_baseline_verifier_requires_exact_profile_and_bounded_distinct_identity(self):
        for profile, target in ((profile, target) for profile, targets in MOD.NPM_BASELINE_TARGETS.items() for target in targets):
            expected = self.npm_baseline_identity(profile)
            result = subprocess.CompletedProcess([], 0, json.dumps(expected).encode(), b"")
            with patch.object(MOD, "command", return_value=result) as command:
                self.assertEqual(MOD.verify_npm_baseline(profile, Path("/baseline"), target), expected)
                self.assertEqual(command.call_args.args[0][2:], ["verify-baseline-server", profile, "/baseline", target])
            for change in ({"version": target}, {"track": "rc"}, {"sourceSha": "invalid"},
                           {"manifestSha256": "invalid"}, {"archiveBytes": True}, {"archiveBytes": -1}, {"accepted": True}):
                result.stdout = json.dumps({**expected, **change}).encode()
                with patch.object(MOD, "command", return_value=result), self.assertRaises(RuntimeError):
                    MOD.verify_npm_baseline(profile, Path("/baseline"), target)
        for profile, version in (("unknown", "1.0.9"), ("stable108", "1.0.9-beta.1"), ("beta1085", "1.0.8-beta.5"),
                                 ("beta1101", "1.0.9"), ("beta1101", "1.0.10-beta.5"),
                                 ("beta1101", "1.0.10-beta.3+local"), ("stable108", "1.0.10-beta.2"),
                                 ("stable108", "1.0.10-beta.3"), ("beta1085", "1.0.10-beta.3"),
                                 ("beta1101", "1.0.10-beta.4+local"), ("stable108", "1.0.10-beta.4"),
                                 ("beta1085", "1.0.10-beta.4")):
            with patch.object(MOD, "command") as command, self.assertRaises(RuntimeError):
                MOD.verify_npm_baseline(profile, Path("/baseline"), version)
            command.assert_not_called()

    def test_beta1101_baseline_arguments_are_exact_beta2_beta3_and_beta4_mac_candidates_only(self):
        self.assertEqual(MOD.NPM_BASELINE_TARGETS, {
            "stable108": ("1.0.9",), "beta1085": ("1.0.9",),
            "beta1101": ("1.0.10-beta.2", "1.0.10-beta.3", "1.0.10-beta.4"),
        })
        args = argparse.Namespace(operation="bootstrap", kind="npm-baseline", candidate=True, candidate_server_linux=False,
                                  baseline_profile="beta1101", baseline_npm_directory=Path("/runner/baseline"),
                                  legacy_root_mode="0755")
        with patch.object(MOD.sys, "platform", "darwin"), patch.dict(os.environ, {"RUNNER_TEMP": "/runner"}):
            for version in ("1.0.9", "1.0.10-beta.1", "1.0.10-beta.5", "1.0.10",
                            "1.0.10-beta.3+local", "1.0.10-beta.4+local"):
                with self.assertRaises(RuntimeError): MOD.validate_baseline_arguments(args, {"version": version})
            for version in ("1.0.10-beta.2", "1.0.10-beta.3", "1.0.10-beta.4"):
                MOD.validate_baseline_arguments(args, {"version": version})
                for change in ({"candidate": False}, {"candidate_server_linux": True}, {"staging_failure_fixture": True},
                               {"baseline_profile": "beta1085"}, {"baseline_npm_directory": Path("/outside")},
                               {"baseline_archive": Path("/legacy.tgz")}):
                    with self.subTest(version=version, change=change), self.assertRaises(RuntimeError):
                        MOD.validate_baseline_arguments(argparse.Namespace(**{**vars(args), **change}), {"version": version})
                with patch.object(MOD.sys, "platform", "linux"), self.assertRaises(RuntimeError):
                    MOD.validate_baseline_arguments(args, {"version": version})

    def test_npm_baseline_installation_policy_does_not_relax_candidate_or_other_files(self):
        original = MOD.installed_runtime_mode
        member = tarfile.TarInfo("package/server/instances.sh")
        member.mode = 0o644
        installer = b'chmod 755 "$STAGE_DIR/instances.sh"\n'
        self.assertEqual(original(member, installer), 0o644)
        with MOD.npm_baseline_installation_policy("1.0.8"):
            self.assertEqual(MOD.installed_runtime_mode(member, installer), 0o755)
            for invalid in (b"", b"# " + installer, installer + installer):
                with self.assertRaises(RuntimeError): MOD.installed_runtime_mode(member, invalid)
            member.name = "package/server/unrelated.sh"
            self.assertEqual(MOD.installed_runtime_mode(member, installer), 0o644)
        self.assertIs(MOD.installed_runtime_mode, original)
        member.name = "package/server/instances.sh"
        with MOD.npm_baseline_installation_policy("1.0.8-beta.5"):
            self.assertEqual(MOD.installed_runtime_mode(member, installer), 0o644)
        with self.assertRaises(RuntimeError), MOD.npm_baseline_installation_policy("1.0.9"):
            self.fail("Candidate mode policy must not be changed.")
        with self.assertRaisesRegex(RuntimeError, "fixture error"):
            with MOD.npm_baseline_installation_policy("1.0.8"):
                raise RuntimeError("fixture error")
        self.assertIs(MOD.installed_runtime_mode, original)

    def test_npm_baseline_bootstrap_uses_baseline_cli_and_retires_both_prefixes_before_restart(self):
        for profile, target in ((profile, target) for profile, targets in MOD.NPM_BASELINE_TARGETS.items() for target in targets):
            for root_mode in ("0755", "0750"):
                with self.subTest(profile=profile, target=target, root_mode=root_mode), tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
                    root = Path(temporary).resolve()
                    home, work, bundle, inputs = (root / name for name in ("account", "work", "candidate", "baseline"))
                    home.mkdir()
                    (bundle / "npm").mkdir(parents=True)
                    inputs.mkdir()
                    identity = self.npm_baseline_identity(profile)
                    baseline = identity["version"]
                    for name in ("agents-server-npm-manifest.json", "agents-server-npm-manifest.sig", f"server-{baseline}.tgz"):
                        (inputs / name).write_bytes(b"independently verified fixture input")
                    (bundle / "npm/agents-server-npm-manifest.json").write_text(json.dumps({"archive": {"name": f"server-{target}.tgz"}}))
                    args = argparse.Namespace(operation="bootstrap", kind="npm-baseline", candidate=True, candidate_server_linux=False,
                        baseline_profile=profile, baseline_npm_directory=inputs, work=work, bundle=bundle,
                        fixture=work / "fixture.json", receipt_sha256="f" * 64, legacy_root_mode=root_mode)
                    receipt = {"version": target, "sourceSha": "a" * 40}
                    events = []
                    def verified(selected, directory, candidate_version):
                        self.assertEqual((selected, candidate_version), (profile, target))
                        events.append(("verify", directory))
                        return copy.deepcopy(identity)
                    def command(argv, **kwargs):
                        events.append(("command", argv))
                        if argv[0] == "npm":
                            self.assertGreaterEqual(sum(event[0] == "verify" for event in events), 2)
                            Path(argv[argv.index("--prefix") + 1]).mkdir()
                            Path(kwargs["env"]["npm_config_cache"]).mkdir()
                            return subprocess.CompletedProcess(argv, 0, b"", b"")
                        is_baseline = "npm-baseline-prefix" in argv[1]
                        if argv[-1] == "--version":
                            return subprocess.CompletedProcess(argv, 0, (baseline if is_baseline else target).encode(), b"")
                        if "--port" in argv:
                            self.assertTrue(is_baseline, "Candidate CLI must never install over the baseline.")
                            for path in MOD.paths(home).values(): path.mkdir(parents=True, mode=0o700)
                            install = MOD.paths(home)["installRoot"]
                            (install / "releases" / baseline).mkdir(parents=True)
                            (install / "current").symlink_to(install / "releases" / baseline)
                            return subprocess.CompletedProcess(argv, 0, b"", b"")
                        self.assertFalse(is_baseline)
                        self.assertEqual(kwargs["allowed"], (1,))
                        return subprocess.CompletedProcess(argv, 1, b"", b"existing installation")
                    def restart(fixture, action):
                        self.assertEqual(action, "restart")
                        for name in ("npm-prefix", "npm-cache", "npm-baseline-prefix", "npm-baseline-cache"):
                            self.assertFalse((work / name).exists())
                            self.assertTrue((work / f"{name}-retired").exists())
                        self.assertEqual(Path(fixture["installRoot"]).stat().st_mode & 0o777, int(root_mode, 8))
                        events.append(("restart", None))
                    def runtime(fixture, runtime_bundle, version):
                        self.assertEqual((runtime_bundle, version), (work / "npm-baseline-bundle", baseline))
                        self.assertIn(("restart", None), events)
                        return 118
                    stack.enter_context(patch.object(MOD.sys, "platform", "darwin"))
                    stack.enter_context(patch.dict(os.environ, {"RUNNER_TEMP": str(root), "GITHUB_RUN_ID": "123",
                                                               "GITHUB_RUN_ATTEMPT": "1", "GITHUB_SHA": "a" * 40}))
                    for name, replacement in (("verify_npm_baseline", verified), ("command", command), ("service", restart),
                                              ("verify_installed_runtime", runtime)):
                        stack.enter_context(patch.object(MOD, name, side_effect=replacement))
                    for name, value in (("ensure_empty", None), ("token_at", "private-token"), ("registered_services", []),
                                        ("request", {"session": {"id": "fixture"}}), ("state_snapshot", self.snapshot())):
                        stack.enter_context(patch.object(MOD, name, return_value=value))
                    health_values = [{"server_identity": "fixture", "server_instance_id": instance} for instance in ("first", "first", "restarted")]
                    health = stack.enter_context(patch.object(MOD, "health", side_effect=health_values))
                    fixture, observations = MOD.bootstrap(args, receipt, home)
                    self.assertEqual(fixture["sourceSha"], receipt["sourceSha"])
                    self.assertEqual(fixture["targetVersion"], target)
                    self.assertEqual(fixture["baselineVersion"], baseline)
                    self.assertEqual(fixture["baselineIdentity"], identity)
                    self.assertEqual(observations["exactBaselineRuntimeFilesCompared"], 118)
                    for key in ("providerChatObserved", "nonemptyProviderHistoryObserved", "queuedUserMessageObserved",
                                "busyWorkObserved", "logoutOrRebootObserved"):
                        self.assertIs(observations[key], False)
                    self.assertTrue(all(call.args[1] == baseline for call in health.call_args_list))
                    loaded_args = argparse.Namespace(fixture=args.fixture, receipt_sha256=args.receipt_sha256, work=work,
                                                     candidate=True, candidate_server_linux=False, kind="fresh")
                    self.assertEqual(MOD.load_fixture(loaded_args, receipt, home)["baselineIdentity"], identity)
                    fixture["baselineIdentity"]["sourceSha"] = receipt["sourceSha"]
                    MOD.write_private(args.fixture, fixture, replace=True)
                    with self.assertRaisesRegex(RuntimeError, "baseline differs"):
                        MOD.load_fixture(loaded_args, receipt, home)

    def test_real_http_gateway_transients_are_narrow_and_never_healthy_json(self):
        response = {"status": 503, "payload": b"temporary unavailable gateway text"}
        class Handler(http.server.BaseHTTPRequestHandler):
            def send_fixture(self):
                self.send_response(response["status"])
                self.send_header("Content-Length", str(len(response["payload"])))
                self.end_headers()
                try:
                    self.wfile.write(response["payload"])
                except (BrokenPipeError, ConnectionResetError):
                    pass
            do_GET = send_fixture
            do_POST = send_fixture
            def log_message(self, *unused):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01))
        worker.start()
        fixture = {"serverUrl": f"http://127.0.0.1:{server.server_port}", "token": "fixture-only-private"}
        try:
            for status in (502, 503):
                response.update(status=status, payload=b"private gateway error text")
                for route in ("/api/health", "/api/admin/update"):
                    with self.subTest(status=status, route=route), self.assertRaises(MOD.NativeTransientHTTPError) as error:
                        MOD.request(fixture, route, expected=(200, 502, 503))
                    self.assertEqual(error.exception.status, status)
                    self.assertNotIn("private", str(error.exception))
                    with self.assertRaises(RuntimeError) as unexpected:
                        MOD.request(fixture, route)
                    self.assertNotIsInstance(unexpected.exception, MOD.NativeTransientHTTPError)
                for route, body in (("/api/admin/update/start", None), ("/api/sessions", None),
                                    ("/api/health", {}), ("/api/admin/update", {})):
                    with self.assertRaises(json.JSONDecodeError):
                        MOD.request(fixture, route, body, expected=(200, 502, 503))
            response.update(status=200, payload=b"malformed successful response")
            with self.assertRaises(json.JSONDecodeError):
                MOD.request(fixture, "/api/health", expected=(200, 502, 503))
            response.update(status=200, payload=b'{"ok":true}')
            self.assertEqual(MOD.request(fixture, "/api/health", expected=(200, 502, 503)), {"ok": True})
            response.update(status=503, payload=b"x" * (8 * 1024 * 1024 + 1))
            with self.assertRaises(RuntimeError) as oversized:
                MOD.request(fixture, "/api/health", expected=(200, 502, 503))
            self.assertNotIsInstance(oversized.exception, MOD.NativeTransientHTTPError)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())

    def test_rollback_failure_receipt_is_bound_bounded_and_never_acceptance(self):
        diagnostic = {"stage": "observe-rollback", "transient502": 1, "transient503": 2,
                      "candidateProcessesFaulted": 1, "rollbackPhasesObserved": 1, "watcherStopped": True,
                      "privateValue": "do-not-publish"}
        args = SimpleNamespace(receipt_sha256="c" * 64)
        receipt = {"sourceSha": "a" * 40, "version": "1.0.8-beta.2"}
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2"}):
            report = MOD.rollback_failure_report(args, receipt, diagnostic,
                json.JSONDecodeError("private-error", "private-body", 0), "b" * 40)
            self.assertEqual(report["sourceSha"], receipt["sourceSha"])
            self.assertEqual(report["harnessSourceSha"], "b" * 40)
            self.assertEqual(report["releaseReceiptSha256"], args.receipt_sha256)
            self.assertEqual((report["runId"], report["runAttempt"]), ("123", "2"))
            self.assertEqual(report["diagnostic"]["failureCategory"], "invalid-json")
            self.assertEqual(report["diagnostic"]["transient503"], 2)
            for key in ("observed", "publicationEligible", "releaseAcceptance", "desktopAcceptance"):
                self.assertIs(report[key], False)
            self.assertEqual(report["status"], "failed")
            self.assertNotIn("private", json.dumps(report))
            self.assertNotIn("do-not-publish", json.dumps(report))
            for patch_value in ({"stage": "secret-stage"}, {"transient502": -1}, {"transient503": "secret"},
                                {"candidateProcessesFaulted": True}, {"rollbackPhasesObserved": 1000001}):
                with self.assertRaises(RuntimeError):
                    MOD.rollback_failure_report(args, receipt, {**diagnostic, **patch_value}, RuntimeError("secret"), "b" * 40)

    def test_actual_linux_failure_collector_rejects_unbound_or_unfiltered_reports(self):
        workflow = (MOD.ROOT / ".github/workflows/ci.yml").read_text()
        section = workflow.split("- name: Collect bounded non-publishing server-only observations", 1)[1]
        program = textwrap.dedent(section.split("<<'NODE'\n", 1)[1].split("\n          NODE", 1)[0])
        for change in (None, "source", "run", "accepted", "unknown-field", "unknown-detail", "counter", "receipt"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source, destination = root / "source", root / "public"
                source.mkdir()
                receipt = {"sourceSha": "a" * 40, "version": "1.0.8-beta.2"}
                receipt_path = root / "receipt.json"
                receipt_path.write_bytes(MOD.canonical(receipt))
                args = SimpleNamespace(receipt_sha256=MOD.sha(receipt_path.read_bytes()))
                environment = {**os.environ, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2",
                               "GITHUB_SHA": "b" * 40, "RECEIPT_SHA256": args.receipt_sha256}
                diagnostic = {"stage": "observe-rollback", "transient502": 1, "transient503": 2,
                              "candidateProcessesFaulted": 1, "rollbackPhasesObserved": 1, "watcherStopped": True}
                with patch.dict(os.environ, environment):
                    report = MOD.rollback_failure_report(args, receipt, diagnostic, RuntimeError("secret"), "b" * 40)
                if change == "source": report["sourceSha"] = "d" * 40
                if change == "run": report["runId"] = "124"
                if change == "accepted": report["observed"] = True
                if change == "unknown-field": report["privateExplanation"] = "private-marker"
                if change == "unknown-detail": report["diagnostic"]["privateExplanation"] = "private-marker"
                if change == "counter": report["diagnostic"]["transient503"] = -1
                if change == "receipt": receipt_path.write_bytes(b"{}")
                (source / "rollback-failure.json").write_bytes(MOD.canonical(report))
                result = subprocess.run(["node", "--input-type=module", "-", str(source), str(destination), str(receipt_path)],
                                        input=program, text=True, capture_output=True, timeout=10, env=environment)
                self.assertEqual(result.returncode == 0, change is None)
                self.assertEqual((destination / "rollback-failure.json").exists(), change is None)
                if change is None:
                    self.assertEqual(json.loads((destination / "rollback-failure.json").read_text()), report)
                self.assertNotIn("private-marker", result.stdout + result.stderr)

    def environment(self, root):
        return {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
                "GITHUB_REPOSITORY": "ZhengyiLuo/AgentsDock", "GITHUB_EVENT_NAME": "workflow_dispatch",
                "GITHUB_WORKFLOW_REF": "ZhengyiLuo/AgentsDock/.github/workflows/product-release-acceptance.yml@refs/heads/main",
                "GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
                "RUNNER_TEMP": str(root), "HOME": str(root / "account")}

    def test_guard_only_allows_exact_source_hosted_acceptance(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            env = self.environment(root)
            receipt = {"sourceSha": "a" * 40}
            work = root / "agentsdock-acceptance-fresh"
            self.assertEqual(MOD.guard(receipt, work, environment=env, uid=501, system="Darwin"), root / "account")
            changes = {"GITHUB_ACTIONS": "false", "RUNNER_ENVIRONMENT": "self-hosted",
                       "GITHUB_REPOSITORY": "attacker/AgentsDock", "GITHUB_EVENT_NAME": "pull_request",
                       "GITHUB_WORKFLOW_REF": "ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/main",
                       "GITHUB_SHA": "b" * 40, "GITHUB_RUN_ID": "", "GITHUB_RUN_ATTEMPT": "",
                       "HOME": ".", "RUNNER_TEMP": "."}
            for key, value in changes.items():
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    MOD.guard(receipt, work, environment={**env, key: value}, uid=501, system="Darwin")
            for selector in MOD.SELECTORS:
                with self.subTest(selector=selector), self.assertRaises(RuntimeError):
                    MOD.guard(receipt, work, environment={**env, selector: "/unrelated"}, uid=501, system="Darwin")
            for uid, system in ((0, "Linux"), (501, "Windows")):
                with self.assertRaises(RuntimeError):
                    MOD.guard(receipt, work, environment=env, uid=uid, system=system)

    def test_containment_rejects_broad_traversing_and_linked_targets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "link").symlink_to(root)
            for value in (root, root.parent / "other", root / "a/../file", root / "link/file"):
                with self.subTest(value=value), self.assertRaises(RuntimeError):
                    MOD.contained(value, root)
            MOD.contained(root / "owned/file", root)

    def test_test_only_candidate_guard_is_explicit_exact_branch_and_not_production(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            env = self.environment(root)
            env["GITHUB_WORKFLOW_REF"] = "ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/release/native-test"
            env["RUNNER_OS"] = "macOS"
            receipt = {"schema": 1, "kind": "agentsdock-macos-candidate", "scope": "darwin-app-server",
                       "publicationEligible": False, "sourceSha": "a" * 40, "sourceRef": "release/native-test"}
            work = root / "agentsdock-acceptance-test"
            self.assertEqual(MOD.guard(receipt, work, candidate=True, environment=env, uid=501, system="Darwin"), root / "account")
            with self.assertRaises(RuntimeError):
                MOD.guard(receipt, work, environment=env, uid=501, system="Darwin")
            for change in ({"kind": "production"}, {"publicationEligible": True}, {"scope": "all-platforms"},
                           {"sourceRef": "main"}):
                with self.subTest(change=change), self.assertRaises(RuntimeError):
                    MOD.guard({**receipt, **change}, work, candidate=True, environment=env, uid=501, system="Darwin")
            for change in ({"GITHUB_EVENT_NAME": "workflow_call"}, {"GITHUB_EVENT_NAME": "pull_request"},
                           {"GITHUB_WORKFLOW_REF": "ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/release/other"},
                           {"RUNNER_ENVIRONMENT": "self-hosted"}, {"RUNNER_OS": "Linux"}, {"GITHUB_SHA": "not-a-commit"}):
                with self.subTest(change=change), self.assertRaises(RuntimeError):
                    MOD.guard(receipt, work, candidate=True, environment={**env, **change}, uid=501, system="Darwin")
            with self.assertRaises(RuntimeError):
                MOD.guard(receipt, work, candidate=True, environment=env, uid=501, system="Linux")
            # The separate validate-runner proof admits only reviewed harness
            # descendants. The environment remains truthful about that HEAD.
            self.assertEqual(MOD.guard(receipt, work, candidate=True,
                             environment={**env, "GITHUB_SHA": "b" * 40}, uid=501, system="Darwin"), root / "account")

    def test_candidate_receipt_inspection_never_invents_production_preparation_metadata(self):
        args = argparse.Namespace(candidate=True, receipt=Path("/fixture/candidate.json"), receipt_sha256="a" * 64,
                                  bundle=Path("/fixture/server"), prepare_run=None)
        with patch.object(MOD, "command") as command:
            MOD.inspect_receipt(args)
        arguments = command.call_args.args[0]
        self.assertTrue(arguments[1].endswith("product-candidate-receipt.mjs"))
        self.assertEqual(arguments[2:], ["inspect", str(args.receipt), args.receipt_sha256, str(args.bundle)])
        args.candidate = False
        with patch.object(MOD, "command") as command, self.assertRaises(RuntimeError):
            MOD.inspect_receipt(args)
        command.assert_not_called()

    def test_linux_server_scope_is_explicit_truthful_and_does_not_admit_mac_desktop_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            env = {**self.environment(root), "RUNNER_OS": "Linux", "GITHUB_JOB": "candidate-server-rollback-linux",
                   "GITHUB_WORKFLOW_REF": "ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/release/native-test"}
            receipt = {"schema": 1, "kind": "agentsdock-macos-candidate", "scope": "darwin-app-server",
                       "publicationEligible": False, "sourceSha": "a" * 40, "sourceRef": "release/native-test"}
            work = root / "agentsdock-acceptance-linux"
            check = lambda **kwargs: MOD.guard(receipt, work, environment=env, uid=501, **kwargs)
            self.assertEqual(check(system="Linux", candidate_server_linux=True), root / "account")
            for options in ({"system": "Linux", "candidate": True}, {"system": "Darwin", "candidate_server_linux": True},
                            {"system": "Linux", "candidate": True, "candidate_server_linux": True}, {"system": "Linux"}):
                with self.subTest(options=options), self.assertRaises(RuntimeError):
                    check(**options)
            for change in ({"GITHUB_JOB": "release-tooling"}, {"RUNNER_OS": "macOS"}, {"RUNNER_ENVIRONMENT": "self-hosted"},
                           {"GITHUB_EVENT_NAME": "pull_request"}, {"AGENTS_SERVER_STATE_DIR": "/unrelated"}):
                with self.subTest(change=change), self.assertRaises(RuntimeError):
                    MOD.guard(receipt, work, environment={**env, **change}, uid=501, system="Linux", candidate_server_linux=True)

    def linux_selector_fixture(self, root):
        account = root / "account"
        account.mkdir(mode=0o700)
        receipt = {"schema": 1, "kind": "agentsdock-macos-candidate", "scope": "darwin-app-server",
                   "publicationEligible": False, "sourceSha": "a" * 40, "sourceRef": "release/native-test"}
        env = {**self.environment(root), "RUNNER_OS": "Linux", "GITHUB_JOB": "candidate-server-rollback-linux",
               "GITHUB_WORKFLOW_REF": "ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/release/native-test",
               "XDG_CONFIG_HOME": str(account / ".config"), "UNRELATED_VALUE": "must-stay-private-and-unchanged"}
        return receipt, env, root / "agentsdock-acceptance-linux"

    def test_linux_candidate_normalizes_only_verified_account_default_after_guards(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            receipt, env, work = self.linux_selector_fixture(root)
            before = dict(env)
            with patch.object(MOD.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=env["HOME"])):
                self.assertEqual(MOD.guard(receipt, work, environment=env, uid=501, system="Linux",
                                           candidate_server_linux=True), root / "account")
            self.assertEqual(env, {key: value for key, value in before.items() if key != "XDG_CONFIG_HOME"})
            # Existing safe .config and an unset selector both remain valid.
            (root / "account/.config").mkdir(mode=0o700)
            env = dict(before)
            with patch.object(MOD.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=env["HOME"])):
                MOD.guard(receipt, work, environment=env, uid=501, system="Linux", candidate_server_linux=True)
            unchanged = dict(env)
            MOD.guard(receipt, work, environment=env, uid=501, system="Linux", candidate_server_linux=True)
            self.assertEqual(env, unchanged)

    def test_custom_selectors_expose_only_bounded_key_names_and_do_not_normalize_any_environment(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            receipt, base, work = self.linux_selector_fixture(root)
            changes = [{"XDG_CONFIG_HOME": value} for value in (
                "/PRIVATE-custom-config", "$HOME/.config", base["XDG_CONFIG_HOME"] + "/", "PRIVATE" * 100_000)]
            changes += [{key: "/PRIVATE-other-selector"} for key in MOD.SELECTORS if key != "XDG_CONFIG_HOME"]
            changes.append({key: "PRIVATE-value" for key in MOD.SELECTORS})
            for change in changes:
                env = {**base, **change}
                before = dict(env)
                with self.subTest(keys=list(change)), \
                        patch.object(MOD.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=env["HOME"])), \
                        self.assertRaisesRegex(RuntimeError, "Offending selector keys:") as caught:
                    MOD.guard(receipt, work, environment=env, uid=501, system="Linux", candidate_server_linux=True)
                self.assertEqual(env, before)
                self.assertLess(len(str(caught.exception)), 512)
                self.assertNotIn("PRIVATE", str(caught.exception))
                self.assertNotIn(str(root), str(caught.exception))
                for key in change:
                    self.assertIn(key, str(caught.exception))

    def test_default_selector_normalization_is_not_available_to_mac_or_production_scope(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            receipt, base, work = self.linux_selector_fixture(root)
            cases = [(receipt, {**base, "RUNNER_OS": "macOS"}, "Darwin", {"candidate": True}),
                     ({"sourceSha": "a" * 40}, {**base, "GITHUB_WORKFLOW_REF":
                      "ZhengyiLuo/AgentsDock/.github/workflows/product-release-acceptance.yml@refs/heads/main"}, "Linux", {})]
            for source, env, host, options in cases:
                before = dict(env)
                with self.subTest(host=host, options=options), \
                        patch.object(MOD.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=env["HOME"])), \
                        self.assertRaisesRegex(RuntimeError, "XDG_CONFIG_HOME"):
                    MOD.guard(source, work, environment=env, uid=501, system=host, **options)
                self.assertEqual(env, before)

    def test_real_account_mismatch_and_symlinked_default_home_or_config_are_not_normalized(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            receipt, base, work = self.linux_selector_fixture(root)
            (root / "other-account").mkdir(mode=0o700)
            (root / "linked-home").symlink_to(root / "account", target_is_directory=True)
            cases = [(base, root / "other-account"),
                     ({**base, "HOME": str(root / "linked-home"), "XDG_CONFIG_HOME": str(root / "linked-home/.config")}, root / "account")]
            for original, account in cases:
                env, before = dict(original), dict(original)
                with patch.object(MOD.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=str(account))), \
                        self.assertRaisesRegex(RuntimeError, "XDG_CONFIG_HOME"):
                    MOD.guard(receipt, work, environment=env, uid=501, system="Linux", candidate_server_linux=True)
                self.assertEqual(env, before)
            # A lexically default path must not alias even another owned directory.
            config = root / "account/.config"
            config.symlink_to(root / "other-account", target_is_directory=True)
            env, before = dict(base), dict(base)
            with patch.object(MOD.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=env["HOME"])), \
                    self.assertRaisesRegex(RuntimeError, "XDG_CONFIG_HOME"):
                MOD.guard(receipt, work, environment=env, uid=501, system="Linux", candidate_server_linux=True)
            self.assertEqual(env, before)

    def test_valid_default_is_not_removed_before_workflow_account_and_work_path_guards_pass(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            receipt, base, work = self.linux_selector_fixture(root)
            linked = root / "agentsdock-acceptance-linked"
            linked.symlink_to(root, target_is_directory=True)
            cases = [(base, root, 501), (base, root / "wrong-prefix", 501), (base, linked, 501),
                     ({**base, "RUNNER_ENVIRONMENT": "self-hosted"}, work, 501),
                     ({**base, "GITHUB_JOB": "unrelated-job"}, work, 501),
                     ({**base, "RUNNER_TEMP": "."}, work, 501), (base, work, 0)]
            for original, target, uid in cases:
                env, before = dict(original), dict(original)
                with self.subTest(target=target, uid=uid, job=env["GITHUB_JOB"]), \
                        patch.object(MOD.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=env["HOME"])), \
                        patch.object(MOD, "command") as command, patch.object(MOD, "write_private") as write, \
                        self.assertRaises(RuntimeError):
                    MOD.guard(receipt, target, environment=env, uid=uid, system="Linux", candidate_server_linux=True)
                self.assertEqual(env, before)
                command.assert_not_called()
                write.assert_not_called()

    def test_default_selector_real_environment_refuses_redirected_home_without_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            receipt, env, work = self.linux_selector_fixture(root)
            with patch.dict(MOD.os.environ, env, clear=True), \
                    patch.object(MOD.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=str(root / "other-account"))), \
                    patch.object(MOD, "command") as command:
                before = dict(MOD.os.environ)
                with self.assertRaisesRegex(RuntimeError, "Do not redirect HOME"):
                    MOD.guard(receipt, work, uid=501, system="Linux", candidate_server_linux=True)
                self.assertEqual(dict(MOD.os.environ), before)
            command.assert_not_called()

    def test_linux_server_checkout_proof_must_explicitly_exclude_desktop_acceptance(self):
        args = argparse.Namespace(receipt=Path("/fixture/candidate.json"), receipt_sha256="c" * 64,
                                  candidate=False, candidate_server_linux=True, bundle=Path("/fixture/server"))
        receipt = {"sourceSha": "a" * 40, "sourceRef": "release/native-test"}
        proof = {**receipt, "harnessSourceSha": "b" * 40, "publicationEligible": False,
                 "executionScope": "candidate-server-linux", "desktopAcceptance": False}
        result = subprocess.CompletedProcess([], 0, json.dumps(proof).encode(), b"")
        with patch.dict(os.environ, {"GITHUB_SHA": "b" * 40}), patch.object(MOD, "command", return_value=result) as command:
            self.assertEqual(MOD.validate_candidate_checkout(args, receipt), "b" * 40)
            self.assertEqual(command.call_args.args[0][2], "validate-server-runner")
            MOD.inspect_receipt(args)
            self.assertEqual(command.call_args.args[0][2], "inspect")
        for change in ({"desktopAcceptance": True}, {"executionScope": "candidate"}, {"publicationEligible": True}):
            result.stdout = json.dumps({**proof, **change}).encode()
            with patch.dict(os.environ, {"GITHUB_SHA": "b" * 40}), patch.object(MOD, "command", return_value=result), self.assertRaises(RuntimeError):
                MOD.validate_candidate_checkout(args, receipt)

    def test_linux_server_scope_refuses_unrelated_operations_before_installer_or_service(self):
        raw = json.dumps({"sourceSha": "a" * 40, "sourceRef": "release/native-test"}).encode()
        for operation, kind, staging in (("bootstrap", "fresh", False), ("verify", "legacy", False),
                                         ("staging-failure-retry", "legacy", True), ("failure-retry", "legacy", False)):
            args = argparse.Namespace(receipt=Path("/fixture/candidate.json"), receipt_sha256=MOD.sha(raw),
                work=Path("/runner/agentsdock-acceptance-linux"), candidate=False, candidate_server_linux=True,
                operation=operation, kind=kind, staging_failure_fixture=staging)
            with patch.object(MOD, "parser") as parser, patch.object(MOD, "read_regular", return_value=raw), \
                    patch.object(MOD, "guard", return_value=Path("/runner/account")), \
                    patch.object(MOD, "validate_candidate_checkout") as checkout, patch.object(MOD, "bootstrap") as bootstrap, \
                    patch.object(MOD, "service") as service, self.assertRaises(RuntimeError):
                parser.return_value.parse_args.return_value = args
                MOD.main()
            checkout.assert_not_called()
            bootstrap.assert_not_called()
            service.assert_not_called()

    def test_rollback_native_state_requires_both_components_journal_cleanup_and_unheld_execution(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            install = root / "install"
            release = install / "releases/1.0.7-beta.21"
            release.mkdir(parents=True)
            (install / "current").symlink_to(release)
            files = [root / "agents-server.service", root / "agents-server-gateway.service"]
            for item in files:
                item.write_text("native unit fixture")
            fixture = {"installRoot": str(install), "rootBindings": {
                "installRoot": [install.stat().st_dev, install.stat().st_ino]}}
            version = "1.0.7-beta.21"
            health = {"server_instance_id": "worker-instance", "gateway": {"protocol": 1, "version": version, "pid": 123, "instance_id": "gateway"},
                      "execution_service": {"protocol": 1, "version": version, "pid": 456, "instance_id": "worker", "maintenance_held": False}}
            def query(args):
                return subprocess.CompletedProcess(args, 0, b"123\n" if "agents-server-gateway.service" in args else b"456\n", b"")
            with patch.object(MOD, "health", return_value=health), patch.object(MOD, "registered_services", return_value=files), \
                    patch.object(MOD, "command", side_effect=query):
                observed = MOD.rollback_native_state(fixture, version)
                self.assertEqual(observed["current"], str(release))
                health["execution_service"]["maintenance_held"] = True
                with self.assertRaisesRegex(RuntimeError, "maintenance"):
                    MOD.rollback_native_state(fixture, version)
                health["execution_service"]["maintenance_held"] = False
                health["gateway"]["version"] = "1.0.3"
                with self.assertRaisesRegex(RuntimeError, "Both exact-version"):
                    MOD.rollback_native_state(fixture, version)
                health["gateway"]["version"] = version
                (install / ".activation-transaction").mkdir()
                with self.assertRaisesRegex(RuntimeError, "existing activation"):
                    MOD.rollback_native_state(fixture, version)

    def test_candidate_checkout_proof_preserves_runtime_source_and_truthful_harness_pin(self):
        args = argparse.Namespace(receipt=Path("/fixture/candidate.json"), receipt_sha256="c" * 64)
        receipt = {"sourceSha": "a" * 40, "sourceRef": "release/native-test"}
        proof = {**receipt, "harnessSourceSha": "b" * 40, "publicationEligible": False}
        result = subprocess.CompletedProcess([], 0, json.dumps(proof).encode(), b"")
        with patch.dict(os.environ, {"GITHUB_SHA": "b" * 40}), patch.object(MOD, "command", return_value=result) as command:
            self.assertEqual(MOD.validate_candidate_checkout(args, receipt), "b" * 40)
            self.assertEqual(command.call_args.args[0][2:], ["validate-runner", str(args.receipt), args.receipt_sha256])
        for change in ({"sourceSha": "d" * 40}, {"harnessSourceSha": "a" * 40},
                       {"sourceRef": "release/other"}, {"publicationEligible": True}):
            result.stdout = json.dumps({**proof, **change}).encode()
            with self.subTest(change=change), patch.dict(os.environ, {"GITHUB_SHA": "b" * 40}), \
                    patch.object(MOD, "command", return_value=result), self.assertRaises(RuntimeError):
                MOD.validate_candidate_checkout(args, receipt)

    def test_candidate_checkout_rejection_precedes_every_native_operation(self):
        raw = json.dumps({"sourceSha": "a" * 40, "sourceRef": "release/native-test"}).encode()
        args = argparse.Namespace(receipt=Path("/fixture/candidate.json"), receipt_sha256=MOD.sha(raw),
                                  work=Path("/runner/agentsdock-acceptance-test"), candidate=True)
        with patch.object(MOD, "parser") as parser, patch.object(MOD, "read_regular", return_value=raw), \
                patch.object(MOD, "guard", return_value=Path("/runner/account")), \
                patch.object(MOD, "validate_candidate_checkout", side_effect=RuntimeError("unreviewed runtime delta")), \
                patch.object(MOD, "inspect_receipt") as inspect, patch.object(MOD, "bootstrap") as bootstrap, \
                patch.object(MOD, "contained") as contained, self.assertRaises(RuntimeError):
            parser.return_value.parse_args.return_value = args
            MOD.main()
        inspect.assert_not_called()
        bootstrap.assert_not_called()
        contained.assert_not_called()

    def test_fixture_from_previous_run_attempt_is_refused_before_root_or_service_access(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            path = root / "fixture.json"
            receipt = {"sourceSha": "a" * 40, "version": "1.0.7-beta.17"}
            args = argparse.Namespace(fixture=path, receipt_sha256="b" * 64, work=root)
            MOD.write_private(path, {"schema": 1, "runId": "123", "runAttempt": "1",
                                    "sourceSha": receipt["sourceSha"], "targetVersion": receipt["version"],
                                    "releaseReceiptSha256": args.receipt_sha256,
                                    "home": str(root), "workDirectory": str(root)})
            with patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2"}), \
                    patch.object(MOD, "owned_directory") as directory, self.assertRaises(RuntimeError):
                MOD.load_fixture(args, receipt, root)
            directory.assert_not_called()

    def test_private_files_refuse_links_hardlinks_public_mode_and_overwrites(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "private.json"
            MOD.write_private(path, {"secret": "fixture"})
            self.assertEqual(json.loads(MOD.read_regular(path, private=True)), {"secret": "fixture"})
            with self.assertRaises(FileExistsError):
                MOD.write_private(path, {})
            with self.assertRaises(RuntimeError):
                MOD.read_regular(path, maximum=1)
            path.chmod(0o644)
            with self.assertRaises(RuntimeError):
                MOD.read_regular(path, private=True)
            path.chmod(0o600)
            linked = root / "linked"
            linked.symlink_to(path)
            with self.assertRaises(OSError):
                MOD.read_regular(linked)
            os.link(path, root / "hard")
            with self.assertRaises(RuntimeError):
                MOD.read_regular(path)

    def test_command_failure_does_not_echo_sensitive_output(self):
        result = subprocess.CompletedProcess(["installer"], 1, b"token=secret", b"private conversation")
        with patch.object(MOD, "bounded_run", return_value=result), self.assertRaises(RuntimeError) as caught:
            MOD.command(["installer"])
        self.assertNotIn("token", str(caught.exception))
        self.assertNotIn("conversation", str(caught.exception))

    def test_launchctl_error_labels_only_the_fixed_subcommand_not_arguments_or_output(self):
        result = subprocess.CompletedProcess([], 5, b"token=private", b"private response")
        with patch.object(MOD, "bounded_run", return_value=result), self.assertRaises(RuntimeError) as caught:
            MOD.command(["/bin/launchctl", "bootstrap", "gui/private", "/private/registration.plist"])
        self.assertIn("launchctl bootstrap, exit 5", str(caught.exception))
        self.assertNotIn("registration", str(caught.exception))
        self.assertNotIn("token", str(caught.exception))
        self.assertNotIn("private response", str(caught.exception))

    def test_launchctl_state_requires_concrete_absence_not_generic_exit_five(self):
        item = Path("/owned/com.agentsdock.server.plist")
        for code, text, expected in ((0, b"private service details", "loaded"),
                                     (113, b"Could not find service", "absent"),
                                     (5, b"Input/output error with private details", None)):
            result = subprocess.CompletedProcess([], code, b"", text)
            with patch.object(MOD, "launchd_registration"), patch.object(MOD, "command", return_value=result):
                if expected is None:
                    with self.assertRaises(RuntimeError) as caught:
                        MOD.launchd_state(item, "a" * 64)
                    self.assertNotIn("private details", str(caught.exception))
                else:
                    self.assertEqual(MOD.launchd_state(item, "a" * 64), expected)

    def test_fresh_launchctl_absence_accepts_known_error_codes_only_with_explicit_absence(self):
        with tempfile.TemporaryDirectory() as temporary:
            for code in (3, 5, 113):
                absent = subprocess.CompletedProcess([], code, b"", b"Could not find service")
                domain = subprocess.CompletedProcess([], 0, b"private domain data", b"")
                with self.subTest(code=code), patch.object(MOD.platform, "system", return_value="Darwin"), \
                        patch.object(MOD, "command", side_effect=[domain, absent, absent]) as command:
                    MOD.ensure_empty(Path(temporary))
                self.assertTrue(all(call.args[0][1] == "print" for call in command.call_args_list))
            unknown = subprocess.CompletedProcess([], 5, b"", b"Input/output error")
            with patch.object(MOD.platform, "system", return_value="Darwin"), \
                    patch.object(MOD, "command", side_effect=[domain, unknown]), self.assertRaises(RuntimeError):
                MOD.ensure_empty(Path(temporary))
            with patch.object(MOD.platform, "system", return_value="Darwin"), \
                    patch.object(MOD, "command", side_effect=[domain, domain]), self.assertRaises(RuntimeError):
                MOD.ensure_empty(Path(temporary))

    def test_launchctl_query_refuses_unrelated_service(self):
        with patch.object(MOD, "command") as command, self.assertRaises(RuntimeError):
            MOD.launchd_query_state(f"gui/{os.getuid()}/unrelated.service")
        command.assert_not_called()

    def test_launchctl_stop_waits_for_real_removal_and_is_idempotent_when_absent(self):
        item = Path("/owned/com.agentsdock.server.plist")
        with patch.object(MOD, "launchd_registration"), \
                patch.object(MOD, "launchd_state", side_effect=["loaded", "loaded", "absent"]) as state, \
                patch.object(MOD, "command", return_value=subprocess.CompletedProcess([], 0, b"", b"")) as command, \
                patch.object(MOD.time, "sleep"):
            MOD.stop_launchd(item, "a" * 64)
        self.assertEqual(state.call_count, 3)
        self.assertEqual(command.call_args.args[0][1], "bootout")
        with patch.object(MOD, "launchd_state", return_value="absent"), patch.object(MOD, "command") as command:
            MOD.stop_launchd(item, "a" * 64)
        command.assert_not_called()

    def test_launchctl_bootout_error_fails_if_owned_job_stays_loaded(self):
        with patch.object(MOD, "launchd_registration"), patch.object(MOD, "launchd_state", return_value="loaded"), \
                patch.object(MOD, "command", return_value=subprocess.CompletedProcess([], 5, b"", b"private")), \
                self.assertRaises(RuntimeError) as caught:
            MOD.stop_launchd(Path("/owned/com.agentsdock.server.plist"), "a" * 64)
        self.assertIn("launchctl bootout, exit 5", str(caught.exception))

    def test_launchctl_bootstrap_retries_only_known_transient_and_requires_registered_success(self):
        transient = subprocess.CompletedProcess([], 5, b"", b"Bootstrap failed: 5: Input/output error")
        success = subprocess.CompletedProcess([], 0, b"", b"")
        item = Path("/owned/com.agentsdock.server.plist")
        with patch.object(MOD, "launchd_registration"), patch.object(MOD, "wait_launchd_absent") as absent, \
                patch.object(MOD, "command", side_effect=[transient, success]) as command, \
                patch.object(MOD, "launchd_state", return_value="loaded"), patch.object(MOD.time, "sleep"):
            MOD.start_launchd(item, "a" * 64)
        self.assertEqual(command.call_count, 2)
        self.assertEqual(absent.call_count, 2)
        with patch.object(MOD, "launchd_registration"), patch.object(MOD, "wait_launchd_absent"), \
                patch.object(MOD, "command", return_value=success), patch.object(MOD, "launchd_state", return_value="absent"), \
                self.assertRaises(RuntimeError):
            MOD.start_launchd(item, "a" * 64)

    def test_launchctl_bootstrap_unknown_or_persistent_failure_never_passes(self):
        for text, expected_attempts in ((b"Permission denied", 1), (b"Bootstrap failed: 5: Input/output error", 3)):
            result = subprocess.CompletedProcess([], 5, b"", text)
            with self.subTest(text=text), patch.object(MOD, "launchd_registration"), \
                    patch.object(MOD, "wait_launchd_absent"), patch.object(MOD.time, "sleep"), \
                    patch.object(MOD, "command", return_value=result) as command, self.assertRaises(RuntimeError):
                MOD.start_launchd(Path("/owned/com.agentsdock.server.plist"), "a" * 64)
            self.assertEqual(command.call_count, expected_attempts)

    def test_launchctl_removal_wait_has_a_bounded_deadline(self):
        clock = [0.0]
        with patch.object(MOD.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(MOD.time, "sleep", side_effect=lambda seconds: clock.__setitem__(0, clock[0] + seconds)), \
                patch.object(MOD, "launchd_state", return_value="loaded") as state, self.assertRaises(RuntimeError):
            MOD.wait_launchd_absent(Path("/owned/com.agentsdock.server.plist"), "a" * 64, timeout=0.25)
        self.assertEqual(state.call_count, 3)

    def test_launchctl_registration_binding_rejects_changed_file_before_any_command(self):
        with tempfile.TemporaryDirectory() as temporary:
            item = Path(temporary) / "com.agentsdock.server.plist"
            item.write_bytes(b"owned-registration")
            expected = MOD.sha(item.read_bytes())
            MOD.launchd_registration(item, expected)
            item.write_bytes(b"different-registration")
            with patch.object(MOD, "command") as command, self.assertRaises(RuntimeError):
                MOD.launchd_state(item, expected)
            command.assert_not_called()

    def test_native_command_output_is_bounded_without_blocking_either_pipe(self):
        result = MOD.bounded_run([sys.executable, "-c", "import os; os.write(1,b'x'*2000000); os.write(2,b'y'*2000000)"], timeout=10, env=None)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(len(result.stdout), 1024 * 1024)
        self.assertEqual(len(result.stderr), 1024 * 1024)

    def test_installer_environment_excludes_publishing_credentials(self):
        with patch.dict(os.environ, {"GH_TOKEN": "secret", "AGENTS_SERVER_RELEASE_PRIVATE_KEY_B64": "secret",
                                     "HOME": "/account", "PATH": "/bin", "SSL_CERT_FILE": "/runner/ca"}, clear=True):
            env = MOD.child_environment(Path("/runner/work"))
        self.assertNotIn("GH_TOKEN", env)
        self.assertNotIn("AGENTS_SERVER_RELEASE_PRIVATE_KEY_B64", env)
        self.assertEqual(env["HOME"], "/account")
        self.assertEqual(env["SSL_CERT_FILE"], "/runner/ca")

    def test_safe_archive_extraction_rejects_links_and_traversal(self):
        for name, kind in (("../escape", tarfile.REGTYPE), ("runtime/link", tarfile.SYMTYPE),
                           ("/escape", tarfile.REGTYPE), ("runtime/pipe", tarfile.FIFOTYPE)):
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = root / "payload.tgz"
                with tarfile.open(archive, "w:gz") as package:
                    member = tarfile.TarInfo(name)
                    member.type = kind
                    member.linkname = "/private"
                    package.addfile(member)
                with self.assertRaises(RuntimeError):
                    MOD.safe_extract(archive, root / "extract")

    def test_safe_archive_keeps_runtime_executable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "payload.tgz"
            with tarfile.open(archive, "w:gz") as package:
                member = tarfile.TarInfo("runtime/install.sh")
                member.mode, member.size = 0o755, 4
                package.addfile(member, io.BytesIO(b"test"))
            runtime = MOD.safe_extract(archive, root / "extract")
            self.assertEqual((runtime / "install.sh").read_bytes(), b"test")
            self.assertTrue((runtime / "install.sh").stat().st_mode & 0o111)

    def test_actual_release_order_not_lexical_order(self):
        self.assertLess(MOD.version_order("1.0.7-beta.9"), MOD.version_order("1.0.7-beta.17"))
        self.assertLess(MOD.version_order("1.0.7-beta.17"), MOD.version_order("1.0.7"))
        self.assertLess(MOD.version_order("1.0.3"), MOD.version_order("1.0.7-beta.17"))
        for value in ("v1.0.3", "1.0.7-beta.0", "1.0.7+fixture", "1.0.7\n"):
            with self.assertRaises(RuntimeError):
                MOD.version_order(value)

    def snapshot(self):
        return {"serverIdentitySha256": "identity", "tokenSha256": "token",
                "sessions": {"sess_fixture": {"identity": {"id": "sess_fixture", "cwd": "/owned/custom",
                                                          "codex_thread_id": "native-fixture"},
                                               "eventHashes": ["first", "second"], "queued": [{"id": "queued"}]}}}

    def test_preservation_allows_append_not_mutation_or_lost_queue(self):
        before = self.snapshot()
        after = copy.deepcopy(before)
        after["sessions"]["sess_fixture"]["eventHashes"].append("third")
        MOD.compare_snapshot(before, after)
        for field in ("token", "identity", "session", "native-id", "events", "queue"):
            after = copy.deepcopy(before)
            if field == "token": after["tokenSha256"] = "different"
            elif field == "identity": after["serverIdentitySha256"] = "different"
            elif field == "session": after["sessions"] = {}
            elif field == "native-id": after["sessions"]["sess_fixture"]["identity"]["codex_thread_id"] = "different"
            elif field == "events": after["sessions"]["sess_fixture"]["eventHashes"] = ["first"]
            else: after["sessions"]["sess_fixture"]["queued"] = []
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                MOD.compare_snapshot(before, after)

    def legacy_schema_snapshots(self):
        before = self.snapshot()
        session = before["sessions"]["sess_fixture"]
        session["identity"].update(backend="codex", codex_provider=None, opencode_permission_mode=None)
        session["presentFields"] = [key for key in session["identity"]
                                    if key not in {"codex_provider", "opencode_permission_mode"}]
        after = copy.deepcopy(before)
        current = after["sessions"]["sess_fixture"]
        current["identity"].update(codex_provider="default", opencode_permission_mode="default")
        current["presentFields"].extend(["codex_provider", "opencode_permission_mode"])
        return before, after

    def test_snapshot_records_actual_api_presence_including_explicit_null(self):
        fixture = {"stateRoot": "/owned/state", "configRoot": "/owned/config",
                   "serverIdentity": "private-identity", "token": "private-token"}
        session = {"id": "sess_fixture", "backend": "codex", "codex_provider": None}
        with patch.object(MOD, "read_regular", return_value=b"private-identity"), \
                patch.object(MOD, "token_at", return_value="private-token"), \
                patch.object(MOD, "request", side_effect=[{"sessions": [{"id": "sess_fixture"}]},
                    {"session": session, "events": []}]):
            snapshot = MOD.state_snapshot(fixture)["sessions"]["sess_fixture"]
        self.assertIn("codex_provider", snapshot["presentFields"])
        self.assertNotIn("opencode_permission_mode", snapshot["presentFields"])
        self.assertIsNone(snapshot["identity"]["codex_provider"])
        self.assertIsNone(snapshot["identity"]["opencode_permission_mode"])

    def test_only_proven_absent_legacy_schema_defaults_are_recognized(self):
        before, after = self.legacy_schema_snapshots()
        observed = MOD.compare_snapshot(before, after, baseline_version="1.0.3", candidate_version="1.0.7-beta.18")
        self.assertEqual(observed, {"schemaDefaultsAdded": ["codex_provider", "opencode_permission_mode"]})
        self.assertIsNone(before["sessions"]["sess_fixture"]["identity"]["codex_provider"])
        for baseline, target in ((None, None), ("1.0.3", None), ("1.0.4", "1.0.7-beta.18"),
                                 ("1.0.3", "1.0.3"), ("1.0.3", "1.0.2"), ("1.0.3", "invalid")):
            with self.subTest(baseline=baseline, target=target), self.assertRaises(RuntimeError):
                MOD.compare_snapshot(before, after, baseline_version=baseline, candidate_version=target)

    def test_explicit_null_or_configured_values_never_become_schema_defaults(self):
        for key, values in (("codex_provider", (None, "custom", "default")),
                            ("opencode_permission_mode", (None, "full_access", "plan", "default"))):
            for value in values:
                before, after = self.legacy_schema_snapshots()
                saved = before["sessions"]["sess_fixture"]
                saved["presentFields"].append(key)
                saved["identity"][key] = value
                if value == "default":
                    after["sessions"]["sess_fixture"]["identity"][key] = "custom" if key == "codex_provider" else "full_access"
                with self.subTest(key=key, value=value), self.assertRaises(RuntimeError):
                    MOD.compare_snapshot(before, after, baseline_version="1.0.3", candidate_version="1.0.7-beta.18")
        for value in ("full_access", "plan", None):
            before, after = self.legacy_schema_snapshots()
            after["sessions"]["sess_fixture"]["identity"]["opencode_permission_mode"] = value
            with self.subTest(candidate=value):
                # Null remains equal to the former absent projection; only a
                # genuinely changed permission must fail, never be defaulted.
                if value is None:
                    result = MOD.compare_snapshot(before, after, baseline_version="1.0.3", candidate_version="1.0.7-beta.18")
                    self.assertEqual(result["schemaDefaultsAdded"], ["codex_provider"])
                else:
                    with self.assertRaises(RuntimeError):
                        MOD.compare_snapshot(before, after, baseline_version="1.0.3", candidate_version="1.0.7-beta.18")

    def test_schema_default_exception_requires_presence_proof_and_non_opencode_backend(self):
        for alteration in ("missing-presence", "invalid-presence", "explicit-null", "missing-target-presence", "opencode", "changed-backend"):
            before, after = self.legacy_schema_snapshots()
            saved, actual = before["sessions"]["sess_fixture"], after["sessions"]["sess_fixture"]
            if alteration == "missing-presence": saved.pop("presentFields")
            elif alteration == "invalid-presence": saved["presentFields"] = [{"secret": "private-token"}]
            elif alteration == "explicit-null": saved["presentFields"].append("codex_provider")
            elif alteration == "missing-target-presence": actual["presentFields"].remove("codex_provider")
            elif alteration == "opencode": saved["identity"]["backend"] = actual["identity"]["backend"] = "opencode"
            else: actual["identity"]["backend"] = "claude"
            with self.subTest(alteration=alteration), self.assertRaises(RuntimeError):
                MOD.compare_snapshot(before, after, baseline_version="1.0.3", candidate_version="1.0.7-beta.18")

    def test_schema_default_exception_does_not_weaken_history_queue_or_native_identity(self):
        for alteration in ("native-id", "cwd", "history", "queue", "token", "identity"):
            before, after = self.legacy_schema_snapshots()
            actual = after["sessions"]["sess_fixture"]
            if alteration == "native-id": actual["identity"]["codex_thread_id"] = "private-replaced-thread"
            elif alteration == "cwd": actual["identity"]["cwd"] = "/private/replaced/path"
            elif alteration == "history": actual["eventHashes"] = ["changed"]
            elif alteration == "queue": actual["queued"] = []
            elif alteration == "token": after["tokenSha256"] = "different"
            else: after["serverIdentitySha256"] = "different"
            with self.subTest(alteration=alteration), self.assertRaises(RuntimeError):
                MOD.compare_snapshot(before, after, baseline_version="1.0.3", candidate_version="1.0.7-beta.18")

    def test_preservation_diagnostics_emit_only_fixed_field_names_and_bounded_counts(self):
        before, after = self.legacy_schema_snapshots()
        actual = after["sessions"]["sess_fixture"]
        actual["identity"]["cwd"] = "/private/replaced/path"
        actual["identity"]["private-field-name"] = "private-token"
        actual["eventHashes"] = ["private-history-hash"]
        actual["queued"] = [{"text": "private-message"}]
        diff = MOD.snapshot_differences(before, after)
        self.assertEqual(diff["changedSessionFields"], ["codex_provider", "cwd", "opencode_permission_mode"])
        self.assertEqual(diff["changedSessionCount"], 1)
        self.assertTrue(diff["unrecognizedSessionFieldChanged"])
        self.assertTrue(diff["historyChanged"])
        self.assertTrue(diff["queuedMessagesChanged"])
        public = json.dumps(diff)
        for secret in ("sess_fixture", "/private", "private-field-name", "private-token", "private-message", "native-fixture"):
            self.assertNotIn(secret, public)
        with self.assertRaises(RuntimeError) as raised:
            MOD.compare_snapshot(before, after, baseline_version="1.0.3", candidate_version="1.0.7-beta.18")
        self.assertEqual(str(raised.exception), "Migration changed preserved session fields: cwd.")
        after["sessions"] = {}
        self.assertEqual(MOD.snapshot_differences(before, after)["missingSessionCount"], 1)
        oversized = {**before, "sessions": {str(index): {} for index in range(31)}}
        with self.assertRaises(RuntimeError):
            MOD.snapshot_differences(oversized, after)

    def test_partial_fresh_native_observations_cannot_claim_complete_acceptance(self):
        checks = MOD.checks_for("bootstrap", "fresh", {"nativeServiceInstalled": True})
        self.assertEqual(checks[0]["name"], "fresh-server-install")
        self.assertEqual(checks[0]["status"], "blocked")
        self.assertIn("real-provider-chat-through-app", checks[0]["observations"]["remaining"])
        for check in checks:
            self.assertEqual(check["status"], "blocked")
        self.assertIn("busy-server-drain", [item["name"] for item in checks])

    def test_real_split_systemd_env_wrapper_uses_permanent_python(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            install = home / ".local/share/agents-server"
            service = home / ".config/systemd/user/agents-server.service"
            service.parent.mkdir(parents=True)
            fixture = {"home": str(home), "installRoot": str(install), "workDirectory": "/owned/staging"}
            service.write_text('ExecStart="/usr/bin/env" "AGENTSDOCK_STATE_DIR=' + str(home / ".agentsdock") + '" "' + str(install / "releases/1.0.3/.venv/bin/python") + '" "-m" "execution_service"\n')
            with patch.object(MOD.platform, "system", return_value="Linux"):
                self.assertEqual(MOD.registered_services(fixture), [service])
                service.write_text('ExecStart="/usr/bin/env" "FOO=bar" "/owned/staging/python"\n')
                with self.assertRaises(RuntimeError):
                    MOD.registered_services(fixture)

    def test_native_rejection_requests_never_admit_a_valid_identity_and_signature(self):
        fixture = {"serverIdentity": "real-fixture-identity", "snapshot": self.snapshot()}
        current = {"server_instance_id": "real-fixture-instance"}
        calls = []
        def request(_fixture, route, body, *, expected):
            calls.append((route, body, expected))
            return {"detail": "rejected"}
        with patch.object(MOD, "health", return_value=current), \
                patch.object(MOD, "read_regular", side_effect=[b"{}", b"x" * 64]), \
                patch.object(MOD, "request", side_effect=request), \
                patch.object(MOD, "state_snapshot", return_value=self.snapshot()):
            result = MOD.rejection_checks(fixture, Path("/signed-bundle"), "1.0.7-beta.17")
        self.assertTrue(result["invalidSignatureRejected"])
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[0][2], (400,))
        self.assertNotEqual(calls[0][1]["signature_base64"], MOD.base64.b64encode(b"x" * 64).decode())
        self.assertNotEqual(calls[1][1]["expected_server_identity"], fixture["serverIdentity"])
        self.assertNotEqual(calls[2][1]["expected_server_instance_id"], current["server_instance_id"])

    def test_exact_installed_runtime_compares_bytes_and_executable_modes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            bundle = root / "bundle"
            (bundle / "npm").mkdir(parents=True)
            runtime = root / "install/releases/1.0.7-beta.17"
            runtime.mkdir(parents=True)
            (root / "install/current").symlink_to(runtime)
            script = runtime / "install.sh"
            script.write_bytes(b"test")
            script.chmod(0o755)
            (bundle / "npm/agents-server-npm-manifest.json").write_text(json.dumps({
                "version": "1.0.7-beta.17", "archive": {"name": "package.tgz"}}))
            with tarfile.open(bundle / "npm/package.tgz", "w:gz") as package:
                member = tarfile.TarInfo("package/server/install.sh")
                member.size, member.mode = 4, 0o755
                package.addfile(member, io.BytesIO(b"test"))
            fixture = {"installRoot": str(root / "install")}
            self.assertEqual(MOD.verify_installed_runtime(fixture, bundle, "1.0.7-beta.17"), 1)
            script.chmod(0o644)
            with self.assertRaises(RuntimeError):
                MOD.verify_installed_runtime(fixture, bundle, "1.0.7-beta.17")
            script.chmod(0o755)
            script.write_bytes(b"oops")
            with self.assertRaises(RuntimeError):
                MOD.verify_installed_runtime(fixture, bundle, "1.0.7-beta.17")

    def test_installer_mode_expectation_is_narrow_and_requires_the_signed_rule(self):
        member = tarfile.TarInfo("package/server/agent_server.py")
        member.mode = 0o644
        installer = b'#!/bin/bash\nchmod 755 "$STAGE_DIR/agent_server.py" "$STAGE_DIR/install.sh"\n'
        self.assertEqual(MOD.installed_runtime_mode(member, installer), 0o755)
        for invalid in (b"", b'# chmod 755 "$STAGE_DIR/agent_server.py"\n', installer + installer,
                        b'chmod 755 "$STAGE_DIR/another.py"\n'):
            with self.subTest(invalid=invalid), self.assertRaises(RuntimeError):
                MOD.installed_runtime_mode(member, invalid)
        member.name = "package/server/unrelated.py"
        self.assertEqual(MOD.installed_runtime_mode(member, installer), 0o644)
        for unsafe in (0o777, 0o4755, 0o664):
            member.mode = unsafe
            with self.assertRaises(RuntimeError):
                MOD.installed_runtime_mode(member, installer)

    def test_installed_entrypoint_mode_matches_real_installer_without_changing_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            bundle = root / "bundle"
            (bundle / "npm").mkdir(parents=True)
            runtime = root / "install/releases/1.0.7-beta.17"
            runtime.mkdir(parents=True)
            (root / "install/current").symlink_to(runtime)
            installer = b'#!/bin/bash\nchmod 755 "$STAGE_DIR/agent_server.py" "$STAGE_DIR/install.sh"\n'
            payload = {"install.sh": (installer, 0o755), "agent_server.py": (b"entrypoint", 0o644),
                       "runtime.py": (b"module", 0o644)}
            (bundle / "npm/agents-server-npm-manifest.json").write_text(json.dumps({
                "version": "1.0.7-beta.17", "archive": {"name": "package.tgz"}}))
            with tarfile.open(bundle / "npm/package.tgz", "w:gz") as package:
                for name, (data, mode) in payload.items():
                    member = tarfile.TarInfo(f"package/server/{name}")
                    member.size, member.mode = len(data), mode
                    package.addfile(member, io.BytesIO(data))
                    installed = runtime / name
                    installed.write_bytes(data)
                    installed.chmod(0o755 if name == "agent_server.py" else mode)
            fixture = {"installRoot": str(root / "install")}
            self.assertEqual(MOD.verify_installed_runtime(fixture, bundle, "1.0.7-beta.17"), 3)
            for name, mode in (("agent_server.py", 0o644), ("agent_server.py", 0o775), ("runtime.py", 0o755)):
                target = runtime / name
                original_mode = target.stat().st_mode & 0o7777
                target.chmod(mode)
                with self.subTest(name=name, mode=mode), self.assertRaises(RuntimeError):
                    MOD.verify_installed_runtime(fixture, bundle, "1.0.7-beta.17")
                target.chmod(original_mode)
            (runtime / "agent_server.py").write_bytes(b"different")
            with self.assertRaises(RuntimeError):
                MOD.verify_installed_runtime(fixture, bundle, "1.0.7-beta.17")

    def test_production_installer_and_packager_have_only_the_known_mode_difference(self):
        server = Path(__file__).resolve().parents[2] / "server"
        module = ast.parse((server / "scripts/package_npm_release.py").read_text())
        package_executables = next(ast.literal_eval(node.value) for node in module.body
                                   if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name)
                                   and target.id == "EXECUTABLE_FILES" for target in node.targets))
        installed_executables = set()
        for line in (server / "install.sh").read_text().splitlines():
            if line.startswith("chmod 755 "):
                installed_executables.update(MOD.re.findall(r'"\$STAGE_DIR/([A-Za-z0-9_.-]+)"', line))
        installed_executables.discard("agentsdock_team_hub")  # directory, not runtime file
        self.assertEqual(installed_executables, package_executables | {"agent_server.py"})

    def staging_case(self, root, version="1.0.10-beta.1"):
        home, work, bundle = root / "account", root / "agentsdock-acceptance-fixture", root / "bundle"
        home.mkdir(mode=0o700)
        work.mkdir(mode=0o700)
        installer = (Path(MOD.__file__).resolve().parents[1] / "server/install.sh").read_bytes()
        receipt = {"sourceSha": "a" * 40, "version": version, "track": "beta" if "-beta." in version else "stable"}
        # Package real audited installer bytes but NEVER execute the installer.
        for distribution, manifest, archive_name, member_name in (
            ("npm", "agents-server-npm-manifest.json", f"server-{version}.tgz", "package/server/install.sh"),
            ("legacy", "agents-server-manifest.json", f"agents-server-{version}.tar.gz", f"agents-server-{version}/install.sh"),
        ):
            (bundle / distribution).mkdir(parents=True)
            archive = bundle / distribution / archive_name
            with tarfile.open(archive, "w:gz") as package:
                member = tarfile.TarInfo(member_name)
                member.size, member.mode = len(installer), 0o755
                package.addfile(member, io.BytesIO(installer))
            manifest_path = bundle / distribution / manifest
            manifest_path.write_text(json.dumps({
                "version": receipt["version"], "commit": receipt["sourceSha"],
                "archive": {"name": archive.name, "size": archive.stat().st_size, "sha256": MOD.sha(archive.read_bytes())}}))
            receipt[f"{distribution}ManifestSha256"] = MOD.sha(manifest_path.read_bytes())
        uv = root / "real-uv"
        uv.write_text("#!/bin/sh\nprintf 'owned-real-uv\\n'\n")
        uv.chmod(0o755)
        args = argparse.Namespace(candidate=True, kind="legacy", work=work, bundle=bundle, receipt_sha256="c" * 64)
        env = {"PATH": str(root)}
        with patch.object(MOD.sys, "platform", "darwin"), patch.object(MOD.shutil, "which", return_value=str(uv)), \
                patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}):
            MOD.prepare_stage_fault_delegate(args, receipt, home, env)
        install = MOD.paths(home)["installRoot"]
        (install / "releases").mkdir(parents=True, mode=0o700)
        fixture = {"home": str(home), "installRoot": str(install), "baselineVersion": "1.0.7-beta.21",
                   "serverIdentity": "owned-server", "snapshot": self.snapshot(),
                   "rootBindings": {"installRoot": [install.stat().st_dev, install.stat().st_ino]}}
        MOD.bind_stage_fault_delegate(args, fixture)
        stage = install / "releases" / f".staging-{receipt['version']}-431"
        stage.mkdir(mode=0o700)
        (stage / "VERSION").write_text(receipt["version"] + "\n")
        (stage / "install.sh").write_bytes(installer)
        config = work / "dependency-delegate/config.json"
        return args, fixture, receipt, config, stage, uv, env

    def test_dependency_delegate_is_durable_private_and_unarmed_calls_real_executable(self):
        with tempfile.TemporaryDirectory() as temporary:
            args, fixture, receipt, config_path, stage, uv, env = self.staging_case(Path(temporary).resolve())
            config = json.loads(MOD.read_regular(config_path, private=True))
            delegate = Path(config["delegate"])
            self.assertNotIn(str(args.work), env["PATH"])
            self.assertTrue(delegate.is_relative_to(Path(fixture["home"]) / ".local/libexec"))
            self.assertEqual(delegate.stat().st_mode & 0o777, 0o700)
            self.assertEqual(delegate.parent.stat().st_mode & 0o777, 0o700)
            self.assertEqual(config_path.stat().st_mode & 0o777, 0o600)
            result = subprocess.run([str(delegate), "--version"], capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout.strip(), b"owned-real-uv")
            self.assertFalse((config_path.parent / "consumed.json").exists())
            self.assertTrue(stage.exists())
            self.assertEqual(uv.read_text(), "#!/bin/sh\nprintf 'owned-real-uv\\n'\n")

    def test_exact_stage_delegate_faults_once_and_does_not_remove_stage_or_touch_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            args, fixture, receipt, config_path, stage, uv, env = self.staging_case(Path(temporary).resolve())
            marker = {"sourceSha": receipt["sourceSha"], "receiptSha256": args.receipt_sha256}
            MOD.write_private(config_path.parent / "armed.json", marker)
            self.assertEqual(MOD.stage_fault_delegate(["sync", "--project", str(stage), "--frozen"], config_path), 73)
            observed = json.loads(MOD.read_regular(config_path.parent / "observed.json", private=True))
            self.assertEqual(observed["stage"], str(stage))
            self.assertEqual(observed["stageInode"], stage.stat().st_ino)
            self.assertTrue(stage.exists(), "Only the actual installer may clean up its stage")
            self.assertFalse((config_path.parent / "armed.json").exists())
            self.assertEqual(json.loads(MOD.read_regular(config_path.parent / "consumed.json", private=True)), marker)
            with patch.object(MOD.os, "execv", side_effect=RuntimeError("delegated")) as execute, self.assertRaisesRegex(RuntimeError, "delegated"):
                MOD.stage_fault_delegate(["sync", "--project", str(stage), "--frozen"], config_path)
            execute.assert_called_once_with(str(uv), [str(uv), "sync", "--project", str(stage), "--frozen"])

    def test_stage_fault_refuses_replaced_uv_delegate_root_wrong_version_bytes_and_authority(self):
        for change in ("uv", "delegate", "root", "version", "bytes", "marker", "linked-version", "wrong-stage"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                args, fixture, receipt, config_path, stage, uv, env = self.staging_case(Path(temporary).resolve())
                marker = {"sourceSha": receipt["sourceSha"], "receiptSha256": args.receipt_sha256}
                if change == "marker":
                    marker["sourceSha"] = "b" * 40
                MOD.write_private(config_path.parent / "armed.json", marker)
                config = json.loads(MOD.read_regular(config_path, private=True))
                if change == "uv":
                    uv.write_text("#!/bin/sh\nexit 0\n")
                elif change == "delegate":
                    Path(config["delegate"]).write_text("#!/bin/sh\nexit 0\n")
                elif change == "root":
                    config["rootBinding"][1] += 1
                    MOD.write_private(config_path, config, replace=True)
                elif change == "version":
                    (stage / "VERSION").write_text("1.0.8\n")
                elif change == "bytes":
                    (stage / "install.sh").write_text("different runtime")
                elif change == "linked-version":
                    (stage / "VERSION").rename(stage / "saved-version")
                    (stage / "VERSION").symlink_to(stage / "saved-version")
                elif change == "wrong-stage":
                    stage = stage.parent / ".staging-1.0.8-beta.1-432"
                with patch.object(MOD.os, "execv") as execute, self.assertRaises((RuntimeError, OSError)):
                    MOD.stage_fault_delegate(["sync", "--project", str(stage)], config_path)
                execute.assert_not_called()
                self.assertTrue((config_path.parent / "armed.json").exists())
                self.assertFalse((config_path.parent / "consumed.json").exists())

    def test_stage_fixture_refuses_existing_delegate_and_non_candidate_before_installation(self):
        with tempfile.TemporaryDirectory() as temporary:
            args, fixture, receipt, config_path, stage, uv, env = self.staging_case(Path(temporary).resolve())
            with patch.object(MOD.sys, "platform", "darwin"), patch.object(MOD.shutil, "which", return_value=str(uv)), \
                    patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}), \
                    self.assertRaises(FileExistsError):
                MOD.prepare_stage_fault_delegate(args, receipt, Path(fixture["home"]), env)
            args.candidate = False
            with patch.object(MOD.shutil, "which") as which, self.assertRaises(RuntimeError):
                MOD.prepare_stage_fault_delegate(args, receipt, Path(fixture["home"]), env)
            which.assert_not_called()

    def run_staging_recovery_case(self, root, *, retain_stage=False, bad_marker=False, root_mode=0o755,
                                 changed_field=None):
        args, fixture, receipt, config_path, stage, uv, env = self.staging_case(root)
        calls = []
        before = {"serverInstanceId": "old", "components": {"gateway": "old-gateway", "execution": "old-worker"},
                  "registrations": {"gateway": "old-plist", "execution": "old-worker-plist"},
                  "currentLink": "owned-baseline", "rootMode": root_mode,
                  "rootIdentity": [*fixture["rootBindings"]["installRoot"], os.getuid()]}
        recovered = {**before, "rootMode": 0o700}
        if changed_field:
            recovered[changed_field] = "private-changed-value"
        accepted = {**before, "serverInstanceId": "new", "rootMode": 0o700}
        def request(_fixture, route, body=None):
            calls.append((route, body))
            if route.endswith("/start") and len(calls) == 1:
                self.assertEqual(MOD.stage_fault_delegate(["sync", "--project", str(stage)], config_path), 73)
                if bad_marker:
                    observed_path = config_path.parent / "observed.json"
                    observed = json.loads(MOD.read_regular(observed_path, private=True))
                    MOD.write_private(observed_path, {**observed, "installerSha256": "d" * 64}, replace=True)
                if not retain_stage:
                    # Unit fixture simulates installer EXIT. The real native
                    # harness contains no deletion or journal repair operation.
                    shutil.rmtree(stage)
            return {"phase": "failed"} if route == "/api/admin/update" else {"phase": "starting"}
        with patch.object(MOD.sys, "platform", "darwin"), \
                patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}), \
                patch.object(MOD, "staging_native_identity", side_effect=[before, recovered, accepted]), \
                patch.object(MOD, "request", side_effect=request), \
                patch.object(MOD, "state_snapshot", return_value=self.snapshot()), \
                patch.object(MOD, "health"), patch.object(MOD, "wait_update_complete"), \
                patch.object(MOD, "verify_installed_runtime", return_value=117), \
                patch.object(MOD, "command") as command:
            if retain_stage or bad_marker or changed_field:
                with self.assertRaises(RuntimeError):
                    MOD.staging_failure_retry(args, fixture, receipt)
                self.assertEqual(len([call for call in calls if call[0].endswith("/start")]), 1)
            else:
                value = MOD.staging_failure_retry(args, fixture, receipt)
                self.assertEqual(calls[0], calls[2], "Retry must use the same public target and process identity")
                self.assertEqual(value["exactRuntimeFilesCompared"], 117)
                self.assertEqual(value["installRootModeBefore"], f"{root_mode:04o}")
                self.assertEqual(value["installRootModeAfter"], "0700")
                self.assertTrue(value["installRootIdentityPreserved"])
                for key in ("failedStageRemovedByInstaller", "installLockReleasedByInstaller",
                            "incumbentComponentsIdentityAndDataPreserved", "sameAcceptedVersionRetried"):
                    self.assertTrue(value[key])
                for key in ("fenceCleanupObserved", "rollbackObserved", "activationInterruptionObserved",
                            "allQaDependenciesIndependent", "nonemptyProviderHistoryObserved"):
                    self.assertFalse(value[key])
                checks = MOD.checks_for("staging-failure-retry", "legacy", value)
                self.assertEqual(checks[0]["name"], "failed-candidate-stage-removal-and-retry")
                self.assertEqual(checks[0]["status"], "passed")
            command.assert_not_called()

    def test_native_stage_recovery_uses_same_api_without_repair_and_keeps_claims_scoped(self):
        for mode in (0o755, 0o750, 0o700):
            with self.subTest(mode=oct(mode)), tempfile.TemporaryDirectory() as temporary:
                self.run_staging_recovery_case(Path(temporary).resolve(), root_mode=mode)

    def test_native_stage_retry_still_rejects_every_incumbent_identity_change(self):
        for field in ("serverInstanceId", "components", "registrations", "currentLink", "rootIdentity", "rootMode"):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as temporary:
                self.run_staging_recovery_case(Path(temporary).resolve(), changed_field=field)

    def test_root_normalization_contract_binds_both_exact_archives_and_source(self):
        changes = (None, "source", "version", "name", "archive", "hash", "coupled-archive-descriptor", "reviewed-policy", "canonical-source")
        for version, change in ((version, change) for version in ("1.0.10-beta.1", "1.0.10-beta.2", "1.0.10-beta.3", "1.0.10-beta.4") for change in changes):
            with self.subTest(version=version, change=change), tempfile.TemporaryDirectory() as temporary:
                args, fixture, receipt, config, stage, uv, env = self.staging_case(Path(temporary).resolve(), version)
                manifest = args.bundle / "legacy/agents-server-manifest.json"
                descriptor = json.loads(manifest.read_text())
                if change == "source": descriptor["commit"] = "b" * 40
                if change == "version": descriptor["version"] = "1.0.8"
                if change == "name": descriptor["archive"]["name"] = "../outside.tar.gz"
                if change == "hash": descriptor["archive"]["sha256"] = "0" * 64
                if change == "coupled-archive-descriptor":
                    archive = args.bundle / "legacy" / descriptor["archive"]["name"]
                    # Keep the reviewed installer but alter other package bytes
                    # and recompute the descriptor. The accepted receipt still
                    # must reject this coupled replacement.
                    installer = (stage / "install.sh").read_bytes()
                    with tarfile.open(archive, "w:gz") as package:
                        member = tarfile.TarInfo(f"agents-server-{receipt['version']}/install.sh")
                        member.size, member.mode = len(installer), 0o755
                        package.addfile(member, io.BytesIO(installer))
                        changed = tarfile.TarInfo(f"agents-server-{receipt['version']}/changed")
                        changed.size = 8
                        package.addfile(changed, io.BytesIO(b"modified"))
                    descriptor["archive"].update(size=archive.stat().st_size, sha256=MOD.sha(archive.read_bytes()))
                manifest.write_text(json.dumps(descriptor))
                if change in {"source", "version", "name", "hash"}:
                    # Independently exercise each inner binding after the raw
                    # descriptor-digest guard has accepted these fixture bytes.
                    receipt["legacyManifestSha256"] = MOD.sha(manifest.read_bytes())
                if change == "archive": (args.bundle / "legacy" / descriptor["archive"]["name"]).write_bytes(b"different")
                if change == "reviewed-policy":
                    with patch.object(MOD, "BETA1101_ROOT_NORMALIZING_INSTALLER_SHA256", "0" * 64), self.assertRaises(RuntimeError):
                        MOD.root_normalization_contract(args.bundle, receipt)
                elif change == "canonical-source":
                    with patch.object(MOD, "ROOT", args.work), self.assertRaises(OSError):
                        MOD.root_normalization_contract(args.bundle, receipt)
                elif change:
                    with self.assertRaises(RuntimeError): MOD.root_normalization_contract(args.bundle, receipt)
                else:
                    self.assertEqual(MOD.root_normalization_contract(args.bundle, receipt), MOD.BETA1101_ROOT_NORMALIZING_INSTALLER_SHA256)

    def test_root_normalization_never_relaxes_mode_inode_owner_or_contract(self):
        before = {"rootMode": 0o755, "rootIdentity": [1, 2, os.getuid()]}
        after = {**before, "rootMode": 0o700}
        pin = MOD.ROOT_NORMALIZING_INSTALLER_SHA256
        for mode in (0o755, 0o750, 0o700):
            self.assertTrue(MOD.verify_root_normalization({**before, "rootMode": mode}, after, pin)["installRootIdentityPreserved"])
        for change in ({"rootMode": 0o755}, {"rootMode": 0o750}, {"rootMode": 0o777}, {"rootMode": "0700"},
                       {"rootIdentity": [1, 3, os.getuid()]}, {"rootIdentity": [2, 2, os.getuid()]},
                       {"rootIdentity": [1, 2, os.getuid() + 1]}):
            with self.subTest(change=change), self.assertRaises(RuntimeError):
                MOD.verify_root_normalization(before, {**after, **change}, pin)
        for mode in (0o775, 0o777, 0o600, None, True):
            with self.assertRaises(RuntimeError): MOD.verify_root_normalization({**before, "rootMode": mode}, after, pin)
        with self.assertRaises(RuntimeError): MOD.verify_root_normalization(before, after, "f" * 64)

    def test_stable109_installer_pin_is_version_scoped_and_old_beta_policy_is_retained(self):
        self.assertEqual(MOD.ROOT_NORMALIZING_INSTALLER_SHA256,
                         "1ad0dc6fc8255959cbd15da08239331401f44467760490818a5669f6f3f75f15")
        self.assertEqual(MOD.STABLE109_ROOT_NORMALIZING_INSTALLER_SHA256,
                         "52b6212d6bd00fdf2b071cbd5ec8f01ea16aa43df58f77352dadca17ee96ffc4")
        self.assertEqual(MOD.BETA1101_ROOT_NORMALIZING_INSTALLER_SHA256, MOD.sha((MOD.ROOT / "server/install.sh").read_bytes()))
        for version in ("1.0.8-beta.5", "1.0.9", "1.0.9-beta.1", "1.0.10", "1.0.10-beta.5"):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as temporary:
                args, _, receipt, *_ = self.staging_case(Path(temporary).resolve(), version)
                with self.assertRaisesRegex(RuntimeError, "not the reviewed exact implementation"):
                    MOD.root_normalization_contract(args.bundle, receipt)
        for version in ("1.0.10-beta.2", "1.0.10-beta.3", "1.0.10-beta.4"):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as temporary:
                args, _, receipt, *_ = self.staging_case(Path(temporary).resolve(), version)
                self.assertEqual(MOD.root_normalization_contract(args.bundle, receipt), MOD.BETA1101_ROOT_NORMALIZING_INSTALLER_SHA256)
        before = {"rootMode": 0o750, "rootIdentity": [1, 2, os.getuid()]}
        self.assertTrue(MOD.verify_root_normalization(before, {**before, "rootMode": 0o700},
                            MOD.STABLE109_ROOT_NORMALIZING_INSTALLER_SHA256)["signedInstallerRootNormalizationObserved"])

    def test_native_root_observation_refuses_replacement_inode_and_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve() / "install"
            root.mkdir(mode=0o750)
            root.chmod(0o750)
            fixture = {"installRoot": str(root), "rootBindings": {"installRoot": [root.stat().st_dev, root.stat().st_ino]}}
            self.assertEqual(MOD.native_root_state(fixture)["rootMode"], 0o750)
            root.rename(root.with_name("incumbent"))
            root.mkdir(mode=0o700)
            with self.assertRaises(RuntimeError): MOD.native_root_state(fixture)
            root.rmdir()
            root.symlink_to(root.with_name("incumbent"))
            with self.assertRaises(RuntimeError): MOD.native_root_state(fixture)

    def test_native_field_failure_diagnostic_exposes_only_fixed_field_names(self):
        before = {"serverInstanceId": "old-private", "components": {"gateway": "private-value"},
                  "registrations": {"token": "private-token"}, "currentLink": "/private/path"}
        after = {**before, "components": {}, "registrations": {}}
        with self.assertRaisesRegex(RuntimeError, "components, registrations") as error:
            MOD.require_preserved_native_fields(before, after, tuple(before))
        self.assertNotIn("private", str(error.exception))
        with self.assertRaises(RuntimeError): MOD.require_preserved_native_fields(before, after, ("arbitrary-secret",))

    def test_retained_stage_or_wrong_fault_receipt_refuses_retry(self):
        for change in ("retained", "wrong-marker"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                self.run_staging_recovery_case(Path(temporary).resolve(),
                    retain_stage=change == "retained", bad_marker=change == "wrong-marker")

    def test_native_staging_identity_rejects_missing_or_mixed_components_before_process_access(self):
        value = {"ok": True, "server_version": "1.0.8-beta.2", "server_instance_id": "owned-instance",
                 "gateway": {"protocol": 1, "version": "1.0.8-beta.2", "pid": 41, "instance_id": "gateway-instance"},
                 "execution_service": {"protocol": 1, "version": "1.0.7-beta.21", "pid": 42, "instance_id": "worker-instance"}}
        with patch.object(MOD.sys, "platform", "darwin"), patch.object(MOD, "health", return_value=value), \
                patch.object(MOD, "registered_services") as registrations, self.assertRaises(RuntimeError):
            MOD.staging_native_identity({}, "1.0.8-beta.2")
        registrations.assert_not_called()

    def failure_case(self, root, *, bad_marker=False):
        bundle = root / "bundle"
        (bundle / "legacy").mkdir(parents=True)
        descriptor = {"archive": {"sha256": "e" * 64, "size": 1000}}
        (bundle / "legacy/agents-server-manifest.json").write_text(json.dumps(descriptor))
        args = argparse.Namespace(work=root, bundle=bundle, fault_control=root / "fault.json",
                                  fault_observed=root / "observed.json", receipt_sha256="c" * 64)
        receipt = {"version": "1.0.7-beta.17", "track": "beta", "sourceSha": "a" * 40}
        fixture = {"baselineVersion": "1.0.3", "serverIdentity": "owned-server", "snapshot": self.snapshot(),
                   "installRoot": str(root / "owned-install")}
        calls = []
        def request(_fixture, route, body=None):
            calls.append((route, body))
            if route.endswith("/start") and len(calls) == 1:
                control = json.loads(MOD.read_regular(args.fault_control, private=True))
                args.fault_control.rename(Path(str(args.fault_control) + ".consumed"))
                MOD.write_private(args.fault_observed, {**control, "interrupted": True, "socketDestroyed": True,
                    "archiveSha256": "d" * 64 if bad_marker else "e" * 64, "bytesOffered": 500, "totalBytes": 1000})
                return {"phase": "starting"}
            if route == "/api/admin/update":
                return {"phase": "failed"} if len(calls) == 2 else {"phase": "complete", "installed_version": receipt["version"]}
            return {"phase": "starting"}
        return args, receipt, fixture, calls, request

    def test_interrupted_download_retries_same_public_api_without_install_or_journal_repair(self):
        with tempfile.TemporaryDirectory() as temporary:
            args, receipt, fixture, calls, request = self.failure_case(Path(temporary).resolve())
            with patch.object(MOD, "request", side_effect=request), \
                    patch.object(MOD, "health", side_effect=[{"server_instance_id": "old"}, {"server_instance_id": "old"}, {"server_instance_id": "new"}]), \
                    patch.object(MOD, "state_snapshot", return_value=self.snapshot()), \
                    patch.object(MOD, "verify_installed_runtime", return_value=116), \
                    patch.object(MOD, "registered_services", return_value=[]), \
                    patch.object(MOD, "command") as command:
                observations = MOD.failure_retry(args, fixture, receipt)
            self.assertEqual(calls[0], calls[2])
            self.assertEqual(calls[0][0], "/api/admin/update/start")
            self.assertEqual(observations["exactRuntimeFilesCompared"], 116)
            self.assertFalse(observations["rollbackObserved"])
            command.assert_not_called()
            checks = MOD.checks_for("failure-retry", "legacy", observations)
            self.assertEqual(checks[0]["status"], "passed")
            self.assertEqual(len(checks), 1)

    def test_wrong_archive_fault_marker_refuses_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            args, receipt, fixture, calls, request = self.failure_case(Path(temporary).resolve(), bad_marker=True)
            with patch.object(MOD, "request", side_effect=request), \
                    patch.object(MOD, "health", return_value={"server_instance_id": "old"}), \
                    patch.object(MOD, "state_snapshot", return_value=self.snapshot()), self.assertRaises(RuntimeError):
                MOD.failure_retry(args, fixture, receipt)
            self.assertEqual(len([call for call in calls if call[0].endswith("/start")]), 1)

    def test_rollback_signal_requires_exact_new_candidate_owned_worker(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            install = root / "install"
            candidate = install / "releases/1.0.7-beta.17"
            candidate.mkdir(parents=True)
            (install / "current").symlink_to(candidate)
            process = root / "proc/222"
            process.mkdir(parents=True)
            user = str(os.getuid())
            (process / "status").write_text(f"Name:\tpython\nUid:\t{user}\t{user}\t{user}\t{user}\n")
            (process / "stat").write_text("222 (python worker) " + " ".join(["S"] + ["0"] * 18 + ["12345", "0"]))
            command = "\0".join([str(candidate / ".venv/bin/python"), str(candidate / "execution_service.py"),
                                   "worker", "--runtime-dir", "/owned/state/execution", "--bind", "127.0.0.1",
                                   "--port", "17850", "--callback-port", "0", ""])
            (process / "cmdline").write_bytes(command.encode())
            (process / "cwd").symlink_to(candidate)
            fixture = {"installRoot": str(install)}
            proof = lambda incumbent=111, arm=12300: MOD.candidate_process_identity(222, fixture, "1.0.7-beta.17", incumbent, arm, proc_root=root / "proc")
            self.assertEqual(proof(), (222, 12345))
            self.assertIsNone(proof(incumbent=222))
            self.assertIsNone(proof(arm=12346))
            wrong_user = str(os.getuid() + 1)
            (process / "status").write_text("Uid:\t" + "\t".join([wrong_user] * 4) + "\n")
            self.assertIsNone(proof())
            (process / "status").write_text(f"Uid:\t{user}\t{user}\t{user}\t{user}\n")
            (process / "cmdline").write_bytes(command.replace("worker", "gateway").encode())
            self.assertIsNone(proof())
            (process / "cmdline").write_bytes(command.replace(str(candidate), str(install / "releases/1.0.3")).encode())
            self.assertIsNone(proof())
            (process / "cmdline").write_bytes((str(candidate / ".venv/bin/python") + "\0-m\0execution_service\0worker\0").encode())
            self.assertIsNone(proof())
            (process / "cmdline").write_bytes(command.encode())
            (process / "cwd").unlink()
            (process / "cwd").symlink_to(root)
            self.assertIsNone(proof())
            (process / "cwd").unlink()
            (process / "cwd").symlink_to(candidate)
            (install / "current").unlink()
            (install / "current").symlink_to(install / "releases/1.0.3")
            self.assertIsNone(proof())

    def test_rollback_operation_refuses_non_linux_before_service_actions(self):
        with patch.object(MOD.sys, "platform", "darwin"), patch.object(MOD, "worker_pid") as pid, self.assertRaises(RuntimeError):
            MOD.rollback_retry(None, {}, {})
        pid.assert_not_called()

    def test_rollback_journal_requires_candidate_and_same_observed_transaction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            directory = root / ".activation-transaction"
            directory.mkdir(mode=0o700)
            path = directory / "manifest.json"
            value = {"format": 3, "release_version": "1.0.7-beta.17",
                     "release_dir": str(root / "releases/1.0.7-beta.17"),
                     "transaction_id": "activation-" + "a" * 24, "phase": "rolling-back"}
            MOD.write_private(path, value)
            self.assertEqual(MOD.candidate_activation_journal(root, value["release_version"], value["transaction_id"]), value)
            for key, changed in (("release_version", "1.0.3"), ("release_dir", str(root / "other")),
                                 ("transaction_id", "activation-" + "b" * 24), ("format", 1)):
                path.unlink()
                MOD.write_private(path, {**value, key: changed})
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    MOD.candidate_activation_journal(root, value["release_version"], value["transaction_id"])

    def test_rollback_fault_refuses_preexisting_transaction_even_if_unreadable(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            MOD.require_no_pending_journals(root)
            for name in (".activation-transaction", ".execution-transaction"):
                path = root / name
                path.symlink_to(root / "missing")
                with self.subTest(name=name), self.assertRaises(RuntimeError):
                    MOD.require_no_pending_journals(root)
                path.unlink()

    def test_no_host_service_can_run_without_guard(self):
        result = subprocess.run([sys.executable, str(Path(MOD.__file__)), "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("disposable", result.stdout)

    def test_service_diagnostics_emit_only_finite_fields_not_environment_or_argv(self):
        raw = b"\tstate = running\n\tpid = 812\n\tlast exit code = 78\n\tenvironment = { TOKEN = private-token }\n\tprogram = /private/path\n"
        value = MOD.diagnostic_service_output(subprocess.CompletedProcess([], 0, raw, b"private-stderr"), "Darwin")
        self.assertEqual(value, {"registered": True, "querySucceeded": True, "state": "running", "pid": 812, "lastExitCode": 78})
        for private in ("private-token", "private/path", "private-stderr", "environment"):
            self.assertNotIn(private, json.dumps(value))
        unknown = MOD.diagnostic_service_output(subprocess.CompletedProcess([], 5, b"private-token", b"I/O error"), "Darwin")
        self.assertEqual(unknown, {"registered": None, "querySucceeded": False})
        absent = MOD.diagnostic_service_output(subprocess.CompletedProcess([], 113, b"", b"Could not find service"), "Darwin")
        self.assertEqual(absent["registered"], False)

    def test_diagnostic_journal_projection_rejects_arbitrary_values(self):
        fixture = {"baselineVersion": "1.0.3", "targetVersion": "1.0.7-beta.18"}
        value = MOD.diagnostic_status({"phase": "rolling-back", "release_version": fixture["targetVersion"],
                                       "error": "private-token private-path", "retryable": True}, fixture)
        self.assertEqual(value, {"readable": True, "phase": "rolling-back", "target": "candidate", "errorPresent": True, "retryable": True,
                                 "preparationPhase": "absent", "errorCode": "absent", "scheduleIdPresent": False,
                                 "updateIdPresent": False, "preparationIdPresent": False, "errorHttpStatus": None,
                                 "failure": {"messageState": "missing", "categories": [], "knownError": None}})
        for phase in ("private-token", {"token": "private-token"}, ["private-token"]):
            result = MOD.diagnostic_status({"phase": phase, "error_code": "private-token"}, fixture)
            self.assertEqual(result["phase"], "other-or-unknown")
            self.assertNotIn("private-token", json.dumps(result))

    def test_retry_admission_projects_finite_status_and_never_identifiers_or_payload(self):
        fixture = {"baselineVersion": "1.0.7-beta.21", "targetVersion": "1.0.8-beta.4"}
        private = "private-canary-path-token-message"
        raw = {"phase": "pending", "target_version": fixture["targetVersion"], "preparation_phase": "staging",
               "error_code": "server_update_pending", "retryable": True, "schedule_id": private,
               "update_id": private, "preparation_id": private, "message": private, "nested": {"token": private}}
        value = MOD.rollback_retry_admission(raw, fixture)
        self.assertEqual(value, {"observed": True, "phase": "pending", "target": "candidate", "preparationPhase": "staging",
                                "errorCode": "server_update_pending", "retryable": True, "errorPresent": True,
                                "scheduleIdPresent": True, "updateIdPresent": True, "preparationIdPresent": True, "errorHttpStatus": None})
        self.assertEqual(MOD.bounded_retry_admission(value), value)
        self.assertNotIn(private, json.dumps(value))
        for malformed in (private, [private], {"private": private}, True, 1):
            with self.subTest(malformed=type(malformed).__name__):
                projected = MOD.rollback_retry_admission({**raw, "phase": malformed, "target_version": malformed,
                    "preparation_phase": malformed, "error_code": malformed, "retryable": malformed,
                    "schedule_id": malformed, "update_id": malformed, "preparation_id": malformed}, fixture)
                self.assertEqual(projected["phase"], "other-or-unknown")
                self.assertEqual(projected["target"], "other-or-unknown")
                self.assertEqual(projected["preparationPhase"], "other-or-unknown")
                self.assertEqual(projected["errorCode"], "other-or-unknown")
                self.assertIs(projected["retryable"], malformed is True)
                self.assertIs(projected["scheduleIdPresent"], isinstance(malformed, str))
                self.assertNotIn(private, json.dumps(projected))
        self.assertEqual(MOD.rollback_retry_admission(None, fixture), {"observed": False})
        self.assertEqual(MOD.bounded_retry_admission({"observed": "private"}), {"observed": False})

    def test_available_error_and_pending_http_are_finite_not_raw_error_text(self):
        fixture = {"baselineVersion": "1.0.7-beta.21", "targetVersion": "1.0.8-beta.4"}
        raw = {"phase": "available", "error_code": "server_update_pending_http_503", "retryable": True,
               "message": "installer failed (1): another AgentsServer installation is active /private/canary?token=secret"}
        result = MOD.diagnostic_status(raw, fixture)
        self.assertEqual(result["phase"], "available")
        self.assertEqual(result["errorCode"], "server_update_pending_http")
        self.assertEqual(result["errorHttpStatus"], 503)
        self.assertEqual(result["failure"]["categories"], ["installer", "installer-lock"])
        self.assertEqual(result["failure"]["installerExitCode"], 1)
        self.assertNotIn("private", json.dumps(result))
        self.assertNotIn("secret", json.dumps(result))
        self.assertNotIn("server_update_pending_http_503", json.dumps(result))
        for status in (400, 499, 500, 599):
            value = MOD.rollback_retry_admission({**raw, "error_code": f"server_update_pending_http_{status}"}, fixture)
            self.assertEqual(value["errorHttpStatus"], status)
            self.assertEqual(value["errorCode"], "server_update_pending_http")
            self.assertEqual(MOD.bounded_retry_admission(value), value)
        for code in ("server_update_pending_http_399", "server_update_pending_http_600", "server_update_pending_http_0503",
                     "server_update_pending_http_503-private-canary", "server_update_pending_http_503\n", ["private-canary"]):
            value = MOD.diagnostic_status({**raw, "error_code": code}, fixture)
            self.assertEqual(value["errorCode"], "other-or-unknown")
            self.assertIsNone(value["errorHttpStatus"])
            self.assertNotIn("private", json.dumps(value))

    def test_component_diagnostic_distinguishes_native_pid_version_and_maintenance_without_identity(self):
        fixture = {"baselineVersion": "1.0.7-beta.21", "targetVersion": "1.0.8-beta.4"}
        raw = {"version": fixture["targetVersion"], "protocol": 1, "pid": 123,
               "instance_id": "private-instance", "maintenance_held": False, "argv": ["private-path"]}
        value = MOD.diagnostic_component(raw, fixture, {"pid": 123})
        self.assertEqual(value, {"present": True, "version": "candidate", "protocolMatches": True, "pidPresent": True,
                                "instancePresent": True, "nativePidMatches": True, "maintenance": "released"})
        self.assertFalse(MOD.diagnostic_component(raw, fixture, {"pid": 124})["nativePidMatches"])
        malformed = MOD.diagnostic_component({**raw, "pid": True, "protocol": True, "maintenance_held": "false"}, fixture, {"pid": True})
        self.assertFalse(malformed["pidPresent"])
        self.assertFalse(malformed["protocolMatches"])
        self.assertIsNone(malformed["nativePidMatches"])
        self.assertEqual(malformed["maintenance"], "unknown")
        self.assertEqual(MOD.diagnostic_component(None, fixture, {}), {"present": False})
        self.assertNotIn("private", json.dumps([value, malformed]))

    def diagnostic_lock_fixture(self, home):
        root = home / "install"
        root.mkdir(mode=0o700)
        lock = root / ".install-lock"
        lock.mkdir(mode=0o700)
        (lock / "pid").write_text("222\n")
        (lock / "pid").chmod(0o600)
        transaction = "activation-" + "a" * 24
        recovery = root / ".activation-recovery"
        recovery.mkdir(mode=0o700)
        directory = recovery / transaction
        directory.mkdir(mode=0o700)
        binding = root.stat()
        owner = {"root_binding": {"device": binding.st_dev, "inode": binding.st_ino}, "root": str(root), "home": str(home),
                 "platform": "Linux", "transaction_id": transaction, "version": "1.0.8-beta.4",
                 "expected_server_identity": "private-server-identity", "interpreter": "/private/python"}
        MOD.write_private(directory / "owner.json", owner)
        MOD.write_private(directory / "terminal.json", {"private": "private-terminal", "phase": "rolled-back"})
        retirement = {"format": 1, "transaction_id": transaction,
                      "terminal_sha256": MOD.sha((directory / "terminal.json").read_bytes())}
        MOD.write_private(directory / "finalized.json", retirement)
        MOD.write_private(directory / "retired.json", retirement)
        unit = home / ".config/systemd/user" / ("agents-server-recovery-" + "a" * 24 + ".service")
        unit.parent.mkdir(parents=True, mode=0o700)
        unit.write_text("[Service]\nExecStart=/private/recovery\n")
        unit.chmod(0o644)
        fixture = {"installRoot": str(root), "home": str(home), "targetVersion": "1.0.8-beta.4",
                   "serverIdentity": "private-server-identity"}
        return fixture, transaction, directory, unit

    def test_pre_retry_lock_snapshot_is_cheap_read_only_and_never_native_queries_or_waits(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            fixture, transaction, directory, unit = self.diagnostic_lock_fixture(home)
            original = {path: path.read_bytes() for path in home.rglob("*") if path.is_file()}
            with patch.object(MOD, "command", side_effect=AssertionError("no native command")) as command, \
                    patch.object(MOD, "request", side_effect=AssertionError("no HTTP")) as request, \
                    patch.object(MOD, "sha", side_effect=AssertionError("no payload hashing")) as digest, \
                    patch.object(MOD.time, "sleep", side_effect=AssertionError("no waiting")) as sleep, \
                    patch.object(MOD.os, "kill", return_value=None) as kill:
                result = MOD.rollback_lock_snapshot(fixture, transaction)
            self.assertTrue(result["lockPresent"])
            self.assertTrue(result["lockSafe"])
            self.assertTrue(result["ownerAlive"])
            self.assertEqual(result["nativeState"], "not-queried")
            self.assertIsNone(result["nativeRegistered"])
            self.assertEqual(result["ownerRole"], "unknown")
            kill.assert_called_once_with(222, 0)
            for unused in (command, request, digest, sleep):
                unused.assert_not_called()
            self.assertEqual(original, {path: path.read_bytes() for path in home.rglob("*") if path.is_file()})
            self.assertNotIn("private", json.dumps(result))
            self.assertNotIn(str(home), json.dumps(result))
            self.assertNotIn(transaction, json.dumps(result))

    def test_lock_snapshot_refuses_unsafe_links_modes_hardlinks_and_foreign_ownership(self):
        for change in ("pid-link", "lock-link", "pid-mode", "lock-mode", "pid-hardlink", "pid-text", "uid"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                fixture, transaction, directory, unit = self.diagnostic_lock_fixture(home)
                lock = Path(fixture["installRoot"]) / ".install-lock"
                pid = lock / "pid"
                if change == "pid-link":
                    destination = home / "private-pid"
                    pid.rename(destination)
                    pid.symlink_to(destination)
                elif change == "lock-link":
                    destination = home / "private-lock"
                    lock.rename(destination)
                    lock.symlink_to(destination, target_is_directory=True)
                elif change == "pid-mode": pid.chmod(0o666)
                elif change == "lock-mode": lock.chmod(0o777)
                elif change == "pid-hardlink": os.link(pid, home / "private-pid")
                elif change == "pid-text": pid.write_text("private-token\n")
                uid = os.getuid() + (1 if change == "uid" else 0)
                with patch.object(MOD.os, "getuid", return_value=uid), patch.object(MOD.os, "kill") as kill, \
                        patch.object(MOD, "command", side_effect=AssertionError("no native command")):
                    result = MOD.rollback_lock_snapshot(fixture, transaction)
                if change == "uid":
                    self.assertEqual(result, {"observed": False})
                    kill.assert_not_called()
                    continue
                self.assertFalse(result["lockSafe"])
                self.assertIsNone(result["ownerAlive"])
                self.assertEqual(result["ownerRole"], "unknown")
                kill.assert_not_called()
                self.assertNotIn("private", json.dumps(result))

    def test_terminal_lock_owner_proof_requires_fixture_native_pid_and_exact_process(self):
        for change in (None, "identity", "root", "transaction", "version", "native-pid", "argv", "uid", "cwd", "replaced-lock"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary).resolve()
                fixture, transaction, directory, unit = self.diagnostic_lock_fixture(home)
                owner_path = directory / "owner.json"
                owner = json.loads(owner_path.read_text())
                key = {"identity": "expected_server_identity", "root": "root", "transaction": "transaction_id", "version": "version"}.get(change)
                if key:
                    owner_path.unlink()
                    MOD.write_private(owner_path, {**owner, key: "private-mismatch"})
                process = home / "proc/222"
                process.mkdir(parents=True)
                uid = str(os.getuid() + (1 if change == "uid" else 0))
                (process / "status").write_text("Uid:\t" + "\t".join([uid] * 4) + "\n")
                (process / "stat").write_text("222 (python recovery) " + " ".join(["S"] + ["0"] * 18 + ["12345", "0"]))
                argv = [owner["interpreter"], "-B", str(directory / "execution_recovery.py"), "run", "--root", fixture["installRoot"], "--transaction-id", transaction]
                if change == "argv": argv[3] = "private-wrong-command"
                (process / "cmdline").write_bytes(("\0".join(argv) + "\0").encode())
                (process / "cwd").symlink_to(home if change == "cwd" else directory)
                def native(args, **kwargs):
                    self.assertEqual(args, ["systemctl", "--user", "show", unit.name, "--property=LoadState,ActiveState,MainPID"])
                    self.assertEqual(kwargs["timeout"], 5)
                    if change == "replaced-lock":
                        pid = Path(fixture["installRoot"]) / ".install-lock/pid"
                        pid.rename(pid.with_name("private-old-pid"))
                        pid.write_text("222\n")
                        pid.chmod(0o600)
                    return subprocess.CompletedProcess(args, 0, f"LoadState=loaded\nActiveState=active\nMainPID={223 if change == 'native-pid' else 222}\n".encode(), b"private-stderr")
                with patch.object(MOD.os, "kill", return_value=None) as kill, patch.object(MOD, "command", side_effect=native) as command, \
                        patch.object(MOD, "service") as service:
                    result = MOD.rollback_lock_snapshot(fixture, transaction, query_native=True, proc_root=home / "proc")
                self.assertEqual(result["ownerRole"], "recovery" if change is None else "unknown")
                self.assertEqual(result["recoveryOwnerVerified"], not bool(key))
                if key: command.assert_not_called()
                service.assert_not_called()
                kill.assert_called_once_with(222, 0)
                self.assertNotIn("private", json.dumps(result))
                self.assertNotIn(str(home), json.dumps(result))

    def test_terminal_lock_query_timeout_is_finite_and_does_not_replace_acceptance_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            fixture, transaction, directory, unit = self.diagnostic_lock_fixture(home)
            with patch.object(MOD.os, "kill", return_value=None), \
                    patch.object(MOD, "command", side_effect=subprocess.TimeoutExpired(["private-command"], 5, output=b"private-token")):
                value = MOD.rollback_lock_snapshot(fixture, transaction, query_native=True)
                diagnostic = {"stage": "retry-health", "transient502": 0, "transient503": 203,
                              "candidateProcessesFaulted": 24, "rollbackPhasesObserved": 3,
                              "watcherStopped": True, "_recoveryTransaction": transaction}
                with patch.object(MOD, "rollback_state_diagnostic", return_value={"diagnosticOnly": True, "collected": False}), \
                        patch.dict(os.environ, {"GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1"}):
                    report = MOD.rollback_failure_report(SimpleNamespace(receipt_sha256="c" * 64),
                        {"sourceSha": "a" * 40, "version": "1.0.8-beta.4"}, diagnostic,
                        RuntimeError("original private-health-failure"), "b" * 40, fixture=fixture)
            self.assertEqual(value["ownerRole"], "unknown")
            self.assertIsNone(value["nativeRegistered"])
            self.assertEqual(report["diagnostic"]["failureCategory"], "assertion")
            self.assertEqual(report["diagnostic"]["stage"], "retry-health")
            self.assertFalse(report["observed"])
            self.assertNotIn("private", json.dumps(report))

    def test_rollback_state_diagnostic_uses_disk_status_not_mutating_update_get_or_history(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            install, state = home / "install", home / "state"
            install.mkdir(mode=0o700)
            (state / "admin").mkdir(parents=True, mode=0o700)
            preparation = "a" * 32
            prep = install / ".update-preparations" / preparation
            prep.mkdir(parents=True, mode=0o700)
            (prep / "prepare.log").write_text("HTTP Error 404: private-token\nanother AgentsServer installation is active /private/path\n")
            raw_status = {"phase": "available", "target_version": "1.0.8-beta.4", "preparation_phase": "ready",
                          "error_code": "server_update_pending_http_503", "preparation_id": preparation,
                          "message": "installer failed (1): private-token another AgentsServer installation is active"}
            MOD.write_private(state / "admin/server-update.json", raw_status)
            fixture = {"installRoot": str(install), "stateRoot": str(state), "home": str(home),
                       "baselineVersion": "1.0.7-beta.21", "targetVersion": "1.0.8-beta.4", "serverIdentity": "private-identity"}
            before = {path: path.read_bytes() for path in home.rglob("*") if path.is_file()}
            def observe(fixture_arg, route, *args, **kwargs):
                self.assertEqual(route, "/api/health", "GET update can advance production recovery and is not read-only")
                return {"ok": True, "server_version": fixture["baselineVersion"], "server_identity": "private-identity",
                        "gateway": {"version": fixture["baselineVersion"], "protocol": 1, "pid": 123, "instance_id": "private-gateway"},
                        "execution_service": {"version": fixture["baselineVersion"], "protocol": 1, "pid": 124, "instance_id": "private-worker", "maintenance_held": False}}
            with patch.object(MOD, "registered_services", return_value=[]), patch.object(MOD, "request", side_effect=observe) as request, \
                    patch.object(MOD, "state_snapshot", side_effect=AssertionError("no history/session traversal")) as snapshot, \
                    patch.object(MOD, "command", side_effect=AssertionError("no unowned native queries")) as command, \
                    patch.object(MOD, "service") as service:
                result = MOD.rollback_state_diagnostic(fixture)
            self.assertTrue(result["collected"])
            self.assertNotIn("updateStatus", result)
            self.assertEqual(result["journals"]["update"]["phase"], "available")
            self.assertEqual(result["journals"]["update"]["errorHttpStatus"], 503)
            self.assertEqual(result["logs"]["preparation"]["categories"], ["http-404", "installer-lock"])
            self.assertEqual(result["health"]["components"]["worker"]["version"], "baseline")
            self.assertEqual(result["health"]["components"]["worker"]["maintenance"], "released")
            request.assert_called_once()
            for unused in (snapshot, command, service): unused.assert_not_called()
            self.assertEqual(before, {path: path.read_bytes() for path in home.rglob("*") if path.is_file()})
            self.assertNotIn("private", json.dumps(result))
            self.assertNotIn(preparation, json.dumps(result))
            self.assertNotIn(str(home), json.dumps(result))

    def test_actual_failure_collector_rejects_nested_raw_fields_invalid_enums_and_unbound_metadata(self):
        workflow = (MOD.ROOT / ".github/workflows/ci.yml").read_text()
        section = workflow.split("- name: Collect bounded non-publishing server-only observations", 1)[1]
        program = textwrap.dedent(section.split("<<'NODE'\n", 1)[1].split("\n          NODE", 1)[0])
        fixture = {"baselineVersion": "1.0.7-beta.21", "targetVersion": "1.0.8-beta.4"}
        status = MOD.diagnostic_status({"phase": "available", "target_version": fixture["targetVersion"],
            "error_code": "server_update_pending_http_503", "message": "installer failed (1): another AgentsServer installation is active private-canary"}, fixture)
        component = MOD.diagnostic_component({"version": fixture["baselineVersion"], "protocol": 1, "pid": 123,
            "instance_id": "private-canary", "maintenance_held": False}, fixture, {"pid": 123})
        lock = MOD.bounded_lock_snapshot({"observed": True, "lockPresent": True, "lockSafe": True, "ownerAlive": True,
            "recoveryOwnerVerified": True, "retiredPresent": True, "unitFilePresent": True, "nativeRegistered": True,
            "ownerRole": "recovery", "nativeState": "active"})
        state = {"diagnosticOnly": True, "collected": True, "currentRuntime": "baseline", "registrationsVerified": True,
                 "services": {"worker": {"registered": True, "querySucceeded": True, "state": "active", "pid": 123, "lastExitCode": 0}},
                 "health": {"reachable": True, "ok": True, "identityMatches": True, "version": "baseline",
                            "components": {"gateway": component, "worker": component}},
                 "logs": {key: {"readable": True, "categories": ["installer-lock"]} for key in
                          ("updater", "legacyStderr", "workerStderr", "gatewayStderr", "preparation")},
                 "tmuxTrust": {"daemonAvailable": True, "ownedTrustBundleAvailable": True, "trustBundleMatches": True},
                 "journals": {"activation": {"readable": False}, "execution": {"readable": False}, "update": status}}
        cases = [(None, None), (("diagnostic", "retryAdmission", "raw"), "private-canary"),
                 (("diagnostic", "retryAdmission", "errorCode"), "server_update_pending_http_503-private-canary"),
                 (("diagnostic", "retryAdmission", "errorHttpStatus"), True),
                 (("diagnostic", "retryAdmission", "errorHttpStatus"), 600),
                 (("diagnostic", "beforeRetry", "pid"), 123), (("diagnostic", "afterAdmission", "nativeState"), "private-canary"),
                 (("diagnostic", "failureLock", "ownerRole"), "private-canary"),
                 (("diagnostic", "state", "raw"), "private-canary"),
                 (("diagnostic", "state", "health", "components", "worker", "instance_id"), "private-canary"),
                 (("diagnostic", "state", "health", "components", "worker", "maintenance"), "private-canary"),
                 (("diagnostic", "state", "services", "worker", "pid"), 2 ** 31),
                 (("diagnostic", "state", "services", "worker", "argv"), ["private-canary"]),
                 (("diagnostic", "state", "logs", "preparation", "categories"), ["private-canary"]),
                 (("diagnostic", "state", "logs", "updater", "categories"), ["installer-lock", "installer-lock"]),
                 (("diagnostic", "state", "tmuxTrust", "bundle"), "private-canary"),
                 (("diagnostic", "state", "journals", "update", "failure", "raw"), "private-canary"),
                 (("diagnostic", "state", "journals", "update", "failure", "knownError"), "private-canary"),
                 (("diagnostic", "state", "journals", "update", "failure", "installerExitCode"), 32768),
                 (("harnessSourceSha",), "d" * 40), (("runAttempt",), "2"), (("version",), "1.0.8-beta.3"),
                 (("releaseReceiptSha256",), "d" * 64)]
        for path, value in cases:
            with self.subTest(path=path, value=value), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source, destination = root / "source", root / "public"
                source.mkdir()
                receipt = {"sourceSha": "a" * 40, "version": fixture["targetVersion"]}
                receipt_path = root / "receipt.json"
                receipt_path.write_bytes(MOD.canonical(receipt))
                args = SimpleNamespace(receipt_sha256=MOD.sha(receipt_path.read_bytes()))
                environment = {**os.environ, "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "1",
                               "GITHUB_SHA": "b" * 40, "RECEIPT_SHA256": args.receipt_sha256}
                diagnostic = {"stage": "retry-completion", "transient502": 0, "transient503": 203,
                              "candidateProcessesFaulted": 24, "rollbackPhasesObserved": 3, "watcherStopped": True,
                              "retryAdmission": MOD.rollback_retry_admission({"phase": "pending", "error_code": "server_update_pending_http_503"}, fixture),
                              "beforeRetry": lock, "afterAdmission": lock}
                with patch.dict(os.environ, environment), patch.object(MOD, "rollback_state_diagnostic", return_value=state), \
                        patch.object(MOD, "rollback_lock_snapshot", return_value=lock):
                    report = MOD.rollback_failure_report(args, receipt, diagnostic, RuntimeError("private-canary"), "b" * 40, fixture=fixture)
                report = copy.deepcopy(report)
                self.assertNotIn("private-canary", json.dumps(report))
                if path:
                    parent = report
                    for key in path[:-1]: parent = parent[key]
                    parent[path[-1]] = value
                (source / "rollback-failure.json").write_bytes(MOD.canonical(report))
                result = subprocess.run(["node", "--input-type=module", "-", str(source), str(destination), str(receipt_path)],
                                        input=program, text=True, capture_output=True, timeout=10, env=environment)
                self.assertEqual(result.returncode == 0, path is None, result.stderr)
                self.assertEqual((destination / "rollback-failure.json").exists(), path is None)
                self.assertNotIn("private-canary", result.stdout + result.stderr)

    def test_legacy_failure_classification_covers_fixed_descriptor_archive_and_installer_errors(self):
        cases = [
            ("Signed beta AgentsServer release 1.0.7-beta.18 is unavailable.", "descriptor-fetch", "signed-descriptor-not-found"),
            ("release manifest version does not match its immutable release tag", "manifest-verification", "manifest-tag-mismatch"),
            ("release archive location is not trusted", "manifest-verification", "archive-location-untrusted"),
            ("release archive checksum does not match the signed manifest", "archive-verification", "archive-checksum-mismatch"),
            ("release archive contains an unsafe path", "archive-extraction", "archive-unsafe-path"),
            ("release archive has an invalid layout", "archive-extraction", "archive-layout-invalid"),
            ("AgentsServer startup readiness timed out after 60 seconds", "health-readiness", "startup-readiness-timeout"),
            ("updated AgentsServer stable identity does not match", "post-install-health", "candidate-identity-mismatch"),
            ("installer failed (2): private-token /private/path", "installer", "installer-exit-failure"),
            ("installer timed out after 1800 seconds: private-token", "installer", "installer-timeout"),
        ]
        for message, category, known in cases:
            with self.subTest(known=known):
                value = MOD.diagnostic_legacy_failure(message)
                self.assertEqual(value["knownError"], known)
                self.assertIn(category, value["categories"])
                self.assertNotIn("stage", value)
                self.assertNotIn("private-token", json.dumps(value))
                self.assertNotIn("private/path", json.dumps(value))

    def test_legacy_failure_classification_keeps_network_and_nested_output_private(self):
        message = "<urlopen error [SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate https://private.invalid/?token=private-token>"
        tls = MOD.diagnostic_legacy_failure(message)
        self.assertEqual(tls["categories"], ["tls-verification"])
        http = MOD.diagnostic_legacy_failure("HTTP Error 403: private-token https://private.invalid/private-path")
        self.assertEqual(http["httpStatus"], 403)
        self.assertEqual(http["categories"], ["http-response"])
        install = MOD.diagnostic_legacy_failure("installer failed (78): ModuleNotFoundError: private-module; [Errno 13] Permission denied: /private/path")
        self.assertEqual(install["installerExitCode"], 78)
        self.assertEqual(install["categories"], ["installer", "missing-python-module", "permission-denied"])
        output = json.dumps([tls, http, install])
        for private in ("private-token", "private.invalid", "private-path", "private/path", "private-module"):
            self.assertNotIn(private, output)

    def test_legacy_failure_classification_is_bounded_and_does_not_invent_signature_or_stage(self):
        for message, state in ((None, "missing"), ({"message": "private-token"}, "invalid-type"),
                               ("x" * 8193, "oversized"), ("", "empty"), ("  ", "empty")):
            with self.subTest(state=state):
                self.assertEqual(MOD.diagnostic_legacy_failure(message), {"messageState": state, "categories": [], "knownError": None})
        self.assertEqual(MOD.diagnostic_legacy_failure("private-token"),
                         {"messageState": "present", "categories": ["unclassified"], "knownError": None})
        fixture = {"baselineVersion": "1.0.3", "targetVersion": "1.0.7-beta.18"}
        failed = MOD.diagnostic_status({"phase": "failed", "message": "HTTP Error 404: private-token"}, fixture)
        self.assertEqual(failed["failure"]["httpStatus"], 404)
        self.assertNotIn("failure", MOD.diagnostic_status({"phase": "installing", "message": "HTTP Error 404: private-token"}, fixture))

    def test_tmux_diagnostic_inspects_only_owned_trust_variable_and_never_starts_a_daemon(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            work = root / "agentsdock-acceptance-candidate"
            work.mkdir()
            network = root / "agentsdock-acceptance-network"
            network.mkdir()
            bundle = network / "trust-bundle.pem"
            MOD.write_private(bundle, {"publicFixture": True})
            cases = [(0, f"SSL_CERT_FILE={bundle}\n".encode(), b"", True, True),
                     (0, b"SSL_CERT_FILE=/private/unrelated\n", b"", True, False),
                     (1, b"", b"unknown variable: SSL_CERT_FILE", True, False),
                     (1, b"", b"no server running on /private/socket", False, False),
                     (1, b"", b"private unknown error", None, False)]
            for code, stdout, stderr, available, matches in cases:
                with self.subTest(code=code, available=available, matches=matches), \
                        patch.object(MOD, "command", return_value=subprocess.CompletedProcess([], code, stdout, stderr)) as command:
                    value = MOD.diagnostic_tmux_trust({"workDirectory": str(work)})
                self.assertEqual(command.call_args.args[0], ["tmux", "show-environment", "-g", "SSL_CERT_FILE"])
                self.assertEqual(value, {"daemonAvailable": available, "ownedTrustBundleAvailable": True, "trustBundleMatches": matches})
                self.assertNotIn("private", json.dumps(value))
                self.assertNotIn(str(root), json.dumps(value))

    def test_diagnostic_log_tail_is_bounded_and_never_exports_text_or_follows_links(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            path = root / "updater.log"
            path.write_bytes(b"CERTIFICATE_VERIFY_FAILED private-token\n" + b"x" * 70000 + b"\nModuleNotFoundError: private-module\n")
            self.assertEqual(MOD.diagnostic_log_categories(path, root), {"readable": True, "categories": ["missing-python-module"]})
            link = root / "linked.log"
            link.symlink_to(path)
            self.assertEqual(MOD.diagnostic_log_categories(link, root), {"readable": False, "categories": []})

    def test_diagnose_is_read_only_and_preserves_port_identity_and_activation_observations(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            install, state = home / "install", home / "state"
            candidate = install / "releases/1.0.7-beta.18"
            candidate.mkdir(parents=True)
            state.mkdir()
            (install / "current").symlink_to(candidate)
            journal = install / ".activation-transaction"
            journal.mkdir()
            MOD.write_private(journal / "manifest.json", {"phase": "candidate-starting", "release_version": "1.0.7-beta.18", "private": "private-token"})
            item = home / "com.agentsdock.server.plist"
            item.write_bytes(plistlib.dumps({"EnvironmentVariables": {"AGENTSDOCK_AGENT_PORT": "17850", "TOKEN": "private-token"}}))
            fixture = {"installRoot": str(install), "stateRoot": str(state), "home": str(home), "serverUrl": "http://127.0.0.1:17850",
                       "baselineVersion": "1.0.3", "targetVersion": "1.0.7-beta.18", "serverIdentity": "private-identity"}
            output = subprocess.CompletedProcess([], 0, b"\tstate = waiting\n\tlast exit code = 1\n", b"")
            with patch.object(MOD, "registered_services", return_value=[item]), patch.object(MOD.platform, "system", return_value="Darwin"), \
                    patch.object(MOD, "command", return_value=output) as command, patch.object(MOD, "request", side_effect=ConnectionRefusedError), \
                    patch.object(MOD, "service") as service:
                result = MOD.diagnose(fixture)
            service.assert_not_called()
            self.assertEqual(command.call_args.args[0][:2], ["/bin/launchctl", "print"])
            self.assertEqual(command.call_count, 1)
            self.assertEqual(result["currentRuntime"], "candidate")
            self.assertEqual(result["services"]["worker"]["lastExitCode"], 1)
            self.assertTrue(result["services"]["worker"]["configuredPortMatches"])
            self.assertFalse(result["health"]["reachable"])
            self.assertEqual(result["journals"]["activation"]["phase"], "candidate-starting")
            self.assertNotIn("private-token", json.dumps(result))
            self.assertNotIn("private-identity", json.dumps(result))
            self.assertNotIn(str(home), json.dumps(result))
            self.assertEqual(MOD.checks_for("diagnose", "legacy", result)[0]["status"], "blocked")

    def test_diagnose_includes_field_only_preservation_difference_without_changing_state(self):
        before, after = self.legacy_schema_snapshots()
        after["sessions"]["sess_fixture"]["identity"]["cwd"] = "/private/changed-path"
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            fixture = {"home": str(home), "installRoot": str(home / "install"), "stateRoot": str(home / "state"),
                       "baselineVersion": "1.0.3", "targetVersion": "1.0.7-beta.18", "snapshot": before,
                       "serverIdentity": "private-identity"}
            with patch.object(MOD, "registered_services", return_value=[]), \
                    patch.object(MOD, "request", return_value={"ok": True, "server_identity": "private-identity", "server_version": "1.0.7-beta.18"}), \
                    patch.object(MOD, "state_snapshot", return_value=after), patch.object(MOD, "command") as command, \
                    patch.object(MOD, "service") as service:
                result = MOD.diagnose(fixture)
            service.assert_not_called()
            command.assert_not_called()
            self.assertEqual(result["preservation"]["changedSessionFields"],
                             ["codex_provider", "cwd", "opencode_permission_mode"])
            self.assertNotIn("private", json.dumps(result))
            self.assertNotIn("sess_fixture", json.dumps(result))
            self.assertEqual(before["sessions"]["sess_fixture"]["identity"]["cwd"], "/owned/custom")

    def test_unverified_registration_diagnostics_do_not_query_or_mutate_service(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary).resolve()
            fixture = {"home": str(home), "installRoot": str(home / "install"), "stateRoot": str(home / "state"),
                       "baselineVersion": "1.0.3", "targetVersion": "1.0.7-beta.18"}
            with patch.object(MOD, "registered_services", side_effect=RuntimeError("unproven")), \
                    patch.object(MOD, "request", side_effect=ConnectionRefusedError), patch.object(MOD, "command") as command:
                result = MOD.diagnose(fixture)
            command.assert_not_called()
            self.assertFalse(result["registrationsVerified"])


if __name__ == "__main__":
    unittest.main()
