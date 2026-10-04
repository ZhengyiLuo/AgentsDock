import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location('prepare_server_export', Path(__file__).parents[1] / 'prepare_server_export.py')
EXPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(EXPORT)


class ServerExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.server = self.root / 'standalone'
        self.app = self.root / 'app'
        for repository in (self.server, self.app):
            repository.mkdir()
            self.git(repository, 'init', '-q')
            self.git(repository, 'config', 'user.name', 'Export Test')
            self.git(repository, 'config', 'user.email', 'export@example.invalid')
        (self.server / 'VERSION').write_text('1.0.0\n')
        self.commit(self.server, 'standalone base')
        self.previous = self.git(self.server, 'rev-parse', 'HEAD')
        (self.app / 'README').write_text('app\n')
        self.commit(self.app, 'client base')
        self.git(self.app, 'subtree', 'add', '--prefix=server', str(self.server), 'HEAD')

    def git(self, repository, *arguments):
        result = subprocess.run(['git', '-C', str(repository), *arguments], text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def commit(self, repository, message):
        self.git(repository, 'add', '.')
        self.git(repository, 'commit', '-qm', message)

    def test_import_round_trip_and_later_server_change_preserve_history(self):
        imported = EXPORT.prepare(self.app, 'HEAD', self.previous)
        self.assertEqual(imported['exported_commit'], self.previous)
        (self.app / 'server' / 'VERSION').write_text('1.0.1\n')
        self.commit(self.app, 'server fix')
        exported = EXPORT.prepare(self.app, 'HEAD', self.previous)
        self.assertNotEqual(exported['exported_commit'], self.previous)
        self.git(self.app, 'merge-base', '--is-ancestor', self.previous, exported['exported_commit'])
        self.assertEqual(self.git(self.app, 'show', exported['exported_commit'] + ':VERSION'), '1.0.1')

    def test_diverged_standalone_branch_is_rejected(self):
        (self.server / 'VERSION').write_text('1.0.2\n')
        self.commit(self.server, 'standalone-only fix')
        diverged = self.git(self.server, 'rev-parse', 'HEAD')
        self.git(self.app, 'fetch', '-q', str(self.server), 'HEAD')
        with self.assertRaisesRegex(ValueError, 'diverged'):
            EXPORT.prepare(self.app, 'HEAD', diverged)

    def test_ambiguous_previous_reference_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'full reviewed'):
            EXPORT.prepare(self.app, 'HEAD', 'main')


if __name__ == '__main__':
    unittest.main()
