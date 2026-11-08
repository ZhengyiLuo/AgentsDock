import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock
import warnings
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import verify_electron_app_zip as verifier


class AppZipTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.archive = Path(temporary.name) / "app.zip"

    def make(self, entries):
        with warnings.catch_warnings(), zipfile.ZipFile(self.archive, "w", zipfile.ZIP_DEFLATED) as output:
            warnings.simplefilter("ignore", UserWarning)
            for name, kind, value in entries:
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = (kind | 0o755) << 16
                output.writestr(entry, value)
        return self.archive

    def test_preserves_framework_relative_symlinks_and_implicit_directories(self):
        base = "AgentsDock.app/Contents/Frameworks/Electron Framework.framework/"
        self.make([
            ("AgentsDock.app/", stat.S_IFDIR, b""),
            (base + "Versions/A/Electron Framework", stat.S_IFREG, b"executable"),
            (base + "Versions/A/Resources/info", stat.S_IFREG, b"metadata"),
            (base + "Versions/Current", stat.S_IFLNK, b"A"),
            (base + "Electron Framework", stat.S_IFLNK, b"Versions/Current/Electron Framework"),
            (base + "Resources", stat.S_IFLNK, b"Versions/Current/Resources"),
            (base + "Versions/A/Resources/parent", stat.S_IFLNK, b".."),
        ])
        result = verifier.verify(self.archive)
        self.assertTrue(result["safeAppZip"])
        self.assertEqual(result["symlinks"], 4)

    def test_rejects_outside_absolute_and_traversal_paths(self):
        for name in ["other/file", "/AgentsDock.app/file", "AgentsDock.app/../outside", "AgentsDock.app//file",
                     "AgentsDock.app/./file", "AgentsDock.app/Contents\\file", "AgentsDock.app/file\n"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                verifier.verify(self.make([(name, stat.S_IFREG, b"data")]))

    def test_rejects_duplicates_aliases_and_unicode_normalization_collisions(self):
        for other in ["AgentsDock.app/Contents/file", "AgentsDock.app/contents/file", "AgentsDock.app/Contents/FILE"]:
            with self.subTest(other=other), self.assertRaisesRegex(ValueError, "duplicate|aliased"):
                verifier.verify(self.make([("AgentsDock.app/Contents/file", stat.S_IFREG, b"x"),
                                           (other, stat.S_IFREG, b"y")]))
        with self.assertRaisesRegex(ValueError, "duplicate|aliased"):
            verifier.verify(self.make([("AgentsDock.app/caf\u00e9", stat.S_IFREG, b"x"),
                                       ("AgentsDock.app/cafe\u0301", stat.S_IFREG, b"y")]))

    def test_rejects_absolute_escaping_dangling_and_cyclic_symlinks(self):
        for target in [b"/tmp/escape", b"../../outside", b"../..", b"missing", b"link", b"file\\name"]:
            with self.subTest(target=target), self.assertRaises(ValueError):
                verifier.verify(self.make([("AgentsDock.app/Contents/link", stat.S_IFLNK, target)]))
        with self.assertRaisesRegex(ValueError, "cyclic"):
            verifier.verify(self.make([("AgentsDock.app/a", stat.S_IFLNK, b"b"),
                                       ("AgentsDock.app/b", stat.S_IFLNK, b"a")]))

    def test_rejects_writes_under_symlink_ancestors_in_either_order(self):
        entries = [("AgentsDock.app/target/", stat.S_IFDIR, b""),
                   ("AgentsDock.app/link", stat.S_IFLNK, b"target"),
                   ("AgentsDock.app/link/child", stat.S_IFREG, b"write")]
        for items in [entries, entries[::-1]]:
            with self.assertRaisesRegex(ValueError, "ancestor"):
                verifier.verify(self.make(items))

    def test_rejects_symlink_chain_that_escapes_after_alias_resolution(self):
        with self.assertRaisesRegex(ValueError, "escapes"):
            verifier.verify(self.make([("AgentsDock.app/deep/place/link", stat.S_IFLNK, b"../.."),
                                       ("AgentsDock.app/escape", stat.S_IFLNK, b"deep/place/link/../outside")]))

    def test_rejects_special_files_root_replacement_and_file_ancestors(self):
        for kind in [stat.S_IFIFO, stat.S_IFSOCK, stat.S_IFBLK, stat.S_IFCHR]:
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                verifier.verify(self.make([("AgentsDock.app/file", kind, b"x")]))
        with self.assertRaises(ValueError):
            verifier.verify(self.make([("AgentsDock.app", stat.S_IFREG, b"x")]))
        with self.assertRaisesRegex(ValueError, "ancestor"):
            verifier.verify(self.make([("AgentsDock.app/a", stat.S_IFREG, b"x"),
                                       ("AgentsDock.app/a/b", stat.S_IFREG, b"y")]))

    def test_limits_members_expansion_and_link_payload_without_extraction(self):
        self.make([("AgentsDock.app/file", stat.S_IFREG, b"12345")])
        with mock.patch.object(verifier, "MAX_EXPANDED", 4), self.assertRaisesRegex(ValueError, "size limit"):
            verifier.verify(self.archive)
        with mock.patch.object(verifier, "MAX_MEMBERS", 0), self.assertRaisesRegex(ValueError, "member count"):
            verifier.verify(self.archive)
        with self.assertRaisesRegex(ValueError, "oversized symlink"):
            verifier.verify(self.make([("AgentsDock.app/link", stat.S_IFLNK, b"a" * 4097)]))
        self.assertEqual(sorted(path.name for path in self.archive.parent.iterdir()), ["app.zip"])

    def test_refuses_symlink_archive_input(self):
        self.make([("AgentsDock.app/file", stat.S_IFREG, b"x")])
        link = self.archive.parent / "alias.zip"
        os.symlink(self.archive, link)
        with self.assertRaises(OSError):
            verifier.verify(link)

    def test_native_extractors_validate_before_ditto(self):
        root = Path(__file__).resolve().parents[2]
        release = (root / "scripts/build_electron_release.sh").read_text()
        self.assertIn("verify_electron_release.sh", release)
        verify = (root / "scripts/verify_electron_release.sh").read_text()
        self.assertLess(verify.index("verify_electron_app_zip.py"), verify.index("/usr/bin/ditto -x"))
        desktop = (root / "scripts/product_desktop_acceptance.mjs").read_text()
        method = desktop[desktop.index("async function extractVerifiedApp"):desktop.index("async function serverHealth")]
        self.assertLess(method.index("verify_electron_app_zip.py"), method.index("run('/usr/bin/ditto'"))


if __name__ == "__main__":
    unittest.main()
