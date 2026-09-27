"""Pure/unit tests only: never change host routing or system trust."""
import hashlib
import json
import os
from pathlib import Path
import stat
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

    def fixture(self):
        self.receipt = self.root / "release.json"
        self.receipt.write_text(json.dumps({"sourceSha": "a" * 40}))
        self.receipt_hash = hashlib.sha256(self.receipt.read_bytes()).hexdigest()
        self.hosts = self.root / "hosts"
        self.baseline = b"127.0.0.1 localhost\n::1 localhost\n"
        self.hosts.write_bytes(self.baseline)
        self.lock = self.root / "lock"
        self.calls = []

        def fake_command(*args, data=None):
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
