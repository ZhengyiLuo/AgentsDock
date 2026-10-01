"""Synthetic archives only; no native software or system changes."""
import hashlib
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
import warnings
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from extract_product_candidate import extract


class CandidateExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.make_fixture("1.0.7-beta.17")

    def make_fixture(self, version):
        self.version = version
        track = "beta" if "-beta." in version else "stable"
        desktop = [f"AgentsDock-{self.version}-mac-universal.zip", f"AgentsDock-{self.version}-mac-universal.zip.blockmap",
                   f"AgentsDock-{self.version}-mac-universal.dmg", f"{'beta' if track == 'beta' else 'latest'}-mac.yml", "agents-server-npm-manifest.json",
                   "agents-server-npm-manifest.sig", "SHA256SUMS"]
        value = {"schema": 1, "kind": "agentsdock-macos-candidate", "scope": "darwin-app-server", "publicationEligible": False,
                 "version": self.version, "track": track, "desktopAssets": {name: {} for name in desktop}}
        self.receipt = self.root / "candidate.json"
        self.receipt.write_text(json.dumps(value))
        self.receipt_hash = hashlib.sha256(self.receipt.read_bytes()).hexdigest()
        self.members = [f"desktop/{name}" for name in desktop] + ["server/product-server-bundle.json",
            "server/npm/agents-server-npm-manifest.json", "server/npm/agents-server-npm-manifest.sig", f"server/npm/server-{self.version}.tgz",
            "server/legacy/agents-server-manifest.json", "server/legacy/agents-server-manifest.sig",
            f"server/legacy/agents-server-{self.version}.tar.gz", "server-import.json", "signer-artifact.zip"]

    def archive(self, extra=None, omit=False):
        path = self.root / "bundle.zip"
        with zipfile.ZipFile(path, "w") as archive:
            for name in self.members[:-1] if omit else self.members:
                archive.writestr(name, b"synthetic fixture bytes")
            if extra:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    archive.writestr(extra, b"untrusted")
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_exact_inventory_extracts_into_only_new_directory(self):
        archive, digest = self.archive()
        output = self.root / "output"
        extract(self.receipt, self.receipt_hash, archive, digest, output)
        self.assertEqual(len([p for p in output.rglob("*") if p.is_file()]), len(self.members))
        with self.assertRaises(ValueError):
            extract(self.receipt, self.receipt_hash, archive, digest, output)

    def test_reviewed_stable_has_exact_stable_inventory_and_remains_nonpublishing(self):
        self.make_fixture("1.0.9")
        archive, digest = self.archive()
        output = self.root / "stable-output"
        extract(self.receipt, self.receipt_hash, archive, digest, output)
        self.assertTrue((output / "desktop/latest-mac.yml").is_file())
        self.assertFalse((output / "desktop/beta-mac.yml").exists())
        self.assertIs(json.loads(self.receipt.read_bytes())["publicationEligible"], False)

    def test_other_stable_versions_wrong_tracks_and_publishing_receipts_fail_before_extraction(self):
        for version, changes in [("1.0.8", {}), ("1.0.10", {}), ("1.0.9", {"track": "beta"}),
                                 ("1.0.8-beta.5", {"track": "stable"}), ("1.0.9", {"publicationEligible": True}),
                                 ("1.0.9", {"track": None})]:
            with self.subTest(version=version, changes=changes):
                self.make_fixture(version)
                value = json.loads(self.receipt.read_bytes())
                value.update(changes)
                self.receipt.write_text(json.dumps(value))
                digest = hashlib.sha256(self.receipt.read_bytes()).hexdigest()
                archive, archive_digest = self.archive()
                output = self.root / "refused-stable"
                with self.assertRaises(ValueError):
                    extract(self.receipt, digest, archive, archive_digest, output)
                self.assertFalse(output.exists())

    def test_rejects_unknown_traversal_duplicate_and_symlink_members_before_creating_root(self):
        link = zipfile.ZipInfo("server/npm/evil")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for extra in ["../outside", "/absolute", "unknown", self.members[0], link]:
            with self.subTest(extra=extra):
                archive, digest = self.archive(extra)
                output = self.root / "refused"
                with self.assertRaises(ValueError):
                    extract(self.receipt, self.receipt_hash, archive, digest, output)
                self.assertFalse(output.exists())

    def test_receipt_and_transport_hashes_are_independent_and_required(self):
        archive, digest = self.archive()
        for receipt_hash, archive_hash in [("0" * 64, digest), (self.receipt_hash, "0" * 64)]:
            with self.assertRaises(ValueError):
                extract(self.receipt, receipt_hash, archive, archive_hash, self.root / "refused")
        archive, digest = self.archive(omit=True)
        with self.assertRaises(ValueError):
            extract(self.receipt, self.receipt_hash, archive, digest, self.root / "refused")


if __name__ == "__main__":
    unittest.main()
