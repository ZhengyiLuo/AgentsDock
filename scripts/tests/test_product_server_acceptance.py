"""Unit-test native harness safety/claims, never start host services."""
import copy
import argparse
import ast
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("product_server_acceptance", Path(__file__).resolve().parents[1] / "product_server_acceptance.py")
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class NativeServerAcceptanceUnitTests(unittest.TestCase):
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
                           {"sourceRef": "main"}, {"sourceSha": "b" * 40}):
                with self.subTest(change=change), self.assertRaises(RuntimeError):
                    MOD.guard({**receipt, **change}, work, candidate=True, environment=env, uid=501, system="Darwin")
            for change in ({"GITHUB_EVENT_NAME": "workflow_call"}, {"GITHUB_EVENT_NAME": "pull_request"},
                           {"GITHUB_WORKFLOW_REF": "ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/release/other"},
                           {"RUNNER_ENVIRONMENT": "self-hosted"}, {"RUNNER_OS": "Linux"}):
                with self.subTest(change=change), self.assertRaises(RuntimeError):
                    MOD.guard(receipt, work, candidate=True, environment={**env, **change}, uid=501, system="Darwin")
            with self.assertRaises(RuntimeError):
                MOD.guard(receipt, work, candidate=True, environment=env, uid=501, system="Linux")

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


if __name__ == "__main__":
    unittest.main()
