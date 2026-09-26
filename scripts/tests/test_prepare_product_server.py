"""Local product-server preparation using disposable repositories and test keys."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import prepare_product_server as bundle

SPEC = importlib.util.spec_from_file_location("product_fixture_release", ROOT / "server/scripts/package_release.py")
PACKAGER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGER)


@unittest.skipUnless(all(shutil.which(tool) for tool in ("git", "npm", "openssl")), "git, npm and openssl required for local packaging fixtures")
class ProductServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="product-server-test-")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "source"
        self.server = self.root / "server"
        self.server.mkdir(parents=True)
        self.version = "1.2.3-beta.4"
        self.output = self.base / "output"
        self.private = self.base / "fixture-private.pem"
        self.command("openssl", "genpkey", "-algorithm", "Ed25519", "-out", str(self.private))
        self.runtime = (*PACKAGER.FILES, *(f"{directory}/{name}" for directory, names in PACKAGER.DIRECTORY_FILES.items() for name in names))
        for name in self.runtime:
            target = self.server / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"fixture {name}\n")
        self.command("openssl", "pkey", "-in", str(self.private), "-pubout", "-out", str(self.server / "release-public-key.pem"))
        (self.server / "VERSION").write_text(self.version + "\n")
        (self.server / "agent_server.py").write_text("API_CONTRACT_VERSION = 28\n")
        for name in ("LICENSE", "NOTICE"):
            (self.root / name).write_bytes((self.server / name).read_bytes())
        for name in ("scripts/package_release.py", "scripts/package_npm_release.py", "package.json", "npm/README.md", "npm/cli.cjs"):
            target = self.server / name
            target.parent.mkdir(exist_ok=True)
            shutil.copyfile(ROOT / "server" / name, target)
        self.git("init", "--quiet")
        self.git("config", "user.name", "Product Bundle Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.commit()
        self.environment = mock.patch.dict(os.environ, {bundle.KEY_ENV: ""})
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def command(self, *args):
        return subprocess.run(args, capture_output=True, text=True, check=True).stdout.strip()

    def git(self, *args):
        return self.command("git", "-C", str(self.root), *args)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "--quiet", "-m", "disposable fixture")
        self.sha = self.git("rev-parse", "HEAD")

    def prepare(self, **overrides):
        args = {"source_sha": self.sha, "version": self.version, "signing_key": self.private}
        args.update(overrides)
        return bundle.prepare(self.root, self.output, **args)

    def assert_no_candidate(self):
        self.assertFalse(self.output.exists())
        self.assertEqual(self.git("status", "--porcelain", "--untracked-files=all"), "")

    def test_real_offline_pack_signatures_exact_assets_and_source_identity(self):
        before_refs = self.git("show-ref")
        receipt = self.prepare(minimum_server_api_contract=9)
        self.assertEqual(receipt, json.loads((self.output / bundle.RECEIPT).read_text()))
        self.assertEqual(receipt["sourceSha"], self.sha)
        self.assertEqual(receipt["version"], self.version)
        self.assertEqual(receipt["track"], "beta")
        self.assertEqual(receipt["schema"], 1)
        self.assertEqual(self.git("show-ref"), before_refs)
        self.assertEqual(self.git("status", "--porcelain", "--untracked-files=all"), "")
        self.assertEqual(len(receipt["artifacts"]), 6)
        files = {p.relative_to(self.output).as_posix() for p in self.output.rglob("*") if p.is_file()}
        self.assertEqual(files, {*receipt["artifacts"], bundle.RECEIPT})
        for path, metadata in receipt["artifacts"].items():
            data = (self.output / path).read_bytes()
            self.assertEqual(metadata, {"sha256": hashlib.sha256(data).hexdigest(), "size": len(data)})
            self.assertNotIn(self.private.read_bytes(), data)
        for directory, manifest_name, schema in (("npm", "agents-server-npm-manifest", 2), ("legacy", "agents-server-manifest", 1)):
            folder = self.output / directory
            self.assertEqual(len(list(folder.iterdir())), 3)
            path = folder / f"{manifest_name}.json"
            manifest = json.loads(path.read_text())
            self.assertEqual(manifest["commit"], self.sha)
            self.assertEqual(manifest["schema"], schema)
            self.assertEqual(manifest["version"], self.version)
            self.command("openssl", "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(self.server / "release-public-key.pem"), "-in", str(path), "-sigfile", str(folder / f"{manifest_name}.sig"))
            self.assertEqual(receipt[directory + "ManifestSha256"], hashlib.sha256(path.read_bytes()).hexdigest())
            if directory == "legacy":
                self.assertEqual(manifest["archive"]["url"], f"https://github.com/ZhengyiLuo/AgentsServer/releases/download/v{self.version}/agents-server-{self.version}.tar.gz")
            else:
                self.assertEqual(manifest["minimum_server_api_contract"], 9)
        with tarfile.open(self.output / "npm" / f"server-{self.version}.tgz") as npm, tarfile.open(self.output / "legacy" / f"agents-server-{self.version}.tar.gz") as legacy:
            for name in self.runtime:
                left = npm.getmember("package/server/" + name)
                right = legacy.getmember(f"agents-server-{self.version}/" + name)
                self.assertEqual(left.mode, right.mode, name)
                self.assertEqual(npm.extractfile(left).read(), legacy.extractfile(right).read(), name)
            self.assertEqual(npm.getmember("package/server/instances.sh").mode, 0o755)

    def test_stable_track_and_secret_environment_is_not_inherited(self):
        self.version = "1.2.3"
        (self.server / "VERSION").write_text(self.version + "\n")
        self.commit()
        real_run = subprocess.run
        calls = []

        def capture(*args, **kwargs):
            calls.append(kwargs["env"])
            return real_run(*args, **kwargs)

        with mock.patch.dict(os.environ, {bundle.KEY_ENV: base64.b64encode(self.private.read_bytes()).decode(), "GH_TOKEN": "fixture-gh-secret", "NPM_TOKEN": "fixture-npm-secret"}), mock.patch.object(bundle.subprocess, "run", side_effect=capture):
            receipt = self.prepare(signing_key=None)
        self.assertEqual(receipt["track"], "stable")
        self.assertTrue(calls)
        for environment in calls:
            self.assertTrue({bundle.KEY_ENV, "GH_TOKEN", "NPM_TOKEN"}.isdisjoint(environment))

    def test_same_committed_source_key_and_version_produce_identical_signed_bundles(self):
        first = self.prepare()
        original = {path.relative_to(self.output).as_posix(): path.read_bytes()
                    for path in self.output.rglob("*") if path.is_file()}
        self.output = self.base / "second-output"
        # Cross a wall-clock second, create another snapshot/destination, and
        # try an ambient epoch override. Only the pinned commit may set time.
        time.sleep(1.1)
        with mock.patch.dict(os.environ, {"SOURCE_DATE_EPOCH": "1"}):
            second = self.prepare()
        repeated = {path.relative_to(self.output).as_posix(): path.read_bytes()
                    for path in self.output.rglob("*") if path.is_file()}
        self.assertEqual(first, second)
        self.assertEqual(original, repeated)
        epoch = int(self.git("show", "-s", "--format=%ct", self.sha))
        archive_path = self.output / "legacy" / f"agents-server-{self.version}.tar.gz"
        self.assertEqual(int.from_bytes(archive_path.read_bytes()[4:8], "little"), epoch)
        with tarfile.open(archive_path) as archive:
            self.assertTrue(all(member.mtime == epoch for member in archive))

    def test_dirty_untracked_and_staged_source_are_rejected(self):
        for kind in ("dirty", "untracked", "staged"):
            with self.subTest(kind=kind):
                target = self.root / ("untracked" if kind == "untracked" else "NOTICE")
                target.write_text(kind)
                if kind == "staged":
                    self.git("add", ".")
                with self.assertRaisesRegex(ValueError, "clean committed source"):
                    self.prepare()
                self.assertFalse(self.output.exists())
                self.commit()

    def test_version_and_exact_source_pin_are_required(self):
        for override, message in (({"source_sha": "HEAD"}, "full lowercase"), ({"source_sha": "0" * 40}, "checked-out HEAD"), ({"version": "1.2.3"}, "server/VERSION"), ({"version": "1.2.3-rc.1"}, "semantic version"), ({"minimum_server_api_contract": True}, "positive integer")):
            with self.subTest(override=override), self.assertRaisesRegex(ValueError, message):
                self.prepare(**override)
        self.assert_no_candidate()

    def test_existing_output_and_source_output_are_rejected(self):
        self.output.mkdir()
        existing = self.output / "reviewed"
        existing.write_text("retained")
        with self.assertRaisesRegex(FileExistsError, "already exists"):
            self.prepare()
        self.assertEqual(existing.read_text(), "retained")
        self.output = self.root / "dist"
        with self.assertRaisesRegex(ValueError, "outside the source"):
            self.prepare()
        self.assert_no_candidate()

    def test_missing_malformed_ambiguous_and_untrusted_signing_keys_fail_closed(self):
        with self.assertRaisesRegex(ValueError, "provide --signing-key"):
            self.prepare(signing_key=None)
        with mock.patch.dict(os.environ, {bundle.KEY_ENV: "invalid key secret"}):
            with self.assertRaisesRegex(ValueError, "valid base64"):
                self.prepare(signing_key=None)
            with self.assertRaisesRegex(ValueError, "not both"):
                self.prepare()
        other_key = self.base / "wrong-key.pem"
        self.command("openssl", "genpkey", "-algorithm", "Ed25519", "-out", str(other_key))
        with self.assertRaisesRegex(ValueError, "committed Ed25519"):
            self.prepare(signing_key=other_key)
        self.assert_no_candidate()

    def test_child_errors_do_not_disclose_signing_material(self):
        with mock.patch.object(bundle.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, b"fixture-secret", b"fixture-secret")):
            with self.assertRaisesRegex(ValueError, "^test operation failed$"):
                bundle.run(["openssl"], cwd=self.base, label="test operation")

    def test_runtime_executable_mode_difference_is_rejected_before_signing(self):
        script = self.server / "scripts/package_npm_release.py"
        script.write_text(script.read_text().replace('"uninstall.sh", "instances.sh",', '"uninstall.sh",'))
        self.commit()
        with self.assertRaisesRegex(ValueError, "runtime differs"), mock.patch.object(bundle, "sign") as sign:
            self.prepare()
        sign.assert_not_called()
        self.assert_no_candidate()

    def test_nonexecutable_permission_difference_is_also_rejected(self):
        script = self.server / "scripts/package_release.py"
        script.write_text(script.read_text().replace("member.mode & 0o111 else 0o644", "member.mode & 0o111 else 0o640"))
        self.commit()
        with self.assertRaisesRegex(ValueError, "file modes must match"):
            self.prepare()
        self.assert_no_candidate()

    def test_runtime_content_difference_is_rejected(self):
        script = self.server / "scripts/package_release.py"
        script.write_text(script.read_text().replace("shutil.copy2(root / name, target)", 'shutil.copy2(root / name, target)\n            if name == "agent_server.py": target.write_text("different runtime\\n")'))
        self.commit()
        with self.assertRaisesRegex(ValueError, "runtime differs"):
            self.prepare()
        self.assert_no_candidate()

    def test_legacy_api_contract_drift_is_rejected(self):
        (self.server / "agent_server.py").write_text("API_CONTRACT_VERSION = 29\n")
        self.commit()
        with self.assertRaisesRegex(ValueError, "committed server API contract"):
            self.prepare()
        self.assert_no_candidate()


if __name__ == "__main__":
    unittest.main()
