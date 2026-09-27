"""Pure/unit tests only: never change host routing or system trust."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import product_acceptance_network as network


class NetworkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.work = self.root / "replay"
        self.env = {"CI": "true", "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted",
                    "GITHUB_REPOSITORY": "ZhengyiLuo/AgentsDock", "GITHUB_EVENT_NAME": "workflow_dispatch",
                    "GITHUB_WORKFLOW_REF": "ZhengyiLuo/AgentsDock/.github/workflows/product-release-acceptance.yml@refs/heads/release/candidate",
                    "GITHUB_RUN_ID": "123", "GITHUB_RUN_ATTEMPT": "2", "RUNNER_TEMP": str(self.root),
                    "RUNNER_OS": "macOS" if sys.platform == "darwin" else "Linux"}

    def test_guard_allows_only_explicit_hosted_native_acceptance(self):
        self.assertEqual(network.guard(self.work, self.env)[0], self.work)
        for key, value in [("CI", "false"), ("GITHUB_ACTIONS", "false"), ("RUNNER_ENVIRONMENT", "self-hosted"),
                           ("GITHUB_REPOSITORY", "other/AgentsDock"), ("GITHUB_EVENT_NAME", "pull_request"),
                           ("GITHUB_RUN_ID", "../1"), ("GITHUB_RUN_ATTEMPT", "0"), ("RUNNER_OS", "Windows"),
                           ("GITHUB_WORKFLOW_REF", "ZhengyiLuo/AgentsDock/.github/workflows/product-release.yml@refs/heads/main"),
                           ("GITHUB_WORKFLOW_REF", "ZhengyiLuo/AgentsDock/.github/workflows/product-release-acceptance.yml@refs/pull/44/merge")]:
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                network.guard(self.work, {**self.env, key: value})
        for value in ({}, {"CI": "true", "GITHUB_ACTIONS": "true"}):
            with self.assertRaises(ValueError):
                network.guard(self.work, value)

    def test_guard_refuses_broad_external_or_symlink_work(self):
        for path in (self.root, Path("/tmp"), Path("/")):
            with self.assertRaises(ValueError):
                network.guard(path, self.env)
        link = self.root / "link"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            network.guard(link / "replay", self.env)

    def test_candidate_scope_has_separate_explicit_ci_guard(self):
        env = {**self.env, "RUNNER_OS": "macOS", "GITHUB_SHA": "a" * 40, "GITHUB_WORKFLOW_REF":
               "ZhengyiLuo/AgentsDock/.github/workflows/ci.yml@refs/heads/release/test"}
        with mock.patch.object(network.sys, "platform", "darwin"):
            self.assertEqual(network.guard(self.work, env, candidate=True)[1]["publicationEligible"], False)
            with self.assertRaises(ValueError):
                network.guard(self.work, env)
            with self.assertRaises(ValueError):
                network.guard(self.work, {**self.env, "RUNNER_OS": "macOS"}, candidate=True)
        with mock.patch.object(network.sys, "platform", "linux"), self.assertRaises(ValueError):
            network.guard(self.work, {**env, "RUNNER_OS": "Linux"}, candidate=True)

    def test_only_exact_three_hosts_are_overridden(self):
        baseline = b"127.0.0.1 localhost\n::1 localhost\n# github.com example comment\n192.0.2.1 other.test\n"
        active = network.hosts_overlay(baseline, network.MARKER + " 1/1")
        self.assertTrue(active.startswith(baseline))
        self.assertIn(b"127.0.0.1 github.com api.github.com registry.npmjs.org\n", active)
        self.assertEqual(active.count(b"127.0.0.1 github.com"), 1)
        self.assertNotIn(b"*.github.com", active)

    def test_existing_host_rules_and_other_instances_are_refused(self):
        for baseline in (b"127.0.0.1 github.com\n", b"::1 API.GITHUB.COM. other\n",
                         b"192.0.2.1 alias registry.npmjs.org # custom\n", network.MARKER.encode()):
            with self.subTest(baseline=baseline), self.assertRaises(ValueError):
                network.hosts_overlay(baseline, network.MARKER)

    def test_baseline_without_newline_is_restored_byte_for_byte(self):
        baseline = b"127.0.0.1 localhost"
        active = network.hosts_overlay(baseline, network.MARKER)
        self.assertEqual(network.restore_hosts(active, baseline, active, network.MARKER), baseline)
        self.assertEqual(network.restore_hosts(baseline, baseline, active, network.MARKER), baseline)
        with self.assertRaisesRegex(ValueError, "unrelated"):
            network.restore_hosts(active + b"192.0.2.1 unrelated\n", baseline, active, network.MARKER)

    def test_private_files_and_bounded_nofollow_inputs(self):
        path = self.root / "private"
        network.write_private(path, b"fixture")
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        with self.assertRaises(FileExistsError):
            network.write_private(path, b"replace")
        with self.assertRaises(ValueError):
            network.regular(path, limit=2)
        link = self.root / "link"
        link.symlink_to(path)
        with self.assertRaises(OSError):
            network.regular(link)

    def test_trust_plan_is_narrow_and_never_disables_verification(self):
        mac = network.trust_commands("macOS", self.work, "A" * 40, True)
        self.assertIn("trustRoot", mac[0])
        self.assertEqual(mac[0][-1], str(self.work / "ca.pem"))
        remove = network.trust_commands("macOS", self.work, "A" * 40, False)
        self.assertEqual(remove[0][-2], "A" * 40)
        linux = network.trust_commands("Linux", self.work, "A" * 40, False)
        self.assertEqual(linux[0], ["sudo", "-n", "/bin/rm", "--", "/usr/local/share/ca-certificates/agentsdock-product-replay.crt"])
        self.assertNotIn("-r", linux[0])
        text = json.dumps([mac, remove, linux])
        for unsafe in ("NODE_TLS_REJECT_UNAUTHORIZED", "--insecure", "--ignore-certificate-errors"):
            self.assertNotIn(unsafe, text)

    def test_child_environment_strips_release_credentials(self):
        with mock.patch.dict(os.environ, {"AGENTSDOCK_RELEASE_TOKEN": "private-fixture", "PATH": "/usr/bin"}), \
                mock.patch.object(network.subprocess, "run") as run:
            run.return_value.stdout = b"ok"
            network.command("openssl", "version")
        child = run.call_args.kwargs["env"]
        self.assertEqual(child["PATH"], "/usr/bin")
        self.assertNotIn("AGENTSDOCK_RELEASE_TOKEN", child)
        self.assertEqual(run.call_args.kwargs["timeout"], 120)

    def test_command_failures_and_timeouts_never_expose_arguments_or_output(self):
        args = ("openssl", "verify", "private-argument")
        for error in (
                subprocess.CalledProcessError(20, args, output=b"private-output", stderr=b"private-stderr"),
                subprocess.TimeoutExpired(args, 30, output=b"private-output", stderr=b"private-stderr")):
            with self.subTest(error=type(error).__name__), \
                    mock.patch.object(network.subprocess, "run", side_effect=error) as run, \
                    self.assertRaises(RuntimeError) as raised:
                network.command(*args, timeout=30)
            message = str(raised.exception)
            self.assertIn("openssl", message)
            self.assertIn("private output was withheld", message)
            for private in ("private-argument", "private-output", "private-stderr"):
                self.assertNotIn(private, message)
            self.assertEqual(run.call_args.kwargs["timeout"], 30)

    def fixture(self):
        self.receipt = self.root / "release.json"
        self.receipt.write_text(json.dumps({"sourceSha": "a" * 40}))
        self.receipt_hash = hashlib.sha256(self.receipt.read_bytes()).hexdigest()
        self.hosts = self.root / "hosts"
        self.baseline = b"127.0.0.1 localhost\n::1 localhost\n"
        self.hosts.write_bytes(self.baseline)
        self.lock = self.root / "lock"
        self.calls = []

        def fake_command(*args, data=None, timeout=120):
            self.calls.append(args)
            if args[:2] == ("git", "rev-parse"):
                return b"a" * 40 + b"\n"
            if args[:2] == ("openssl", "req"):
                for option in ("-keyout", "-out"):
                    network.write_private(Path(args[args.index(option) + 1]), b"fixture-not-a-real-certificate")
            if args[:2] == ("openssl", "x509"):
                if "-fingerprint" in args:
                    return b"sha1 Fingerprint=" + b"AA:" * 19 + b"AA\n"
                network.write_private(Path(args[args.index("-out") + 1]), b"fixture-leaf")
            if args[:4] == ("sudo", "-n", "/usr/bin/tee", str(self.hosts)):
                self.hosts.write_bytes(data)
            return b""

        for patch in (mock.patch.dict(os.environ, self.env, clear=True),
                      mock.patch.object(network, "HOSTS_FILE", self.hosts),
                      mock.patch.object(network, "LOCK", self.lock),
                      mock.patch.object(network, "command", side_effect=fake_command),
                      mock.patch.object(network.ssl, "create_default_context")):
            value = patch.start()
            self.addCleanup(patch.stop)
            if isinstance(value, mock.Mock) and patch.attribute == "create_default_context":
                value.return_value.get_ca_certs.return_value = [b"fixture-public-ca"]

    def test_mocked_setup_cleanup_keeps_private_bytes_out_of_report(self):
        self.fixture()
        result = network.setup(self.receipt, self.receipt_hash, self.work)
        self.assertEqual(result["receiptSha256"], self.receipt_hash)
        self.assertEqual(result["hosts"], list(network.HOSTS))
        self.assertEqual(result["port"], 443)
        self.assertNotIn("fixture-not-a-real", json.dumps(result))
        self.assertIn("SSL_CERT_FILE", result["environment"])
        self.assertIn("NODE_EXTRA_CA_CERTS", result["environment"])
        self.assertIn(b"DNS:github.com,DNS:api.github.com,DNS:registry.npmjs.org", (self.work / "leaf.ext").read_bytes())
        self.assertEqual(stat.S_IMODE((self.work / "ca.key").stat().st_mode), 0o600)
        self.assertNotEqual(self.hosts.read_bytes(), self.baseline)
        self.assertEqual(network.teardown(self.work), {"restored": True})
        self.assertEqual(self.hosts.read_bytes(), self.baseline)
        self.assertFalse(self.lock.exists())
        self.assertFalse((self.work / "ca.key").exists())
        self.assertFalse((self.work / "leaf.key").exists())
        self.assertEqual(network.teardown(self.work), {"restored": True})

    def test_all_replay_hostnames_are_verified_before_any_privileged_mutation(self):
        self.fixture()
        network.setup(self.receipt, self.receipt_hash, self.work)
        verifications = [call for call in network.command.call_args_list
                         if call.args[:2] == ("openssl", "verify")]
        self.assertEqual([call.args for call in verifications], [
            ("openssl", "verify", "-CAfile", str(self.work / "ca.pem"),
             "-purpose", "sslserver", "-verify_hostname", host, str(self.work / "leaf.pem"))
            for host in network.HOSTS])
        self.assertTrue(all(call.kwargs.get("timeout") == 30 for call in verifications))
        last_verification = max(index for index, call in enumerate(self.calls)
                                if call[:2] == ("openssl", "verify"))
        first_mutation = min(index for index, call in enumerate(self.calls) if call[0] == "sudo")
        self.assertLess(last_verification, first_mutation)

    def test_certificate_generation_owns_its_config_and_never_appends_ca_extensions(self):
        self.fixture()
        network.setup(self.receipt, self.receipt_hash, self.work)
        requests = [call for call in self.calls if call[:2] == ("openssl", "req")]
        self.assertEqual(len(requests), 2)
        self.assertEqual([call[call.index("-config") + 1] for call in requests],
                         [str(self.work / "ca.cnf"), str(self.work / "leaf.cnf")])
        self.assertTrue(all("-addext" not in call for call in requests))
        ca_config = (self.work / "ca.cnf").read_text()
        self.assertEqual(ca_config.count("basicConstraints="), 1)
        self.assertEqual(ca_config.count("keyUsage="), 1)
        self.assertIn("subjectKeyIdentifier=hash", ca_config)
        self.assertIn("authorityKeyIdentifier=keyid:always", ca_config)
        self.assertNotIn("x509_extensions", (self.work / "leaf.cnf").read_text())

    def test_real_temporary_certificate_chains_have_unique_extensions_and_all_three_hostnames(self):
        # Generate disposable fixture keys only. Never run setup, install trust,
        # change hosts, or read a real signing identity in this regression.
        binaries = []
        for candidate in (shutil.which("openssl"), "/usr/bin/openssl", "/opt/homebrew/bin/openssl"):
            if candidate and Path(candidate).is_file() and str(Path(candidate).resolve()) not in binaries:
                binaries.append(str(Path(candidate).resolve()))
        verifiers = []
        for binary in binaries:
            help_result = subprocess.run([binary, "verify", "-help"], capture_output=True, timeout=10)
            if b"-verify_hostname" in help_result.stdout + help_result.stderr:
                verifiers.append(binary)
        if not verifiers:
            self.skipTest("A hostname-capable OpenSSL verifier is not installed")
        for index, binary in enumerate(binaries):
            with self.subTest(binary=Path(binary).name, index=index):
                work = self.root / f"certificates-{index}"
                work.mkdir(mode=0o700)
                network.generate_certificates(work, "AgentsDock disposable unit fixture", openssl=binary)
                for certificate in ("ca.pem", "leaf.pem"):
                    details = network.command(binary, "x509", "-in", str(work / certificate), "-noout", "-text")
                    self.assertEqual(details.count(b"X509v3 Basic Constraints:"), 1)
                    self.assertEqual(details.count(b"X509v3 Key Usage:"), 1)
                for verifier in verifiers:
                    for host in network.HOSTS:
                        network.command(verifier, "verify", "-CAfile", str(work / "ca.pem"),
                                        "-purpose", "sslserver", "-verify_hostname", host,
                                        str(work / "leaf.pem"), timeout=30)
                    with self.assertRaises(RuntimeError):
                        network.command(verifier, "verify", "-CAfile", str(work / "ca.pem"),
                                        "-purpose", "sslserver", "-verify_hostname", "unrelated.example",
                                        str(work / "leaf.pem"), timeout=30)
                for name in ("ca.key", "leaf.key"):
                    self.assertEqual(stat.S_IMODE((work / name).stat().st_mode), 0o600)

    def test_certificate_preflight_failure_never_mutates_trust_or_hosts_and_is_cleanable(self):
        self.fixture()
        original = network.command.side_effect

        def reject_hostname(*args, data=None, timeout=120):
            if args[:2] == ("openssl", "verify") and "api.github.com" in args:
                self.calls.append(args)
                raise RuntimeError("Replay command failed (openssl, exit 20); private output was withheld")
            return original(*args, data=data, timeout=timeout)

        with mock.patch.object(network, "command", side_effect=reject_hostname), \
                self.assertRaisesRegex(RuntimeError, "openssl, exit 20"):
            network.setup(self.receipt, self.receipt_hash, self.work)
        verified_hosts = [call[call.index("-verify_hostname") + 1] for call in self.calls
                          if call[:2] == ("openssl", "verify")]
        self.assertEqual(verified_hosts, ["github.com", "api.github.com"])
        self.assertFalse(any(call[0] == "sudo" for call in self.calls))
        self.assertEqual(self.hosts.read_bytes(), self.baseline)
        for marker in ("trust.attempted", "hosts.attempted", "trust.env", "network.json"):
            self.assertFalse((self.work / marker).exists())
        self.assertEqual(network.teardown(self.work), {"restored": True})
        self.assertFalse(any(call[0] == "sudo" for call in self.calls))
        self.assertFalse(self.lock.exists())
        self.assertFalse((self.work / "ca.key").exists())
        self.assertFalse((self.work / "leaf.key").exists())
        self.assertEqual(network.teardown(self.work), {"restored": True})

    def test_receipt_tamper_or_source_mismatch_never_calls_sudo(self):
        self.fixture()
        with self.assertRaisesRegex(ValueError, "seal"):
            network.setup(self.receipt, "b" * 64, self.work)
        self.receipt.write_text(json.dumps({"sourceSha": "b" * 40}))
        with self.assertRaisesRegex(ValueError, "source"):
            network.setup(self.receipt, hashlib.sha256(self.receipt.read_bytes()).hexdigest(), self.work)
        self.assertFalse(any(call[0] == "sudo" for call in self.calls))
        self.assertFalse(self.lock.exists())

    def test_cleanup_rejects_other_run_and_preserves_unrelated_changes(self):
        self.fixture()
        network.setup(self.receipt, self.receipt_hash, self.work)
        with mock.patch.dict(os.environ, {"GITHUB_RUN_ID": "999"}), self.assertRaisesRegex(ValueError, "ownership"):
            network.teardown(self.work)
        changed = self.hosts.read_bytes() + b"192.0.2.1 unrelated\n"
        self.hosts.write_bytes(changed)
        with self.assertRaisesRegex(ValueError, "unrelated"):
            network.teardown(self.work)
        self.assertEqual(self.hosts.read_bytes(), changed)
        self.assertTrue(self.lock.exists())

    def test_second_instance_never_changes_routing_or_lock_owner(self):
        self.fixture()
        network.setup(self.receipt, self.receipt_hash, self.work)
        owner = (self.lock / "owner.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "already"):
            network.setup(self.receipt, self.receipt_hash, self.root / "second")
        self.assertEqual((self.lock / "owner.json").read_bytes(), owner)
        self.assertFalse((self.root / "second").exists())

    def test_partial_setup_failure_remains_owned_and_cleanable(self):
        self.fixture()
        original = network.command.side_effect

        def fail_openssl(*args, data=None):
            if args[:2] == ("openssl", "req"):
                raise RuntimeError("fixture certificate failure")
            return original(*args, data=data)

        with mock.patch.object(network, "command", side_effect=fail_openssl), self.assertRaisesRegex(RuntimeError, "fixture"):
            network.setup(self.receipt, self.receipt_hash, self.work)
        self.assertEqual(network.teardown(self.work), {"restored": True})
        self.assertEqual(self.hosts.read_bytes(), self.baseline)
        self.assertFalse(self.lock.exists())

    def test_empty_public_trust_roots_fail_before_privileged_changes(self):
        self.fixture()
        network.ssl.create_default_context.return_value.get_ca_certs.return_value = []
        with self.assertRaisesRegex(ValueError, "public trust"):
            network.setup(self.receipt, self.receipt_hash, self.work)
        self.assertFalse(any(call[0] == "sudo" for call in self.calls))
        self.assertEqual(network.teardown(self.work), {"restored": True})


if __name__ == "__main__":
    unittest.main()
