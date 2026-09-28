"""Real npm packing/bin checks in disposable homes/prefixes; no service install."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import package_agentsdock_cli as cli_package
import package_npm_release as core_package


class AgentsDockCliPackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="agentsdock-entry-package-")
        self.addCleanup(self.temporary.cleanup)
        self.work = Path(self.temporary.name)
        self.root = self.work / "source/server"
        source = self.root / "npm/agentsdock"
        source.mkdir(parents=True)
        for name in ("package.json", "cli.cjs", "README.md"):
            shutil.copyfile(ROOT / "npm/agentsdock" / name, source / name)
        (self.root / "VERSION").write_text("1.2.3-beta.4\n")
        for name in ("LICENSE", "NOTICE"):
            (self.root.parent / name).write_text(f"fixture {name}\n")
        subprocess.run(["git", "init", "--quiet"], cwd=self.root.parent, check=True)
        subprocess.run(["git", "add", "."], cwd=self.root.parent, check=True)
        subprocess.run(["git", "-c", "user.name=CLI Fixture", "-c", "user.email=fixture@example.invalid",
                        "commit", "--quiet", "-m", "fixture"], cwd=self.root.parent, check=True)

    def test_exact_pin_no_hooks_and_no_private_files(self):
        (self.root / "npm/agentsdock/.env").write_text("not packaged")
        destination = self.work / "stage"
        version, expected = cli_package.stage_package(self.root, destination)
        metadata = json.loads((destination / "package.json").read_text())
        self.assertEqual(metadata["name"], "agentsdock")
        self.assertEqual(metadata["bin"], {"agentsdock": "cli.cjs"})
        self.assertEqual(metadata["dependencies"], {"@agentsdock/server": version})
        self.assertNotIn("private", metadata)
        self.assertNotIn("scripts", metadata)
        self.assertEqual({p.name for p in destination.iterdir()}, expected)
        self.assertEqual((destination / "cli.cjs").stat().st_mode & 0o777, 0o755)
        for name in ("LICENSE", "NOTICE"):
            self.assertEqual((destination / name).read_bytes(), (self.root.parent / name).read_bytes())

    def test_rejects_hooks_extra_dependencies_and_wrong_name(self):
        source = self.root / "npm/agentsdock/package.json"
        original = json.loads(source.read_text())
        for change in ({"scripts": {"postinstall": "bad"}}, {"name": "other"},
                       {"dependencies": {"@agentsdock/server": "latest"}},
                       {"optionalDependencies": {"other": "*"}}):
            source.write_text(json.dumps({**original, **change}))
            with self.assertRaises(ValueError):
                cli_package.stage_package(self.root, self.work / "stage")

    def test_actual_pack_is_reproducible_and_receipt_is_bound_to_bytes(self):
        one = cli_package.prepare(self.root, self.work / "one", require_clean_source=True)
        two = cli_package.prepare(self.root, self.work / "two", require_clean_source=True)
        self.assertEqual(one, two)
        archive = self.work / "one" / one["archive"]["name"]
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), one["archive"]["sha256"])
        with tarfile.open(archive) as packed:
            self.assertEqual(set(packed.getnames()), {f"package/{name}" for name in
                             ("package.json", "cli.cjs", "README.md", "LICENSE", "NOTICE")})
        with self.assertRaises(FileExistsError):
            cli_package.prepare(self.root, self.work / "one")
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), one["archive"]["sha256"])
        (self.root / "VERSION").write_text("1.2.3-beta.5")
        with self.assertRaisesRegex(ValueError, "clean committed"):
            cli_package.prepare(self.root, self.work / "dirty", require_clean_source=True)

    @unittest.skipUnless(shutil.which("npm") and shutil.which("node") and os.getuid() != 0,
                         "real npm CLI smoke needs npm/node and a non-root user")
    def test_real_global_and_local_npm_entrypoint_with_actual_runtime(self):
        # Actual source payload, npm resolver, bin symlink and Python/bash helpers.
        # Never invoke service creation/control or connect to a real provider.
        core = core_package.prepare(ROOT, self.work / "core")
        cli = cli_package.prepare(ROOT, self.work / "cli")
        archives = [str(self.work / "core" / core["archive"]["name"]),
                    str(self.work / "cli" / cli["archive"]["name"])]
        home = self.work / "home"
        home.mkdir(mode=0o700)
        outside = self.work / "outside"
        outside.mkdir()
        user_config, global_config = self.work / "user.npmrc", self.work / "global.npmrc"
        user_config.touch()
        global_config.touch()
        env = {"HOME": str(home), "PATH": os.environ["PATH"], "LANG": "C.UTF-8",
               "NPM_CONFIG_CACHE": str(self.work / "cache"),
               "NPM_CONFIG_USERCONFIG": str(user_config), "NPM_CONFIG_GLOBALCONFIG": str(global_config),
               "NPM_CONFIG_UPDATE_NOTIFIER": "false"}

        def invoke(args, **kwargs):
            result = subprocess.run(args, cwd=outside, env=env, capture_output=True, text=True,
                                    timeout=90, **kwargs)
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout

        prefix = self.work / "global"
        invoke(["npm", "install", "--global", "--prefix", str(prefix), "--ignore-scripts",
                "--no-audit", "--no-fund", "--offline", *archives])
        env["PATH"] = str(prefix / "bin") + os.pathsep + env["PATH"]
        self.assertEqual(invoke(["agentsdock", "--version"]).strip(), cli["version"])
        self.assertIn("agentsdock setup", invoke(["agentsdock", "--help"]))
        self.assertIn("No installations found", invoke(["agentsdock", "servers", "list"]))
        self.assertIn("No installations found", invoke(["agentsdock", "status"]))
        self.assertIn("No unfinished default", invoke(["agentsdock", "recover"]))
        # Private synthetic config; no service or real credential is involved.
        config = home / ".config/agents-server"
        config.mkdir(parents=True, mode=0o700)
        private_env = config / "env"
        private_env.write_text("AGENTSDOCK_AGENT_TOKEN=fixture-only-token\n")
        private_env.chmod(0o600)
        self.assertEqual(invoke(["agentsdock", "token"]).strip(), "fixture-only-token")
        named_config = home / ".config/agents-server-instances/work"
        named_config.mkdir(parents=True, mode=0o700)
        named_env = named_config / "env"
        named_env.write_text("AGENTSDOCK_AGENT_TOKEN=separate-fixture-token\n")
        named_env.chmod(0o600)
        self.assertEqual(invoke(["agentsdock", "token", "--instance", "work"]).strip(), "separate-fixture-token")
        self.assertEqual(invoke(["agentsdock", "token", "--instance", "default"]).strip(), "fixture-only-token")
        before = private_env.read_bytes()
        rejected = subprocess.run(["agentsdock", "install", "--dry-run"], cwd=outside,
                                  env=env, capture_output=True, text=True, timeout=20)
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("existing server installation or state", rejected.stderr)
        self.assertEqual(private_env.read_bytes(), before)
        self.assertFalse((home / "Library/LaunchAgents").exists())
        self.assertFalse((home / ".config/systemd").exists())

        local = self.work / "local"
        invoke(["npm", "install", "--prefix", str(local), "--ignore-scripts",
                "--no-audit", "--no-fund", "--offline", *archives])
        self.assertEqual(invoke([str(local / "node_modules/.bin/agentsdock"), "--version"]).strip(), cli["version"])
        # Do not let the global smoke-test command mask a missing local bin.
        env["PATH"] = os.environ["PATH"]
        result = subprocess.run(["npm", "exec", "--offline", "--", "agentsdock", "--version"],
                                cwd=local, env=env, capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), cli["version"])


if __name__ == "__main__":
    unittest.main()
